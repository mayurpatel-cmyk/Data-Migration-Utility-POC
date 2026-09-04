import logging
from fastapi import APIRouter, Depends, HTTPException
from app.api.dependencies.auth import get_current_user
from app.utils.config import supabase

logger = logging.getLogger(__name__)

router = APIRouter()

@router.get("/api/migration-history")
def get_migration_history(current_user = Depends(get_current_user)):
    try:
        response = supabase.table("migration_history") \
            .select("*") \
            .eq("user_id", current_user.id) \
            .order("created_at", desc=True) \
            .execute()
        return {"success": True, "history": response.data}
    except Exception as e:
        logger.error("Failed to fetch migration history for user %s: %s", current_user.id, e)
        raise HTTPException(status_code=500, detail="Failed to fetch migration history.")