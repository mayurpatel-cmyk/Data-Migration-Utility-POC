from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase

class CrmService:
    @staticmethod
    def get_user_connections(user_id: str):
        print(f"\n--- DATABASE CHECK ---")
        print(f"Connecting to: {supabase.supabase_url}")
        
        try:
            response = supabase.table("crm_connections").select("*").eq("user_id", user_id).execute()
            return response.data
        except Exception as e:
            print(f"Crash details: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")

    @staticmethod
    def delete_connection(user_id: str, side: str):
        try:
            # Delete the specific connection slot (source or target) for this user
            response = supabase.table("crm_connections").delete().eq("user_id", user_id).eq("connection_role", side).execute()
            return response.data
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    
    @staticmethod
    def get_active_crm_credentials(user_id: str, crm_type: str, role: str):
        """
        Fetches the secure CRM credentials for a user directly from the database.
        """
        response = supabase.table("crm_connections") \
            .select("*") \
            .eq("user_id", user_id) \
            .eq("crm_type", crm_type.lower()) \
            .eq("connection_role", role.lower()) \
            .execute()
            
        if not response.data or len(response.data) == 0:
            raise HTTPException(status_code=404, detail=f"No active database connection found for {crm_type} ({role}).")
            
        return response.data[0]