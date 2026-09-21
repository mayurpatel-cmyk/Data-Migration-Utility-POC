# app/services/coql_query_builder.py
"""
Single source of truth for composing Zoho COQL SELECT statements.

COQL differs from SOQL in ways that break generic query merging:
  * WHERE is MANDATORY. `select a from Leads` (or a dangling `... where`) is
    rejected with SYNTAX_ERROR / "missing clause" / details.clause = "where".
  * `*` is not a valid select list.
  * Max 200 rows per call; paging is via `limit N offset M`.
  * An empty result set returns HTTP 204 with no body.

Used by crm_query_service.py (preview + count) and zoho_migrator.py (extract).
"""
import re
from typing import List, Optional, Tuple

from app.services.query_field_utils import ensure_fields_selected

COQL_PAGE_SIZE = 200
DEFAULT_WHERE = "id is not null"

_QUOTED_RE = re.compile(r"'(?:[^'\\]|\\.)*'")
_TAIL_RE = re.compile(r"(?i)\b(?:order\s+by|group\s+by|limit)\b")
_WHERE_RE = re.compile(r"(?i)\bwhere\b")
_LIMIT_RE = re.compile(r"(?i)\blimit\s+(\d+)(?:\s*,\s*(\d+)|\s+offset\s+(\d+))?")


def _mask_quotes(sql: str) -> str:
    """Blank out quoted literals (same length) so keyword searches can't match inside values."""
    return _QUOTED_RE.sub(lambda m: "'" + "_" * (len(m.group(0)) - 2) + "'", sql)


def _csv(fields: List[str]) -> str:
    return ",".join(f for f in fields if f) or "id"


def split_coql(query: str) -> Tuple[str, str, str]:
    """Splits a SELECT into (head, where_condition, tail).
    head = 'select ... from X', tail = 'order by/group by/limit ...' (may be empty)."""
    q = query.strip().rstrip(";").strip()
    masked = _mask_quotes(q)

    tail_match = _TAIL_RE.search(masked)
    cut = tail_match.start() if tail_match else len(q)
    body, tail = q[:cut], q[cut:].strip()

    where_match = _WHERE_RE.search(masked[:cut])
    if where_match:
        return body[:where_match.start()].strip(), body[where_match.end():].strip(), tail
    return body.strip(), "", tail


def strip_limit(tail: str) -> Tuple[str, Optional[int], int]:
    """Removes a `limit N`, `limit N offset M` or `limit M, N` clause. Returns (tail, count, offset)."""
    match = _LIMIT_RE.search(tail)
    if not match:
        return tail.strip(), None, 0
    first, comma_count, offset_kw = match.groups()
    if comma_count:
        count, offset = int(comma_count), int(first)
    else:
        count, offset = int(first), int(offset_kw or 0)
    return (tail[:match.start()] + tail[match.end():]).strip(), count, offset


def extract_user_limit(query: str) -> Optional[int]:
    """The row cap the user typed into the query editor, if any."""
    q = (query or "").strip()
    if not re.match(r"(?i)^select\s", q):
        return None
    return strip_limit(split_coql(q)[2])[1]


def build_coql(
    query: str,
    obj_name: str,
    fields: List[str],
    time_clause: str = "",
    *,
    limit: Optional[int] = None,
    offset: int = 0,
    select_override: Optional[str] = None,
    keep_tail: bool = True,
) -> str:
    """
    Composes a valid COQL statement from any of:
      - a full `select ... from X [where ...] [order by ...] [limit ...]`
      - a bare condition (`Lead_Status = 'New'` or `where Lead_Status = 'New'`)
      - an empty string (time filter only / everything)

    Guarantees: mapped `fields` are selected, `*` is expanded, the user's condition
    is parenthesized when combined with the time clause, a WHERE clause is always
    present, ORDER BY/GROUP BY stay after WHERE, and paging is applied last.

    select_override replaces the select list (e.g. "count(id)"); keep_tail=False
    drops order by/group by/limit (used for counts).
    """
    q = (query or "").strip()

    if re.match(r"(?i)^select\s", q):
        head, cond, tail = split_coql(q)
        if select_override:
            head = re.sub(r"(?is)^select\s+.*?\s+from\b", f"select {select_override} from", head, count=1)
        elif re.match(r"(?i)^select\s+\*\s+from\b", head):
            head = re.sub(r"(?i)^select\s+\*\s+from\b", f"select {_csv(fields)} from", head, count=1)
        else:
            head = ensure_fields_selected(head, fields)
    else:
        head = f"select {select_override or _csv(fields)} from {obj_name}"
        cond, tail = re.sub(r"(?i)^where\s+", "", q).strip(), ""

    if keep_tail:
        tail, user_limit, user_offset = strip_limit(tail)
        if limit is None:
            limit, offset = user_limit, user_offset
    else:
        tail = ""

    parts = []
    if cond:
        parts.append(f"({cond})" if time_clause else cond)
    if time_clause:
        parts.append(time_clause)
    where = " and ".join(parts) if parts else DEFAULT_WHERE

    sql = f"{head} where {where}"
    if tail:
        sql += f" {tail}"
    if limit is not None:
        sql += f" limit {limit}"
        if offset:
            sql += f" offset {offset}"
    return sql