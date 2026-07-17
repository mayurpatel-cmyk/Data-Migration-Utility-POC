from fastapi import APIRouter, Depends, Request, HTTPException
from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.crm_metadata_service import CrmMetadataService
from app.services.crm_query_service import CrmQueryService
from app.services.ai_services import LocalAiService
import traceback
import re
import difflib

router = APIRouter()

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

# =========================================================
# HIGH-SPEED HYBRID AI AUTO-MAPPING WITH TOKEN ALIGNMENT
# =========================================================

def normalize_field_name(name: str) -> str:
    """Helper to strip symbols, underscores, and case for clean string comparisons."""
    if not name:
        return ""
    return re.sub(r'[^a-zA-Z0-9]', '', name).lower()

def tokenize_field(name: str) -> set:
    """Splits camelCase/snake_case into core semantic word tokens for fast identification."""
    if not name:
        return set()
    # Handle camelCase transitions (e.g., "firstName" -> "first Name")
    s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s1)
    words = re.sub(r'[^a-zA-Z0-9]', ' ', s2).lower().split()
    
    # Stemming: Truncate words to their base roots to align variations (e.g., billing/bill -> bill)
    roots = []
    for w in words:
        if w.endswith('ing'): w = w[:-3]
        elif w.endswith('ed'): w = w[:-2]
        elif w.endswith('tion'): w = w[:-4]
        if len(w) > 3:
            roots.append(w[:4])
        else:
            roots.append(w)
    return set(roots)

@router.post("/api/metadata/ai-auto-map")
async def ai_auto_map_fields(payload: dict, current_user = Depends(get_current_user)):
    """
    Advanced Token-Heuristic Pipeline. Instantly resolves field layouts using 
    in-memory word mechanics, leaving only deep semantic anomalies for the local SLM.
    """
    try:
        source_fields = payload.get("sourceFields")
        target_fields = payload.get("targetFields")
        
        if not source_fields or not target_fields:
            raise HTTPException(status_code=400, detail="Both sourceFields and targetFields arrays are required.")
            
        final_mappings = []
        unmapped_source = []
        
        # Pre-calculate target catalogs for fast lookup loops
        target_names = [t.get("name") for t in target_fields]
        target_lookup = {normalize_field_name(t.get("name")): t.get("name") for t in target_fields}
        
        target_tokens = []
        for t in target_fields:
            t_name = t.get("name")
            target_tokens.append({
                "name": t_name,
                "tokens": tokenize_field(t_name)
            })
        
        # 1. RUN FAST HEURISTIC ALIGNMENT (Executes in ~5 Milliseconds)
        for src in source_fields:
            src_name = src.get("name")
            src_norm = normalize_field_name(src_name)
            src_tok = tokenize_field(src_name)
            
            # Pass A: Perfect Text Normalization (e.g., "first_name" -> "FirstName")
            if src_norm in target_lookup:
                final_mappings.append({
                    "sourceField": src_name,
                    "targetField": target_lookup[src_norm],
                    "confidence": 1.0
                })
                continue
                
            # Pass B: Token Intersect Overlap (e.g., "mailing_street" -> "MailingStreetAddress")
            best_token_match = None
            max_overlap = 0
            for tgt in target_tokens:
                overlap = len(src_tok.intersection(tgt["tokens"]))
                if overlap > max_overlap:
                    max_overlap = overlap
                    best_token_match = tgt["name"]
                    
            if max_overlap >= 1 and best_token_match:
                final_mappings.append({
                    "sourceField": src_name,
                    "targetField": best_token_match,
                    "confidence": 0.90
                })
                continue

            # Pass C: Text Distance Fallback (Fuzzy typos / layout variations)
            close_matches = difflib.get_close_matches(src_name, target_names, n=1, cutoff=0.60)
            if close_matches:
                final_mappings.append({
                    "sourceField": src_name,
                    "targetField": close_matches[0],
                    "confidence": 0.80
                })
                continue
                
            # Only fields that completely fail textual heuristics go to the local AI
            unmapped_source.append({"name": src_name, "type": src.get("type", "string")})
                
        print(f"[HYBRID ENGINE]: Resolved {len(final_mappings)} fields instantly via fast token algorithms.")
        print(f"[HYBRID ENGINE]: Passing remaining {len(unmapped_source)} complex fields to local SLM...")

        # 2. LOCAL AI PHASE (Processes the tiny remaining fraction of fields)
        if unmapped_source:
            minimized_target = [{"name": f.get("name"), "type": f.get("type", "string")} for f in target_fields]
            
            # Small, single-batch call because the workload has been minimized
            CHUNK_SIZE = 35
            source_chunks = [unmapped_source[i:i + CHUNK_SIZE] for i in range(0, len(unmapped_source), CHUNK_SIZE)]
            
            for index, chunk in enumerate(source_chunks):
                print(f"[AI BATCH LOG]: Running local inference on batch {index + 1}...")
                res = await LocalAiService.generate_mapping(chunk, minimized_target)
                
                if isinstance(res, dict) and "mappings" in res:
                    final_mappings.extend(res["mappings"])

        print(f"[HYBRID ENGINE]: Complete! Safely returning {len(final_mappings)} mappings.")
        return {"mappings": final_mappings}

    except Exception as e:
        print("\n=== FATAL AI ROUTE CRASH ===")
        traceback.print_exc()
        print("============================\n")
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")