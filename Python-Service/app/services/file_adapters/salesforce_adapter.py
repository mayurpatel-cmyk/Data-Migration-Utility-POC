import math
import re
import urllib.parse
from typing import List, Tuple

from app.services.crm_service import CrmService
from app.services.file_adapters.base import FileAdapter, FileTypeEstimate, OrgBudget, SourceFile
from app.services.migrators.salesforce_file_migrator import SalesforceFileMigrator
from app.services.time_filter_service import merge_time_clause, build_salesforce_time_clause, TimeFilterError

API_VERSION = "v60.0"
CHUNK = 200
BULK_BATCH_OVERHEAD_CALLS = 5
_SF_ID = re.compile(r"^[a-zA-Z0-9]{15,18}$")


def _in_list(ids: List[str]) -> str:
    return ",".join(f"'{i}'" for i in ids if _SF_ID.match(str(i)))


class SalesforceFileAdapter(FileAdapter):
    crm = "salesforce"
    sample_size = 2000
    max_concurrency = 6

    def __init__(self):
        self.m = SalesforceFileMigrator()

    # ------------------------------------------------------------------ http
    async def _get_json(self, client, url, creds, user_id, role):
        headers = {"Authorization": f"Bearer {creds.get('access_token')}"}
        res = await client.get(url, headers=headers)
        if res.status_code == 401:
            creds["access_token"] = await CrmService.refresh_crm_token(user_id, "salesforce", role)
            headers["Authorization"] = f"Bearer {creds['access_token']}"
            res = await client.get(url, headers=headers)
        res.raise_for_status()
        return res.json()

    async def _query_all(self, client, creds, user_id, role, soql) -> List[dict]:
        instance = creds.get("instance_url", "").rstrip("/")
        url = f"{instance}/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}"
        records: List[dict] = []
        while url:
            data = await self._get_json(client, url, creds, user_id, role)
            records.extend(data.get("records", []))
            nxt = data.get("nextRecordsUrl")
            url = f"{instance}{nxt}" if nxt and not data.get("done") else None
        return records

    # --------------------------------------------------------------- source
    async def fetch_record_ids(self, client, creds, user_id, obj_name, query, time_filter, send_log) -> List[str]:
        clean = (query or "").strip()
        try:
            time_clause = build_salesforce_time_clause(time_filter)
        except TimeFilterError as e:
            await send_log(f"[{obj_name}] Invalid migration filter for budget pre-check: {e}")
            raise

        if clean.lower().startswith("select "):
            soql = merge_time_clause(clean, time_clause, where_kw="WHERE", and_kw="AND") if time_clause else clean
            soql = re.sub(r"(?is)^select\s+.+?\s+from", "SELECT Id FROM", soql, count=1)
        else:
            parts = ([f"({clean})"] if clean else []) + ([time_clause] if time_clause else [])
            soql = f"SELECT Id FROM {obj_name}" + (f" WHERE {' AND '.join(parts)}" if parts else "")

        return [r["Id"] for r in await self._query_all(client, creds, user_id, "source", soql)]

    async def count_files(self, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        total_count, total_bytes = 0, 0

        if kind == "attachments":
            for i in range(0, len(parent_ids), CHUNK):
                ids = _in_list(parent_ids[i:i + CHUNK])
                if not ids:
                    continue
                rows = await self._query_all(
                    client, creds, user_id, "source",
                    f"SELECT COUNT(Id) cnt, SUM(BodyLength) totalBytes FROM Attachment WHERE ParentId IN ({ids})")
                rec = (rows or [{}])[0]
                total_count += rec.get("cnt", 0) or 0
                total_bytes += rec.get("totalBytes", 0) or 0
        else:
            doc_ids: List[str] = []
            for i in range(0, len(parent_ids), CHUNK):
                ids = _in_list(parent_ids[i:i + CHUNK])
                if not ids:
                    continue
                rows = await self._query_all(
                    client, creds, user_id, "source",
                    f"SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN ({ids})")
                doc_ids.extend(r["ContentDocumentId"] for r in rows)
            for i in range(0, len(doc_ids), CHUNK):
                ids = _in_list(doc_ids[i:i + CHUNK])
                if not ids:
                    continue
                rows = await self._query_all(
                    client, creds, user_id, "source",
                    "SELECT COUNT(Id) cnt, SUM(ContentSize) totalBytes FROM ContentVersion "
                    f"WHERE ContentDocumentId IN ({ids}) AND IsLatest = true")
                rec = (rows or [{}])[0]
                total_count += rec.get("cnt", 0) or 0
                total_bytes += rec.get("totalBytes", 0) or 0

        return FileTypeEstimate(file_count=total_count, total_bytes=total_bytes,
                                avg_bytes=(total_bytes / total_count) if total_count else 0.0)

    async def list_files(self, client, creds, user_id, parent_ids, source_object,
                         migrate_attachments, migrate_files, send_log) -> List[SourceFile]:
        out: List[SourceFile] = []
        if migrate_attachments:
            for a in await self.m.extract_attachments(client, creds, user_id, parent_ids, send_log):
                out.append(SourceFile(a["Id"], a["ParentId"], a.get("Name") or "attachment",
                                      int(a.get("BodyLength") or 0), "attachment", a.get("ContentType")))
        if migrate_files:
            for f in await self.m.extract_files(client, creds, user_id, parent_ids, send_log):
                out.append(SourceFile(f["ContentVersionId"], f["ParentId"], f.get("Name") or "file",
                                      int(f.get("ContentSize") or 0), "file"))
        return out

    async def download_to_disk(self, client, creds, user_id, f: SourceFile, staging_dir, send_log) -> Tuple[str, int]:
        fn = (self.m.download_body_to_disk_streamed if f.size > self.m.MAX_INLINE_BYTES
              else self.m.download_body_to_disk)
        return await fn(client, creds, user_id, f.source_id, f.kind, staging_dir, send_log)

    # --------------------------------------------------------------- target
    async def upload(self, client, creds, user_id, target_object, new_parent_id, f: SourceFile, path, send_log):
        """Cross-CRM files always land as modern Salesforce Files (ContentVersion)
        linked to the parent -- legacy Attachment is deprecated for new data."""
        if f.size > self.m.MAX_INLINE_BYTES:
            return await self.m.upload_file_multipart(client, creds, user_id, new_parent_id, f.name, path, f.size, send_log)
        with open(path, "rb") as fh:
            blob = fh.read()
        return await self.m.upload_file(client, creds, user_id, new_parent_id, f.name, blob, send_log)

    # --------------------------------------------------------------- budget
    async def get_budget(self, client, creds, user_id, role, send_log, safety_threshold, other_reserved) -> OrgBudget:
        instance = creds.get("instance_url", "").rstrip("/")
        data = await self._get_json(client, f"{instance}/services/data/{API_VERSION}/limits", creds, user_id, role)
        daily = data.get("DailyApiRequests", {})
        used, limit = daily.get("Used", 0), daily.get("Max", 0)
        remaining = max(limit - used, 0)
        available = max(int(remaining * safety_threshold) - other_reserved, 0)
        return OrgBudget(role, limit, used, remaining, available)

    def source_calls(self, total_records, total_files) -> int:
        return total_files  # SOQL listing is aggregated; 1 REST download per file

    def target_calls(self, total_files, total_bytes, strategy) -> int:
        if strategy != "bulk_zip":
            return total_files  # 1 REST upload per file
        by_bytes = math.ceil(total_bytes / self.m.MAX_BULK_BATCH_BYTES) if total_bytes else 0
        by_rows = math.ceil(total_files / self.m.MAX_BULK_BATCH_ROWS) if total_files else 0
        return max(by_bytes, by_rows, 1 if total_files else 0) * BULK_BATCH_OVERHEAD_CALLS