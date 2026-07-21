from fastapi import APIRouter, Depends, HTTPException
from app.api.dependencies.auth import get_current_user
from app.utils.config import supabase

# 1. Initialize the router here so FastAPI knows what 'router' is
router = APIRouter()

@router.get("/api/migration-history")
def get_migration_history(current_user = Depends(get_current_user)):
    try:
        # Fetch only the history for the currently logged-in user
        response = supabase.table("migration_history") \
            .select("*") \
            .eq("user_id", current_user.id) \
            .order("created_at", desc=True) \
            .execute()
        return {"success": True, "history": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))