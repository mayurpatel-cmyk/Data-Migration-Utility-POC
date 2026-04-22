from fastapi import APIRouter, Request
from app.services.validator_service import process_validation_batch

router = APIRouter()

@router.post("/api/python/validate")
async def validate_batch(request: Request):
    payload = await request.json()
    records = payload.get("records", [])
    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    
    dynamic_country_map = payload.get("validCountries", {})
    dynamic_state_map = payload.get("validStates", {})
    
    # NEW: Extract the Describe API rules
    sf_rules = payload.get("sfRules", {})

    result = process_validation_batch(
        records, mappings, dedupe_key, dynamic_country_map, dynamic_state_map, sf_rules
    )
    
    return result