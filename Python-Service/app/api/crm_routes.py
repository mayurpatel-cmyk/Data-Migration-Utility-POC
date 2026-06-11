import os
import urllib.parse
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
import httpx
from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.utils.config import supabase

router = APIRouter()

# =========================================================
# GLOBAL OAUTH ENVIRONMENT SETUP
# =========================================================
FASTAPI_BACKEND_URL = os.getenv("FASTAPI_BACKEND_URL", "http://localhost:8000").rstrip("/")
ANGULAR_FRONTEND_URL = os.getenv("ANGULAR_FRONTEND_URL", "http://localhost:4200").replace("/connection", "").rstrip("/")

SF_CLIENT_ID = os.getenv("SF_CLIENT_ID")
SF_CLIENT_SECRET = os.getenv("SF_CLIENT_SECRET")
SF_REDIRECT_URI = f"{FASTAPI_BACKEND_URL}/api/crm/auth/salesforce/callback"

ZD_CLIENT_ID = os.getenv("ZD_CLIENT_ID", "").strip()
ZD_CLIENT_SECRET = os.getenv("ZD_CLIENT_SECRET", "").strip()
ZD_REDIRECT_URI = f"{FASTAPI_BACKEND_URL}/api/crm/auth/zendesk/callback"

ZOHO_CLIENT_ID = os.getenv("ZOHO_CLIENT_ID", "").strip()
ZOHO_CLIENT_SECRET = os.getenv("ZOHO_CLIENT_SECRET", "").strip()
ZOHO_REDIRECT_URI = f"{FASTAPI_BACKEND_URL}/api/crm/auth/zoho/callback"

ZOHO_REGIONS = {
    "us": "https://accounts.zoho.com",
    "in": "https://accounts.zoho.in",
    "eu": "https://accounts.zoho.eu",
    "au": "https://accounts.zoho.com.au",
    "jp": "https://accounts.zoho.jp",
    "ca": "https://accounts.zohocloud.ca",
    "sa": "https://accounts.zoho.sa",
    "uk": "https://accounts.zoho.uk",
    "cn": "https://accounts.zoho.com.cn"
}

# =========================================================
# 1. SALESFORCE ROUTING (Login & Callback)
# =========================================================
@router.get("/auth/salesforce/login")
def get_salesforce_url(side: str, environment: str = "production", current_user = Depends(get_current_user)):
    domain = "test.salesforce.com" if environment.lower() == "sandbox" else "login.salesforce.com"
    custom_state = f"{side}::{current_user.id}::{environment}"
    
    params = {
        "response_type": "code",
        "client_id": SF_CLIENT_ID,
        "redirect_uri": SF_REDIRECT_URI,
        "prompt": "login",
        "scope": "api refresh_token offline_access",
        "state": custom_state
    }
    auth_url = f"https://{domain}/services/oauth2/authorize?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


@router.get("/auth/salesforce/callback")
async def salesforce_callback(code: str = None, state: str = None, error: str = None):
    if error or not code:
        return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    try:
        side, user_id, environment = state.split("::")
    except (ValueError, AttributeError):
        return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error&message=InvalidState")

    domain = "test.salesforce.com" if environment == "sandbox" else "login.salesforce.com"
    token_url = f"https://{domain}/services/oauth2/token"

    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "client_id": SF_CLIENT_ID,
        "client_secret": SF_CLIENT_SECRET,
        "redirect_uri": SF_REDIRECT_URI
    }

    async with httpx.AsyncClient(verify=False) as client:
        response = await client.post(token_url, data=payload)
        
        if response.status_code != 200:
            print(f"\n❌ OAUTH TOKEN ERROR: {response.text}\n")
            return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")
            
        token_data = response.json()
        access_token = token_data.get("access_token")
        refresh_token = token_data.get("refresh_token", "")
        instance_url = token_data.get("instance_url", "")

    try:
        supabase.table("crm_connections").delete().eq("user_id", user_id).eq("connection_role", side).execute()
        supabase.table("crm_connections").insert({
            "user_id": user_id,
            "crm_type": "salesforce",
            "connection_role": side,
            "access_token": access_token,
            "refresh_token": refresh_token,
            "instance_url": instance_url,
            "environment": environment
        }).execute()
    except Exception as database_error:
        print(f"Supabase Database storage failure event: {str(database_error)}")
        return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=success&side={side}&crm=salesforce")


# =========================================================
# 2. ZOHO ROUTING (Login & Callback)
# =========================================================
@router.get("/auth/zoho/login")
def get_zoho_url(side: str, region: str = "IN", current_user = Depends(get_current_user)):
    custom_state = f"{side}::{current_user.id}::{region}"
    scopes = ["ZohoCRM.modules.ALL", "ZohoCRM.bulk.READ", "ZohoCRM.settings.FIELDS.READ"]
    
    params = {
        "scope": ",".join(scopes),
        "client_id": ZOHO_CLIENT_ID,
        "response_type": "code",
        "access_type": "offline",
        "redirect_uri": ZOHO_REDIRECT_URI,
        "prompt": "consent",
        "state": custom_state
    }
    
    auth_url = f"https://accounts.zoho.com/oauth/v2/auth?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


@router.get("/auth/zoho/callback")
async def zoho_callback(code: str, state: str, request: Request):
    try:
        side, user_id, reg_key = state.split("::") 
    except ValueError:
        return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    base_accounts_url = ZOHO_REGIONS.get(reg_key.lower(), ZOHO_REGIONS["us"])
    accounts_server = request.query_params.get("accounts-server", base_accounts_url)
    
    async with httpx.AsyncClient(verify=False) as client:
        response = await client.post(f"{accounts_server}/oauth/v2/token", data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": ZOHO_CLIENT_ID,
            "client_secret": ZOHO_CLIENT_SECRET,
            "redirect_uri": ZOHO_REDIRECT_URI
        })
        
        if response.status_code != 200:
            return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")
            
        token_data = response.json()
        access_token = token_data.get("access_token")
        api_domain = token_data.get("api_domain", "https://www.zohoapis.com")
        
        try:
            supabase.table("crm_connections").delete().eq("user_id", user_id).eq("connection_role", side).execute()
            supabase.table("crm_connections").insert({
                "user_id": user_id,
                "crm_type": "zoho",
                "connection_role": side,
                "access_token": access_token,
                "refresh_token": token_data.get("refresh_token", ""),
                "instance_url": api_domain,
                "region": reg_key
            }).execute()
        except Exception as e:
            print(f"Supabase error: {str(e)}")
            return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=success&side={side}&crm=zoho")


# =========================================================
# 3. ZENDESK ROUTING (Login & Callback)
# =========================================================
@router.get("/auth/zendesk/login")
def get_zendesk_url(side: str, subdomain: str, current_user = Depends(get_current_user)):
    if not subdomain:
        raise HTTPException(status_code=400, detail="Subdomain parameter is missing.")
        
    custom_state = f"{side}::{current_user.id}::{subdomain}"
    
    params = {
        "response_type": "code",
        "client_id": ZD_CLIENT_ID,
        "redirect_uri": ZD_REDIRECT_URI,
        "scope": "read write",
        "state": custom_state
    }
    
    auth_url = f"https://{subdomain}.zendesk.com/oauth/authorizations/new?{urllib.parse.urlencode(params)}"
    return {"url": auth_url}


@router.get("/auth/zendesk/callback")
async def zendesk_callback(code: str, state: str):
    try:
        side, user_id, subdomain = state.split("::")
    except ValueError:
        return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    async with httpx.AsyncClient(verify=False) as client:
        response = await client.post(f"https://{subdomain}.zendesk.com/oauth/tokens", json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": ZD_CLIENT_ID,
            "client_secret": ZD_CLIENT_SECRET,
            "redirect_uri": ZD_REDIRECT_URI,
            "scope": "read write"
        })
        
        if response.status_code != 200:
            return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")
            
        token_data = response.json()
        access_token = token_data.get("access_token")

        try:
            supabase.table("crm_connections").delete().eq("user_id", user_id).eq("connection_role", side).execute()
            supabase.table("crm_connections").insert({
                "user_id": user_id,
                "crm_type": "zendesk",
                "connection_role": side,
                "access_token": access_token,
                "subdomain": subdomain
            }).execute()
        except Exception as e:
            print(f"Supabase error: {str(e)}")
            return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=error")

    return RedirectResponse(url=f"{ANGULAR_FRONTEND_URL}/connection?status=success&side={side}&crm=zendesk")


# =========================================================
# CORE CONNECTIONS MANAGEMENT
# =========================================================
@router.get("/connections")
def get_connections(current_user = Depends(get_current_user)):
    return CrmService.get_user_connections(current_user.id)

@router.delete("/connections/{side}")
def disconnect_crm(side: str, current_user = Depends(get_current_user)):
    CrmService.delete_connection(current_user.id, side)
    return {"success": True}