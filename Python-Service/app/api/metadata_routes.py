import json
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, Request, HTTPException
from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.crm_metadata_service import CrmMetadataService
from app.services.crm_query_service import CrmQueryService

router = APIRouter()
PROJECT_ROOT = Path(__file__).resolve().parents[3]
MAPPING_AGENT_PATH = PROJECT_ROOT / 'mapping-agent.js'

# =========================================================
# FETCH OBJECTS DYNAMICALLY (With Silent Token Refresh)
# =========================================================
@router.get("/api/metadata/{crm_id}/objects")
async def get_crm_objects(crm_id: str, role: str = "source", current_user = Depends(get_current_user)):
    crm_lower = crm_id.lower()
    
    # Securely grab credentials from Database using Supabase Auth token
    creds = CrmService.get_active_crm_credentials(current_user.id, crm_lower, role)

    async def _fetch(token):
        if crm_lower == "salesforce":
            return await CrmMetadataService.fetch_salesforce_objects(token, creds.get("instance_url"))
        elif crm_lower == "zendesk":
            return await CrmMetadataService.fetch_zendesk_objects(token, creds.get("subdomain"))
        elif crm_lower == "zoho":
            return await CrmMetadataService.fetch_zoho_objects(token, creds.get("api_domain"))
        elif crm_lower == "hubspot":
            return await CrmMetadataService.fetch_hubspot_objects(token, creds.get("api_domain", "https://api.hubapi.com"))
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM")

    try:
        return await _fetch(creds["access_token"])
    except HTTPException as e:
        # If the CRM rejects the token, silently refresh it and retry!
        if e.status_code == 401:
            new_token = await CrmService.refresh_crm_token(current_user.id, crm_lower, role)
            return await _fetch(new_token)
        raise e

# =========================================================
# FETCH FIELDS DYNAMICALLY (With Silent Token Refresh)
# =========================================================
@router.get("/api/metadata/{crm_id}/fields/{object_name}")
async def get_crm_fields(crm_id: str, object_name: str, role: str = "source", current_user = Depends(get_current_user)):
    crm_lower = crm_id.lower()
    creds = CrmService.get_active_crm_credentials(current_user.id, crm_lower, role)

    async def _fetch(token):
        if crm_lower == "salesforce":
            return await CrmMetadataService.fetch_salesforce_fields(token, creds.get("instance_url"), object_name)
        elif crm_lower == "zendesk":
            return await CrmMetadataService.fetch_zendesk_fields(token, creds.get("subdomain"), object_name)
        elif crm_lower == "zoho":
            return await CrmMetadataService.fetch_zoho_fields(token, creds.get("api_domain"), object_name)
        elif crm_lower == "hubspot":
            return await CrmMetadataService.fetch_hubspot_fields(token, creds.get("api_domain", "https://api.hubapi.com"), object_name)
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM")

    try:
        return await _fetch(creds["access_token"])
    except HTTPException as e:
        # If the CRM rejects the token, silently refresh it and retry!
        if e.status_code == 401:
            new_token = await CrmService.refresh_crm_token(current_user.id, crm_lower, role)
            return await _fetch(new_token)
        raise e

@router.post("/api/metadata/auto-map")
async def auto_map_fields(request: Request, current_user = Depends(get_current_user)):
    payload = await request.json()
    source_fields = payload.get('sourceFields', []) or []
    target_fields = payload.get('targetFields', []) or []

    if not source_fields or not target_fields:
        raise HTTPException(status_code=400, detail='sourceFields and targetFields are required.')

    source_names = [str(field) for field in source_fields if field]
    target_names = [str(field) for field in target_fields if field]

    command = ['node', str(MAPPING_AGENT_PATH), '--json', '--source', ','.join(source_names), '--target', ','.join(target_names)]
    if payload.get('useFastMode'):
        command.append('--fast')

    model = payload.get('model')
    if model:
        command.extend(['--model', str(model)])

    completed_process = subprocess.run(
        command,
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=45
    )

    if completed_process.returncode != 0:
        raise HTTPException(status_code=500, detail=(completed_process.stderr or completed_process.stdout).strip() or 'Auto mapping failed.')

    try:
        output_text = completed_process.stdout.strip()
        if not output_text:
            raise ValueError('No output')
        return json.loads(output_text)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f'Unable to parse auto-mapping response: {exc}') from exc

# =========================================================
# RUN PREVIEW QUERY DYNAMICALLY (With Silent Token Refresh)
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

    async def _fetch(token):
        # Temporarily inject the new token into the creds dictionary for the query service
        creds["access_token"] = token 
        
        if crm_id == "salesforce":
            return await CrmQueryService.execute_salesforce_query(creds, obj_name, query, headers_list, limit)
        elif crm_id == "zendesk":
            return await CrmQueryService.execute_zendesk_query(creds, obj_name, query, limit)
        elif crm_id == "zoho":
            return await CrmQueryService.execute_zoho_query(creds, obj_name, query, headers_list, limit)
        elif crm_id == "hubspot":
            return await CrmQueryService.execute_hubspot_query(creds, obj_name, query, headers_list, limit)
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM Engine")

    try:
        return await _fetch(creds["access_token"])
    except HTTPException as e:
        # If the CRM rejects the token, silently refresh it and retry!
        if e.status_code == 401:
            new_token = await CrmService.refresh_crm_token(current_user.id, crm_id, role)
            return await _fetch(new_token)
        raise e