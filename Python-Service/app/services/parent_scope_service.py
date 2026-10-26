"""
Parent-scoped extraction: lets a child object's query reference "the parent records already migrated
through this tool" instead of hardcoding parent Ids.

Query syntax (anywhere an IN list is valid):

    SELECT Id, FirstName, LastName, AccountId, Email FROM Contact
    WHERE AccountId IN ({{MIGRATED:Account}}) LIMIT 5

`{{MIGRATED:<Object>}}` is expanded server-side from the persisted source->target Id map
(IdMappingService), scoped to the current CRM + org pair. The expansion is chunked so the SOQL/COQL
statement never exceeds URL limits, and the user's trailing LIMIT is applied to the combined result.

Several parents can be combined in one query, e.g. an Opportunity linked to both Account and Contact:

    SELECT Id, Name, AccountId, ContactId FROM Opportunity
    WHERE AccountId IN ({{MIGRATED:Account}}) AND ContactId IN ({{MIGRATED:Contact}})

AND / OR both work. Each parent's Ids are chunked and the chunks are combined (cartesian product), so every
statement stays small and the union of all statements equals the full condition. Rows are de-duplicated by Id.

Only Salesforce (SOQL) sources are supported for now (see SQL_STYLE_CRMS). The linking of the child's lookups to
the NEW parent Ids in the target org is unchanged: remap_reference_fields() resolves every reference field
independently (Opportunity->Account and Opportunity->Contact in the same run) from the same map.
"""
import itertools
import re
from typing import Any, Awaitable, Callable, List, Optional, Tuple

from app.services.id_mapping_service import IdMappingService

TOKEN_RE = re.compile(r"\{\{\s*MIGRATED\s*:\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}", re.IGNORECASE)
_TRAILING_LIMIT_RE = re.compile(r"(?is)\s+limit\s+(\d+)\s*$")
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
# Salesforce only: IdMappingService._normalize_id() stores every Id of 15+ chars truncated to 15 characters.
# SOQL accepts 15-char Ids in an IN list, but Zoho's 18-19 digit Ids would be truncated to a prefix that COQL
# can never match (and two Zoho Ids can even collapse into one key). Re-enable "zoho" here only after the map
# stores full Ids for non-Salesforce CRMs.
SQL_STYLE_CRMS = {"salesforce"}
DEFAULT_CHUNK_SIZE = 200  # max quoted Ids per statement (ALL parents combined); stays well under the ~8 KB GET URL limit
MIN_CHUNK_SIZE = 25       # floor per parent when several parents share one statement
MAX_SCOPE_QUERIES = 100   # safety cap on the number of statements one scoped query may expand into
# NOT IN over a chunked list is wrong (each chunk would return everything outside just that chunk).
_NOT_IN_RE = re.compile(r"(?is)\bnot\s+(?:[A-Za-z_][\w.]*\s+)?in\s*\(\s*\{\{\s*MIGRATED")


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
    def _expand_detail(
        query: str, ctx: ScopeContext, chunk_size: int = DEFAULT_CHUNK_SIZE
    ) -> Tuple[List[str], Optional[int], "dict[str, int]"]:
        """Returns (queries, overall_limit, {parent: migrated_id_count}). One query per combination of Id chunks."""
        if ctx.source_crm not in SQL_STYLE_CRMS:
            raise ParentScopeError("{{MIGRATED:...}} is currently supported for Salesforce sources only.")

        if _NOT_IN_RE.search(query):
            raise ParentScopeError(
                "NOT IN ({{MIGRATED:...}}) is not supported. Use IN ({{MIGRATED:<Object>}}) to scope to migrated parents."
            )

        parents: List[str] = []  # distinct, in order of first appearance
        for m in TOKEN_RE.finditer(query):
            if m.group(1) not in parents:
                parents.append(m.group(1))
        if not parents:
            raise ParentScopeError("No {{MIGRATED:<Object>}} token found in the query.")

        per_parent_chunk = max(MIN_CHUNK_SIZE, chunk_size // len(parents))
        chunks_by_parent: "dict[str, List[str]]" = {}
        counts: "dict[str, int]" = {}
        for parent in parents:
            id_map = IdMappingService.get_mapping(
                ctx.user_id, ctx.source_crm, ctx.target_crm, parent, ctx.source_instance, ctx.target_instance
            )
            ids = sorted(k for k in id_map if _SAFE_ID_RE.match(k))
            if not ids:
                raise ParentScopeError(
                    f"No migrated {parent} records found for {ctx.source_crm} -> {ctx.target_crm} on these connections. "
                    f"Migrate {parent} through this tool first."
                )
            counts[parent] = len(ids)
            chunks_by_parent[parent] = [
                ", ".join(f"'{x}'" for x in ids[i:i + per_parent_chunk]) for i in range(0, len(ids), per_parent_chunk)
            ]

        total_queries = 1
        for parent in parents:
            total_queries *= len(chunks_by_parent[parent])
        if total_queries > MAX_SCOPE_QUERIES:
            sizes = ", ".join(f"{p}: {counts[p]}" for p in parents)
            raise ParentScopeError(
                f"This query would need {total_queries} statements (migrated Ids -> {sizes}); the limit is {MAX_SCOPE_QUERIES}. "
                f"Scope by fewer parents, or add a time filter / extra condition to reduce the volume."
            )

        limit: Optional[int] = None
        base = query.strip().rstrip(";").strip()
        m = _TRAILING_LIMIT_RE.search(base)
        if m:
            limit = int(m.group(1))
            base = base[:m.start()]

        queries: List[str] = []
        for combo in itertools.product(*(chunks_by_parent[p] for p in parents)):
            in_lists = dict(zip(parents, combo))
            queries.append(TOKEN_RE.sub(lambda _m: in_lists[_m.group(1)], base))
        return queries, limit, counts

    @staticmethod
    def expand(query: str, ctx: ScopeContext, chunk_size: int = DEFAULT_CHUNK_SIZE) -> Tuple[List[str], Optional[int], int]:
        """Returns (queries, overall_limit, parent_count). One query per combination of parent-Id chunks."""
        queries, limit, counts = ParentScopeService._expand_detail(query, ctx, chunk_size)
        return queries, limit, sum(counts.values())

    @staticmethod
    async def extract(
        source_migrator: Any, client: Any, creds: dict, obj_name: str, query: str, mappings: list,
        send_log: Callable[[str], Awaitable[None]], time_filter: Optional[dict], ctx: ScopeContext,
    ):
        """Drop-in for source_migrator.extract(); passes straight through when the query has no token."""
        if not ParentScopeService.has_scope(query):
            return await source_migrator.extract(client, creds, obj_name, query, mappings, send_log, time_filter)

        queries, limit, counts = ParentScopeService._expand_detail(query, ctx)
        breakdown = " + ".join(f"{n} {p}" for p, n in counts.items())
        await send_log(
            f"[{obj_name}] Scoping to previously migrated parent record(s): {breakdown} "
            f"in {len(queries)} chunk(s)" + (f", overall limit {limit}." if limit else ".")
        )

        records: List[dict] = []
        used: List[str] = []
        seen_ids = set()  # the same child can match several chunk combinations (OR conditions): keep it once
        for q in queries:
            remaining = None if limit is None else limit - len(records)
            if remaining is not None and remaining <= 0:
                break
            chunk_query = f"{q} LIMIT {remaining}" if remaining is not None else q
            result = await source_migrator.extract(client, creds, obj_name, chunk_query, mappings, send_log, time_filter)
            rows, query_used = result if isinstance(result, tuple) else (result, None)
            for row in rows:
                rid = row.get("Id") if isinstance(row, dict) else None
                if rid is not None:
                    if rid in seen_ids:
                        continue
                    seen_ids.add(rid)
                records.append(row)
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