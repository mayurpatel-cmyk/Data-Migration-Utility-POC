import httpx
import os
import math
import re
from fastapi import HTTPException
from typing import Dict, List, Any

OLLAMA_BASE_URL = "http://127.0.0.1:11434/api"
EMBEDDING_MODEL = "mxbai-embed-large" 

_TARGET_CACHE: Dict[str, List[float]] = {}

# ====================================================
# GLOBAL CRM SYNONYM
# ====================================================
CRM_FIELD_CONTEXT = {
    # --- Names & Identity ---
    "firstname": "first given name",
    "fname": "first given name",
    "lastname": "last family surname name",
    "lname": "last family surname name",
    "fullname": "full complete name",
    "company": "account company organization name",
    "accountname": "account company organization name",
    "title": "job title position role designation",
    
    # --- Contact Info ---
    "email": "email address electronic mail",
    "phone": "phone telephone mobile cell number",
    "mobile": "phone telephone mobile cell number",
    "fax": "fax facsimile number",
    "website": "website url domain link",
    
    # --- Addresses ---
    "billingstreet": "billing street address line 1 location",
    "billingcity": "billing city municipality",
    "billingstate": "billing state province region",
    "billingpostalcode": "billing postal zip code",
    "billingcountry": "billing country nation",
    "shippingstreet": "shipping delivery street address line 1",
    
    # --- Sales & Deals (Opportunities) ---
    "amount": "amount deal value revenue price",
    "stagename": "stage status phase pipeline",
    "dealstage": "stage status phase pipeline",
    "closedate": "close date expected timeline",
    "probability": "probability chance likelihood percent",
    "leadsource": "lead source origin channel",
    
    # --- Support & Tickets (Cases) ---
    "subject": "subject title issue summary",
    "description": "description details notes context",
    "priority": "priority urgency severity level",
    "status": "status state condition phase"
}


class LocalAiService:
    @staticmethod
    def _precompute_magnitude(vector: List[float]) -> float:
        """Helper to pre-calculate vector magnitude for faster loops."""
        return math.sqrt(sum(a * a for a in vector))

    @staticmethod
    def fast_cosine_similarity(v1: List[float], v2: List[float], mag1: float, mag2: float) -> float:
        """Optimized math function using pre-calculated magnitudes."""
        if mag1 * mag2 == 0:
            return 0.0
        dot_product = sum(a * b for a, b in zip(v1, v2))
        return dot_product / (mag1 * mag2)

    @staticmethod
    async def get_embeddings(texts: List[str]) -> List[List[float]]:
        """Fetches vector embeddings in batches from Ollama."""
        if not texts:
            return []
            
        payload = {
            "model": EMBEDDING_MODEL,
            "input": texts
        }
        
        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            try:
                response = await client.post(
                    f"{OLLAMA_BASE_URL}/embed", 
                    json=payload
                )
                
                if response.status_code != 200:
                    raise HTTPException(status_code=500, detail=f"Ollama Embed Error: {response.text}")
                
                return response.json().get("embeddings", [])
                
            except httpx.RequestError:
                raise HTTPException(status_code=503, detail="Cannot reach Ollama embedding service.")

    @staticmethod
    def prep_text(field: Dict[str, Any]) -> str:
        """
        Enriches raw field metadata with taxonomy synonyms, labels, 
        and descriptions to produce high-accuracy AI vectors.
        """
        if not isinstance(field, dict):
            return ""

        raw_name = field.get("name", "")
        label = field.get("label", "")
        desc = field.get("description", "")

        if not raw_name and not label:
            return ""

        clean_name = raw_name.replace('__c', '').replace('__r', '')
        s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1 \2', clean_name)
        base_string = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s1).replace('_', ' ').lower().strip()

        condensed_key = base_string.replace(' ', '')
        taxonomy_expansion = CRM_FIELD_CONTEXT.get(condensed_key, "")

        parts = []
        if taxonomy_expansion:
            parts.append(taxonomy_expansion)
        else:
            if base_string:
                parts.append(base_string)
            if label:
                clean_label = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', label).replace('_', ' ').lower().strip()
                if clean_label != base_string:
                    parts.append(clean_label)

        if desc:
            clean_desc = re.sub(r'[^a-zA-Z0-9\s]', ' ', str(desc)).lower().strip()[:80]
            parts.append(clean_desc)

        return " ".join(parts).strip()

    @staticmethod
    async def generate_mapping(source_fields: List[Dict[str, Any]], target_fields: List[Dict[str, Any]]) -> dict:
        if not source_fields or not target_fields:
            return {"mappings": []}

        # ====================================================
        #  FILTER OUT RESTRICTED SYSTEM FIELDS
        # ====================================================
        restricted_targets = {
            # General & Primary Keys
            'id', 'hs_object_id',
            
            # Salesforce
            'createddate', 'lastmodifieddate', 'createdbyid', 'lastmodifiedbyid', 'systemmodstamp',
            
            # HubSpot
            'hs_createdate', 'hs_lastmodifieddate', 'createdate', 'archived',
            
            # Zendesk
            'created_at', 'updated_at', 'submitter_id',
            
            # Zoho
            'created_time', 'modified_time', 'created_by', 'modified_by', '$state', '$process_flow',
            
            # General Fallbacks & Variations
            'createdat', 'updatedat', 'updateddate', 'deleted'
        }
        
        target_fields = [
            f for f in target_fields 
            if f.get("name", "").lower() not in restricted_targets
        ]

        if not target_fields:
            return {"mappings": []}

        src_texts = [LocalAiService.prep_text(f) for f in source_fields]
        tgt_texts = [LocalAiService.prep_text(f) for f in target_fields] 
        
        tgt_texts_to_fetch = []
        tgt_indices_to_fetch = []
        tgt_vectors = [None] * len(target_fields)

        for i, text in enumerate(tgt_texts):
            cache_key = text
            if cache_key in _TARGET_CACHE:
                tgt_vectors[i] = _TARGET_CACHE[cache_key]
            else:
                tgt_texts_to_fetch.append(cache_key)
                tgt_indices_to_fetch.append(i)

        src_vectors = await LocalAiService.get_embeddings(src_texts)
        
        if tgt_texts_to_fetch:
            new_tgt_vectors = await LocalAiService.get_embeddings(tgt_texts_to_fetch)
            for text, idx, vec in zip(tgt_texts_to_fetch, tgt_indices_to_fetch, new_tgt_vectors):
                tgt_vectors[idx] = vec
                _TARGET_CACHE[text] = vec 

        src_mags = [LocalAiService._precompute_magnitude(v) for v in src_vectors]
        tgt_mags = [LocalAiService._precompute_magnitude(v) for v in tgt_vectors]

        mappings = []
        claimed_targets = set() 
        all_potential_matches = []

        numeric_types = {'number', 'integer', 'double', 'currency', 'float', 'decimal', 'percent'}
        text_types = {'string', 'text', 'textarea', 'picklist', 'reference', 'id', 'url', 'phone', 'email'}
        date_types = {'date', 'datetime', 'timestamp'}
        bool_types = {'boolean', 'checkbox'}

        for idx_src, src_vec in enumerate(src_vectors):
            src_field = source_fields[idx_src]
            src_type = src_field.get("type", "string").lower()
            src_mag = src_mags[idx_src]
            
            for idx_tgt, tgt_vec in enumerate(tgt_vectors):
                tgt_field = target_fields[idx_tgt]
                tgt_type = tgt_field.get("type", "string").lower()

                is_exact_type = src_type == tgt_type
                is_forgiving = (
                    (src_type in text_types and tgt_type in text_types) or
                    (src_type in numeric_types and tgt_type in numeric_types) or
                    (src_type in date_types and tgt_type in date_types) or
                    (src_type in bool_types and tgt_type in bool_types)
                )

                if not (is_exact_type or is_forgiving):
                    continue

                similarity = LocalAiService.fast_cosine_similarity(src_vec, tgt_vec, src_mag, tgt_mags[idx_tgt])
                
                if src_texts[idx_src] == tgt_texts[idx_tgt]:
                    similarity += 0.20

                if is_exact_type:
                    similarity += 0.05 
                
                if similarity > 0.83:
                    all_potential_matches.append({
                        "sourceField": src_field.get("name"),
                        "targetField": tgt_field.get("name"),
                        "confidence": similarity
                    })

        all_potential_matches.sort(key=lambda x: x["confidence"], reverse=True)

        for match in all_potential_matches:
            if match["targetField"] not in claimed_targets:
                mappings.append({
                    "sourceField": match["sourceField"],
                    "targetField": match["targetField"],
                    "confidence": round(match["confidence"], 2)
                })
                claimed_targets.add(match["targetField"])
                
                if len(mappings) >= len(source_fields):
                    break

        return {"mappings": mappings}