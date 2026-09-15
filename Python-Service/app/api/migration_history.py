import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from app.api.dependencies.auth import get_current_user
from app.utils.config import supabase
from app.services.analytics_service import AnalyticsService

logger = logging.getLogger(__name__)

router = APIRouter()


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
        response = query.order("created_at", desc=True).execute()
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
        response = query.order("created_at", desc=True).execute()
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
        migration_rows = migration_query.order("created_at", desc=True).execute().data

        validation_query = supabase.table("validation_history").select("*").eq("user_id", current_user.id)
        validation_query = _apply_common_filters(validation_query, source_crm, target_crm, target_object, start_date, end_date)
        validation_rows = validation_query.order("created_at", desc=True).execute().data

        dashboard = AnalyticsService.build_dashboard(migration_rows, validation_rows)
        return {"success": True, **dashboard}
    except Exception as e:
        logger.error("Failed to build analytics summary for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=500, detail="Failed to build analytics summary.")