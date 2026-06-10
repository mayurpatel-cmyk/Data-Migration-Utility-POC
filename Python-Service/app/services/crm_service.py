from app.utils.config import supabase
from fastapi import HTTPException

class CrmService:
    @staticmethod
    def get_user_connections(user_id: str):
        try:
            # Fetch all connections belonging to this specific user
            response = supabase.table("crm_connections").select("*").eq("user_id", user_id).execute()
            return response.data
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

    @staticmethod
    def delete_connection(user_id: str, side: str):
        try:
            # Delete the specific connection slot (source or target) for this user
            response = supabase.table("crm_connections").delete().eq("user_id", user_id).eq("connection_role", side).execute()
            return response.data
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")