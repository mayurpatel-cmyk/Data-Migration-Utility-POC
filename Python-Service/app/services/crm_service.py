from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase
import os
import httpx

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

    @staticmethod
    async def refresh_crm_token(user_id: str, crm_type: str, role: str):
        """Silently exchanges an expired access_token for a new one using the refresh_token."""
        creds = CrmService.get_active_crm_credentials(user_id, crm_type, role)
        refresh_token = creds.get("refresh_token")
        
        if not refresh_token:
            raise HTTPException(status_code=401, detail="No refresh token available. Reconnect UI.")
        
        crm = crm_type.lower()
        new_access_token = None
        
        async with httpx.AsyncClient(verify=False) as client:
            if crm == "salesforce":
                domain = "test.salesforce.com" if creds.get("environment") == "sandbox" else "login.salesforce.com"
                res = await client.post(f"https://{domain}/services/oauth2/token", data={
                    "grant_type": "refresh_token",
                    "client_id": os.getenv("SF_CLIENT_ID"),
                    "client_secret": os.getenv("SF_CLIENT_SECRET"),
                    "refresh_token": refresh_token
                })
                if res.status_code == 200:
                    new_access_token = res.json().get("access_token")
                    
            elif crm == "zoho":
                accounts_server = creds.get("accounts_server", "https://accounts.zoho.com")
                res = await client.post(f"{accounts_server}/oauth/v2/token", data={
                    "grant_type": "refresh_token",
                    "client_id": os.getenv("ZOHO_CLIENT_ID"),
                    "client_secret": os.getenv("ZOHO_CLIENT_SECRET"),
                    "refresh_token": refresh_token
                })
                if res.status_code == 200:
                    new_access_token = res.json().get("access_token")
                    
        if new_access_token:
            # Save new token back to database
            supabase.table("crm_connections").update({"access_token": new_access_token}).eq("id", creds["id"]).execute()
            return new_access_token
            
        raise HTTPException(status_code=401, detail="Refresh token expired. Reconnect UI.")