from fastapi import APIRouter, Depends, Request, HTTPException
from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.crm_metadata_service import CrmMetadataService
from app.services.crm_query_service import CrmQueryService

router = APIRouter()

# =========================================================
# FETCH OBJECTS DYNAMICALLY
# =========================================================
@router.get("/api/metadata/{crm_id}/objects")
async def get_crm_objects(crm_id: str, role: str = "source", current_user = Depends(get_current_user)):
    crm_lower = crm_id.lower()
    
    # Securely grab credentials from Database using Supabase Auth token
    creds = CrmService.get_active_crm_credentials(current_user.id, crm_lower, role)

    if crm_lower == "salesforce":
        return await CrmMetadataService.fetch_salesforce_objects(creds["access_token"], creds["instance_url"])
    elif crm_lower == "zendesk":
        return await CrmMetadataService.fetch_zendesk_objects(creds["access_token"], creds["subdomain"])
    elif crm_lower == "zoho":
        # Note: You'll need to slightly update your `fetch_zoho_objects` in CrmMetadataService to just take (token, domain)
        return await CrmMetadataService.fetch_zoho_objects(creds["access_token"], creds["api_domain"])
    else:
        raise HTTPException(status_code=400, detail="Unsupported CRM")

# =========================================================
# FETCH FIELDS DYNAMICALLY
# =========================================================
@router.get("/api/metadata/{crm_id}/fields/{object_name}")
async def get_crm_fields(crm_id: str, object_name: str, role: str = "source", current_user = Depends(get_current_user)):
    crm_lower = crm_id.lower()
    creds = CrmService.get_active_crm_credentials(current_user.id, crm_lower, role)

    if crm_lower == "salesforce":
        return await CrmMetadataService.fetch_salesforce_fields(creds["access_token"], creds["instance_url"], object_name)
    elif crm_lower == "zendesk":
        return await CrmMetadataService.fetch_zendesk_fields(creds["access_token"], creds["subdomain"], object_name)
    elif crm_lower == "zoho":
        return await CrmMetadataService.fetch_zoho_fields(creds["access_token"], creds["api_domain"], object_name)
    else:
        raise HTTPException(status_code=400, detail="Unsupported CRM")

# =========================================================
# RUN PREVIEW QUERY DYNAMICALLY
# =========================================================
@router.post("/api/metadata/preview-filter")
async def get_filtered_preview(request: Request, current_user = Depends(get_current_user)):
    payload = await request.json()
    
    crm_id = payload.get("crmId", "").lower()
    obj_name = payload.get("objectName", "")
    query = payload.get("query", "").strip()
    headers_list = payload.get("headers", [])
    limit = int(payload.get("limit", 5))
    role = payload.get("role", "source")

    if not obj_name:
        raise HTTPException(status_code=400, detail="Object name is required.")

    # Securely grab credentials from Database
    creds = CrmService.get_active_crm_credentials(current_user.id, crm_id, role)

    if crm_id == "salesforce":
        return await CrmQueryService.execute_salesforce_query(creds, obj_name, query, headers_list, limit)
    elif crm_id == "zendesk":
        return await CrmQueryService.execute_zendesk_query(creds, obj_name, query, limit)
    elif crm_id == "zoho":
        return await CrmQueryService.execute_zoho_query(creds, obj_name, query, headers_list, limit)
    else:
        raise HTTPException(status_code=400, detail="Unsupported CRM Engine")