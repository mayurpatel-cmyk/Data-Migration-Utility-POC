import logging
import socket
import time
from fastapi import APIRouter, Depends, HTTPException, Query
from app.api.dependencies.auth import get_current_user
from app.utils.config import supabase
from app.services.analytics_service import AnalyticsService

logger = logging.getLogger(__name__)

router = APIRouter()

_TRANSIENT_WINSOCK_ERRNOS = {10035}  # WSAEWOULDBLOCK


def _is_transient_socket_error(exc: Exception) -> bool:
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) in _TRANSIENT_WINSOCK_ERRNOS


def _execute_with_retry(query, max_retries: int = 3, base_delay: float = 0.15):
    """Runs a Supabase query builder's .execute(), retrying only on the
    transient Windows socket error above. Any other exception (auth error,
    bad filter, real network failure, etc.) propagates immediately -- this
    is not a general-purpose retry-everything wrapper."""
    last_exc: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            return query.execute()
        except Exception as exc:
            if not _is_transient_socket_error(exc):
                raise
            last_exc = exc
            logger.warning(
                "[SUPABASE] Transient WinError 10035 on attempt %d/%d -- retrying.",
                attempt, max_retries
            )
            time.sleep(base_delay * attempt)  # 0.15s, 0.30s, 0.45s
    raise last_exc


def _apply_common_filters(query, source_crm=None, target_crm=None, target_object=None, start_date=None, end_date=None):
    """Shared filter application for both migration_history and
    validation_history. Every param is optional, so a bare
    /api/migration-history call (no filters) behaves exactly as before."""
    if source_crm:
        query = query.eq("source_crm", source_crm.lower())
    if target_crm:
        query = query.eq("target_crm", target_crm.lower())
    if target_object:
        query = query.eq("target_object", target_object)
    if start_date:
        query = query.gte("created_at", start_date)
    if end_date:
        # end_date is a calendar day from the UI (YYYY-MM-DD); push it to
        # the end of that day so rows created ON end_date are included.
        query = query.lte("created_at", f"{end_date}T23:59:59.999999")
    return query


@router.get("/api/migration-history")
def get_migration_history(
    current_user=Depends(get_current_user),
    source_crm: str = Query(None),
    target_crm: str = Query(None),
    target_object: str = Query(None),
    start_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
    end_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
):
    try:
        query = supabase.table("migration_history").select("*").eq("user_id", current_user.id)
        query = _apply_common_filters(query, source_crm, target_crm, target_object, start_date, end_date)
        response = _execute_with_retry(query.order("created_at", desc=True))
        return {"success": True, "history": response.data}
    except Exception as e:
        logger.error("Failed to fetch migration history for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=500, detail="Failed to fetch migration history.")


@router.get("/api/validation-history")
def get_validation_history(
    current_user=Depends(get_current_user),
    source_crm: str = Query(None),
    target_crm: str = Query(None),
    target_object: str = Query(None),
    start_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
    end_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
):
    try:
        query = supabase.table("validation_history").select("*").eq("user_id", current_user.id)
        query = _apply_common_filters(query, source_crm, target_crm, target_object, start_date, end_date)
        response = _execute_with_retry(query.order("created_at", desc=True))
        return {"success": True, "history": response.data}
    except Exception as e:
        logger.error("Failed to fetch validation history for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=500, detail="Failed to fetch validation history.")


@router.get("/api/analytics/summary")
def get_analytics_summary(
    current_user=Depends(get_current_user),
    source_crm: str = Query(None),
    target_crm: str = Query(None),
    target_object: str = Query(None),
    start_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
    end_date: str = Query(None, description="YYYY-MM-DD, inclusive"),
):
    """Powers the History & Analytics dashboard: KPI overview, per-object
    and per-pathway breakdowns, a day-by-day trend, and a merged
    top-errors list, computed across both completed migrations and
    validation runs. All aggregation happens in AnalyticsService over the
    rows fetched here -- this route is just filtering + wiring, so the
    numbers stay in sync with whatever filters the user applied to the
    tables above the charts."""
    try:
        migration_query = supabase.table("migration_history").select("*").eq("user_id", current_user.id)
        migration_query = _apply_common_filters(migration_query, source_crm, target_crm, target_object, start_date, end_date)
        migration_rows = _execute_with_retry(migration_query.order("created_at", desc=True)).data

        validation_query = supabase.table("validation_history").select("*").eq("user_id", current_user.id)
        validation_query = _apply_common_filters(validation_query, source_crm, target_crm, target_object, start_date, end_date)
        validation_rows = _execute_with_retry(validation_query.order("created_at", desc=True)).data

        dashboard = AnalyticsService.build_dashboard(migration_rows, validation_rows)
        return {"success": True, **dashboard}
    except Exception as e:
        logger.error("Failed to build analytics summary for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=500, detail="Failed to build analytics summary.")