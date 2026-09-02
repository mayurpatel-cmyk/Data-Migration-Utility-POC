import logging
import re
import difflib
from typing import List, Dict, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.crm_metadata_service import CrmMetadataService
from app.services.crm_query_service import CrmQueryService
from app.services.ai_services import LocalAiService

logger = logging.getLogger(__name__)
router = APIRouter()

# =========================================================
# FETCH OBJECTS DYNAMICALLY (With Silent Token Refresh)
# =========================================================
@router.get("/api/metadata/{crm_id}/objects")
async def get_crm_objects(crm_id: str, role: str = "source", current_user = Depends(get_current_user)):
    crm_lower = crm_id.lower()

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
        if e.status_code == 401:
            new_token = await CrmService.refresh_crm_token(current_user.id, crm_lower, role)
            return await _fetch(new_token)
        raise e

# =========================================================
# RUN PREVIEW QUERY DYNAMICALLY (With Silent Token Refresh)
# =========================================================
class PreviewFilterPayload(BaseModel):
    crmId: str
    objectName: str
    query: str = ""
    headers: List[str] = Field(default_factory=list)
    limit: int = 5
    role: str = "source"
    migrationTimeFilter: Optional[Dict[str, Any]] = None 

@router.post("/api/metadata/preview-filter")
async def get_filtered_preview(payload: PreviewFilterPayload, current_user = Depends(get_current_user)):
    crm_id = payload.crmId.lower()
    obj_name = payload.objectName
    query = payload.query.strip()
    headers_list = payload.headers
    limit = payload.limit
    role = payload.role

    if not obj_name:
        raise HTTPException(status_code=400, detail="Object name is required.")

    creds = CrmService.get_active_crm_credentials(current_user.id, crm_id, role)

    async def _fetch(token):
        creds["access_token"] = token

        if crm_id == "salesforce":
            return await CrmQueryService.execute_salesforce_query(creds, obj_name, query, headers_list, limit,payload.migrationTimeFilter)
        elif crm_id == "zendesk":
            return await CrmQueryService.execute_zendesk_query(creds, obj_name, query, limit, payload.migrationTimeFilter)
        elif crm_id == "zoho":
            return await CrmQueryService.execute_zoho_query(creds, obj_name, query, headers_list, limit,payload.migrationTimeFilter)
        elif crm_id == "hubspot":
            return await CrmQueryService.execute_hubspot_query(creds, obj_name, query, headers_list, limit, payload.migrationTimeFilter)
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM Engine")

    try:
        return await _fetch(creds["access_token"])
    except HTTPException as e:
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
    s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1 \2', name)
    s2 = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s1)
    words = re.sub(r'[^a-zA-Z0-9]', ' ', s2).lower().split()

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

class FieldMeta(BaseModel):
    name: str
    type: str = "string"

class AiAutoMapPayload(BaseModel):
    sourceFields: List[FieldMeta]
    targetFields: List[FieldMeta]

@router.post("/api/metadata/ai-auto-map")
async def ai_auto_map_fields(payload: AiAutoMapPayload, current_user = Depends(get_current_user)):
    """
    Advanced Token-Heuristic Pipeline. Instantly resolves field layouts using
    in-memory word mechanics, leaving only deep semantic anomalies for the local SLM.
    """
    try:
        source_fields = [f.model_dump() for f in payload.sourceFields]
        raw_target_fields = [f.model_dump() for f in payload.targetFields]

        if not source_fields or not raw_target_fields:
            raise HTTPException(status_code=400, detail="Both sourceFields and targetFields arrays are required.")

        # ====================================================
        #  FILTER OUT RESTRICTED SYSTEM FIELDS FOR THE HYBRID ENGINE
        # ====================================================
        restricted_targets = {
            'id', 'hs_object_id', 'url',
            'createddate', 'lastmodifieddate', 'createdbyid', 'lastmodifiedbyid', 'systemmodstamp',
            'hs_createdate', 'hs_lastmodifieddate', 'createdate', 'archived',
            'created_at', 'updated_at', 'submitter_id',
            'created_time', 'modified_time', 'created_by', 'modified_by', '$state', '$process_flow',
            'createdat', 'updatedat', 'updateddate', 'deleted'
        }

        target_fields = [
            t for t in raw_target_fields
            if t.get("name", "").lower() not in restricted_targets
            and t.get("type", "").lower() not in ['reference', 'id']
        ]
        source_fields = [
            s for s in source_fields
            if s.get("type", "").lower() not in ['reference', 'id']
        ]

        final_mappings = []
        unmapped_source = []

        target_names = [t.get("name") for t in target_fields]
        target_lookup = {normalize_field_name(t.get("name")): t.get("name") for t in target_fields}

        target_tokens = []
        for t in target_fields:
            t_name = t.get("name")
            target_tokens.append({
                "name": t_name,
                "tokens": tokenize_field(t_name)
            })
        for src in source_fields:
            src_name = src.get("name")
            src_type = src.get("type", "string")
            src_norm = normalize_field_name(src_name)
            src_tok = tokenize_field(src_name)

            if src_norm in target_lookup:
                tgt_name = target_lookup[src_norm]
                tgt_meta = next((t for t in target_fields if t.get("name") == tgt_name), {})

                if src_type == tgt_meta.get("type", "string"):
                    final_mappings.append({
                        "sourceField": src_name,
                        "targetField": tgt_name,
                        "confidence": 1.0
                    })
                    continue

            best_token_match = None
            max_overlap = 0
            for tgt in target_tokens:
                tgt_meta = next((t for t in target_fields if t.get("name") == tgt["name"]), {})
                if src_type != tgt_meta.get("type", "string"):
                    continue

                overlap = len(src_tok.intersection(tgt["tokens"]))
                if overlap > max_overlap:
                    max_overlap = overlap
                    best_token_match = tgt["name"]

            if max_overlap >= 2 and best_token_match:
                final_mappings.append({
                    "sourceField": src_name,
                    "targetField": best_token_match,
                    "confidence": 0.85
                })
                continue

            close_matches = difflib.get_close_matches(src_name, target_names, n=1, cutoff=0.75)
            if close_matches:
                tgt_meta = next((t for t in target_fields if t.get("name") == close_matches[0]), {})
                if src_type == tgt_meta.get("type", "string"):
                    final_mappings.append({
                        "sourceField": src_name,
                        "targetField": close_matches[0],
                        "confidence": 0.75
                    })
                    continue

            unmapped_source.append({"name": src_name, "type": src_type})

        logger.info(
            "[HYBRID ENGINE] Resolved %d fields via fast token algorithms; %d remain for local SLM.",
            len(final_mappings), len(unmapped_source)
        )

        if unmapped_source:
            mapped_target_names = [m["targetField"] for m in final_mappings if "targetField" in m]

            minimized_target = [
                {"name": f.get("name"), "type": f.get("type", "string")}
                for f in target_fields
                if f.get("name") not in mapped_target_names
            ]

            CHUNK_SIZE = 10
            source_chunks = [unmapped_source[i:i + CHUNK_SIZE] for i in range(0, len(unmapped_source), CHUNK_SIZE)]

            for index, chunk in enumerate(source_chunks):
                logger.debug("[AI BATCH] Running local inference on batch %d...", index + 1)
                res = await LocalAiService.generate_mapping(chunk, minimized_target)

                if isinstance(res, dict) and "mappings" in res:
                    final_mappings.extend(res["mappings"])

        logger.info("[HYBRID ENGINE] Complete: returning %d mappings.", len(final_mappings))
        return {"mappings": final_mappings}

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("AI auto-map route crashed")
        raise HTTPException(status_code=500, detail="Internal Server Error while generating field mappings.")