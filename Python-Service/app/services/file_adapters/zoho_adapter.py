import asyncio
import mimetypes
import os
import uuid
from typing import List, Tuple

from app.services.crm_service import CrmService
from app.services.coql_query_builder import build_coql
from app.services.file_adapters.base import FileAdapter, FileTypeEstimate, OrgBudget, SourceFile
from app.services.migrators.salesforce_file_migrator import ApiLimitNearExhaustionError
from app.services.time_filter_service import build_zoho_time_clause, TimeFilterError

UNVERIFIED_BUDGET = 10_000_000
_SINGULAR_TO_MODULE = {"lead": "Leads", "contact": "Contacts", "account": "Accounts", "deal": "Deals"}


class CrmRateLimitError(ApiLimitNearExhaustionError):
    """Raised when a CRM keeps answering 429 after every retry. Reuses the
    'apiLimitReached' resume path (progress is checkpointed, re-run later)."""
    def __init__(self, crm: str, detail: str):
        Exception.__init__(self, detail)
        self.crm, self.used, self.limit = crm, 0, 0


def normalize_zoho_module(name: str) -> str:
    """API name of the module. Only maps the four common singular labels;
    custom modules are passed through untouched (blindly pluralizing them breaks them)."""
    n = (name or "").strip()
    return _SINGULAR_TO_MODULE.get(n.lower(), n)


class ZohoFileAdapter(FileAdapter):
    crm = "zoho"
    sample_size = 200            # listing is 1 API call PER RECORD in Zoho, so sample small
    max_concurrency = 5          # Zoho's per-org concurrent-request ceiling is low
    files_are_attachments = True

    MAX_UPLOAD_BYTES = 20 * 1024 * 1024   # Zoho attachment upload limit per file
    PAGE_SIZE = 200
    MAX_RETRIES = 5

    # ------------------------------------------------------------------ http
    @staticmethod
    def _domain(creds: dict) -> str:
        d = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip("/")
        return d if d.startswith("http") else f"https://{d}"

    async def _call(self, role, creds, user_id, send_log, make_call):
        """make_call(headers) -> httpx.Response. Handles one silent token refresh
        and exponential backoff on 429."""
        refreshed = False
        for attempt in range(self.MAX_RETRIES + 1):
            headers = {"Authorization": f"Zoho-oauthtoken {creds.get('access_token')}"}
            res = await make_call(headers)
            if res.status_code == 401 and not refreshed:
                await send_log(f"[Files] Zoho {role} session expired. Refreshing token...")
                creds["access_token"] = await CrmService.refresh_crm_token(user_id, "zoho", role)
                refreshed = True
                continue
            if res.status_code == 429:
                wait = min(5 * 2 ** attempt, 60)
                await send_log(f"[Files] Zoho {role} rate limit hit. Pausing {wait}s...")
                await asyncio.sleep(wait)
                continue
            return res
        raise CrmRateLimitError("zoho", f"Zoho {role} API kept returning 429 after {self.MAX_RETRIES} retries.")

    # --------------------------------------------------------------- source
    async def fetch_record_ids(self, client, creds, user_id, obj_name, query, time_filter, send_log) -> List[str]:
        try:
            time_clause = build_zoho_time_clause(time_filter)
        except TimeFilterError as e:
            await send_log(f"[{obj_name}] Invalid migration filter for budget pre-check: {e}")
            raise

        domain, ids, offset = self._domain(creds), [], 0
        while True:
            coql = build_coql(query, obj_name, ["id"], time_clause,
                              select_override="id", limit=self.PAGE_SIZE, offset=offset)
            res = await self._call("source", creds, user_id, send_log, lambda h: client.post(
                f"{domain}/crm/v6/coql", headers=h, json={"select_query": coql}))
            if res.status_code == 204:
                break
            if res.status_code != 200:
                raise RuntimeError(f"Zoho COQL Error: {res.text} | Query: {coql}")
            body = res.json()
            batch = body.get("data", [])
            ids.extend(str(r["id"]) for r in batch if r.get("id"))
            offset += len(batch)
            if not batch or not body.get("info", {}).get("more_records"):
                break
        return ids

    async def _list_record_attachments(self, client, creds, user_id, module, record_id, send_log) -> List[dict]:
        domain, out, page = self._domain(creds), [], 1
        while True:
            url = (f"{domain}/crm/v6/{module}/{record_id}/Attachments"
                   f"?fields=id,File_Name,Size,Created_Time&page={page}&per_page={self.PAGE_SIZE}")
            res = await self._call("source", creds, user_id, send_log, lambda h: client.get(url, headers=h))
            if res.status_code == 204:
                break
            if res.status_code != 200:
                raise RuntimeError(f"Zoho attachment list failed for {module}/{record_id} ({res.status_code}): {res.text[:300]}")
            body = res.json()
            out.extend(body.get("data", []))
            if not body.get("info", {}).get("more_records"):
                break
            page += 1
        return out

    async def _gather_attachments(self, client, creds, user_id, parent_ids, source_object, send_log):
        module = normalize_zoho_module(source_object)
        sem = asyncio.Semaphore(self.max_concurrency)
        results: List[Tuple[str, dict]] = []

        async def one(pid):
            async with sem:
                for a in await self._list_record_attachments(client, creds, user_id, module, pid, send_log):
                    results.append((pid, a))

        await asyncio.gather(*[one(p) for p in parent_ids])
        return module, results

    async def count_files(self, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        if kind == "files":  # Zoho has a single attachment type
            return FileTypeEstimate()
        _, rows = await self._gather_attachments(client, creds, user_id, parent_ids, source_object, send_log)
        total_bytes = sum(int(a.get("Size") or 0) for _, a in rows)
        n = len(rows)
        return FileTypeEstimate(file_count=n, total_bytes=total_bytes, avg_bytes=(total_bytes / n) if n else 0.0)

    async def list_files(self, client, creds, user_id, parent_ids, source_object,
                         migrate_attachments, migrate_files, send_log) -> List[SourceFile]:
        if not (migrate_attachments or migrate_files):
            return []
        module, rows = await self._gather_attachments(client, creds, user_id, parent_ids, source_object, send_log)
        files = []
        for pid, a in rows:
            name = a.get("File_Name") or "attachment"
            sf = SourceFile(
                source_id=str(a["id"]), parent_id=str(pid), name=name,
                size=int(a.get("Size") or 0), kind="attachment",
                content_type=mimetypes.guess_type(name)[0], meta={"module": module},
            )
            if a.get("$type") == "Link URL":
                sf.skip_reason = "link-type attachment (URL only, no file body)"
            files.append(sf)
        await send_log(f"[Attachments] Found {len(files)} Zoho attachment(s) across {len(parent_ids)} record(s).")
        return files

    async def download_to_disk(self, client, creds, user_id, f: SourceFile, staging_dir, send_log) -> Tuple[str, int]:
        url = f"{self._domain(creds)}/crm/v6/{f.meta['module']}/{f.parent_id}/Attachments/{f.source_id}"
        path = os.path.join(staging_dir, f"zoho_{f.source_id}_{uuid.uuid4().hex[:8]}.bin")
        refreshed = False

        for attempt in range(self.MAX_RETRIES + 1):
            need_refresh, wait = False, 0
            headers = {"Authorization": f"Zoho-oauthtoken {creds.get('access_token')}"}
            async with client.stream("GET", url, headers=headers) as res:
                if res.status_code == 401 and not refreshed:
                    need_refresh = True
                elif res.status_code == 429:
                    wait = min(5 * 2 ** attempt, 60)
                elif res.status_code != 200:
                    body = (await res.aread()).decode(errors="replace")[:300]
                    raise RuntimeError(f"Zoho download failed ({res.status_code}): {body}")
                else:
                    written = 0
                    with open(path, "wb") as fh:
                        async for chunk in res.aiter_bytes(chunk_size=1024 * 1024):
                            fh.write(chunk)
                            written += len(chunk)
                    return path, written

            if need_refresh:
                await send_log("[Files] Zoho source session expired mid-download. Refreshing token...")
                creds["access_token"] = await CrmService.refresh_crm_token(user_id, "zoho", "source")
                refreshed = True
            else:
                await send_log(f"[Files] Zoho source rate limit hit. Pausing {wait}s...")
                await asyncio.sleep(wait)

        raise CrmRateLimitError("zoho", "Zoho source API kept returning 429 during download.")

    # --------------------------------------------------------------- target
    async def upload(self, client, creds, user_id, target_object, new_parent_id, f: SourceFile, path, send_log):
        if f.size > self.MAX_UPLOAD_BYTES:
            msg = f"'{f.name}' is {f.size / 1e6:.1f}MB, over Zoho's {self.MAX_UPLOAD_BYTES / 1e6:.0f}MB attachment limit."
            await send_log(f"[File SKIPPED] {msg}")
            return False, msg

        url = f"{self._domain(creds)}/crm/v6/{normalize_zoho_module(target_object)}/{new_parent_id}/Attachments"
        ctype = f.content_type or mimetypes.guess_type(f.name)[0] or "application/octet-stream"

        async def make_call(headers):
            with open(path, "rb") as fh:
                return await client.post(url, headers=headers, files={"file": (f.name, fh, ctype)})

        res = await self._call("target", creds, user_id, send_log, make_call)

        if res.status_code in (200, 201, 202, 207):
            rows = res.json().get("data") or [{}]
            row = rows[0]
            if row.get("status") == "success" or row.get("code") == "SUCCESS":
                return True, str((row.get("details") or {}).get("id") or "")
            return False, f"[{row.get('code')}] {row.get('message')} {row.get('details') or ''}".strip()
        return False, res.text[:500]

    # --------------------------------------------------------------- budget
    async def get_budget(self, client, creds, user_id, role, send_log, safety_threshold, other_reserved) -> OrgBudget:
        """Zoho's daily API-credit quota isn't exposed by a stable endpoint, so this
        can't be read live. Set ZOHO_DAILY_API_LIMIT to enforce a ceiling in the
        pre-flight check; otherwise the budget is reported as unverified and the run
        relies on 429 backoff + checkpoint/resume."""
        limit = int(os.getenv("ZOHO_DAILY_API_LIMIT", "0") or 0)
        if limit:
            available = max(int(limit * safety_threshold) - other_reserved, 0)
            return OrgBudget(role, limit, 0, limit, available, verified=False)
        return OrgBudget(role, 0, 0, 0, UNVERIFIED_BUDGET, verified=False)

    def source_calls(self, total_records, total_files) -> int:
        return total_records + total_files      # 1 list call per record + 1 download per file

    def target_calls(self, total_files, total_bytes, strategy) -> int:
        return total_files                      # 1 upload call per file