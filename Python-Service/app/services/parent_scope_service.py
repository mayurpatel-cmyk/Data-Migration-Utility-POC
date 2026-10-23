"""
Parent-scoped extraction: lets a child object's query reference "the parent records already migrated
through this tool" instead of hardcoding parent Ids.

Query syntax (anywhere an IN list is valid):

    SELECT Id, FirstName, LastName, AccountId, Email FROM Contact
    WHERE AccountId IN ({{MIGRATED:Account}}) LIMIT 5

`{{MIGRATED:<Object>}}` is expanded server-side from the persisted source->target Id map
(IdMappingService), scoped to the current CRM + org pair. The expansion is chunked so the SOQL/COQL
statement never exceeds URL limits, and the user's trailing LIMIT is applied to the combined result.

Only SQL-style sources (Salesforce SOQL, Zoho COQL) are supported. The linking of the child's lookup to
the NEW parent Id in the target org is unchanged: remap_reference_fields() already does that from the
same map.
"""
import re
from typing import Any, Awaitable, Callable, List, Optional, Tuple

from app.services.id_mapping_service import IdMappingService

TOKEN_RE = re.compile(r"\{\{\s*MIGRATED\s*:\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}", re.IGNORECASE)
_TRAILING_LIMIT_RE = re.compile(r"(?is)\s+limit\s+(\d+)\s*$")
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
SQL_STYLE_CRMS = {"salesforce", "zoho"}
DEFAULT_CHUNK_SIZE = 200  # 200 quoted Ids stays well under the ~8 KB GET URL limit once encoded


class ParentScopeError(ValueError):
    """Bad or unresolvable {{MIGRATED:...}} usage. Surface as a 400 / a failed-validation log line."""


class ScopeContext:
    def __init__(self, user_id: str, source_crm: str, target_crm: str,
                 source_instance: Optional[str], target_instance: Optional[str]):
        self.user_id = user_id
        self.source_crm = (source_crm or "").lower()
        self.target_crm = (target_crm or "").lower()
        self.source_instance = source_instance
        self.target_instance = target_instance


class ParentScopeService:

    @staticmethod
    def has_scope(query: Optional[str]) -> bool:
        return bool(query and TOKEN_RE.search(query))

    @staticmethod
    def expand(query: str, ctx: ScopeContext, chunk_size: int = DEFAULT_CHUNK_SIZE) -> Tuple[List[str], Optional[int], int]:
        """Returns (queries, overall_limit, parent_count). One query per chunk of parent Ids."""
        if ctx.source_crm not in SQL_STYLE_CRMS:
            raise ParentScopeError("{{MIGRATED:...}} is supported for Salesforce and Zoho sources only.")

        parents = {m.group(1) for m in TOKEN_RE.finditer(query)}
        if len(parents) != 1:
            raise ParentScopeError(
                f"Use {{{{MIGRATED:<Object>}}}} for exactly one parent object per query (found: {', '.join(sorted(parents))})."
            )
        parent = next(iter(parents))

        id_map = IdMappingService.get_mapping(
            ctx.user_id, ctx.source_crm, ctx.target_crm, parent, ctx.source_instance, ctx.target_instance
        )
        ids = sorted(k for k in id_map if _SAFE_ID_RE.match(k))
        if not ids:
            raise ParentScopeError(
                f"No migrated {parent} records found for {ctx.source_crm} -> {ctx.target_crm} on these connections. "
                f"Migrate {parent} through this tool first."
            )

        limit: Optional[int] = None
        base = query.strip().rstrip(";").strip()
        m = _TRAILING_LIMIT_RE.search(base)
        if m:
            limit = int(m.group(1))
            base = base[:m.start()]

        queries = []
        for i in range(0, len(ids), chunk_size):
            in_list = ", ".join(f"'{x}'" for x in ids[i:i + chunk_size])
            queries.append(TOKEN_RE.sub(lambda _m: in_list, base))
        return queries, limit, len(ids)

    @staticmethod
    async def extract(
        source_migrator: Any, client: Any, creds: dict, obj_name: str, query: str, mappings: list,
        send_log: Callable[[str], Awaitable[None]], time_filter: Optional[dict], ctx: ScopeContext,
    ):
        """Drop-in for source_migrator.extract(); passes straight through when the query has no token."""
        if not ParentScopeService.has_scope(query):
            return await source_migrator.extract(client, creds, obj_name, query, mappings, send_log, time_filter)

        queries, limit, parent_count = ParentScopeService.expand(query, ctx)
        await send_log(
            f"[{obj_name}] Scoping to {parent_count} previously migrated parent record(s) "
            f"in {len(queries)} chunk(s)" + (f", overall limit {limit}." if limit else ".")
        )

        records: List[dict] = []
        used: List[str] = []
        for q in queries:
            remaining = None if limit is None else limit - len(records)
            if remaining is not None and remaining <= 0:
                break
            chunk_query = f"{q} LIMIT {remaining}" if remaining is not None else q
            result = await source_migrator.extract(client, creds, obj_name, chunk_query, mappings, send_log, time_filter)
            rows, query_used = result if isinstance(result, tuple) else (result, None)
            records.extend(rows)
            if query_used:
                used.append(query_used)

        if limit is not None:
            records = records[:limit]
        summary = used[0] + (f"  /* +{len(used) - 1} more chunk(s) */" if len(used) > 1 else "") if used else None
        return records, summary

    @staticmethod
    def first_chunk_query(query: str, ctx: ScopeContext) -> str:
        """For previews: expand to the first chunk only (LIMIT is re-applied by the preview path)."""
        queries, limit, _ = ParentScopeService.expand(query, ctx)
        return f"{queries[0]} LIMIT {limit}" if limit else queries[0]

    @staticmethod
    def count_queries(query: str, ctx: ScopeContext) -> Tuple[List[str], Optional[int]]:
        queries, limit, _ = ParentScopeService.expand(query, ctx)
        return queries, limit