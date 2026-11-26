"""
Zendesk migrator: extraction (source) AND loading (target).

Target contract (same as the Salesforce / Zoho / HubSpot migrators):
    upload(client, payload, op_mode, pass_name, options, send_log)
        -> (success, error, skipped, success_rows, error_rows, skipped_rows)
    find_existing(client, options, key_field, values) -> {value: zendesk_id}
    revert_created(client, options, record_ids, send_log) -> [ids that could NOT be reverted]
Every success row carries Target_Id, so the id map, reference remap and the file pass keep working.

Writes
  users / organizations  create_many | create_or_update_many | update_many | destroy_many   (async jobs, 100/job)
  tickets                imports/tickets/create_many (keeps created_at/solved_at + the comment thread, fires no
                         triggers or notifications) or tickets/create_many; update_many; destroy_many
  groups                 single create / update / delete (Zendesk has no bulk endpoint)
  custom objects         custom_objects/{key}/records/jobs  create | create_or_update | update | delete
  macros / triggers / views are read-only (their rules embed ids that differ per account).
"""
import asyncio
import json
import logging
import os
import re
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from app.services.crm_service import CrmService, CrmSessionExpired, crm_session_expired
from app.services.resilience.retry import ApiQuotaExhausted, CircuitOpen, OUTCOME_UNKNOWN
from app.services.time_filter_service import TimeFilterError, build_zendesk_time_clause, zendesk_time_bounds
from app.services.zendesk_common import (
    LIST_ENDPOINT_OBJECTS, SEARCH_EXPORT_TYPES, WRITABLE_STANDARD, api_base, classify_object, flatten_record,
    in_time_bounds, resolve_subdomain, singular,
)

logger = logging.getLogger(__name__)

BATCH_SIZE = 100
JOB_CONCURRENCY = 2
SINGLE_CONCURRENCY = 4
LOOKUP_CONCURRENCY = 5
MAX_RETRIES = 6
MAX_RETRY_AFTER = 120.0
JOB_TIMEOUT_SECONDS = float(os.getenv("ZENDESK_JOB_TIMEOUT_SECONDS", "900"))
_PROPAGATE = (ApiQuotaExhausted, CircuitOpen, asyncio.CancelledError, CrmSessionExpired)

_REFRESH_LOCKS: Dict[Tuple[str, str], asyncio.Lock] = {}   # Zendesk refresh tokens rotate: refresh once at a time

_READ_ONLY = {"url", "generated_timestamp", "via", "has_incidents", "last_login_at", "active", "Id",
              "created_at", "updated_at", "solved_at"}
_TICKET_IMPORT_KEEP = {"created_at", "updated_at", "solved_at"}
_LIST_FIELDS = {"tags", "domain_names", "collaborator_ids", "follower_ids", "email_cc_ids"}
_ID_LIST_FIELDS = {"collaborator_ids", "follower_ids", "email_cc_ids"}


def chunk_dataset(data: list, chunk_size: int = BATCH_SIZE):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]


def _retry_after(res) -> Optional[float]:
    raw = res.headers.get("Retry-After")
    try:
        return max(0.0, float(raw)) if raw else None
    except ValueError:
        return None


def _to_int_if_digits(v: Any) -> Any:
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _split_list(v: Any) -> List[str]:
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    return [x for x in re.split(r"[;,\s]+", str(v)) if x]


def _fmt_error(item: Optional[dict]) -> str:
    if not item:
        return "Unknown Zendesk error."
    parts = [str(item.get(k)) for k in ("error", "title", "description", "details", "message") if item.get(k)]
    return " - ".join(dict.fromkeys(parts)) or json.dumps(item, default=str)[:300]


def _fmt_http(res) -> str:
    return f"HTTP {res.status_code}: {res.text[:400]}"


def align_results(results: Any, n: int) -> Optional[List[Optional[dict]]]:
    """Per-item job results lined up with the request order, or None when they can't be matched safely."""
    if not isinstance(results, list):
        return None
    if results and all(isinstance(r, dict) and isinstance(r.get("index"), int) for r in results):
        by_index = {r["index"]: r for r in results}
        if all(0 <= i < n for i in by_index):
            return [by_index.get(i) for i in range(n)]
    if len(results) == n:
        return results
    return None


def _result_ok(r: Optional[dict], need_id: bool = True) -> bool:
    if not isinstance(r, dict) or r.get("error") or r.get("success") is False:
        return False
    return (r.get("id") is not None) if need_id else True


class _Session:
    """State of one upload() call."""

    def __init__(self, client, base, headers, user_id, role, send_log, source_records, kind, name, ext, use_import):
        self.client, self.base, self.headers, self.user_id, self.role = client, base, headers, user_id, role
        self.send_log, self.source_records = send_log, source_records
        self.kind, self.name, self.ext, self.use_import = kind, name, ext, use_import
        self.succ: List[dict] = []
        self.errs: List[dict] = []
        self.skips: List[dict] = []
        self.decided: set = set()
        self.jobs = asyncio.Semaphore(JOB_CONCURRENCY)
        self.singles = asyncio.Semaphore(SINGLE_CONCURRENCY)
        self.label = name

    def ok(self, it, zd_id):
        rec = self.source_records[it["idx"]]
        rec["Target_Id"] = str(zd_id)
        self.decided.add(it["idx"])
        self.succ.append(rec)

    def fail(self, it, msg):
        rec = self.source_records[it["idx"]]
        rec["Target_Error"] = f"Zendesk Error: {msg}"
        self.decided.add(it["idx"])
        self.errs.append(rec)

    def skip(self, it, msg):
        rec = self.source_records[it["idx"]]
        rec["Target_SkipReason"] = msg
        self.decided.add(it["idx"])
        self.skips.append(rec)

    def unknown(self, it, msg):
        rec = self.source_records[it["idx"]]
        rec["Target_Error"] = f"{OUTCOME_UNKNOWN}Zendesk did not confirm this write ({msg}); the record may already exist."
        self.decided.add(it["idx"])
        self.errs.append(rec)

    def undecided(self, items):
        return [i for i in items if i["idx"] not in self.decided]

    def settle_ambiguous(self, mode, items, msg):
        for it in self.undecided(items):
            (self.unknown if mode == "insert" else self.fail)(it, msg if mode == "insert" else f"{msg} (safe to retry)")


class ZendeskMigrator:

    # ------------------------------------------------------------------ http
    async def _refresh(self, user_id, role, headers, stale_auth):
        lock = _REFRESH_LOCKS.setdefault((str(user_id), role), asyncio.Lock())
        async with lock:
            if headers.get("Authorization") != stale_auth:   # a sibling task already refreshed this connection
                return
            token = await CrmService.refresh_crm_token(user_id, "zendesk", role)
            headers["Authorization"] = f"Bearer {token}"

    async def _request(self, client, method, url, headers, user_id, role, send_log, *, idempotent=True, **kwargs):
        refreshed = False
        res = None
        for attempt in range(1, MAX_RETRIES + 1):
            sent_auth = headers.get("Authorization")
            res = await client.request(method, url, headers=headers, **kwargs)
            if res.status_code == 401:
                if refreshed:
                    raise crm_session_expired("zendesk", role)
                await send_log(" Zendesk token expired. Silently refreshing...")
                await self._refresh(user_id, role, headers, sent_auth)
                refreshed = True
                continue
            if res.status_code == 429:
                wait = _retry_after(res)
                wait = wait if wait is not None else min(5.0 * 2 ** (attempt - 1), 60.0)
                if wait > MAX_RETRY_AFTER:
                    raise ApiQuotaExhausted(f"Zendesk asked to wait {wait:.0f}s (Retry-After).")
                if attempt >= MAX_RETRIES:
                    return res
                await send_log(f" Zendesk rate limit hit. Pausing {wait:.0f}s...")
                await asyncio.sleep(wait)
                continue
            if res.status_code in (502, 503, 504) and attempt < MAX_RETRIES and (idempotent or res.status_code == 503):
                await asyncio.sleep(min(2.0 ** attempt, 30.0))
                continue
            return res
        return res

    @staticmethod
    def _headers(token: str) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # ================================================================== EXTRACTION
    async def _pages(self, client, url, headers, user_id, role, send_log, list_key, method="GET", body=None):
        while url:
            kwargs = {"json": body} if method == "POST" else {}
            res = await self._request(client, method, url, headers, user_id, role, send_log, **kwargs)
            res.raise_for_status()
            data = res.json()
            rows = data.get(list_key) or []
            if rows:
                yield rows
            if not rows or not (data.get("meta") or {}).get("has_more"):
                return
            url = (data.get("links") or {}).get("next")

    async def extract(self, client, creds, obj_name, query, mappings, send_log, time_filter=None):
        token, user_id = creds.get("access_token"), creds.get("user_id")
        try:
            base = api_base(resolve_subdomain(creds))
        except ValueError as e:
            await send_log(f"[{obj_name}] {e}")
            raise
        headers = self._headers(token)
        try:
            time_clause = build_zendesk_time_clause(time_filter)
            bounds = zendesk_time_bounds(time_filter)
        except TimeFilterError as e:
            await send_log(f"[{obj_name}] Invalid migration filter: {e}")
            raise

        kind, name = classify_object(obj_name)
        records: List[dict] = []
        try:
            if kind == "standard" and name in SEARCH_EXPORT_TYPES:
                records = await self._extract_export(client, base, headers, user_id, name, query, time_clause, send_log)
            elif kind == "standard":
                records = await self._extract_list(client, base, headers, user_id, name, bounds, send_log)
            else:
                records = await self._extract_custom(client, base, headers, user_id, name, query, bounds, send_log)
        except _PROPAGATE:
            raise
        except Exception as e:
            await send_log(f" Zendesk Extraction Error: {e}")
            raise
        await send_log(f"[{name}] Extraction Complete! Total: {len(records)}")
        return records

    async def _extract_export(self, client, base, headers, user_id, plural, query, time_clause, send_log):
        sing = SEARCH_EXPORT_TYPES[plural]
        clean = re.sub(r"type:[a-zA-Z0-9_]+", "", query or "", flags=re.IGNORECASE).strip()
        final = f"{' '.join(p for p in (clean, time_clause) if p)} type:{sing}".strip()
        url = f"{base}/search/export.json?filter[type]={sing}&query={urllib.parse.quote(final)}&page[size]=1000"
        out: List[dict] = []
        async for rows in self._pages(client, url, headers, user_id, "source", send_log, "results"):
            out.extend(flatten_record(r) for r in rows)
            await send_log(f"[{plural}] Extracted {len(out)} records...")
        return out

    async def _extract_list(self, client, base, headers, user_id, plural, bounds, send_log):
        if bounds:
            await send_log(f"[{plural}] Date filter applied client-side on {bounds[0]}.")
        out: List[dict] = []
        async for rows in self._pages(client, f"{base}/{plural}.json?page[size]=100", headers, user_id, "source", send_log, plural):
            out.extend(flatten_record(r) for r in rows if in_time_bounds(r, bounds))
            await send_log(f"[{plural}] Extracted {len(out)} records...")
        return out

    async def _extract_custom(self, client, base, headers, user_id, key, query, bounds, send_log):
        payload: Dict[str, Any] = {}
        if query and query.strip():
            try:
                payload = json.loads(query)
            except json.JSONDecodeError:
                raise Exception("Invalid JSON payload in Zendesk query for custom objects.")
            payload.pop("fields", None)   # preview-only column hint; the search API rejects it
        if bounds:
            await send_log(f"[{key}] Date filter applied client-side on {bounds[0]}.")

        searching = bool(payload)
        url = f"{base}/custom_objects/{urllib.parse.quote(key)}/records" + ("/search" if searching else "") + "?page[size]=100"
        out: List[dict] = []
        async for rows in self._pages(client, url, headers, user_id, "source", send_log, "custom_object_records",
                                      method="POST" if searching else "GET", body=payload if searching else None):
            out.extend(flatten_record(r) for r in rows if in_time_bounds(r, bounds))
            await send_log(f"[{key}] Extracted {len(out)} records...")
        return out

    # ================================================================== LOOKUP
    async def _lookup(self, s: _Session, by: str, values: List[str]) -> Dict[str, str]:
        """{value: zendesk_id}. by = 'external_id' | 'id' (groups: 'name' | 'id')."""
        values = [str(v) for v in dict.fromkeys(values) if v not in (None, "")]
        found: Dict[str, str] = {}
        if not values:
            return found
        c, h, u, base = s.client, s.headers, s.user_id, s.base

        async def get(url):
            res = await self._request(c, "GET", url, h, u, s.role, s.send_log)
            res.raise_for_status()
            return res.json()

        if s.kind == "custom":
            key = urllib.parse.quote(s.name)
            param = "filter[ids]" if by == "id" else "filter[external_ids]"
            usable = [v for v in values if "," not in v]
            for chunk in chunk_dataset(usable, BATCH_SIZE):
                url = f"{base}/custom_objects/{key}/records?{param}={','.join(urllib.parse.quote(v) for v in chunk)}&page[size]=100"
                async for rows in self._pages(c, url, h, u, s.role, s.send_log, "custom_object_records"):
                    for r in rows:
                        k = str(r.get("id")) if by == "id" else str(r.get("external_id") or "")
                        if k:
                            found[k] = str(r["id"])
            return found

        plural = s.name
        if plural == "groups":
            async for rows in self._pages(c, f"{base}/groups.json?page[size]=100", h, u, s.role, s.send_log, "groups"):
                for r in rows:
                    found[str(r.get("id") if by == "id" else r.get("name"))] = str(r["id"])
            return {v: found[v] for v in values if v in found}

        if plural in ("users", "organizations"):
            param = "ids" if by == "id" else "external_ids"
            batchable = [v for v in values if "," not in v]
            for chunk in chunk_dataset(batchable, BATCH_SIZE):
                data = await get(f"{base}/{plural}/show_many.json?{param}={','.join(urllib.parse.quote(v) for v in chunk)}")
                for r in data.get(plural) or []:
                    k = str(r.get("id")) if by == "id" else str(r.get("external_id") or "")
                    if k:
                        found[k] = str(r["id"])
            for v in (x for x in values if "," in x):   # a comma would split the list: look these up one by one
                if by == "id":
                    continue
                data = await get(f"{base}/{plural}/search.json?external_id={urllib.parse.quote(v)}")
                hits = data.get(plural) or []
                if hits:
                    found[v] = str(hits[0]["id"])
            return found

        # tickets
        if by == "id":
            for chunk in chunk_dataset(values, BATCH_SIZE):
                data = await get(f"{base}/tickets/show_many.json?ids={','.join(chunk)}")
                for r in data.get("tickets") or []:
                    found[str(r["id"])] = str(r["id"])
            return found
        sem = asyncio.Semaphore(LOOKUP_CONCURRENCY)

        async def one(v):
            async with sem:
                data = await get(f"{base}/tickets.json?external_id={urllib.parse.quote(v)}")
                hits = data.get("tickets") or []
                if hits:
                    found[v] = str(hits[0]["id"])

        await asyncio.gather(*[one(v) for v in values])
        return found

    def _session_for(self, client, options, send_log, role="target") -> _Session:
        base = api_base(options.get("instance_url") or options.get("subdomain") or "")
        kind, name = classify_object(options["targetObject"])
        return _Session(client, base, self._headers(options["token"]), options.get("userId"), role, send_log,
                        options.get("sourceRecords") or [], kind, name,
                        (options.get("targetExtIdField") or "").strip(), bool(options.get("zendeskTicketImport", True)))

    async def find_existing(self, client, options, key_field, values):
        """Records that already exist for these correlation values (lets a resumed INSERT adopt them instead of duplicating)."""
        async def noop(_m):
            return None
        s = self._session_for(client, options, noop)
        key = (key_field or "external_id").lower()
        if key not in ("external_id", "id", "name"):
            raise RuntimeError("Zendesk correlation lookup supports external_id, id (or name for groups) only.")
        by = "id" if key == "id" else ("name" if s.name == "groups" and key == "name" else "external_id")
        return await self._lookup(s, by, [str(v) for v in values])

    # ================================================================== WIRE PAYLOADS
    def _wire(self, s: _Session, raw: dict, mode: str, known_id: Optional[str] = None) -> dict:
        """One mapped record -> the JSON Zendesk expects. ValueError(message) marks just this row as failed."""
        rec = {k: v for k, v in raw.items() if v is not None and not str(k).startswith("Target_")}
        is_ticket = s.kind == "standard" and s.name == "tickets"
        keep_ts = is_ticket and s.use_import and mode == "insert"
        for k in list(rec):
            if k in _READ_ONLY and not (k in _TICKET_IMPORT_KEEP and keep_ts):
                rec.pop(k)
        rec.pop("id", None)

        for k in list(rec):
            v = rec[k]
            if k in _LIST_FIELDS:
                rec[k] = [_to_int_if_digits(x) for x in _split_list(v)] if k in _ID_LIST_FIELDS else _split_list(v)
            elif k != "external_id" and (k.endswith("_id") or k in ("brand_id", "ticket_form_id")) and not k.startswith(("custom_field_", "user_field_", "organization_field_")):
                rec[k] = _to_int_if_digits(v)

        custom_fields, user_fields, org_fields = [], {}, {}
        for k in list(rec):
            if k.startswith("custom_field_"):
                fid = k[len("custom_field_"):]
                if not fid.isdigit():
                    raise ValueError(f"'{k}' is not a valid Zendesk ticket field (expected custom_field_<numeric id>).")
                custom_fields.append({"id": int(fid), "value": rec.pop(k)})
            elif k.startswith("user_field_"):
                user_fields[k[len("user_field_"):]] = rec.pop(k)
            elif k.startswith("organization_field_"):
                org_fields[k[len("organization_field_"):]] = rec.pop(k)
        if custom_fields:
            rec["custom_fields"] = custom_fields
        if user_fields:
            rec["user_fields"] = {**(rec.get("user_fields") or {}), **user_fields}
        if org_fields:
            rec["organization_fields"] = {**(rec.get("organization_fields") or {}), **org_fields}

        if s.kind == "custom":
            fields = dict(rec.pop("custom_object_fields", None) or {})
            wire = {k: rec.pop(k) for k in ("name", "external_id") if k in rec}
            fields.update(rec)
            wire["custom_object_fields"] = fields
            if known_id:
                wire["id"] = str(known_id)
            return wire

        if s.name == "users" and mode in ("insert", "upsert"):
            rec.setdefault("skip_verify_email", True)

        if is_ticket and mode == "insert":
            body = rec.pop("description", None) or rec.pop("comment", None) or rec.get("subject")
            if isinstance(body, dict):
                body = body.get("body")
            if not body:
                raise ValueError("A ticket needs a description or subject to create (Zendesk requires an initial comment).")
            if s.use_import:
                comment = {"body": str(body), "public": True}
                if rec.get("created_at"):
                    comment["created_at"] = rec["created_at"]
                if rec.get("requester_id"):
                    comment["author_id"] = rec["requester_id"]
                rec["comments"] = [comment]
            else:
                rec["comment"] = {"body": str(body), "public": True}
        elif is_ticket:
            rec.pop("description", None)

        if known_id is not None:
            rec["id"] = _to_int_if_digits(known_id)
        return rec

    # ================================================================== UPLOAD
    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload:
            return 0, 0, 0, [], [], []
        s = self._session_for(client, options, send_log)
        label = s.name
        source_records = s.source_records

        def result():
            return len(s.succ), len(s.errs), len(s.skips), s.succ, s.errs, s.skips

        if s.kind == "standard" and s.name not in WRITABLE_STANDARD:
            msg = (f"{s.name} can't be written to Zendesk by this tool (their rules reference ids that differ per account). "
                   f"Recreate them manually or export/import them in Admin Center.")
            for e in payload:
                s.fail({"idx": e["originalIndex"]}, msg)
            await send_log(f"[{label}] {pass_name}: {msg}")
            return result()

        if op_mode in ("update", "upsert") and not s.ext:
            await send_log(f"[{label}] {pass_name}: No unique/external ID field configured -- "
                           f"cannot match existing records for {op_mode.upper()}.")
            return 0, len(payload), 0, [], [source_records[e["originalIndex"]] for e in payload], []

        await send_log(f"[{label}] {pass_name}: Initializing {op_mode.upper()} to Zendesk...")

        items = []
        for e in payload:
            raw = e["targetRecord"]
            if op_mode == "delete" or s.ext.lower() == "id":
                value = raw.get("id") or raw.get("Id") or raw.get("external_id")
            else:
                value = raw.get("external_id") or raw.get(s.ext)
            items.append({"idx": e["originalIndex"], "raw": raw, "ext_val": None if value in (None, "") else str(value)})

        try:
            if op_mode == "delete":
                await self._write_group(s, "delete", [i for i in items if self._need_value(s, i, "No Zendesk id to delete.")])
            elif op_mode == "insert":
                await self._write_group(s, "insert", items)
            else:
                native = op_mode == "upsert" and (s.name in ("users", "organizations") or s.kind == "custom")
                if native:
                    await self._write_group(s, "upsert", [i for i in items if self._need_value(s, i, f"No value for the match field '{s.ext}'.")])
                else:
                    todo = [i for i in items if self._need_value(s, i, f"No value for the match field '{s.ext}'.")]
                    by = "id" if s.ext.lower() == "id" else ("name" if s.name == "groups" else "external_id")
                    found = await self._lookup(s, by, [i["ext_val"] for i in todo])
                    create, update = [], []
                    for i in todo:
                        rid = found.get(i["ext_val"])
                        if rid:
                            i["known_id"] = rid
                            update.append(i)
                        elif op_mode == "upsert":
                            create.append(i)
                        else:
                            s.skip(i, f"[{s.ext}] No matching record found in Zendesk. "
                                      f"Skipped because Update mode does not create new records.")
                    await self._write_group(s, "insert", create)
                    await self._write_group(s, "update", update)
        except _PROPAGATE:
            raise
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"[:300]
            await send_log(f"[{label}] {pass_name}: stopped by an error: {detail}")
            s.settle_ambiguous(op_mode if op_mode == "insert" else "update", items, detail)

        for i in items:   # nothing may be left undecided
            if i["idx"] not in s.decided:
                s.fail(i, "No result was returned for this record.")
        await send_log(f"[{label}] {pass_name}: {len(s.succ)} succeeded, {len(s.errs)} failed, {len(s.skips)} skipped.")
        return result()

    @staticmethod
    def _need_value(s: _Session, item: dict, msg: str) -> bool:
        if item["ext_val"] is None:
            s.fail(item, msg)
            return False
        return True

    async def _write_group(self, s: _Session, mode: str, items: List[dict]):
        if not items:
            return
        if s.kind == "standard" and s.name == "groups":
            await asyncio.gather(*[self._write_group_single(s, mode, it) for it in items])
            return
        ready = []
        for it in items:
            if mode == "delete":
                ready.append((it, it["ext_val"]))
                continue
            try:
                ready.append((it, self._wire(s, it["raw"], mode, it.get("known_id"))))
            except ValueError as e:
                s.fail(it, str(e))
        results = await asyncio.gather(
            *[self._send_chunk(s, mode, [it for it, _ in c], [w for _, w in c]) for c in chunk_dataset(ready, BATCH_SIZE)],
            return_exceptions=True)
        for r in results:
            if isinstance(r, BaseException):
                raise r

    def _job_request(self, s: _Session, mode: str, wires: list):
        """(method, url, json_body) for one bulk call."""
        if s.kind == "custom":
            action = {"insert": "create", "upsert": "create_or_update", "update": "update", "delete": "delete"}[mode]
            items = [str(w) for w in wires] if mode == "delete" else wires
            return "POST", f"{s.base}/custom_objects/{urllib.parse.quote(s.name)}/records/jobs", {"job": {"action": action, "items": items}}
        if mode == "delete":
            return "DELETE", f"{s.base}/{s.name}/destroy_many.json?ids={','.join(str(w) for w in wires)}", None
        if s.name == "tickets":
            path = {"insert": "imports/tickets/create_many.json" if s.use_import else "tickets/create_many.json",
                    "update": "tickets/update_many.json"}[mode]
        else:
            path = {"insert": f"{s.name}/create_many.json", "upsert": f"{s.name}/create_or_update_many.json",
                    "update": f"{s.name}/update_many.json"}[mode]
        return ("PUT" if mode == "update" else "POST"), f"{s.base}/{path}", {s.name: wires}

    async def _wait_job(self, s: _Session, job_id: str) -> Tuple[str, dict]:
        waited, delay = 0.0, 1.0
        while True:
            res = await self._request(s.client, "GET", f"{s.base}/job_statuses/{job_id}.json", s.headers, s.user_id, s.role, s.send_log)
            if res.status_code == 200:
                js = res.json().get("job_status") or {}
                if js.get("status") in ("completed", "failed", "killed"):
                    return js["status"], js
            elif res.status_code == 404:
                return "missing", {}
            if waited >= JOB_TIMEOUT_SECONDS:
                return "timeout", {}
            await asyncio.sleep(delay)
            waited += delay
            delay = min(delay * 1.5, 10.0)

    async def _send_chunk(self, s: _Session, mode: str, chunk: List[dict], wires: list):
        if not chunk:
            return
        isolate = False
        async with s.jobs:
            method, url, body = self._job_request(s, mode, wires)
            kwargs = {"json": body} if body is not None else {}
            try:
                res = await self._request(s.client, method, url, s.headers, s.user_id, s.role, s.send_log,
                                          idempotent=(mode != "insert"), **kwargs)
            except _PROPAGATE:
                raise
            except Exception as exc:
                s.settle_ambiguous(mode, chunk, f"{type(exc).__name__}: {exc}"[:200])
                return

            if res.status_code not in (200, 201, 202):
                msg = _fmt_http(res)
                if len(chunk) > 1 and res.status_code < 500 and res.status_code != 429:
                    isolate = True      # whole bulk call rejected (nothing committed): isolate the offending rows
                elif mode == "insert" and res.status_code >= 500 and res.status_code != 503:
                    for it in chunk:
                        s.unknown(it, msg)
                    return
                else:
                    for it in chunk:
                        s.fail(it, msg)
                    return
            else:
                job_id = ((res.json() or {}).get("job_status") or {}).get("id")
                if not job_id:
                    s.settle_ambiguous(mode, chunk, "Zendesk accepted the request but returned no job id")
                    return
                status, js = await self._wait_job(s, job_id)

        if isolate:   # semaphore released above, so re-entering cannot deadlock
            await asyncio.gather(*[self._send_chunk(s, mode, [it], [w]) for it, w in zip(chunk, wires)])
            return

        aligned = align_results(js.get("results"), len(chunk))
        if aligned is None:
            s.settle_ambiguous(mode, chunk, f"job {job_id} ended '{status}' without per-record results")
            return
        for it, r in zip(chunk, aligned):
            if _result_ok(r, need_id=(mode != "delete")):
                s.ok(it, (r or {}).get("id") or it.get("known_id") or it.get("ext_val"))
            elif r is None:
                s.settle_ambiguous(mode, [it], f"job {job_id} returned no result for this record")
            else:
                s.fail(it, _fmt_error(r))

    async def _write_group_single(self, s: _Session, mode: str, it: dict):
        """Groups: one request per record."""
        async with s.singles:
            try:
                if mode == "delete":
                    res = await self._request(s.client, "DELETE", f"{s.base}/groups/{it['ext_val']}.json", s.headers, s.user_id, s.role, s.send_log)
                    (s.ok(it, it["ext_val"]) if res.status_code in (200, 204) else s.fail(it, _fmt_http(res)))
                    return
                wire = self._wire(s, it["raw"], mode, it.get("known_id"))
                if mode == "update":
                    gid = wire.pop("id")
                    res = await self._request(s.client, "PUT", f"{s.base}/groups/{gid}.json", s.headers, s.user_id, s.role, s.send_log, json={"group": wire})
                else:
                    res = await self._request(s.client, "POST", f"{s.base}/groups.json", s.headers, s.user_id, s.role, s.send_log,
                                              idempotent=False, json={"group": wire})
                if res.status_code in (200, 201):
                    s.ok(it, res.json()["group"]["id"])
                elif mode == "insert" and res.status_code >= 500 and res.status_code != 503:
                    s.unknown(it, _fmt_http(res))
                else:
                    s.fail(it, _fmt_http(res))
            except ValueError as e:
                s.fail(it, str(e))
            except _PROPAGATE:
                raise
            except Exception as exc:
                s.settle_ambiguous(mode, [it], f"{type(exc).__name__}: {exc}"[:200])

    # ================================================================== REVERT
    async def revert_created(self, client, options, record_ids, send_log):
        """Deletes records this run created. Returns the ids that could NOT be deleted ([] = all reverted)."""
        s = self._session_for(client, options, send_log)
        ids = [str(r) for r in dict.fromkeys(record_ids) if r]
        failed: List[str] = []
        if s.kind == "standard" and s.name not in WRITABLE_STANDARD:
            return ids

        if s.kind == "standard" and s.name == "groups":
            for rid in ids:
                res = await self._request(client, "DELETE", f"{s.base}/groups/{rid}.json", s.headers, s.user_id, s.role, send_log)
                if res.status_code not in (200, 204, 404):
                    failed.append(rid)
            return failed

        for chunk in chunk_dataset(ids, BATCH_SIZE):
            method, url, body = self._job_request(s, "delete", chunk)
            res = await self._request(client, method, url, s.headers, s.user_id, s.role, send_log,
                                      **({"json": body} if body is not None else {}))
            if res.status_code not in (200, 201, 202):
                await send_log(f"[{s.name}] Revert batch failed ({res.status_code}): {res.text[:300]}")
                failed.extend(chunk)
                continue
            job_id = ((res.json() or {}).get("job_status") or {}).get("id")
            status, js = await self._wait_job(s, job_id) if job_id else ("missing", {})
            aligned = align_results(js.get("results"), len(chunk))
            if status != "completed" or aligned is None:
                failed.extend(chunk)
                continue
            failed.extend(rid for rid, r in zip(chunk, aligned) if not _result_ok(r, need_id=False))
        return failed