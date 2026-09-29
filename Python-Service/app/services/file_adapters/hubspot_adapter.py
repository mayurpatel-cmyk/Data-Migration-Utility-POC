"""
HubSpot file adapter.

HubSpot has a single file concept (Files API v3). A file "belongs" to a CRM
record only through an engagement (Note) whose `hs_attachment_ids` references the
file and which is associated with the record. This adapter therefore:

  SOURCE  record ids -> associated Notes (v4 batch associations) -> Notes'
          `hs_attachment_ids` (v3 batch read) -> file metadata (Files search)
          -> signed URL -> stream to disk
  TARGET  upload to Files API (per-record folder) -> create Note carrying the
          file id -> associate the Note with the migrated record
"""
import asyncio
import json
import math
import mimetypes
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Tuple

from app.services.crm_service import CrmService
from app.services.file_adapters.base import FileAdapter, FileTypeEstimate, OrgBudget, SourceFile
from app.services.file_adapters.zoho_adapter import CrmRateLimitError
from app.services.migrators.hubspot_migrator import _merge_hubspot_time_filters
from app.services.time_filter_service import build_hubspot_time_filters, TimeFilterError

UNVERIFIED_BUDGET = 10_000_000
_SINGULAR_TO_OBJECT = {
    "contact": "contacts", "company": "companies", "deal": "deals", "ticket": "tickets",
}
# HUBSPOT_DEFINED association type ids for Note -> <object>. Any other object
# (custom objects, products, ...) falls back to the v4 "default association" endpoint.
_NOTE_ASSOC_TYPE_IDS = {"contacts": 202, "companies": 190, "deals": 214, "tickets": 228}
_ID_CHUNK_ASSOC = 1000     # v4 associations batch-read limit
_ID_CHUNK_BATCH = 100      # v3 objects batch-read / Files search limit
_SEARCH_MAX_RESULTS = 10_000


def normalize_hubspot_object(name: str) -> str:
    """API name of an object. Maps common singular labels; custom objects
    (`p123_thing` / `2-12345` objectTypeId) pass through untouched."""
    n = (name or "").strip()
    return _SINGULAR_TO_OBJECT.get(n.lower(), n if re.match(r"^\d+-\d+$", n) else n.lower())


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


class HubspotFileAdapter(FileAdapter):
    crm = "hubspot"
    sample_size = 2000              # listing is batched (1000 assoc / 100 notes per call), so sampling is cheap
    max_concurrency = 5             # stays well inside HubSpot's 10-second burst window
    files_are_attachments = True    # one file type: UI "Files" == "Attachments"
    requires_object_names = True    # association + folder path need the object names


    ENGAGEMENT_OBJECTS: Tuple[str, ...] = ("notes", "emails", "calls", "meetings", "tasks")

    MAX_UPLOAD_BYTES = 300 * 1024 * 1024   # Files API per-file upload limit
    MAX_RETRIES = 5
    # Files API read/write, plus hidden files (attachments added to Notes are stored as hidden files).
    REQUIRED_SCOPES = ("files.read", "files.write", "files.ui_hidden.read")
    UPLOAD_ROOT_FOLDER = "/crm-migration"
    CALLS_PER_UPLOAD = 3                   # file upload + note create + association (worst case)

    # ------------------------------------------------------------------ http
    @staticmethod
    def _domain(creds: dict) -> str:
        d = (creds.get("api_domain") or "https://api.hubapi.com").rstrip("/")
        return d if d.startswith("http") else f"https://{d}"

    @staticmethod
    def _is_daily_limit(res) -> bool:
        try:
            return (res.json() or {}).get("policyName") == "DAILY"
        except Exception:
            return False

    def _scope_error_message(self, role: str, res) -> str:
        """Names the exact scopes HubSpot says are missing (falls back to REQUIRED_SCOPES)."""
        missing: List[str] = []
        try:
            for err in (res.json() or {}).get("errors", []):
                ctx = err.get("context") or {}
                for key in ("requiredGranularScopes", "requiredScopes"):
                    missing.extend(ctx.get(key) or [])
        except Exception:
            pass
        scopes = ", ".join(dict.fromkeys(missing)) or ", ".join(self.REQUIRED_SCOPES)
        return (f"HubSpot {role} connection is missing OAuth scope(s): {scopes}. Add them to the HubSpot app "
                f"AND to the scopes requested by your OAuth authorize URL, then disconnect and reconnect "
                f"the {role} HubSpot account.")

    async def _call(self, role, creds, user_id, send_log, make_call):
        """make_call(headers) -> httpx.Response. One silent token refresh, Retry-After
        backoff on 429, and an immediate stop when the DAILY quota is exhausted
        (retrying can't help; progress is checkpointed for a later resume)."""
        refreshed = False
        for attempt in range(self.MAX_RETRIES + 1):
            headers = {"Authorization": f"Bearer {creds.get('access_token')}"}
            res = await make_call(headers)
            if res.status_code == 401 and not refreshed:
                await send_log(f"[Files] HubSpot {role} session expired. Refreshing token...")
                creds["access_token"] = await CrmService.refresh_crm_token(user_id, "hubspot", role)
                refreshed = True
                continue
            if res.status_code == 429:
                if self._is_daily_limit(res):
                    raise CrmRateLimitError("hubspot", f"HubSpot {role} daily API limit reached.")
                try:
                    wait = int(res.headers.get("Retry-After") or 0)
                except ValueError:
                    wait = 0
                wait = min(wait or 2 ** (attempt + 1), 60)
                await send_log(f"[Files] HubSpot {role} rate limit hit. Pausing {wait}s...")
                await asyncio.sleep(wait)
                continue
            if res.status_code == 403 and "scope" in res.text.lower():
                raise RuntimeError(self._scope_error_message(role, res))
            return res
        raise CrmRateLimitError("hubspot", f"HubSpot {role} API kept returning 429 after {self.MAX_RETRIES} retries.")

    # --------------------------------------------------------------- source
    async def fetch_record_ids(self, client, creds, user_id, obj_name, query, time_filter, send_log) -> List[str]:
        try:
            time_filters = build_hubspot_time_filters(time_filter)
        except TimeFilterError as e:
            await send_log(f"[{obj_name}] Invalid migration filter for budget pre-check: {e}")
            raise

        obj = normalize_hubspot_object(obj_name)
        url = f"{self._domain(creds)}/crm/v3/objects/{obj}/search"
        payload: Dict = {"limit": 100, "properties": ["hs_object_id"]}

        if (query or "").strip():
            try:
                q = json.loads(query)
                if "filterGroups" in q:
                    payload["filterGroups"] = q["filterGroups"]
            except json.JSONDecodeError:
                await send_log("[HubSpot Files] Invalid query format for budget pre-check. Ignoring.")
        if time_filters:
            payload["filterGroups"] = _merge_hubspot_time_filters(payload.get("filterGroups"), time_filters)

        ids: List[str] = []
        while True:
            res = await self._call("source", creds, user_id, send_log,
                                   lambda h: client.post(url, headers=h, json=payload))
            if res.status_code != 200:
                raise RuntimeError(f"HubSpot search failed ({res.status_code}): {res.text[:300]}")
            body = res.json()
            ids.extend(str(r["id"]) for r in body.get("results", []) if r.get("id"))
            after = (body.get("paging") or {}).get("next", {}).get("after")
            if not after or not body.get("results"):
                break
            if len(ids) >= _SEARCH_MAX_RESULTS:
                await send_log(f"[HubSpot Files] Search API caps results at {_SEARCH_MAX_RESULTS:,}; pre-check is truncated.")
                break
            payload["after"] = after
        return ids

    async def _gather_files(self, client, creds, user_id, parent_ids, source_object, send_log):
        """Returns (object_name, [(parent_id, engagement_id, file_meta)])."""
        obj = normalize_hubspot_object(source_object)
        base = self._domain(creds)
        sem = asyncio.Semaphore(self.max_concurrency)
        parent_ids = [str(p) for p in parent_ids]
        rows: List[Tuple[str, str, dict]] = []
        seen: set = set()   # (parent_id, file_id): same file can hang off several engagements

        for eng in self.ENGAGEMENT_OBJECTS:
            optional = eng != "notes"
            skipped_reason: List[str] = []

            async def guarded(role_call):
                """Runs an HTTP step; for optional engagement types converts access errors into a skip."""
                try:
                    res = await role_call()
                except RuntimeError as e:
                    if not optional:
                        raise
                    skipped_reason.append(str(e)[:200])
                    return None
                if optional and res.status_code in (400, 403, 404):
                    skipped_reason.append(f"HTTP {res.status_code}: {res.text[:150]}")
                    return None
                return res

            # 1) record -> engagement associations
            eng_to_parents: Dict[str, List[str]] = {}

            async def assoc_chunk(chunk):
                async with sem:
                    res = await guarded(lambda: self._call("source", creds, user_id, send_log, lambda h: client.post(
                        f"{base}/crm/v4/associations/{obj}/{eng}/batch/read", headers=h,
                        json={"inputs": [{"id": p} for p in chunk]})))
                    if res is None:
                        return
                    if res.status_code not in (200, 207):
                        raise RuntimeError(f"HubSpot association read failed ({res.status_code}): {res.text[:300]}")
                    for r in res.json().get("results", []):
                        pid = str((r.get("from") or {}).get("id"))
                        for t in r.get("to", []):
                            eng_to_parents.setdefault(str(t["toObjectId"]), []).append(pid)

            await asyncio.gather(*[assoc_chunk(c) for c in _chunks(parent_ids, _ID_CHUNK_ASSOC)])
            if skipped_reason:
                await send_log(f"[HubSpot Files] Skipping {eng}: {skipped_reason[0]}")
                continue
            await send_log(f"[HubSpot Files] {len(eng_to_parents)} {eng[:-1]}(s) associated with "
                           f"{len(parent_ids)} {obj} record(s).")
            if not eng_to_parents:
                continue

            # 2) engagement -> attachment file ids
            eng_to_files: Dict[str, List[str]] = {}

            async def eng_chunk(chunk):
                async with sem:
                    res = await guarded(lambda: self._call("source", creds, user_id, send_log, lambda h: client.post(
                        f"{base}/crm/v3/objects/{eng}/batch/read", headers=h,
                        json={"properties": ["hs_attachment_ids"], "inputs": [{"id": e} for e in chunk]})))
                    if res is None:
                        return
                    if res.status_code not in (200, 207):
                        raise RuntimeError(f"HubSpot {eng} read failed ({res.status_code}): {res.text[:300]}")
                    for r in res.json().get("results", []):
                        raw = (r.get("properties") or {}).get("hs_attachment_ids") or ""
                        fids = [x.strip() for x in raw.split(";") if x.strip()]
                        if fids:
                            eng_to_files[str(r["id"])] = fids

            await asyncio.gather(*[eng_chunk(c) for c in _chunks(list(eng_to_parents), _ID_CHUNK_BATCH)])
            if skipped_reason:
                await send_log(f"[HubSpot Files] Skipping {eng}: {skipped_reason[0]}")
                continue

            # 3) file ids -> file metadata
            all_fids = sorted({f for fids in eng_to_files.values() for f in fids})
            await send_log(f"[HubSpot Files] {len(eng_to_files)} {eng[:-1]}(s) carry attachments "
                           f"({len(all_fids)} distinct file id(s)).")
            meta: Dict[str, dict] = {}

            async def meta_chunk(chunk):
                async with sem:
                    res = await self._call("source", creds, user_id, send_log, lambda h: client.get(
                        f"{base}/files/v3/files/search", headers=h,
                        params={"ids": chunk, "limit": _ID_CHUNK_BATCH}))
                    if res.status_code != 200:
                        raise RuntimeError(f"HubSpot file lookup failed ({res.status_code}): {res.text[:300]}")
                    for m in res.json().get("results", []):
                        meta[str(m["id"])] = m

            await asyncio.gather(*[meta_chunk(c) for c in _chunks(all_fids, _ID_CHUNK_BATCH)])

            missing = [f for f in all_fids if f not in meta]
            if missing:
                await send_log(f"[HubSpot Files] Search returned {len(all_fids) - len(missing)}/{len(all_fids)} "
                               f"file(s); resolving {len(missing)} hidden/unlisted file(s) by id...")

                async def meta_one(fid):
                    async with sem:
                        res = await self._call("source", creds, user_id, send_log, lambda h: client.get(
                            f"{base}/files/v3/files/{fid}", headers=h))
                        if res.status_code == 200:
                            meta[fid] = res.json()
                        elif res.status_code != 404:   # 404 == genuinely deleted
                            raise RuntimeError(f"HubSpot file {fid} lookup failed ({res.status_code}): {res.text[:300]}")

                await asyncio.gather(*[meta_one(f) for f in missing])
                gone = [f for f in all_fids if f not in meta]
                if gone:
                    await send_log(f"[HubSpot Files] {len(gone)} attachment file(s) no longer exist in HubSpot: {gone[:5]}")

            for eng_id, fids in eng_to_files.items():
                for fid in fids:
                    if fid not in meta:
                        continue
                    for pid in eng_to_parents[eng_id]:
                        if (pid, fid) in seen:
                            continue
                        seen.add((pid, fid))
                        rows.append((pid, eng_id, meta[fid]))
        return obj, rows

    @staticmethod
    def _full_name(meta: dict) -> str:
        name, ext = meta.get("name") or "attachment", meta.get("extension") or ""
        return name if not ext or name.lower().endswith(f".{ext.lower()}") else f"{name}.{ext}"

    async def count_files(self, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        if kind == "files":  # single file type
            return FileTypeEstimate()
        _, rows = await self._gather_files(client, creds, user_id, parent_ids, source_object, send_log)
        total_bytes = sum(int(m.get("size") or 0) for _, _, m in rows)
        n = len(rows)
        return FileTypeEstimate(file_count=n, total_bytes=total_bytes, avg_bytes=(total_bytes / n) if n else 0.0)

    async def list_files(self, client, creds, user_id, parent_ids, source_object,
                         migrate_attachments, migrate_files, send_log) -> List[SourceFile]:
        if not (migrate_attachments or migrate_files):
            return []
        obj, rows = await self._gather_files(client, creds, user_id, parent_ids, source_object, send_log)
        files = []
        for pid, eng_id, m in rows:
            name = self._full_name(m)
            fid = str(m["id"])
            files.append(SourceFile(
                # composite: the same HubSpot file can hang off several records
                source_id=f"{pid}:{fid}", parent_id=pid, name=name,
                size=int(m.get("size") or 0), kind="attachment",
                content_type=mimetypes.guess_type(name)[0], meta={"file_id": fid, "object": obj},
            ))
        await send_log(f"[Attachments] Found {len(files)} HubSpot file(s) across {len(parent_ids)} record(s).")
        return files

    async def download_to_disk(self, client, creds, user_id, f: SourceFile, staging_dir, send_log) -> Tuple[str, int]:
        base = self._domain(creds)
        res = await self._call("source", creds, user_id, send_log, lambda h: client.get(
            f"{base}/files/v3/files/{f.meta['file_id']}/signed-url", headers=h))
        if res.status_code != 200:
            raise RuntimeError(f"HubSpot signed-url failed ({res.status_code}): {res.text[:300]}")
        signed = res.json().get("url")
        if not signed:
            raise RuntimeError(f"HubSpot returned no download URL for file {f.meta['file_id']}.")

        path = os.path.join(staging_dir, f"hubspot_{f.meta['file_id']}_{uuid.uuid4().hex[:8]}.bin")
        async with client.stream("GET", signed, follow_redirects=True) as dl:   # pre-signed: no auth header
            if dl.status_code != 200:
                body = (await dl.aread()).decode(errors="replace")[:300]
                raise RuntimeError(f"HubSpot download failed ({dl.status_code}): {body}")
            written = 0
            with open(path, "wb") as fh:
                async for chunk in dl.aiter_bytes(chunk_size=1024 * 1024):
                    fh.write(chunk)
                    written += len(chunk)
        return path, written

    # --------------------------------------------------------------- target
    async def _delete_quietly(self, client, creds, user_id, send_log, url):
        try:
            await self._call("target", creds, user_id, send_log, lambda h: client.delete(url, headers=h))
        except Exception:
            pass

    async def upload(self, client, creds, user_id, target_object, new_parent_id, f: SourceFile, path, send_log):
        if f.size > self.MAX_UPLOAD_BYTES:
            msg = f"'{f.name}' is {f.size / 1e6:.1f}MB, over HubSpot's {self.MAX_UPLOAD_BYTES / 1e6:.0f}MB file limit."
            await send_log(f"[File SKIPPED] {msg}")
            return False, msg

        base = self._domain(creds)
        obj = normalize_hubspot_object(target_object)
        ctype = f.content_type or mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        options = json.dumps({
            "access": "PRIVATE", "overwrite": False,
            "duplicateValidationStrategy": "NONE", "duplicateValidationScope": "EXACT_FOLDER",
        })
        folder = f"{self.UPLOAD_ROOT_FOLDER}/{obj}/{new_parent_id}"   # per-record folder avoids name collisions

        # 1) upload the file
        async def upload_call(headers):
            with open(path, "rb") as fh:
                return await client.post(f"{base}/files/v3/files", headers=headers,
                                         files={"file": (f.name, fh, ctype)},
                                         data={"folderPath": folder, "options": options})

        res = await self._call("target", creds, user_id, send_log, upload_call)
        if res.status_code not in (200, 201):
            return False, f"File upload failed ({res.status_code}): {res.text[:500]}"
        file_id = str(res.json().get("id") or "")
        if not file_id:
            return False, "File upload succeeded but HubSpot returned no file id."
        file_url = f"{base}/files/v3/files/{file_id}"

        # 2) note carrying the file (inline association for standard objects)
        note_body: Dict = {"properties": {
            "hs_timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "hs_note_body": f"Migrated attachment: {f.name}",
            "hs_attachment_ids": file_id,
        }}
        assoc_type = _NOTE_ASSOC_TYPE_IDS.get(obj)
        if assoc_type:
            note_body["associations"] = [{
                "to": {"id": new_parent_id},
                "types": [{"associationCategory": "HUBSPOT_DEFINED", "associationTypeId": assoc_type}],
            }]
        res = await self._call("target", creds, user_id, send_log, lambda h: client.post(
            f"{base}/crm/v3/objects/notes", headers=h, json=note_body))
        if res.status_code not in (200, 201):
            await self._delete_quietly(client, creds, user_id, send_log, file_url)
            return False, f"Note creation failed ({res.status_code}): {res.text[:500]}"
        note_id = str(res.json().get("id") or "")

        # 3) generic association for custom / non-standard objects
        if not assoc_type:
            res = await self._call("target", creds, user_id, send_log, lambda h: client.put(
                f"{base}/crm/v4/objects/notes/{note_id}/associations/default/{obj}/{new_parent_id}", headers=h))
            if res.status_code not in (200, 201):
                await self._delete_quietly(client, creds, user_id, send_log, f"{base}/crm/v3/objects/notes/{note_id}")
                await self._delete_quietly(client, creds, user_id, send_log, file_url)
                return False, f"Note association failed ({res.status_code}): {res.text[:500]}"
        return True, file_id

    # --------------------------------------------------------------- budget
    async def get_budget(self, client, creds, user_id, role, send_log, safety_threshold, other_reserved) -> OrgBudget:
        """Reads the daily quota from the API-usage endpoint (private apps). OAuth apps
        or missing scopes can't read it: falls back to HUBSPOT_DAILY_API_LIMIT, else
        reports the budget as unverified (run relies on 429 backoff + checkpoint/resume)."""
        limit = used = 0
        try:
            res = await self._call(role, creds, user_id, send_log, lambda h: client.get(
                f"{self._domain(creds)}/account-info/v3/api-usage/daily/private-apps", headers=h))
            if res.status_code == 200:
                row = (res.json().get("results") or [{}])[0]
                limit, used = int(row.get("usageLimit") or 0), int(row.get("currentUsage") or 0)
        except Exception:
            limit = used = 0

        if limit:
            remaining = max(limit - used, 0)
            return OrgBudget(role, limit, used, remaining,
                             max(int(remaining * safety_threshold) - other_reserved, 0))

        env_limit = int(os.getenv("HUBSPOT_DAILY_API_LIMIT", "0") or 0)
        if env_limit:
            return OrgBudget(role, env_limit, 0, env_limit,
                             max(int(env_limit * safety_threshold) - other_reserved, 0), verified=False)
        return OrgBudget(role, 0, 0, 0, UNVERIFIED_BUDGET, verified=False)

    def source_calls(self, total_records: int, total_files: int) -> int:
        assoc = math.ceil(total_records / _ID_CHUNK_ASSOC) * len(self.ENGAGEMENT_OBJECTS)
        engagement_reads = math.ceil(total_records / _ID_CHUNK_BATCH) * len(self.ENGAGEMENT_OBJECTS)  # ~1 engagement/record upper bound
        file_lookups = math.ceil(total_files / _ID_CHUNK_BATCH)
        return assoc + engagement_reads + file_lookups + total_files   # +1 signed-url per file

    def target_calls(self, total_files: int, total_bytes: int, strategy: str) -> int:
        return total_files * self.CALLS_PER_UPLOAD