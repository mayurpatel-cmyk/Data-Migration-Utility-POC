import os
import urllib.parse
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
import httpx
from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService

router = APIRouter()

# Global Environment Setup
ANGULAR_FRONTEND_URL = "http://localhost:4200"

# =========================================================
# SALESFORCE ROUTING
# =========================================================
@router.get("/auth/salesforce/login")
def get_salesforce_url(side: str, environment: str = "production", current_user = Depends(get_current_user)):
    """
    Angular calls this via http.get(). Returns a JSON object with the login URL.
    """
    domain = "test.salesforce.com" if environment.lower() == "sandbox" else "login.salesforce.com"
    custom_state = f"{side}::{current_user.id}::{environment}"
    
    params = {
        "response_type": "code",
        "client_id": os.getenv("SF_CONSUMER_KEY"),
        "redirect_uri": "http://localhost:8000/api/crm/auth/salesforce/callback",
        "prompt": "login",
        "scope": "api refresh_token offline_access",
        "state": custom_state
    }
    auth_url = f"https://{domain}/services/oauth2/authorize?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


# =========================================================
# ZOHO ROUTING (Aligned with Angular's ?side=...&region=...)
# =========================================================
@router.get("/auth/zoho/login")
def get_zoho_url(side: str, region: str = "IN", current_user = Depends(get_current_user)):
    """
    Constructs the entry route for multi-tenant Zoho installations.
    """
    # Pack parameters into state
    custom_state = f"{side}::{current_user.id}::{region}"
    
    scopes = ["ZohoCRM.modules.ALL", "ZohoCRM.bulk.READ", "ZohoCRM.settings.FIELDS.READ"]
    
    params = {
        "scope": ",".join(scopes),
        "client_id": os.getenv("ZOHO_CLIENT_ID"),
        "response_type": "code",
        "access_type": "offline",
        "redirect_uri": "http://localhost:8000/api/crm/auth/zoho/callback",
        "prompt": "consent",
        "state": custom_state
    }
    
    # Always initiate handshake at the global base domain (.com)
    auth_url = f"https://accounts.zoho.com/oauth/v2/auth?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


# =========================================================
# ZENDESK ROUTING (Aligned with Angular's ?side=...&subdomain=...)
# =========================================================
@router.get("/auth/zendesk/login")
def get_zendesk_url(side: str, subdomain: str, current_user = Depends(get_current_user)):
    """
    Handles localized subdomain redirections required by Zendesk instances.
    """
    if not subdomain:
        raise HTTPException(status_code=400, detail="Subdomain parameter is missing.")
        
    custom_state = f"{side}::{current_user.id}::{subdomain}"
    
    params = {
        "response_type": "code",
        "client_id": os.getenv("ZENDESK_CLIENT_ID"),
        "redirect_uri": "http://localhost:8000/api/crm/auth/zendesk/callback",
        "scope": "read write",
        "state": custom_state
    }
    
    auth_url = f"https://{subdomain}.zendesk.com/oauth/authorizations/new?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


# =========================================================
# CORE CONNECTIONS MANAGEMENT (Already configured)
# =========================================================
@router.get("/connections")
def get_connections(current_user = Depends(get_current_user)):
    return CrmService.get_user_connections(current_user.id)

@router.delete("/connections/{side}")
def disconnect_crm(side: str, current_user = Depends(get_current_user)):
    CrmService.delete_connection(current_user.id, side)
    return {"success": True}


