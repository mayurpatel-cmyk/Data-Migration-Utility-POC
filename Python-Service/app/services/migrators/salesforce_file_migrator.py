import base64
import asyncio
import csv
import io
import zipfile
import urllib.parse
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional, Awaitable, List, Dict, Tuple

from app.services.crm_service import CrmService


def chunk_list(data: list, size: int = 200):
    for i in range(0, len(data), size):
        yield data[i:i + size]


class FileMigrationStrategy(str, Enum):
    REST = "rest"
    BULK_ZIP = "bulk_zip"


class ApiLimitNearExhaustionError(Exception):
    def __init__(self, used: int, limit: int):
        self.used = used
        self.limit = limit
        super().__init__(f"Salesforce daily API usage at {used}/{limit} -- stopping before hard limit.")


@dataclass
class FileMigrationCheckpoint:
    migrated_attachment_ids: set = field(default_factory=set)
    migrated_content_version_ids: set = field(default_factory=set)
    on_migrated: Optional[Callable[[str, str], Awaitable[None]]] = None

    async def mark(self, kind: str, source_id: str):
        if kind == "attachment":
            self.migrated_attachment_ids.add(source_id)
        else:
            self.migrated_content_version_ids.add(source_id)
        if self.on_migrated:
            await self.on_migrated(kind, source_id)


class SalesforceFileMigrator:

    API_VERSION = "v60.0"
    MAX_INLINE_BYTES = 25 * 1024 * 1024
    MAX_BULK_BATCH_BYTES = 4_500_000
    MAX_BULK_BATCH_ROWS = 2000

    def __init__(self, api_usage_safety_threshold: float = 0.90):
        self.api_usage_safety_threshold = api_usage_safety_threshold

    # ==========================================
    # AUTH-AWARE REQUEST WRAPPER -- REST endpoints (/services/data/...)
    # download/upload calls.
    # ==========================================
    async def _authed_request(self, client, method: str, url: str, creds: dict, user_id: str, role: str, send_log, **kwargs):
        token = creds.get("access_token")
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {token}"

        res = await client.request(method, url, headers=headers, **kwargs)

        if res.status_code == 401:
            await send_log(f"[Files] {role.capitalize()} session expired mid-transfer. Refreshing token...")
            new_token = await CrmService.refresh_crm_token(user_id, "salesforce", role)
            creds["access_token"] = new_token
            headers["Authorization"] = f"Bearer {new_token}"
            res = await client.request(method, url, headers=headers, **kwargs)

        self._enforce_api_limit(res, send_log)
        return res

    # ==========================================
    # AUTH-AWARE REQUEST WRAPPER -- Bulk API 1.0 endpoints (/services/async/...)
    # ==========================================
    async def _bulk_authed_request(self, client, method: str, url: str, creds: dict, user_id: str, role: str, send_log, **kwargs):
        token = creds.get("access_token")
        headers = kwargs.pop("headers", {})
        headers["X-SFDC-Session"] = token

        res = await client.request(method, url, headers=headers, **kwargs)

        if res.status_code == 401 or self._is_invalid_session(res):
            await send_log(f"[Files] {role.capitalize()} session expired mid-transfer (Bulk API). Refreshing token...")
            new_token = await CrmService.refresh_crm_token(user_id, "salesforce", role)
            creds["access_token"] = new_token
            headers["X-SFDC-Session"] = new_token
            res = await client.request(method, url, headers=headers, **kwargs)

        self._enforce_api_limit(res, send_log)
        return res

    def _safe_json(self, res):
        """Parse a response body as JSON, returning None instead of raising if the
        body is empty or not valid JSON (e.g. Salesforce's default XML fallback
        when an Accept header is missing, or a truncated/empty response body)."""
        if not res.content:
            return None
        try:
            return res.json()
        except ValueError:
            return None

    def _parse_batch_xml_field(self, text: str, field: str) -> Optional[str]:
        """Bulk API 1.0 ignores the Accept: application/json header for any
        call tied to a zip/csv-content job -- batch submission AND batch
        status polling both come back as XML (<batchInfo>...) no matter what
        we ask for. This pulls a single named field (e.g. 'id', 'state') out
        of that XML body."""
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            return None
        tag = root.tag.split("}")[-1] if "}" in root.tag else root.tag
        if tag != "batchInfo":
            return None
        for child in root:
            child_tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
            if child_tag == field and child.text:
                return child.text.strip()
        return None

    def _is_invalid_session(self, res) -> bool:
        """Bulk API 1.0 reports an expired/bad session as HTTP 400 with a JSON
        body ({"exceptionCode": "InvalidSessionId", ...}), not a 401 -- so the
        401 check alone misses it. This catches that shape specifically."""
        if res.status_code not in (400, 403):
            return False
        try:
            data = res.json()
            if isinstance(data, list) and data:
                data = data[0]
            return isinstance(data, dict) and data.get("exceptionCode") == "InvalidSessionId"
        except Exception:
            return False

    def _enforce_api_limit(self, res, send_log):
        usage = res.headers.get("Sforce-Limit-Info")
        if not usage:
            return
        try:
            used_str, limit_str = usage.split("=")[1].split("/")
            used, limit = int(used_str), int(limit_str)
        except (IndexError, ValueError):
            return
        if limit and (used / limit) >= self.api_usage_safety_threshold:
            raise ApiLimitNearExhaustionError(used, limit)

    # ==========================================
    # EXTRACTION (from source org) -- REST, unchanged
    # ==========================================
    async def extract_attachments(self, client, creds, user_id, parent_ids: list, send_log):
        instance = creds.get("instance_url", "").rstrip('/')
        all_attachments = []

        for id_chunk in chunk_list(parent_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = f"SELECT Id, ParentId, Name, ContentType, BodyLength FROM Attachment WHERE ParentId IN ({id_list})"
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Attachments] Query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                all_attachments.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        await send_log(f"[Attachments] Found {len(all_attachments)} legacy attachments across {len(parent_ids)} records.")
        return all_attachments

    async def extract_files(self, client, creds, user_id, parent_ids: list, send_log):
        instance = creds.get("instance_url", "").rstrip('/')

        links = []
        for id_chunk in chunk_list(parent_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = f"SELECT LinkedEntityId, ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN ({id_list})"
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Files] ContentDocumentLink query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                links.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        if not links:
            await send_log(f"[Files] No modern Files found across {len(parent_ids)} records.")
            return []

        doc_to_parents = defaultdict(list)
        for l in links:
            doc_to_parents[l["ContentDocumentId"]].append(l["LinkedEntityId"])

        doc_ids = list(doc_to_parents.keys())
        versions = []
        for id_chunk in chunk_list(doc_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = (
                "SELECT Id, ContentDocumentId, Title, FileExtension, ContentSize "
                f"FROM ContentVersion WHERE ContentDocumentId IN ({id_list}) AND IsLatest = true"
            )
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Files] ContentVersion query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                versions.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        files = []
        per_parent_count = defaultdict(int)
        for v in versions:
            for parent_id in doc_to_parents.get(v["ContentDocumentId"], []):
                title = v.get("Title") or "file"
                ext = v.get("FileExtension") or ""
                name = f"{title}.{ext}" if ext and not title.lower().endswith(f".{ext.lower()}") else title
                files.append({
                    "ParentId": parent_id,
                    "ContentVersionId": v["Id"],
                    "Name": name,
                    "ContentSize": v.get("ContentSize", 0)
                })
                per_parent_count[parent_id] += 1

        multi_file_parents = {p: c for p, c in per_parent_count.items() if c > 1}
        await send_log(
            f"[Files] Found {len(files)} modern Files across {len(parent_ids)} records "
            f"({len(multi_file_parents)} record(s) have more than one file; "
            f"max on a single record: {max(per_parent_count.values()) if per_parent_count else 0})."
        )
        return files

    # ==========================================
    # DOWNLOAD (binary body, from source org)
    # ==========================================
    async def download_body(self, client, creds, user_id, record_id: str, kind: str, send_log) -> bytes:
        instance = creds.get("instance_url", "").rstrip('/')
        if kind == "attachment":
            url = f"{instance}/services/data/{self.API_VERSION}/sobjects/Attachment/{record_id}/Body"
        else:
            url = f"{instance}/services/data/{self.API_VERSION}/sobjects/ContentVersion/{record_id}/VersionData"

        res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
        res.raise_for_status()
        return res.content

    # ==========================================
    # UPLOAD -- REST strategy
    # ==========================================
    async def upload_attachment(self, client, creds, user_id, new_parent_id: str, name: str, content_type: str, blob: bytes, send_log):
        instance = creds.get("instance_url", "").rstrip('/')

        if len(blob) > self.MAX_INLINE_BYTES:
            msg = f"'{name}' is {len(blob) / 1e6:.1f}MB, over the {self.MAX_INLINE_BYTES / 1e6:.0f}MB inline upload limit."
            await send_log(f"[Attachment SKIPPED] {msg}")
            return False, msg

        payload = {
            "ParentId": new_parent_id,
            "Name": name,
            "ContentType": content_type or "application/octet-stream",
            "Body": base64.b64encode(blob).decode("ascii")
        }
        url = f"{instance}/services/data/{self.API_VERSION}/sobjects/Attachment/"
        res = await self._authed_request(client, "POST", url, creds, user_id, "target", send_log, json=payload)

        if res.status_code == 201:
            return True, res.json().get("id")
        return False, res.text

    async def upload_file(self, client, creds, user_id, new_parent_id: str, name: str, blob: bytes, send_log):
        instance = creds.get("instance_url", "").rstrip('/')

        if len(blob) > self.MAX_INLINE_BYTES:
            msg = f"'{name}' is {len(blob) / 1e6:.1f}MB, over the {self.MAX_INLINE_BYTES / 1e6:.0f}MB inline upload limit."
            await send_log(f"[File SKIPPED] {msg}")
            return False, msg

        payload = {
            "Title": name,
            "PathOnClient": name,
            "VersionData": base64.b64encode(blob).decode("ascii"),
            "FirstPublishLocationId": new_parent_id
        }
        url = f"{instance}/services/data/{self.API_VERSION}/sobjects/ContentVersion/"
        res = await self._authed_request(client, "POST", url, creds, user_id, "target", send_log, json=payload)

        if res.status_code == 201:
            return True, res.json().get("id")
        return False, res.text

    # ==========================================
    # UPLOAD -- BULK_ZIP strategy (Bulk API 1.0 binary-attachment batches).
    # ==========================================
    def _chunk_rows_for_zip(self, rows_with_blobs: List[Tuple[dict, bytes]]):
        """Returns (batches, oversized), where each batch/oversized entry is
        (original_index, row, blob) -- carrying the index lets callers place
        results back at the position the caller originally gave us, instead
        of assuming oversized rows can only ever be at the tail of the list."""
        batches, current, current_bytes = [], [], 0
        oversized = []

        for idx, (row, blob) in enumerate(rows_with_blobs):
            blob_size = len(blob)
            if blob_size > self.MAX_BULK_BATCH_BYTES:
                oversized.append((idx, row, blob))
                continue

            projected = current_bytes + blob_size
            if current and (projected > self.MAX_BULK_BATCH_BYTES or len(current) >= self.MAX_BULK_BATCH_ROWS):
                batches.append(current)
                current, current_bytes = [], 0

            current.append((idx, row, blob))
            current_bytes += blob_size

        if current:
            batches.append(current)

        return batches, oversized

    def _build_zip_batch(self, rows_with_blobs: List[Tuple[dict, bytes]], csv_columns: List[str], blob_field: str) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            csv_buf = io.StringIO()
            writer = csv.DictWriter(csv_buf, fieldnames=csv_columns)
            writer.writeheader()

            for i, (row, blob) in enumerate(rows_with_blobs):
                part_name = f"part_{i}.bin"
                zf.writestr(part_name, blob)
                csv_row = dict(row)
                csv_row[blob_field] = f"#{part_name}"
                writer.writerow(csv_row)

            zf.writestr("request.csv", csv_buf.getvalue())
        return buf.getvalue()

    async def _bulk_zip_insert(
        self, client, creds, user_id, object_name: str, blob_field: str, csv_columns: List[str],
        rows_with_blobs: List[Tuple[dict, bytes]], send_log
    ) -> List[Tuple[bool, str]]:
        instance = creds.get("instance_url", "").rstrip('/')
        bulk_base_url = f"{instance}/services/async/{self.API_VERSION.lstrip('v')}"

        job_res = await self._bulk_authed_request(
            client, "POST", f"{bulk_base_url}/job", creds, user_id, "target", send_log,
            json={"operation": "insert", "object": object_name, "contentType": "ZIP_CSV"},
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        job_json = self._safe_json(job_res)
        if job_res.status_code != 201 or job_json is None:
            err = job_res.text
            await send_log(f"[Bulk {object_name}] Job creation failed (status={job_res.status_code}): {err[:500]}")
            return [(False, err) for _ in rows_with_blobs]

        job_id = job_json.get("id")
        batches, oversized = self._chunk_rows_for_zip(rows_with_blobs)

        if oversized:
            await send_log(
                f"[Bulk {object_name}] {len(oversized)} file(s) exceed the "
                f"{self.MAX_BULK_BATCH_BYTES / 1e6:.1f}MB Bulk batch budget individually -- "
                f"these will be uploaded via REST instead."
            )

        batch_ids = []
        for batch_rows in batches:
            zip_bytes = self._build_zip_batch(
                [(row, blob) for _, row, blob in batch_rows], csv_columns, blob_field
            )
            b_res = await self._bulk_authed_request(
                client, "POST", f"{bulk_base_url}/job/{job_id}/batch", creds, user_id, "target", send_log,
                content=zip_bytes, headers={"Content-Type": "zip/csv", "Accept": "application/json"},
            )
            if b_res.status_code != 201:
                await send_log(
                    f"[Bulk {object_name}] Batch submit failed (status={b_res.status_code}): "
                    f"{b_res.text[:500]}"
                )
                batch_ids.append(None)
                continue

            batch_json = self._safe_json(b_res)
            if batch_json is not None:
                batch_ids.append(batch_json.get("id"))
                continue

            # Salesforce returns XML for zip/csv batch submissions even when
            # Accept: application/json is set -- try that before giving up.
            xml_batch_id = self._parse_batch_xml_field(b_res.text, "id")
            if xml_batch_id:
                batch_ids.append(xml_batch_id)
                continue

            await send_log(
                f"[Bulk {object_name}] Batch submit returned 201 but the response body "
                f"couldn't be parsed as JSON or XML: {b_res.text[:500]}"
            )
            batch_ids.append(None)

        await self._bulk_authed_request(
            client, "POST", f"{bulk_base_url}/job/{job_id}", creds, user_id, "target", send_log,
            json={"state": "Closed"}, headers={"Accept": "application/json", "Content-Type": "application/json"},
        )

        poll_delay = 1.0
        max_poll_seconds = 600  # hard ceiling -- a stuck/unknown state must never hang the migration forever
        elapsed = 0.0
        live_batch_ids = [b for b in batch_ids if b]
        timed_out = False
        while live_batch_ids:
            if elapsed >= max_poll_seconds:
                await send_log(
                    f"[Bulk {object_name}] Gave up waiting for {len(live_batch_ids)} batch(es) to reach a "
                    f"terminal state after {max_poll_seconds}s -- marking them as failed. Check the Salesforce "
                    f"Bulk Data Load Jobs page for job {job_id} to see if they actually completed server-side."
                )
                timed_out = True
                break

            await asyncio.sleep(poll_delay)
            elapsed += poll_delay
            status_res = await asyncio.gather(*[
                self._bulk_authed_request(
                    client, "GET", f"{bulk_base_url}/job/{job_id}/batch/{b_id}", creds, user_id, "target", send_log,
                    headers={"Accept": "application/json"},
                )
                for b_id in live_batch_ids
            ])
            states = []
            for r in status_res:
                parsed = self._safe_json(r)
                if parsed is not None:
                    states.append(parsed.get("state", "Unknown"))
                else:
                    # Same XML quirk as batch submission -- fall back before
                    # giving up and stalling the whole poll loop on "Unknown".
                    states.append(self._parse_batch_xml_field(r.text, "state") or "Unknown")
            if all(s in ("Completed", "Failed", "NotProcessed") for s in states):
                break
            poll_delay = min(poll_delay * 1.5, 4.0)

        results_by_index: Dict[int, Tuple] = {}
        for b_id, batch_rows in zip(batch_ids, batches):
            batch_indices = [idx for idx, _, _ in batch_rows]

            if b_id in timed_out_ids:
                msg = (
                    f"Batch {b_id} did not reach a terminal state within {max_poll_seconds}s -- "
                    f"check job {job_id} in Salesforce Setup, it may still complete server-side."
                )
                for idx in batch_indices:
                    results_by_index[idx] = (False, msg)
                continue
            if not b_id:
                for idx in batch_indices:
                    results_by_index[idx] = (False, "Batch submission failed")
                continue

            # A batch can fail at the WHOLE-BATCH level (malformed ZIP, job-level
            # rejection) rather than per-row -- in that case /result does NOT
            # return one CSV row per submitted record, it returns an error body
            # or something short. Check batch state first so a whole-batch
            # failure gets one explicit failure per row instead of csv.DictReader
            # silently yielding fewer rows than we submitted (which used to make
            # those rows vanish from `results` with no trace at all).
            status_r = await self._bulk_authed_request(
                client, "GET", f"{bulk_base_url}/job/{job_id}/batch/{b_id}", creds, user_id, "target", send_log,
                headers={"Accept": "application/json"},
            )
            status_json = self._safe_json(status_r)
            batch_state = (
                (status_json or {}).get("state")
                or self._parse_batch_xml_field(status_r.text, "state")
                or "Unknown"
            )

            if batch_state in ("Failed", "NotProcessed"):
                state_msg = (
                    (status_json or {}).get("stateMessage")
                    or self._parse_batch_xml_field(status_r.text, "stateMessage")
                    or f"Batch {b_id} state: {batch_state}"
                )
                await send_log(f"[Bulk {object_name}] Batch {b_id} failed at the batch level: {state_msg}")
                for idx in batch_indices:
                    results_by_index[idx] = (False, state_msg)
                continue

            res_res = await self._bulk_authed_request(
                client, "GET", f"{bulk_base_url}/job/{job_id}/batch/{b_id}/result", creds, user_id, "target", send_log,
                headers={"Accept": "text/csv"},
            )
            reader = csv.DictReader(io.StringIO(res_res.text))
            row_results: List[Tuple[bool, str]] = []
            for csv_row in reader:
                if csv_row.get("Success", "false").lower() == "true":
                    row_results.append((True, csv_row.get("Id")))
                else:
                    row_results.append((False, csv_row.get("Error", "Unknown Bulk error")))

            if len(row_results) != len(batch_rows):
                # Never let the result count silently drift from what we
                # submitted -- pad/truncate so every input row gets exactly
                # one accounted outcome, and log it so it's visible instead
                # of just quietly under-reporting.
                await send_log(
                    f"[Bulk {object_name}] Batch {b_id} returned {len(row_results)} result row(s) for "
                    f"{len(batch_rows)} submitted record(s) -- treating the difference as failed instead "
                    f"of dropping it silently."
                )
                if len(row_results) < len(batch_rows):
                    row_results += [(False, "No result row returned for this record")] * (len(batch_rows) - len(row_results))
                else:
                    row_results = row_results[:len(batch_rows)]

            for idx, res in zip(batch_indices, row_results):
                results_by_index[idx] = res

        for idx, row, _blob in oversized:
            results_by_index[idx] = ("__OVERSIZED__", row)

        return [results_by_index[i] for i in range(len(rows_with_blobs))]

    async def upload_attachments_bulk(self, client, creds, user_id, items: List[dict], send_log):
        rows_with_blobs = [
            ({"ParentId": it["ParentId"], "Name": it["Name"], "ContentType": it.get("ContentType") or "application/octet-stream"}, it["Body"])
            for it in items
        ]
        return await self._bulk_zip_insert(client, creds, user_id, "Attachment", "Body",
                                            ["ParentId", "Name", "ContentType", "Body"], rows_with_blobs, send_log)

    async def upload_files_bulk(self, client, creds, user_id, items: List[dict], send_log):
        rows_with_blobs = [
            ({"Title": it["Title"], "PathOnClient": it["PathOnClient"], "FirstPublishLocationId": it["FirstPublishLocationId"]}, it["VersionData"])
            for it in items
        ]
        return await self._bulk_zip_insert(client, creds, user_id, "ContentVersion", "VersionData",
                                            ["Title", "PathOnClient", "FirstPublishLocationId", "VersionData"], rows_with_blobs, send_log)

    # ==========================================
    # ORCHESTRATION 
    # ==========================================
    async def migrate_files_for_batch(
        self, client, source_creds, target_creds, user_id: str, id_map: dict,
        migrate_attachments: bool, migrate_files: bool, send_log, concurrency: int = 6,
        strategy: FileMigrationStrategy = FileMigrationStrategy.BULK_ZIP,
        checkpoint: Optional[FileMigrationCheckpoint] = None,
    ):
        checkpoint = checkpoint or FileMigrationCheckpoint()
        old_ids = list(id_map.keys())
        results = {
            "attachments": {"success": 0, "error": 0, "skipped": 0, "errors": []},
            "files": {"success": 0, "error": 0, "skipped": 0, "errors": []},
            "apiLimitReached": False,
        }
        semaphore = asyncio.Semaphore(concurrency)

        if not old_ids:
            return results

        try:
            if migrate_attachments:
                await self._migrate_attachments(
                    client, source_creds, target_creds, user_id, id_map, old_ids,
                    send_log, semaphore, strategy, checkpoint, results,
                )
            if migrate_files:
                await self._migrate_content_files(
                    client, source_creds, target_creds, user_id, id_map, old_ids,
                    send_log, semaphore, strategy, checkpoint, results,
                )
        except ApiLimitNearExhaustionError as e:
            await send_log(
                f"[Files] Stopping: Salesforce daily API usage reached {e.used}/{e.limit}. "
                f"Progress so far is checkpointed -- re-run later (next 24h window) to resume "
                f"the remaining files."
            )
            results["apiLimitReached"] = True

        return results

    async def _migrate_attachments(
        self, client, source_creds, target_creds, user_id, id_map, old_ids,
        send_log, semaphore, strategy, checkpoint: FileMigrationCheckpoint, results,
    ):
        attachments = await self.extract_attachments(client, source_creds, user_id, old_ids, send_log)
        attachments = [a for a in attachments if a["Id"] not in checkpoint.migrated_attachment_ids]
        if not attachments:
            return

        await send_log(f"[Attachments] Migrating {len(attachments)} legacy attachments (strategy={strategy.value})...")

        downloaded: List[dict] = []

        async def download_one(att):
            async with semaphore:
                new_parent = id_map.get(att["ParentId"])
                if not new_parent:
                    results["attachments"]["skipped"] += 1
                    await send_log(
                        f"[Attachments] Skipped '{att.get('Name')}' (Attachment {att['Id']}): "
                        f"parent {att['ParentId']} is outside this migration batch."
                    )
                    return
                try:
                    blob = await self.download_body(client, source_creds, user_id, att["Id"], "attachment", send_log)
                    downloaded.append({
                        "SourceId": att["Id"], "ParentId": new_parent,
                        "Name": att.get("Name", "attachment"), "ContentType": att.get("ContentType"), "Body": blob,
                    })
                except ApiLimitNearExhaustionError:
                    raise
                except Exception as e:
                    results["attachments"]["error"] += 1
                    results["attachments"]["errors"].append({"name": att.get("Name"), "parentId": att["ParentId"], "error": str(e)})

        await asyncio.gather(*[download_one(a) for a in attachments])

        if strategy == FileMigrationStrategy.REST:
            await self._upload_attachments_rest(client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results)
        else:
            await self._upload_attachments_bulk_with_fallback(client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results)

        await send_log(
            f"[Attachments] Done: {results['attachments']['success']} succeeded, "
            f"{results['attachments']['error']} failed, {results['attachments']['skipped']} skipped."
        )

    async def _upload_attachments_rest(self, client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results):
        async def upload_one(item):
            async with semaphore:
                ok, info = await self.upload_attachment(
                    client, target_creds, user_id, item["ParentId"], item["Name"], item["ContentType"], item["Body"], send_log
                )
                if ok:
                    results["attachments"]["success"] += 1
                    await checkpoint.mark("attachment", item["SourceId"])
                else:
                    results["attachments"]["error"] += 1
                    results["attachments"]["errors"].append({"name": item["Name"], "parentId": item["ParentId"], "error": info})

        await asyncio.gather(*[upload_one(d) for d in downloaded])

    async def _upload_attachments_bulk_with_fallback(self, client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results):
        if not downloaded:
            return

        bulk_results = await self.upload_attachments_bulk(client, target_creds, user_id, downloaded, send_log)

        rest_fallback = []
        for item, (ok, info) in zip(downloaded, bulk_results):
            if ok is True:
                results["attachments"]["success"] += 1
                asyncio.ensure_future(checkpoint.mark("attachment", item["SourceId"]))
            elif ok == "__OVERSIZED__":
                rest_fallback.append(item)
            else:
                results["attachments"]["error"] += 1
                results["attachments"]["errors"].append({"name": item["Name"], "parentId": item["ParentId"], "error": info})

        if rest_fallback:
            await send_log(f"[Attachments] Falling back to REST for {len(rest_fallback)} oversized attachment(s).")
            await self._upload_attachments_rest(client, target_creds, user_id, rest_fallback, send_log, semaphore, checkpoint, results)

    async def _migrate_content_files(
        self, client, source_creds, target_creds, user_id, id_map, old_ids,
        send_log, semaphore, strategy, checkpoint: FileMigrationCheckpoint, results,
    ):
        files = await self.extract_files(client, source_creds, user_id, old_ids, send_log)
        files = [f for f in files if f["ContentVersionId"] not in checkpoint.migrated_content_version_ids]
        if not files:
            return

        await send_log(f"[Files] Migrating {len(files)} modern Files (strategy={strategy.value})...")

        downloaded: List[dict] = []

        async def download_one(f):
            async with semaphore:
                new_parent = id_map.get(f["ParentId"])
                if not new_parent:
                    # A ContentDocument can be linked (via ContentDocumentLink) to
                    # more than just the records we're migrating -- e.g. also
                    # shared to a User, a Chatter post, or another record outside
                    # this batch. That link row's ParentId won't be in id_map.
                    # Previously this was silently dropped with no trace, which is
                    # why "Found N files" and "Done: X/Y" could disagree.
                    results["files"]["skipped"] += 1
                    await send_log(
                        f"[Files] Skipped '{f.get('Name')}' (ContentVersion {f['ContentVersionId']}): "
                        f"linked to source record {f['ParentId']}, which is outside this migration batch."
                    )
                    return
                try:
                    blob = await self.download_body(client, source_creds, user_id, f["ContentVersionId"], "file", send_log)
                    downloaded.append({
                        "SourceId": f["ContentVersionId"], "ParentId": new_parent,
                        "Name": f.get("Name", "file"), "VersionData": blob,
                    })
                except ApiLimitNearExhaustionError:
                    raise
                except Exception as e:
                    results["files"]["error"] += 1
                    results["files"]["errors"].append({"name": f.get("Name"), "parentId": f["ParentId"], "error": str(e)})

        await asyncio.gather(*[download_one(f) for f in files])

        if strategy == FileMigrationStrategy.REST:
            await self._upload_files_rest(client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results)
        else:
            await self._upload_files_bulk_with_fallback(client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results)

        await send_log(
            f"[Files] Done: {results['files']['success']} succeeded, "
            f"{results['files']['error']} failed, {results['files']['skipped']} skipped."
        )

    async def _upload_files_rest(self, client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results):
        async def upload_one(item):
            async with semaphore:
                ok, info = await self.upload_file(client, target_creds, user_id, item["ParentId"], item["Name"], item["VersionData"], send_log)
                if ok:
                    results["files"]["success"] += 1
                    await checkpoint.mark("file", item["SourceId"])
                else:
                    results["files"]["error"] += 1
                    results["files"]["errors"].append({"name": item["Name"], "parentId": item["ParentId"], "error": info})

        await asyncio.gather(*[upload_one(d) for d in downloaded])

    async def _upload_files_bulk_with_fallback(self, client, target_creds, user_id, downloaded, send_log, semaphore, checkpoint, results):
        if not downloaded:
            return

        items = [{
            "Title": d["Name"], "PathOnClient": d["Name"],
            "FirstPublishLocationId": d["ParentId"], "VersionData": d["VersionData"],
        } for d in downloaded]

        bulk_results = await self.upload_files_bulk(client, target_creds, user_id, items, send_log)

        rest_fallback = []
        for item, (ok, info) in zip(downloaded, bulk_results):
            if ok is True:
                results["files"]["success"] += 1
                asyncio.ensure_future(checkpoint.mark("file", item["SourceId"]))
            elif ok == "__OVERSIZED__":
                rest_fallback.append(item)
            else:
                results["files"]["error"] += 1
                results["files"]["errors"].append({"name": item["Name"], "parentId": item["ParentId"], "error": info})

        if rest_fallback:
            await send_log(f"[Files] Falling back to REST for {len(rest_fallback)} oversized file(s).")
            await self._upload_files_rest(client, target_creds, user_id, rest_fallback, send_log, semaphore, checkpoint, results)