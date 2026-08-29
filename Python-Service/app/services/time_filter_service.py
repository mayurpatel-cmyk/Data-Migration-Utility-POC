"""
Single source of truth for turning the UI's `migrationTimeFilter` payload
into a CRM-specific WHERE/COQL clause fragment, and for merging that clause
into an existing query string.

Both the live-preview path (crm_query_service.py) and every CRM's extraction
path (salesforce_migrator.py, zoho_migrator.py) import from here instead of
keeping their own copy of this logic in sync by hand. Any future change --
a new CRM, a different default field, inclusive/exclusive boundary handling,
timezone handling, or reintroducing a relative mode -- only has to be made
in this one file.

Only `mode: "range"` (explicit startDate/endDate) is supported. Relative
filtering (LAST_N_DAYS / LAST_N_MONTHS / LAST_N_YEARS) has been removed.
"""
import re
from datetime import datetime, timedelta
from typing import Optional, Tuple

DEFAULT_SALESFORCE_DATE_FIELD = "LastModifiedDate"
DEFAULT_ZOHO_DATE_FIELD = "Modified_Time"

_DATE_FMT = "%Y-%m-%d"


class TimeFilterError(ValueError):
    """Raised when a migrationTimeFilter payload is present but malformed
    (e.g. only one of startDate/endDate supplied, unparseable dates, or
    startDate after endDate). Callers should surface this as a 400 to the
    user rather than let it fall through as a generic 500."""


def merge_time_clause(base_query: str, time_clause: str, where_kw: str = "WHERE", and_kw: str = "AND") -> str:
    """
    Safely merges a time_clause into a query that already starts with SELECT.
    Handles three cases:
      - no WHERE at all             -> appends "WHERE <time_clause>"
      - WHERE with a real condition -> "WHERE <time_clause> AND <condition>"
      - a *dangling* WHERE with     -> just fills it in, no trailing AND/and
        nothing after it (e.g. a
        cleared filter box that left
        "...WHERE " behind)
    Splits off any trailing LIMIT first so the "is there a real condition"
    check isn't fooled by the limit clause itself.
    """
    if not time_clause:
        return base_query

    limit_match = re.search(r'(?i)\blimit\b.*$', base_query)
    head = base_query[:limit_match.start()] if limit_match else base_query
    tail = base_query[limit_match.start():] if limit_match else ""

    where_match = re.search(r'(?i)\bwhere\b', head)
    if where_match:
        existing_condition = head[where_match.end():].strip()
        if existing_condition:
            new_head = f"{head[:where_match.end()]} {time_clause} {and_kw} {existing_condition}"
        else:
            new_head = f"{head[:where_match.end()]} {time_clause}"
    else:
        new_head = f"{head.rstrip()} {where_kw} {time_clause}"

    return f"{new_head} {tail}".strip() if tail else new_head.strip()


def _parse_date_range(time_filter: Optional[dict], default_field: str) -> Optional[Tuple[str, datetime, datetime]]:
    """
    Extracts (field, start_dt, end_dt) from a migrationTimeFilter payload.

    Returns None when no filter should be applied (filter absent, or an
    unsupported/legacy `mode` such as the old 'relative' -- treated as
    "no filter" rather than an error so a stale cached frontend build
    degrades gracefully instead of hard-failing mid-rollout).

    `utcOffsetMinutes` (optional, defaults to 0/UTC) shifts the calendar-day
    boundaries so "Jan 1" means midnight in the caller's local timezone
    rather than midnight UTC -- otherwise a record modified in the last few
    hours of a local day can fall outside the range because the day
    boundary was computed in UTC. Positive values are ahead of UTC (e.g.
    India = +330).

    Raises TimeFilterError when a range filter IS present but incomplete
    or invalid, so the caller can surface a real 400 instead of silently
    ignoring bad input.
    """
    if not time_filter:
        return None

    mode = time_filter.get("mode")
    if mode not in (None, "range"):
        return None

    start_raw = (time_filter.get("startDate") or "").strip()
    end_raw = (time_filter.get("endDate") or "").strip()

    if not start_raw and not end_raw:
        return None
    if not start_raw or not end_raw:
        raise TimeFilterError("migrationTimeFilter requires both startDate and endDate.")

    try:
        start_dt = datetime.strptime(start_raw, _DATE_FMT)
        end_dt = datetime.strptime(end_raw, _DATE_FMT).replace(hour=23, minute=59, second=59)
    except ValueError as exc:
        raise TimeFilterError(f"migrationTimeFilter dates must be in YYYY-MM-DD format: {exc}") from exc

    if start_dt > end_dt:
        raise TimeFilterError("migrationTimeFilter.startDate must be on or before endDate.")

    try:
        offset_minutes = int(time_filter.get("utcOffsetMinutes") or 0)
    except (TypeError, ValueError) as exc:
        raise TimeFilterError(f"migrationTimeFilter.utcOffsetMinutes must be an integer: {exc}") from exc

    offset = timedelta(minutes=offset_minutes)
    start_dt -= offset
    end_dt -= offset

    field = (time_filter.get("field") or default_field).strip() or default_field
    return field, start_dt, end_dt


def build_salesforce_time_clause(time_filter: Optional[dict]) -> str:
    """Returns a SOQL boolean expression fragment (already parenthesized),
    or '' if no filter should be applied."""
    parsed = _parse_date_range(time_filter, DEFAULT_SALESFORCE_DATE_FIELD)
    if not parsed:
        return ""
    field, start_dt, end_dt = parsed
    start_lit = start_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end_lit = end_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return f"({field} >= {start_lit} AND {field} <= {end_lit})"


def build_zoho_time_clause(time_filter: Optional[dict]) -> str:
    """Returns a COQL boolean expression fragment (already parenthesized),
    or '' if no filter should be applied."""
    parsed = _parse_date_range(time_filter, DEFAULT_ZOHO_DATE_FIELD)
    if not parsed:
        return ""
    field, start_dt, end_dt = parsed
    start_lit = start_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")
    end_lit = end_dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")
    return f"({field} >= '{start_lit}' and {field} <= '{end_lit}')"