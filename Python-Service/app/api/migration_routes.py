import asyncio
import httpx
import traceback
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from app.services.validator_service import process_validation_batch
import uuid
import sqlite3
import urllib.parse
import os
import tempfile
from datetime import datetime
import io
import json
import csv
import re
from fastapi.responses import StreamingResponse

router = APIRouter()

BASE_STAGING_DIR = os.path.join(os.getcwd(), "SureShift_staging_databases")

def get_db_path(session_id: str):
    """
    Reads the Smart Session ID and routes the database into a CRM/Object folder structure.
    Example session_id: 'zoho_leads_20260528_153000_a1b2c3d4'
    """
    parts = session_id.split('_')
    
    # Extract the CRM (part 1) and Object Name (part 2)
    crm_folder = parts[0] if len(parts) > 0 else "uncategorized"
    obj_folder = parts[1] if len(parts) > 1 else "unknown_object"
    
    # Create the deeply nested folder (e.g., /staging_databases/zoho/leads/)
    target_dir = os.path.join(BASE_STAGING_DIR, crm_folder, obj_folder)
    os.makedirs(target_dir, exist_ok=True)
    
    # Return the exact path for the database file
    return os.path.join(target_dir, f"{session_id}.db")

# ==========================================
#  CHUNK DATASET
# ==========================================
def chunk_dataset(data: list, chunk_size: int = 5000):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

# ==========================================
#  DEPENDENCY SORTER
# ==========================================
def sort_jobs_by_dependency(jobs):
    sorted_jobs = []
    pass3_jobs = []
    visited = set()
    visiting = set()

    def visit(job):
        target_obj = job.get("targetObject")
        if target_obj in visited: return
        
        visiting.add(target_obj)

        dependencies = []
        for m in job.get("mappings", []):
            if m.get("type") == "reference" and m.get("referenceTo"):
                dependencies.extend(m.get("referenceTo"))

        defer_references_to = []
        for dep in dependencies:
            parent_job = next((j for j in jobs if j.get("targetObject") == dep), None)
            if parent_job:
                if dep in visiting:
                    print(f" Circular dependency detected: {target_obj} <-> {dep}. Deferring to Pass 3.")
                    defer_references_to.append(dep)
                else:
                    visit(parent_job)

        visiting.remove(target_obj)
        visited.add(target_obj)

        job["deferReferencesTo"] = defer_references_to
        sorted_jobs.append(job)

        if defer_references_to:
            pass3_patch = dict(job)
            pass3_patch["isPass3Patch"] = True
            pass3_patch["onlyReferencesTo"] = defer_references_to
            pass3_jobs.append(pass3_patch)

    for job in jobs:
        visit(job)

    return sorted_jobs + pass3_jobs

# ==========================================
#  PAYLOAD BUILDER 
# ==========================================
def build_payload(raw_records, mappings, options):
    skip_self_ref = options.get("skipSelfReferencing", False)
    only_self_ref = options.get("onlySelfReferencing", False)
    exclude_refs = options.get("excludeReferencesTo", [])
    only_refs = options.get("onlyReferencesTo", [])
    target_object = options.get("targetObject", "")
    target_ext_id_field = options.get("targetExtIdField", "")
    op_mode = options.get("operationMode", "insert")

    payload = []
    is_patch_mode = only_self_ref or len(only_refs) > 0

    for idx, raw_row in enumerate(raw_records):
        sf_record = {}
        has_patch_data = False

        for mapping in mappings:
            sf_field = mapping.get("targetField")
            if not sf_field: continue

            csv_val = raw_row.get(mapping.get("sourceField"))

            if is_patch_mode and sf_field in ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'created_at', 'updated_at']:
                continue

            # Prevent empty strings from wiping out data
            if (csv_val is None or str(csv_val).strip() == "") and sf_field != target_ext_id_field: 
                continue

            is_self_ref = mapping.get("type") == "reference" and target_object in mapping.get("referenceTo", [])
            refs_other = mapping.get("referenceTo", []) if mapping.get("type") == "reference" else []

            is_excluded_cross = any(obj in refs_other for obj in exclude_refs)
            is_only_target_cross = len(only_refs) > 0 and any(obj in refs_other for obj in only_refs)

            if skip_self_ref and is_self_ref: continue
            if only_self_ref and not is_self_ref: continue
            if is_excluded_cross: continue
            if len(only_refs) > 0 and not is_only_target_cross: continue

            rel_name = mapping.get("relationshipName")
            if not rel_name and sf_field:
                if sf_field.endswith('Id'): rel_name = sf_field[:-2]
                elif sf_field.endswith('__c'): rel_name = sf_field.replace('__c', '__r')

            rel_ext_id = mapping.get("relationalExtIdField")
            if mapping.get("type") == "reference" and rel_ext_id and rel_name:
                sf_record[f"{rel_name}.{rel_ext_id}"] = csv_val
                if is_patch_mode: has_patch_data = True
            else:
                sf_record[sf_field] = csv_val

        if target_ext_id_field and target_ext_id_field not in sf_record:
            sf_record[target_ext_id_field] = None

        if op_mode == "delete":
            if "Id" in sf_record: sf_record = {"Id": sf_record["Id"]}
            elif "id" in sf_record: sf_record = {"id": sf_record["id"]}
            else: sf_record = {}

        if sf_record:
            if not is_patch_mode or (is_patch_mode and has_patch_data):
                payload.append({"originalIndex": idx, "sfRecord": sf_record})

    return payload


# ==========================================
# CORE WEBSOCKET ROUTE
# ==========================================
@router.websocket("/ws/migrate")
async def websocket_migration(websocket: WebSocket):
    await websocket.accept()
    
    try:
        await websocket.send_json({"log": "System: Multi-Object 3-Pass Engine Initialized.", "status": "Initializing..."})
        payload = await websocket.receive_json()
        
        raw_queue = payload.get("queue") 
        if not raw_queue:
            raw_queue = [payload] 
            
        # 1. Grab the Supabase Token from the Angular Payload
        auth_token = payload.get("authToken") or raw_queue[0].get("authToken")
        if not auth_token:
            await websocket.send_json({"log": "FATAL: Unauthenticated. Missing Supabase Auth Token.", "status": "Failed"})
            await websocket.close()
            return
            
        # 2. Verify the user securely with Supabase
        from app.utils.config import supabase
        user_res = supabase.auth.get_user(auth_token)
        if not user_res or not user_res.user:
            await websocket.send_json({"log": "FATAL: Invalid or expired session.", "status": "Failed"})
            await websocket.close()
            return
            
        user_id = user_res.user.id

        source_crm = raw_queue[0].get("sourceCrmId", "zendesk").lower() 
        target_crm = raw_queue[0].get("targetCrmId", "salesforce").lower() 
        
        # 3. Fetch Secure Credentials directly from the Database!
        from app.services.crm_service import CrmService
        try:
            source_creds = CrmService.get_active_crm_credentials(user_id, source_crm, "source")
            target_creds = CrmService.get_active_crm_credentials(user_id, target_crm, "target")
        except Exception as e:
            await websocket.send_json({"log": f"FATAL: Database credential lookup failed: {str(e)}", "status": "Failed"})
            await websocket.close()
            return

        # 4. DYNAMIC TARGET CREDENTIAL CHECK
        target_token = target_creds.get("access_token")
        if not target_token:
            await websocket.send_json({"log": f"FATAL: Missing Target Token for {target_crm.capitalize()}.", "status": "Failed"})
            await websocket.close()
            return
            
        if target_crm == "salesforce" and not target_creds.get("instance_url"):
            await websocket.send_json({"log": "FATAL: Missing Target Salesforce Instance URL.", "status": "Failed"})
            await websocket.close()
            return
            
        elif target_crm == "zendesk" and not target_creds.get("subdomain"):
            await websocket.send_json({"log": "FATAL: Missing Target Zendesk Subdomain.", "status": "Failed"})
            await websocket.close()
            return

        # 5. DYNAMIC SOURCE CREDENTIAL CHECK
        source_token = source_creds.get("access_token")
        if not source_token:
            await websocket.send_json({"log": f"FATAL: Missing Source Token for {source_crm.capitalize()}.", "status": "Failed"})
            await websocket.close()
            return
            
        # Map variables backward-compatibility for the extraction logic
        zoho_token = source_token if source_crm == "zoho" else None
        zoho_api_domain = source_creds.get("api_domain") if source_crm == "zoho" else None
        zd_token = source_token if source_crm == "zendesk" else None
        zd_subdomain = source_creds.get("subdomain") if source_crm == "zendesk" else None
        sf_token = target_token if target_crm == "salesforce" else None
        sf_instance = target_creds.get("instance_url") if target_crm == "salesforce" else None
        
        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        await send_log(f"Analyzing {len(raw_queue)} objects for dependencies...")
        execution_queue = sort_jobs_by_dependency(raw_queue)

        async with httpx.AsyncClient(timeout=120.0, verify=False) as client:
            
            total_success, total_error = 0, 0
            all_success_data = []
            all_error_data = []

            # ------------------------------------------
            # SALESFORCE TARGET UPLOADER
            # ------------------------------------------
            async def execute_sf_bulk(sf_payload, sf_op, pass_name="Standard"):
                nonlocal total_success, total_error, sf_token 
                if not sf_payload: return

                await send_log(f"[{target_object}] {pass_name}: Initializing {sf_op.upper()} to Salesforce...")
                sf_headers = {"X-SFDC-Session": sf_token, "Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"}
                bulk_base_url = f"{sf_instance.rstrip('/')}/services/async/60.0"

                job_config = {"operation": sf_op, "object": target_object, "contentType": "JSON"}
                if sf_op == "upsert": job_config["externalIdFieldName"] = target_ext_id_field

                job_res = await client.post(f"{bulk_base_url}/job", json=job_config, headers=sf_headers)
                
                if job_res.status_code == 401:
                    await send_log(f"[{target_object}] Session Expired. Silently refreshing Token...")
                    sf_token = await CrmService.refresh_crm_token(user_id, target_crm, "target")
                    sf_headers["X-SFDC-Session"] = sf_token
                    job_res = await client.post(f"{bulk_base_url}/job", json=job_config, headers=sf_headers)

                if job_res.status_code != 201:
                    await send_log(f"[{target_object}] Salesforce Job Failed: {job_res.text}")
                    return
                job_id = job_res.json().get("id")

                chunks = list(chunk_dataset(sf_payload, batch_size))
                await send_log(f"[{target_object}] {pass_name}: Executing {len(chunks)} batches...")

                semaphore = asyncio.Semaphore(6)

                async def upload_chunk(chunk_data):
                    async with semaphore:
                        just_sf_records = [c["sfRecord"] for c in chunk_data]
                        b_res = await client.post(f"{bulk_base_url}/job/{job_id}/batch", json=just_sf_records, headers=sf_headers)
                        b_res.raise_for_status()
                        return b_res.json().get("id")

                batch_ids = await asyncio.gather(*[upload_chunk(c) for c in chunks])
                await client.post(f"{bulk_base_url}/job/{job_id}", json={"state": "Closed"}, headers=sf_headers)

                poll_delay = 1.0
                while True:
                    await asyncio.sleep(poll_delay)
                    status_res = await asyncio.gather(*[client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}", headers=sf_headers) for b_id in batch_ids])
                    states = [r.json().get("state") for r in status_res]
                    if all(s == "Completed" for s in states) or any(s in ["Failed", "NotProcessed"] for s in states):
                        break
                    poll_delay = min(poll_delay * 1.5, 4.0)

                for i, b_id in enumerate(batch_ids):
                    res = await client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}/result", headers=sf_headers)
                    results = res.json()
                    original_chunk = chunks[i]

                    for row_data, sf_result in zip(original_chunk, results):
                        orig_record = source_records[row_data["originalIndex"]]
                        if sf_result.get("success"):
                            orig_record["Target_Id"] = sf_result.get("id")
                            all_success_data.append(orig_record)
                            total_success += 1
                        else:
                            err_msg = sf_result.get("errors", [{"message": "Unknown"}])[0].get("message")
                            orig_record["Target_Error"] = err_msg
                            all_error_data.append(orig_record)
                            total_error += 1

            # ------------------------------------------
            # ZOHO TARGET UPLOADER (v6 API API-compliant Chunks)
            # ------------------------------------------
            async def execute_zoho_upload(zoho_payload, zoho_op, pass_name="Standard"):
                nonlocal total_success, total_error
                if not zoho_payload: return

                # Zoho endpoints MUST be properly capitalized and pluralized 
                # (e.g., 'Lead' -> 'Leads', 'contact' -> 'Contacts')
                normalized_obj = target_object.strip()
                if not normalized_obj.endswith('s') if normalized_obj.lower() != 'data' else False:
                    # Quick pluralization helper for standard modules
                    if normalized_obj.lower() == 'lead': normalized_obj = 'Leads'
                    elif normalized_obj.lower() == 'contact': normalized_obj = 'Contacts'
                    elif normalized_obj.lower() == 'account': normalized_obj = 'Accounts'
                    elif normalized_obj.lower() == 'deal': normalized_obj = 'Deals'
                    else: normalized_obj = normalized_obj.capitalize() + 's'
                else:
                    
                    if not normalized_obj.startswith('$') and len(normalized_obj) > 0:
                        normalized_obj = normalized_obj[0].upper() + normalized_obj[1:]

                await send_log(f"[{normalized_obj}] {pass_name}: Injecting data stream into Zoho CRM...")
                base_url = (target_creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
                if not base_url.startswith("http"): base_url = f"https://{base_url}"
                
                headers = {"Authorization": f"Zoho-oauthtoken {target_token}", "Content-Type": "application/json"}
                
                # Zoho maximum single REST request limit is 100 rows
                chunks = list(chunk_dataset(zoho_payload, 100))
                
                for chunk in chunks:
                    zoho_data_rows = []
                    for c in chunk:
                        clean_row = {}
                        for k, v in c["sfRecord"].items():
                            # 🚨 FIX 2: Strip Salesforce tracking suffixes if they bled into the payload
                            clean_key = k.replace('__c', '').replace('__r', '')
                            clean_row[clean_key] = v
                        zoho_data_rows.append(clean_row)
                    
                    try:
                        api_url = f"{base_url}/crm/v6/{normalized_obj}"
                        res = await client.post(api_url, json={"data": zoho_data_rows}, headers=headers)
                        
                        if res.status_code in [200, 201, 202]:
                            res_entries = res.json().get("data", [])
                            for item, z_res in zip(chunk, res_entries):
                                orig_record = source_records[item["originalIndex"]]
                                if z_res.get("status") == "success":
                                    orig_record["Target_Id"] = z_res.get("details", {}).get("id")
                                    all_success_data.append(orig_record)
                                    total_success += 1
                                else:
                                    # Grab the precise reason Zoho rejected this specific row
                                    error_details = z_res.get("message") or z_res.get("code") or "Rejected"
                                    orig_record["Target_Error"] = f"Zoho Row Error: {error_details}"
                                    all_error_data.append(orig_record)
                                    total_error += 1
                        else:
                            # 🚨 FIX 3: If Zoho throws a 400, capture and print the actual JSON error payload
                            error_text = res.text
                            try:
                                parsed_err = res.json()
                                if "message" in parsed_err: error_text = parsed_err["message"]
                                elif "errors" in parsed_err: error_text = parsed_err["errors"][0].get("message")
                            except: pass
                            
                            await send_log(f"⚠️ Zoho API Rejected Batch ({res.status_code}): {error_text}")
                            
                            for item in chunk:
                                orig_record = source_records[item["originalIndex"]]
                                orig_record["Target_Error"] = f"Zoho API Error: {error_text}"
                                all_error_data.append(orig_record)
                                total_error += 1
                    except Exception as exc:
                        for item in chunk:
                            orig_record = source_records[item["originalIndex"]]
                            orig_record["Target_Error"] = str(exc)
                            all_error_data.append(orig_record)
                            total_error += 1
                        else:
                            for item in chunk:
                                orig_record = source_records[item["originalIndex"]]
                                orig_record["Target_Error"] = f"Zoho error context: HTTP {res.status_code}"
                                all_error_data.append(orig_record)
                                total_error += 1
                    except Exception as exc:
                        for item in chunk:
                            orig_record = source_records[item["originalIndex"]]
                            orig_record["Target_Error"] = str(exc)
                            all_error_data.append(orig_record)
                            total_error += 1

            # ------------------------------------------
            # DYNAMIC PIPELINE DISPATCH ROUTER
            # ------------------------------------------
            async def execute_upload(payload_data, op_mode, pass_name="Standard"):
                if target_crm == "salesforce":
                    await execute_sf_bulk(payload_data, op_mode, pass_name)
                elif target_crm == "zoho":
                    await execute_zoho_upload(payload_data, op_mode, pass_name)
                else:
                    # Generic Fallback/Simulator for alternative configurations
                    nonlocal total_success
                    await send_log(f"[{target_object}] Simulated successful integration pass into target engine.")
                    for item in payload_data:
                        orig_record = source_records[item["originalIndex"]]
                        orig_record["Target_Id"] = f"MOCK_{uuid.uuid4().hex[:8].upper()}"
                        all_success_data.append(orig_record)
                        total_success += 1

            for job in execution_queue:
                target_object = job.get("targetObject")
                source_object = job.get("sourceObject", "")
                extraction_query = job.get("extractionQuery", "").strip()
                mappings = [m for m in job.get("mappings", []) if m.get("targetField")]
                
                operation_mode = job.get("operationMode", "insert")
                batch_size = int(job.get("batchSize", 5000))
                target_ext_id_field = job.get("externalIdField", "")
                
                is_pass3_patch = job.get("isPass3Patch", False)
                defer_references_to = job.get("deferReferencesTo", [])
                only_references_to = job.get("onlyReferencesTo", [])

                if not mappings: continue

                # ------------------------------------------
                # EXTRACT FROM SQL/STAGING ENGINE
                # ------------------------------------------
                session_id = job.get("sessionId")
                source_records = []
                
                if session_id:
                    db_path = get_db_path(session_id)
                    if os.path.exists(db_path):
                        await send_log(f"[{target_object}] Reading strictly validated payload from staging database...")
                        try:
                            conn = sqlite3.connect(db_path)
                            cursor = conn.cursor()
                            cursor.execute("SELECT data FROM records WHERE is_valid = 1")
                            source_records = [json.loads(row[0]) for row in cursor.fetchall()]
                            conn.close()
                            
                            if not source_records:
                                await send_log(f"[{target_object}] FATAL: No valid records found in database. Fix errors and Re-Validate first.", "Failed")
                                continue 
                                
                            job["rawRecords"] = source_records
                            await send_log(f"[{target_object}] Loaded {len(source_records)} perfectly valid records ready for migration.")
                        except Exception as e:
                            await send_log(f"[{target_object}] FATAL: Database read error: {str(e)}", "Failed")
                            continue
                    else:
                        await send_log(f"[{target_object}] FATAL: Staging payload expired or missing.", "Failed")
                        continue 
                else:
                    await send_log(f"[{target_object}] No UI session detected. Initiating direct API extraction...")
                    
                    # ======================================
                    # ZOHO EXTRACTION ENGINE
                    # ======================================
                    if zoho_token:
                        await send_log(f"[{target_object}] Initializing extraction from Zoho CRM...")
                        if zoho_api_domain and not zoho_api_domain.startswith(("http://", "https://")):
                            zoho_api_domain = f"https://{zoho_api_domain}"
                        base_url = zoho_api_domain.rstrip('/') if zoho_api_domain else "https://www.zohoapis.com"
                        z_headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
                        
                        headers_list = [m["sourceField"] for m in mappings if m.get("sourceField")]
                        safe_fields = headers_list[:40] if headers_list else ["id"]
                        fields_str = ",".join(safe_fields)
                        
                        page = 1
                        page_token = None
                        more_records = True
                        
                        try:
                            while more_records:
                                if extraction_query:
                                    coql_query = extraction_query.strip()
                                    if coql_query.lower().startswith("select "):
                                        if "*" in coql_query:
                                            coql_query = coql_query.replace("*", fields_str, 1)
                                        match = re.match(r'(?i)select\s+(.*?)\s+from\s+', coql_query)
                                        if match:
                                            clean_select = match.group(1).replace(" ", "")
                                            coql_query = coql_query.replace(match.group(1), clean_select, 1)
                                        if " where " not in coql_query.lower():
                                            coql_query += " where id is not null"
                                        coql_query = re.sub(r'(?i)\s+limit\s+\d+', '', coql_query)
                                    else:
                                        coql_query = f"select {fields_str} from {source_object} where {coql_query}"
                                        
                                    paginated_coql = f"{coql_query} limit 200 offset {(page - 1) * 200}"
                                    res = await client.post(f"{base_url}/crm/v6/coql", headers=z_headers, json={"select_query": paginated_coql})
                                else:
                                    if page_token:
                                        res = await client.get(f"{base_url}/crm/v6/{source_object}?page_token={page_token}&per_page=200&fields={fields_str}", headers=z_headers)
                                    else:
                                        res = await client.get(f"{base_url}/crm/v6/{source_object}?page=1&per_page=200&fields={fields_str}", headers=z_headers)
                                    
                                if res.status_code == 429:
                                    await send_log("⚠️ Zoho Rate Limit. Pausing 30s...", "Paused")
                                    await asyncio.sleep(30)
                                    continue
                                    
                                res.raise_for_status()
                                data = res.json()
                                raw_records = data.get("data") or []
                                
                                if not raw_records: break
                                
                                for r in raw_records:
                                    flat_rec = {}
                                    for k, v in r.items():
                                        if isinstance(v, dict):
                                            flat_rec[k] = v.get("name", v.get("id", str(v)))
                                        elif isinstance(v, list):
                                            parsed_list = [str(i.get("name", i.get("id", i))) if isinstance(i, dict) else str(i) for i in v]
                                            flat_rec[k] = ";".join(parsed_list)
                                        else:
                                            flat_rec[k] = v
                                    source_records.append(flat_rec)
                                    
                                await send_log(f"[{target_object}] Extracted {len(source_records)} records so far...")
                                info = data.get("info", {})
                                more_records = info.get("more_records", False)
                                page_token = info.get("next_page_token")
                                page += 1 
                                
                            job["rawRecords"] = source_records 
                            await send_log(f"[{target_object}] Extraction Complete! Total Records: {len(source_records)}")
                        except Exception as e:
                            await send_log(f"[{target_object}] Zoho Extract Failed: {str(e)}", "Failed")
                            continue

                    # ======================================
                    # ZENDESK EXTRACTION ENGINE
                    # ======================================
                    elif zd_token:
                        await send_log(f"[{target_object}] Initializing extraction from Zendesk...")
                        zd_headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
                        safe_obj = source_object.lower()
                        
                        try:
                            safe_obj_singular = safe_obj.rstrip('s')
                            clean_query = re.sub(r'type:[a-zA-Z0-9_]+', '', extraction_query, flags=re.IGNORECASE).strip()
                            final_query = f"{clean_query} type:{safe_obj_singular}".strip()
                            safe_query = urllib.parse.quote(final_query)
                            
                            url = f"https://{zd_subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
                            
                            while url:
                                res = await client.get(url, headers=zd_headers)
                                if res.status_code == 429:
                                    retry_after = int(res.headers.get("Retry-After", 60))
                                    await send_log(f"⚠️ [Zendesk Rate Limit] Pausing for {retry_after} seconds...", "Paused")
                                    await asyncio.sleep(retry_after)
                                    continue
                                    
                                res.raise_for_status()
                                data = res.json()
                                records = data.get("results", [])
                                
                                if not records: break
                                source_records.extend(records)
                                
                                if len(source_records) % 1000 == 0:
                                    await send_log(f"[{target_object}] Extracted {len(source_records)} records...")
                                
                                meta = data.get("meta")
                                if meta and meta.get("has_more"):
                                    url = data.get("links", {}).get("next")
                                else:
                                    url = None
                                    
                            job["rawRecords"] = source_records 
                            await send_log(f"[{target_object}] Extraction Complete! Total Records: {len(source_records)}")
                        except Exception as e:
                            await send_log(f"[{target_object}] Extract Failed: {str(e)}", "Failed")
                            continue

                # ------------------------------------------
                # EXECUTING PIPELINE INTERCEPT VIA DISPATCHER
                # ------------------------------------------
                has_self_ref = any(m.get("type") == "reference" and target_object in m.get("referenceTo", []) for m in mappings)

                if is_pass3_patch:
                    payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "onlyReferencesTo": only_references_to, "operationMode": "upsert"})
                    await execute_upload(payload, "upsert", "Pass 3 (Circular Patch)")

                elif operation_mode == "delete":
                    payload = build_payload(source_records, mappings, {"targetObject": target_object, "operationMode": "delete"})
                    await execute_upload(payload, "delete", "Deletion")

                elif has_self_ref:
                    target_op = "upsert" if (target_ext_id_field and target_ext_id_field.lower() != "id") else operation_mode
                    p1_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "excludeReferencesTo": defer_references_to, "skipSelfReferencing": True, "operationMode": target_op})
                    await execute_upload(p1_payload, target_op, "Pass 1 (Base Data)")

                    p2_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "onlySelfReferencing": True, "operationMode": "upsert"})
                    await execute_upload(p2_payload, "upsert", "Pass 2 (Hierarchy Patch)")

                else:
                    target_op = "upsert" if (target_ext_id_field and target_ext_id_field.lower() != "id") else operation_mode
                    std_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "excludeReferencesTo": defer_references_to, "operationMode": target_op})
                    await execute_upload(std_payload, target_op, "Standard Sync")

            # Final Summary Delivery pass
            if total_error > 0:
                await send_log(f"Completed with Errors: {total_success} records loaded, {total_error} rejected.", "Finished")
            else:
                await send_log(f"QUEUE COMPLETE! {total_success} records seamlessly pushed.", "Finished")
                
            await websocket.send_json({
                "log": "System: Generating downloadable execution logs...",
                "status": "Finished",
                "successData": all_success_data,
                "errorData": all_error_data
            })

        await websocket.close()
        
    except WebSocketDisconnect:
        print(" ANGULAR CLIENT DISCONNECTED PREMATURELY")
    except Exception as e:
        traceback.print_exc()
        try:
            await websocket.send_json({"log": f"SYSTEM CRASH: {str(e)}", "status": "Failed"})
            await websocket.close()
        except:
            pass


# ==========================================
# MASSIVE STREAMING VALIDATION (WS)
# ==========================================
@router.websocket("/ws/validate-stream")
async def websocket_validate_stream(websocket: WebSocket):
    await websocket.accept()
    
    try:
        payload = await websocket.receive_json()
        
        # --- RE-VALIDATION SHORTCUT ---
        is_revalidation = payload.get("isRevalidation", False)
        session_id = payload.get("sessionId", "")

        if is_revalidation and session_id:
            db_path = get_db_path(session_id) 
            
            if not os.path.exists(db_path):
                await websocket.send_json({"log": "Error: Staging session expired. Please run a fresh validation.", "status": "Validation Failed"})
                await websocket.close()
                return

            fixed_records = payload.get("fixedRecords", [])
            mappings = payload.get("mappings", [])
            dedupe_key = payload.get("dedupeKey", "")
            sf_rules = payload.get("sfRules", {})

            await websocket.send_json({"log": "System: Re-validating manual UI fixes...", "status": "Validating"})

            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            db_ids_to_delete = []
            for rec in fixed_records:
                if "_db_id" in rec:
                    db_ids_to_delete.append(rec.pop("_db_id"))

            target_crm = payload.get("targetCrmId", "salesforce").lower()
            chunk_result = process_validation_batch(
                records=fixed_records, 
                mappings=mappings, 
                dedupe_key=dedupe_key, 
                target_rules=sf_rules, 
                date_format="", 
                target_crm=target_crm
            )

            if db_ids_to_delete:
                placeholders = ','.join(['?'] * len(db_ids_to_delete))
                cursor.execute(f"DELETE FROM records WHERE id IN ({placeholders})", db_ids_to_delete)

            valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
            invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]

            conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
            conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
            conn.commit()

            cursor.execute("SELECT COUNT(*) FROM records")
            total_count = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM records WHERE is_valid = 1")
            valid_count = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM records WHERE is_valid = 0")
            invalid_count = cursor.fetchone()[0]

            cursor.execute("SELECT id, data, errors FROM records WHERE is_valid = 0 LIMIT 500")
            db_errors = cursor.fetchall()
            
            all_invalid_records = []
            for row in db_errors:
                rec_data = json.loads(row[1])
                rec_data["_db_id"] = row[0]
                all_invalid_records.append({
                    "originalRow": rec_data,
                    "errors": row[2]
                })

            conn.close()

            aggregate_stats = {
                "total": total_count,
                "valid": valid_count,
                "invalid": invalid_count,
                "duplicates": chunk_result["stats"].get("duplicates", 0)
            }

            await websocket.send_json({
                "log": f"Re-validation Complete: Fixed {len(valid_inserts)} records. {invalid_count} errors remaining.",
                "status": "Validation Passed" if invalid_count == 0 else "Validation Warning",
                "stats": aggregate_stats,
                "invalidRecords": all_invalid_records,
                "sessionId": session_id
            })
            
            await websocket.close()
            return

        # --- ORIGINAL LOGIC FOR FRESH RUNS ---
        crm_id = payload.get("crmId", "").lower()
        obj_name = payload.get("objectName", "")
        query = payload.get("query", "").strip()
        mappings = payload.get("mappings", [])
        dedupe_key = payload.get("dedupeKey", "")
        sf_rules = payload.get("sfRules", {})
        
        auth_token = payload.get("authToken")
        if not auth_token:
            await websocket.send_json({"log": "FATAL: Unauthenticated.", "status": "Validation Failed"})
            await websocket.close()
            return
            
        from app.utils.config import supabase
        user_res = supabase.auth.get_user(auth_token)
        if not user_res or not user_res.user:
            await websocket.send_json({"log": "FATAL: Invalid or expired session.", "status": "Validation Failed"})
            await websocket.close()
            return
        
        user_id = user_res.user.id

        source_crm = payload.get("crmId", "").lower()
        target_crm = payload.get("targetCrmId", "salesforce").lower()
            
        from app.services.crm_service import CrmService
        try:
            source_creds = CrmService.get_active_crm_credentials(user_id, source_crm, "source")
            target_creds = CrmService.get_active_crm_credentials(user_id, target_crm, "target")
        except Exception as e:
            await websocket.send_json({"log": f"FATAL: Database credential lookup failed: {str(e)}", "status": "Failed"})
            await websocket.close()
            return

        target_token = target_creds.get("access_token")
        if not target_token:
            await websocket.send_json({"log": f"FATAL: Missing Target Token for {target_crm.capitalize()}.", "status": "Failed"})
            await websocket.close()
            return
            
        if target_crm == "salesforce" and not target_creds.get("instance_url"):
            await websocket.send_json({"log": "FATAL: Missing Target Salesforce Instance URL.", "status": "Failed"})
            await websocket.close()
            return
            
        elif target_crm == "zendesk" and not target_creds.get("subdomain"):
            await websocket.send_json({"log": "FATAL: Missing Target Zendesk Subdomain.", "status": "Failed"})
            await websocket.close()
            return

        source_token = source_creds.get("access_token")
        if not source_token:
            await websocket.send_json({"log": f"FATAL: Missing Source Token for {source_crm.capitalize()}.", "status": "Failed"})
            await websocket.close()
            return
        
        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        sf_token = source_creds.get("access_token") if crm_id == "salesforce" else None
        sf_instance = source_creds.get("instance_url") if crm_id == "salesforce" else None
        zd_token = source_creds.get("access_token") if crm_id == "zendesk" else None
        zd_subdomain = source_creds.get("subdomain") if crm_id == "zendesk" else None
        zoho_token = source_creds.get("access_token") if crm_id == "zoho" else None
        zoho_api_domain = source_creds.get("api_domain") if crm_id == "zoho" else None

        safe_obj = ''.join(e for e in obj_name if e.isalnum()).lower()
        if not safe_obj: safe_obj = "unknown"
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        short_uuid = str(uuid.uuid4())[:8]
        session_id = f"{crm_id}_{safe_obj}_{timestamp}_{short_uuid}"
        
        db_path = get_db_path(session_id)
        
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, is_valid BOOLEAN, data TEXT, errors TEXT)")
        
        aggregate_stats = {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}
        await websocket.send_json({"log": f"System: Initializing Streaming Validation...", "status": "Connecting"})

        async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
            
            # ------------------------------------------
            # 1. ZENDESK STREAMING VALIDATION
            # ------------------------------------------
            if crm_id == "zendesk":
                safe_obj = obj_name.lower()
                zd_headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
                
                standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
                is_standard = safe_obj in standard_objects or f"{safe_obj}s" in standard_objects

                if is_standard:
                    safe_obj_singular = safe_obj[:-1] if safe_obj.endswith('s') else safe_obj
                    clean_query = re.sub(r'(?i)^(select.*from\s+\w+\s+where\s+)', '', query).strip()
                    final_query = f"{clean_query} type:{safe_obj_singular}".strip()
                    safe_query = urllib.parse.quote(final_query)
                    url = f"https://{zd_subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
                    
                    while url:
                        res = await client.get(url, headers=zd_headers)
                        if res.status_code == 429:
                            retry = int(res.headers.get("Retry-After", 60))
                            await websocket.send_json({"log": f"⚠️ Zendesk Rate Limit. Pausing for {retry}s...", "status": "Paused"})
                            await asyncio.sleep(retry)
                            continue
                            
                        res.raise_for_status()
                        data = res.json()
                        
                        chunk_records = []
                        for rec in data.get("results", []):
                            flat_rec = {}
                            for k, v in rec.items():
                                if k == "custom_fields" and isinstance(v, list):
                                    for cf in v: 
                                        val = cf.get("value")
                                        if isinstance(val, list): val = ";".join([str(i) for i in val])
                                        flat_rec[f"custom_field_{cf['id']}"] = val
                                elif not isinstance(v, (dict, list)):
                                    flat_rec[k] = v
                                elif isinstance(v, list): 
                                    flat_rec[k] = ";".join([str(i) for i in v])
                            chunk_records.append(flat_rec)

                        if not chunk_records: break
                        chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "", target_crm=target_crm)

                        valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
                        invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]
            
                        conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
                        conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
                        conn.commit()
                        
                        aggregate_stats["total"] += chunk_result["stats"]["total"]
                        aggregate_stats["valid"] += chunk_result["stats"]["valid"]
                        aggregate_stats["invalid"] += chunk_result["stats"]["invalid"]
                        aggregate_stats["duplicates"] += chunk_result["stats"]["duplicates"]

                        await websocket.send_json({
                            "log": f"Validated {aggregate_stats['total']} records so far...",
                            "status": "Validating",
                            "stats": aggregate_stats
                        })
                        url = data.get("links", {}).get("next") if data.get("meta", {}).get("has_more") else None
                else:
                    url = None
                    json_payload = None
                    
                    if query.strip():
                        try:
                            json_payload = json.loads(query)
                            url = f"https://{zd_subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records/search?page[size]=100"
                        except Exception:
                            await websocket.send_json({"log": "Error: Invalid JSON query for Custom Object", "status": "Failed"})
                            await websocket.close()
                            return
                    else:
                        url = f"https://{zd_subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records?page[size]=100"
                        
                    while url:
                        if json_payload:
                            res = await client.post(url, headers=zd_headers, json=json_payload)
                        else:
                            res = await client.get(url, headers=zd_headers)
                            
                        if res.status_code == 429:
                            retry = int(res.headers.get("Retry-After", 60))
                            await websocket.send_json({"log": f"⚠️ Zendesk Rate Limit. Pausing for {retry}s...", "status": "Paused"})
                            await asyncio.sleep(retry)
                            continue
                            
                        if res.status_code != 200:
                            err_msg = res.text
                            try: 
                                err_msg = res.json().get("error", {}).get("message", res.text)
                            except: pass
                            await websocket.send_json({"log": f"Zendesk API Error: {err_msg}", "status": "Validation Failed"})
                            await websocket.close()
                            return
                            
                        data = res.json()
                        chunk_records = []
                        for rec in data.get("custom_object_records", []):
                            flat_rec = {}
                            for k, v in rec.items():
                                if k == "custom_object_fields" and isinstance(v, dict):
                                    for cf_key, cf_val in v.items():
                                        if isinstance(cf_val, list): cf_val = ";".join([str(i) for i in cf_val])
                                        flat_rec[cf_key] = cf_val
                                elif not isinstance(v, (dict, list)):
                                    flat_rec[k] = v
                                elif isinstance(v, list):
                                    flat_rec[k] = ";".join([str(i) for i in v])
                            chunk_records.append(flat_rec)
                            
                        if not chunk_records: break
                        chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "", target_crm=target_crm)
                        
                        valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
                        invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]
            
                        conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
                        conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
                        conn.commit()
                        
                        aggregate_stats["total"] += chunk_result["stats"]["total"]
                        aggregate_stats["valid"] += chunk_result["stats"]["valid"]
                        aggregate_stats["invalid"] += chunk_result["stats"]["invalid"]
                        aggregate_stats["duplicates"] += chunk_result["stats"]["duplicates"]

                        await websocket.send_json({
                            "log": f"Validated {aggregate_stats['total']} records so far...",
                            "status": "Validating",
                            "stats": aggregate_stats
                        })
                        meta = data.get("meta", {})
                        if meta.get("has_more"):
                            url = data.get("links", {}).get("next")
                        else:
                            url = None

            # ------------------------------------------
            # 2. SALESFORCE STREAMING VALIDATION
            # ------------------------------------------
            elif crm_id == "salesforce":
                headers_list = [m["csvField"] for m in mappings if m.get("csvField")]
                fields_str = ", ".join(headers_list) if headers_list else "Id"
                where_clause = f" WHERE {query}" if query else ""
                soql = f"SELECT {fields_str} FROM {obj_name}{where_clause}"
                headers = {"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"}
                safe_soql = urllib.parse.quote(soql)
                base_url = sf_instance.rstrip('/')
                url = f"{base_url}/services/data/v60.0/query?q={safe_soql}"
                
                while url:
                    res = await client.get(url, headers=headers)
                    res.raise_for_status()
                    data = res.json()
                    
                    chunk_records = []
                    for r in data.get("records", []):
                        r.pop("attributes", None)
                        chunk_records.append(r)
                        
                    if not chunk_records: break
                    chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "", target_crm=target_crm)
                    
                    valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
                    invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
                    conn.commit()

                    aggregate_stats["total"] += chunk_result["stats"]["total"]
                    aggregate_stats["valid"] += chunk_result["stats"]["valid"]
                    aggregate_stats["invalid"] += chunk_result["stats"]["invalid"]
                    aggregate_stats["duplicates"] += chunk_result["stats"]["duplicates"]

                    await websocket.send_json({
                        "log": f"Validated {aggregate_stats['total']} records so far...",
                        "status": "Validating",
                        "stats": aggregate_stats
                    })
                    
                    if not data.get("done"):
                        url = f"{base_url}{data.get('nextRecordsUrl')}"
                    else:
                        url = None

            # ------------------------------------------
            # 3. ZOHO STREAMING VALIDATION
            # ------------------------------------------
            elif crm_id == "zoho":
                if not zoho_token:
                    await websocket.send_json({"log": "❌ Zoho Token Missing", "status": "Failed"})
                    await websocket.close()
                    return

                if zoho_api_domain and not zoho_api_domain.startswith(("http://", "https://")):
                    zoho_api_domain = f"https://{zoho_api_domain}"
                base_url = zoho_api_domain.rstrip('/') if zoho_api_domain else "https://www.zohoapis.com"
                headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
                
                headers_list = [m["csvField"] for m in mappings if m.get("csvField")]
                safe_fields = headers_list[:40] if headers_list else ["id"]
                fields_str = ",".join(safe_fields)

                page = 1
                page_token = None
                more_records = True

                while more_records:
                    if query:
                        coql_query = query.strip()
                        if coql_query.lower().startswith("select "):
                            if "*" in coql_query:
                                coql_query = coql_query.replace("*", fields_str, 1)
                            match = re.match(r'(?i)select\s+(.*?)\s+from\s+', coql_query)
                            if match:
                                clean_select = match.group(1).replace(" ", "")
                                coql_query = coql_query.replace(match.group(1), clean_select, 1)
                            if " where " not in coql_query.lower():
                                coql_query += " where id is not null"
                            coql_query = re.sub(r'(?i)\s+limit\s+\d+', '', coql_query)
                        else:
                            coql_query = f"select {fields_str} from {obj_name} where {coql_query}"

                        paginated_coql = f"{coql_query} limit 200 offset {(page - 1) * 200}"
                        res = await client.post(f"{base_url}/crm/v6/coql", headers=headers, json={"select_query": paginated_coql})
                    else:
                        if page_token:
                            res = await client.get(f"{base_url}/crm/v6/{obj_name}?page_token={page_token}&per_page=200&fields={fields_str}", headers=headers)
                        else:
                            res = await client.get(f"{base_url}/crm/v6/{obj_name}?page=1&per_page=200&fields={fields_str}", headers=headers)

                    if res.status_code == 429:
                        await websocket.send_json({"log": "⚠️ Zoho Rate Limit. Pausing for 30s...", "status": "Paused"})
                        await asyncio.sleep(30)
                        continue

                    if res.status_code != 200:
                        await websocket.send_json({"log": f"❌ Zoho Error: {res.text}", "status": "Validation Failed"})
                        break

                    data = res.json()
                    raw_records = data.get("data") or []
                    if not raw_records: break
                        
                    chunk_records = []
                    for r in raw_records:
                        flat_rec = {}
                        for k, v in r.items():
                            if isinstance(v, dict):
                                flat_rec[k] = v.get("name", v.get("id", str(v)))
                            elif isinstance(v, list):
                                parsed_list = [str(i.get("name", i.get("id", i))) if isinstance(i, dict) else str(i) for i in v]
                                flat_rec[k] = ";".join(parsed_list)
                            else:
                                flat_rec[k] = v
                        chunk_records.append(flat_rec)

                    chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "", target_crm=target_crm)
                    
                    valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
                    invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
                    conn.commit()
                    
                    aggregate_stats["total"] += chunk_result["stats"]["total"]
                    aggregate_stats["valid"] += chunk_result["stats"]["valid"]
                    aggregate_stats["invalid"] += chunk_result["stats"]["invalid"]
                    aggregate_stats["duplicates"] += chunk_result["stats"]["duplicates"]

                    await websocket.send_json({
                        "log": f"Validated {aggregate_stats['total']} records so far...",
                        "status": "Validating",
                        "stats": aggregate_stats
                    })
                    
                    info = data.get("info", {})
                    more_records = info.get("more_records", False)
                    page_token = info.get("next_page_token")
                    page += 1 

            else:
                await websocket.send_json({"log": f"Unsupported CRM: {crm_id}", "status": "Failed"})
                await websocket.close()
                return

        # ----------------------------------------------------
        # GRAB THE TOP 500 ERRORS FOR INITIAL UI LOAD
        # ----------------------------------------------------
        cursor = conn.cursor()
        cursor.execute("SELECT id, data, errors FROM records WHERE is_valid = 0 LIMIT 500")
        db_errors = cursor.fetchall()
        
        all_invalid_records = []
        for row in db_errors:
            rec_data = json.loads(row[1])
            rec_data["_db_id"] = row[0] 
            all_invalid_records.append({
                "originalRow": rec_data,
                "errors": row[2]
            })

        conn.close()

        # --- FINAL DELIVERY ---
        await websocket.send_json({
            "log": f" Stream Validation Complete: {aggregate_stats['total']} total records.",
            "status": "Validation Passed" if aggregate_stats["invalid"] == 0 else "Validation Warning",
            "stats": aggregate_stats,
            "invalidRecords": all_invalid_records,
            "sessionId": session_id
        })
        await websocket.close()
        
    except WebSocketDisconnect:
        print("Client disconnected from validation stream.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            await websocket.send_json({"log": f" Stream Crash: {str(e)}", "status": "Validation Failed"})
            await websocket.close()
        except:
            pass


# ==========================================
# ROUTE: DOWNLOAD FULL AUDIT REPORT (CSV)
# ==========================================
@router.get("/api/audit/download/{session_id}")
async def download_validation_audit(session_id: str, type: str = 'valid'):
    db_path = get_db_path(session_id)
    
    if not os.path.exists(db_path):
        raise HTTPException(status_code=404, detail="Staging database not found or session expired.")

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    is_valid = 1 if type == 'valid' else 0
    cursor.execute("SELECT data, errors FROM records WHERE is_valid = ?", (is_valid,))
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        raise HTTPException(status_code=404, detail=f"No {type} records available.")

    all_records = []
    fieldnames = set()
    for row in rows:
        rec = json.loads(row[0])
        if type == 'invalid':
            rec['Validation_Errors'] = row[1]
            
        fieldnames.update(rec.keys())
        all_records.append(rec)
    
    fieldnames = list(fieldnames)
    if 'Validation_Errors' in fieldnames:
        fieldnames.remove('Validation_Errors')
        fieldnames.insert(0, 'Validation_Errors')

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(all_records)
    
    output.seek(0)
    
    headers = {
        'Content-Disposition': f'attachment; filename="Validation_Audit_{type.capitalize()}_{session_id}.csv"'
    }
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv", headers=headers)