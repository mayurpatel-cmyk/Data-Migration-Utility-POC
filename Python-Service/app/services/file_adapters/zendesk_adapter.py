"""
Zendesk file adapter.

SOURCE: attachments on ticket comments (one comments call per ticket, then a streamed download of content_url).
TARGET: tickets only. A file is uploaded to /uploads and attached to a PRIVATE comment on the (already migrated)
        ticket -- private so the requester is never emailed. Zendesk makes closed tickets read-only: if the ticket
        was migrated as 'closed' the upload fails with Zendesk's own message (migrate it as 'solved', attach, then close).
"""
import asyncio
import mimetypes
import os
import urllib.parse
import uuid
from typing import List, Tuple

from app.services.file_adapters.base import FileAdapter, FileTypeEstimate, OrgBudget, SourceFile
from app.services.migrators.zendesk_migrator import ZendeskMigrator, chunk_dataset
from app.services.zendesk_common import api_base, classify_object, resolve_subdomain

UNVERIFIED_BUDGET = 10_000_000
MAX_UPLOAD_BYTES = 50 * 1024 * 1024        # Zendesk's per-attachment limit


class ZendeskFileAdapter(FileAdapter):
    crm = "zendesk"
    sample_size = 200            # one comments call per ticket, so sample small
    max_concurrency = 4
    files_are_attachments = True
    requires_object_names = True

    def __init__(self):
        self.m = ZendeskMigrator()

    @staticmethod
    def _headers(creds) -> dict:
        return {"Authorization": f"Bearer {creds.get('access_token')}"}

    async def _call(self, client, creds, user_id, role, method, url, send_log, **kw):
        headers = self._headers(creds)
        res = await self.m._request(client, method, url, headers, user_id, role, send_log, **kw)
        creds["access_token"] = headers["Authorization"][len("Bearer "):]   # keep a refreshed token for the next call
        return res

    # --------------------------------------------------------------- source
    async def fetch_record_ids(self, client, creds, user_id, obj_name, query, time_filter, send_log) -> List[str]:
        c = dict(creds)
        c.setdefault("user_id", user_id)
        rows = await self.m.extract(client, c, obj_name, query, [], send_log, time_filter)
        return [str(r["id"]) for r in rows if r.get("id") is not None]

    async def _comments(self, client, creds, user_id, ticket_id, send_log) -> List[dict]:
        base, out = api_base(resolve_subdomain(creds)), []
        url = f"{base}/tickets/{ticket_id}/comments.json?page[size]=100"
        while url:
            res = await self._call(client, creds, user_id, "source", "GET", url, send_log)
            if res.status_code == 404:
                return out
            res.raise_for_status()
            data = res.json()
            out.extend(data.get("comments") or [])
            url = (data.get("links") or {}).get("next") if (data.get("meta") or {}).get("has_more") else None
        return out

    async def _gather(self, client, creds, user_id, parent_ids, source_object, send_log):
        kind, name = classify_object(source_object)
        if not (kind == "standard" and name == "tickets"):
            return []
        sem, rows = asyncio.Semaphore(self.max_concurrency), []

        async def one(tid):
            async with sem:
                for cm in await self._comments(client, creds, user_id, tid, send_log):
                    for a in cm.get("attachments") or []:
                        if not a.get("deleted"):
                            rows.append((tid, a))

        await asyncio.gather(*[one(t) for t in parent_ids])
        return rows

    async def count_files(self, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        if kind == "files":
            return FileTypeEstimate()
        rows = await self._gather(client, creds, user_id, parent_ids, source_object, send_log)
        total = sum(int(a.get("size") or 0) for _, a in rows)
        return FileTypeEstimate(file_count=len(rows), total_bytes=total, avg_bytes=(total / len(rows)) if rows else 0.0)

    async def list_files(self, client, creds, user_id, parent_ids, source_object,
                         migrate_attachments, migrate_files, send_log) -> List[SourceFile]:
        if not (migrate_attachments or migrate_files):
            return []
        rows = await self._gather(client, creds, user_id, parent_ids, source_object, send_log)
        files = []
        for tid, a in rows:
            name = a.get("file_name") or "attachment"
            sf = SourceFile(str(a["id"]), str(tid), name, int(a.get("size") or 0), "attachment",
                            a.get("content_type") or mimetypes.guess_type(name)[0], meta={"url": a.get("content_url")})
            if not a.get("content_url"):
                sf.skip_reason = "attachment has no download URL"
            files.append(sf)
        await send_log(f"[Attachments] Found {len(files)} Zendesk attachment(s) across {len(parent_ids)} ticket(s).")
        return files

    async def download_to_disk(self, client, creds, user_id, f: SourceFile, staging_dir, send_log) -> Tuple[str, int]:
        url = f.meta["url"]
        path = os.path.join(staging_dir, f"zendesk_{f.source_id}_{uuid.uuid4().hex[:8]}.bin")
        host = urllib.parse.urlparse(url).netloc
        refreshed = False
        for attempt in range(1, 6):
            headers = self._headers(creds) if host.endswith(".zendesk.com") else {}   # never send the token elsewhere
            async with client.stream("GET", url, headers=headers, follow_redirects=True) as res:
                if res.status_code == 401 and host.endswith(".zendesk.com") and not refreshed:
                    refreshed = True
                    stale = headers["Authorization"]
                    await self.m._refresh(user_id, "source", headers, stale)
                    creds["access_token"] = headers["Authorization"][len("Bearer "):]
                    continue
                if res.status_code == 429:
                    await asyncio.sleep(min(5 * 2 ** attempt, 60))
                    continue
                if res.status_code != 200:
                    body = (await res.aread()).decode(errors="replace")[:300]
                    raise RuntimeError(f"Zendesk download failed ({res.status_code}): {body}")
                written = 0
                with open(path, "wb") as fh:
                    async for chunk in res.aiter_bytes(1024 * 1024):
                        fh.write(chunk)
                        written += len(chunk)
                return path, written
        raise RuntimeError("Zendesk download kept failing (rate limit / expired session).")

    # --------------------------------------------------------------- target
    async def upload(self, client, creds, user_id, target_object, new_parent_id, f: SourceFile, path, send_log):
        kind, name = classify_object(target_object)
        if not (kind == "standard" and name == "tickets"):
            return False, "Zendesk accepts attachments on tickets only."
        if f.size > MAX_UPLOAD_BYTES:
            msg = f"'{f.name}' is {f.size / 1e6:.1f}MB, over Zendesk's {MAX_UPLOAD_BYTES / 1e6:.0f}MB attachment limit."
            await send_log(f"[File SKIPPED] {msg}")
            return False, msg

        base = api_base(resolve_subdomain(creds))
        ctype = f.content_type or mimetypes.guess_type(f.name)[0] or "application/binary"
        with open(path, "rb") as fh:
            blob = fh.read()
        res = await self._upload_blob(client, creds, user_id, base, f.name, ctype, blob, send_log)
        if res.status_code not in (200, 201):
            return False, f"upload failed ({res.status_code}): {res.text[:300]}"
        token = (res.json().get("upload") or {}).get("token")
        if not token:
            return False, "Zendesk returned no upload token."

        res = await self._call(client, creds, user_id, "target", "PUT", f"{base}/tickets/{new_parent_id}.json", send_log,
                               json={"ticket": {"comment": {"body": f"Migrated attachment: {f.name}", "public": False,
                                                            "uploads": [token]}}})
        if res.status_code in (200, 201):
            return True, str(token)
        return False, f"attaching to ticket {new_parent_id} failed ({res.status_code}): {res.text[:300]}"

    async def _upload_blob(self, client, creds, user_id, base, name, ctype, blob, send_log):
        headers = {**self._headers(creds), "Content-Type": ctype}
        res = await self.m._request(client, "POST", f"{base}/uploads.json?filename={urllib.parse.quote(name)}",
                                    headers, user_id, "target", send_log, idempotent=False, content=blob)
        creds["access_token"] = headers["Authorization"][len("Bearer "):]
        return res

    # --------------------------------------------------------------- budget
    async def get_budget(self, client, creds, user_id, role, send_log, safety_threshold, other_reserved) -> OrgBudget:
        """Zendesk limits requests PER MINUTE (plan dependent), not per day, so there is no daily quota to read.
        Set ZENDESK_DAILY_API_LIMIT to enforce a ceiling; otherwise the budget is reported as unverified and the
        run relies on Retry-After back-off + checkpoint/resume."""
        limit = int(os.getenv("ZENDESK_DAILY_API_LIMIT", "0") or 0)
        if limit:
            return OrgBudget(role, limit, 0, limit, max(int(limit * safety_threshold) - other_reserved, 0), verified=False)
        return OrgBudget(role, 0, 0, 0, UNVERIFIED_BUDGET, verified=False)

    def source_calls(self, total_records, total_files) -> int:
        return total_records                    # one comments call per ticket; attachment downloads are CDN fetches

    def target_calls(self, total_files, total_bytes, strategy) -> int:
        return total_files * 2                  # upload + attach comment