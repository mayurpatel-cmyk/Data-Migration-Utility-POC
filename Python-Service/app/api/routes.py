import json
import os
import tempfile
import shutil
import urllib.parse 
import pandas as pd
from openpyxl import load_workbook
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Request, Query, Header 
from fastapi.responses import RedirectResponse
import httpx  
from dotenv import load_dotenv # <--- ADDED: To load environment variables

from app.services.validator_service import process_validation_batch
from app.services.crm_metadata_service import CrmMetadataService

# Load environment variables from .env file
load_dotenv()

router = APIRouter()

# =========================================================
# OAUTH CONFIGURATION (Loaded safely from .env)
# =========================================================
ANGULAR_FRONTEND_URL = os.getenv("ANGULAR_FRONTEND_URL", "http://localhost:4200/connection")
FASTAPI_BACKEND_URL = os.getenv("FASTAPI_BACKEND_URL", "http://localhost:8000")

SF_CLIENT_ID = os.getenv("SF_CLIENT_ID", "").strip()
SF_CLIENT_SECRET = os.getenv("SF_CLIENT_SECRET", "").strip()
SF_REDIRECT_URI = f"{FASTAPI_BACKEND_URL}/api/auth/salesforce/callback"

ZD_CLIENT_ID = os.getenv("ZD_CLIENT_ID", "").strip()
ZD_CLIENT_SECRET = os.getenv("ZD_CLIENT_SECRET", "").strip()
ZD_REDIRECT_URI = f"{FASTAPI_BACKEND_URL}/api/auth/zendesk/callback"


# =========================================================
# ROUTE: DYNAMIC OAUTH LOGIN INITIALIZATION
# =========================================================
@router.get("/api/auth/{crm_id}/login")
async def crm_oauth_login(
    crm_id: str, 
    side: str = Query(...),  # 'source' or 'target'
    subdomain: str = Query(None)  # Required only for zendesk
):
    crm_id_lower = crm_id.lower()
    
    if crm_id_lower == "salesforce":
        params = {
            "client_id": SF_CLIENT_ID,
            "redirect_uri": SF_REDIRECT_URI,
            "response_type": "code",
            "state": side
        }
        query_string = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        auth_url = f"https://login.salesforce.com/services/oauth2/authorize?{query_string}"
        return RedirectResponse(auth_url)

    elif crm_id_lower == "zendesk":
        if not subdomain:
            raise HTTPException(status_code=400, detail="Zendesk requires a subdomain parameter.")
        
        params = {
            "client_id": ZD_CLIENT_ID,
            "redirect_uri": ZD_REDIRECT_URI,
            "response_type": "code",
            "state": f"{side}:{subdomain}",
            "scope": "read write",
        }
        query_string = urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        auth_url = f"https://{subdomain.strip()}.zendesk.com/oauth/authorizations/new?{query_string}"
        return RedirectResponse(auth_url)

    raise HTTPException(status_code=400, detail=f"CRM engine '{crm_id}' is not yet supported via OAuth.")


# =========================================================
# ROUTE: SALESFORCE OAUTH CALLBACK
# =========================================================
@router.get("/api/auth/salesforce/callback")
async def salesforce_callback(code: str, state: str):
    async with httpx.AsyncClient() as client:
        response = await client.post("https://login.salesforce.com/services/oauth2/token", data={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": SF_CLIENT_ID,
            "client_secret": SF_CLIENT_SECRET,
            "redirect_uri": SF_REDIRECT_URI
        })
        
        if response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to retrieve token from Salesforce.")
            
        token_data = response.json()
        access_token = token_data.get("access_token")
        instance_url = token_data.get("instance_url", "")
        
        safe_instance_url = urllib.parse.quote(instance_url)

    return RedirectResponse(f"{ANGULAR_FRONTEND_URL}?connected_side={state}&crm=salesforce&access_token={access_token}&instance_url={safe_instance_url}")


# =========================================================
# ROUTE: ZENDESK OAUTH CALLBACK
# =========================================================
@router.get("/api/auth/zendesk/callback")
async def zendesk_callback(code: str, state: str):
    try:
        side, subdomain = state.split(":")
    except ValueError:
        raise HTTPException(status_code=400, detail="State parameter verification corruption.")

    async with httpx.AsyncClient() as client:
        response = await client.post(f"https://{subdomain}.zendesk.com/oauth/tokens", json={
            "grant_type": "authorization_code",
            "code": code,
            "client_id": ZD_CLIENT_ID,
            "client_secret": ZD_CLIENT_SECRET,
            "redirect_uri": ZD_REDIRECT_URI,
            "scope": "read write"
        })
        
        if response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to retrieve token from Zendesk.")
            
        token_data = response.json()

    access_token = token_data.get("access_token")
    return RedirectResponse(f"{ANGULAR_FRONTEND_URL}?connected_side={side}&crm=zendesk&access_token={access_token}")


# ==========================================
# ROUTE 1: FAST HEADER EXTRACTION
# ==========================================
@router.post("/api/python/extract-headers")
async def extract_headers(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    temp_file_name = temp_file.name
    temp_file.close() 
    
    try:
        with open(temp_file_name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        sheets = []
        headers_map = {}

        if ext == '.csv':
            df = pd.read_csv(temp_file_name, nrows=0)
            sheets = ["Sheet1"]
            headers_map["Sheet1"] = df.columns.tolist()
            
        elif ext in ['.xlsx', '.xls']:
            wb = load_workbook(temp_file_name, read_only=True, data_only=True)
            sheets = wb.sheetnames
            for sheet in sheets:
                ws = wb[sheet]
                first_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), [])
                headers_map[sheet] = [str(h) if h is not None else f"Unnamed_{i}" for i, h in enumerate(first_row)]
            wb.close()
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format.")

        return {
            "sheets": sheets,
            "headersMap": headers_map
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        file.file.close()
        if os.path.exists(temp_file_name):
            try:
                os.remove(temp_file_name)
            except PermissionError:
                pass


# ==========================================
# ROUTE 2: MASSIVE DATA VALIDATION (CHUNKS)
# ==========================================
@router.post("/api/python/validate")
async def validate_batch(
    file: UploadFile = File(...),
    config: str = Form(...) 
):
    try:
        payload = json.loads(config)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid configuration format")

    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    sheet_name = payload.get("sheetName", "")
    sf_rules = payload.get("sfRules", {})
    date_format = payload.get("dateFormat", "")

    ext = os.path.splitext(file.filename)[1].lower()

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    temp_file_name = temp_file.name
    temp_file.close()

    try:
        with open(temp_file_name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        total_count = 0
        total_valid = 0
        total_invalid_count = 0
        total_duplicates = 0
        all_invalid_records = []
        all_valid_records = []

        if ext == '.csv':
            chunk_iterator = pd.read_csv(temp_file_name, chunksize=10000)
            
            for chunk_df in chunk_iterator:
                chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                chunk_records = chunk_df.to_dict(orient="records")
                
                result = process_validation_batch(
                    records=chunk_records, mappings=mappings, dedupe_key=dedupe_key, 
                    sf_rules=sf_rules, date_format=date_format
                )
                
                total_count += result["stats"]["total"]
                total_valid += result["stats"]["valid"]
                total_invalid_count += result["stats"]["invalid"]
                total_duplicates += result["stats"]["duplicates"]
                all_invalid_records.extend(result["invalidRecords"])
                all_valid_records.extend(result["validRecords"])

        elif ext in ['.xlsx', '.xls']:
            wb = load_workbook(temp_file_name, read_only=True, data_only=True)
            ws = wb[sheet_name] if sheet_name in wb.sheetnames else wb.active
            
            rows_iter = ws.iter_rows(values_only=True)
            headers_raw = next(rows_iter, [])
            headers = [str(h) if h is not None else f"Unnamed_{i}" for i, h in enumerate(headers_raw)]

            chunk_records = []
            
            for row in rows_iter:
                if not any(row): continue 
                
                chunk_records.append(dict(zip(headers, row)))
                
                if len(chunk_records) == 10000:
                    chunk_df = pd.DataFrame(chunk_records)
                    chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                    
                    result = process_validation_batch(
                        records=chunk_df.to_dict(orient="records"), mappings=mappings, dedupe_key=dedupe_key,  
                        sf_rules=sf_rules, date_format=date_format
                    )
                    
                    total_count += result["stats"]["total"]
                    total_valid += result["stats"]["valid"]
                    total_invalid_count += result["stats"]["invalid"]
                    total_duplicates += result["stats"]["duplicates"]
                    all_invalid_records.extend(result["invalidRecords"])
                    all_valid_records.extend(result["validRecords"])
                    
                    chunk_records = []
            
            if chunk_records:
                chunk_df = pd.DataFrame(chunk_records)
                chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                
                result = process_validation_batch(
                    records=chunk_df.to_dict(orient="records"), mappings=mappings, dedupe_key=dedupe_key,  
                    sf_rules=sf_rules, date_format=date_format
                )
                
                total_count += result["stats"]["total"]
                total_valid += result["stats"]["valid"]
                total_invalid_count += result["stats"]["invalid"]
                total_duplicates += result["stats"]["duplicates"]
                all_invalid_records.extend(result["invalidRecords"])
                all_valid_records.extend(result["validRecords"])
                
            wb.close()

        return {
            "stats": {
                "total": total_count,
                "valid": total_valid,
                "invalid": total_invalid_count,
                "duplicates": total_duplicates
            },
            "invalidRecords": all_invalid_records,
            "validRecords": all_valid_records
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        file.file.close()
        if os.path.exists(temp_file_name):
            try:
                os.remove(temp_file_name)
            except PermissionError:
                pass


# ==========================================
# ROUTE 3: QUICK RE-VALIDATION (JSON)
# ==========================================
@router.post("/api/python/revalidate")
async def revalidate_batch_json(request: Request):
    payload = await request.json()
    records = payload.get("records", [])
    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    sf_rules = payload.get("sfRules", {})
    date_format = payload.get("dateFormat", "")

    result = process_validation_batch(
        records=records, 
        mappings=mappings, 
        dedupe_key=dedupe_key,  
        sf_rules=sf_rules,
        date_format=date_format
    )
    
    return result


# =========================================================
# ROUTE: FETCH DYNAMIC CRM CORE ENTITIES / OBJECT LIST
# =========================================================
@router.get("/api/metadata/{crm_id}/objects")
async def get_crm_objects(
    crm_id: str,
    sf_token: str = Header(None, alias="sf-token"),
    sf_instance_url: str = Header(None, alias="sf-instance-url"),
    zd_token: str = Header(None, alias="zd-token"),
    zd_subdomain: str = Header(None, alias="zd-subdomain")
):
    crm_lower = crm_id.lower()
    
    if crm_lower == "salesforce":
        return await CrmMetadataService.fetch_salesforce_objects(sf_token, sf_instance_url)
        
    elif crm_lower == "zendesk":
        return await CrmMetadataService.fetch_zendesk_objects()
        
    else:
        return [
            {"name": "account", "label": "Account (Mock)"},
            {"name": "contact", "label": "Contact (Mock)"}
        ]


# =========================================================
# ROUTE: FETCH SCHEMA FIELDS & SAMPLE PREVIEW DATA
# =========================================================
@router.get("/api/metadata/{crm_id}/fields/{object_name}")
async def get_crm_fields(
    crm_id: str,
    object_name: str,
    sf_token: str = Header(None, alias="sf-token"),
    sf_instance_url: str = Header(None, alias="sf-instance-url"),
    zd_token: str = Header(None, alias="zd-token"),
    zd_subdomain: str = Header(None, alias="zd-subdomain")
):
    crm_lower = crm_id.lower()
    
    if crm_lower == "salesforce":
        return await CrmMetadataService.fetch_salesforce_fields(sf_token, sf_instance_url, object_name)
        
    elif crm_lower == "zendesk":
        return await CrmMetadataService.fetch_zendesk_fields(zd_token, zd_subdomain, object_name)
        
    else:
        return {
            "headers": ["id", "name", "status"],
            "sampleRecords": [
                {"id": "MOCK-1", "name": "Global Test Enterprise", "status": "Active"},
                {"id": "MOCK-2", "name": "Acme Industrial Logistics", "status": "Inactive"}
            ],
            "fields": [
                {"name": "id", "label": "Record Identifier", "type": "string", "required": True},
                {"name": "name", "label": "Name Text", "type": "string", "required": True},
                {"name": "status", "label": "Status Flag", "type": "picklist", "required": False}
            ]
        }