import urllib.parse
import asyncio
import httpx
import traceback
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from app.services.validator_service import process_validation_batch
import re
import uuid
import sqlite3
import os
import tempfile
import json
from datetime import datetime

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

            if is_patch_mode and sf_field in ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById']:
                continue

            # Prevent empty strings from wiping out Salesforce data
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
            sf_record = {"Id": sf_record["Id"]} if "Id" in sf_record else {}

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
            
        sf_token = payload.get("sfToken") or raw_queue[0].get("sfToken")
        sf_instance = payload.get("sfInstance") or raw_queue[0].get("sfInstance")
        zd_token = payload.get("zdToken") or raw_queue[0].get("zdToken")
        zd_subdomain = payload.get("zdSubdomain") or raw_queue[0].get("zdSubdomain")
        zoho_token = payload.get("zohoToken", "") or raw_queue[0].get("zohoToken")
        zoho_api_domain = payload.get("zohoDomain", "") or raw_queue[0].get("zohoDomain")

        if not sf_token or not sf_instance:
            await websocket.send_json({"log": "FATAL: Missing Target Salesforce Credentials.", "status": "Failed"})
            await websocket.close()
            return
            
        # 2. Check Source (Must have EITHER Zendesk OR Zoho)
        if not zd_token and not zoho_token:
            await websocket.send_json({"log": "FATAL: Missing Source CRM Credentials (Zendesk or Zoho).", "status": "Failed"})
            await websocket.close()
            return

        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        await send_log(f"Analyzing {len(raw_queue)} objects for dependencies...")
        execution_queue = sort_jobs_by_dependency(raw_queue)

        async with httpx.AsyncClient(timeout=120.0, verify=False) as client:
            
            total_success, total_error = 0, 0
            all_success_data = []
            all_error_data = []

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
                # EXTRACT (With Massive Pagination)
                # ------------------------------------------
                source_records = job.get("rawRecords")

                session_id = job.get("sessionId")
                fixed_records = job.get("fixedRecords", [])
                source_records = []
                
                # 1. If we are running from the UI, we MUST have a Session ID
                if session_id:
                    db_path = get_db_path(session_id)
                    
                    if os.path.exists(db_path):
                        await send_log(f"[{target_object}] Reading strictly validated payload from staging database...")
                        import sqlite3
                        import json
                        
                        try:
                            conn = sqlite3.connect(db_path)
                            cursor = conn.cursor()
                            
                            # ONLY load records that perfectly passed validation
                            cursor.execute("SELECT data FROM records WHERE is_valid = 1")
                            source_records = [json.loads(row[0]) for row in cursor.fetchall()]
                            conn.close()
                            
                            if not source_records:
                                await send_log(f"[{target_object}] FATAL: No valid records found in database. Fix errors and Re-Validate first.", "Failed")
                                continue # Skip this job entirely
                                
                            job["rawRecords"] = source_records
                            await send_log(f"[{target_object}] Loaded {len(source_records)} perfectly valid records ready for migration.")
                            
                        except Exception as e:
                            await send_log(f"[{target_object}] FATAL: Database read error: {str(e)}", "Failed")
                            continue
                            
                    else:
                        # THE FIX: If the file is missing, ABORT! Do not fall back to the API.
                        await send_log(f"[{target_object}] FATAL: Staging payload expired or missing. Please click 'Validate' to generate a fresh payload.", "Failed")
                        continue # Skip this job entirely
                
                # 2. Only allow live API fetching if there is NO session ID at all (e.g., Scheduled Background Jobs)
                else:
                    await send_log(f"[{target_object}] No UI session detected. Initiating direct API extraction...")
                    source_records = []
                    
                    # ======================================
                    # ZOHO EXTRACTION ENGINE
                    # ======================================
                    if zoho_token:
                        await send_log(f"[{target_object}] Initializing extraction from Zoho CRM...")
                        if zoho_api_domain and not zoho_api_domain.startswith(("http://", "https://")):
                            zoho_api_domain = f"https://{zoho_api_domain}"
                        base_url = zoho_api_domain.rstrip('/') if zoho_api_domain else "https://www.zohoapis.com"
                        z_headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
                        
                        # Grab source fields for the API call
                        headers_list = [m["sourceField"] for m in mappings if m.get("sourceField")]
                        safe_fields = headers_list[:40] if headers_list else ["id"]
                        fields_str = ",".join(safe_fields)
                        
                        page = 1
                        more_records = True
                        
                        try:
                            while more_records:
                                if extraction_query:
                                    coql_query = extraction_query.strip()
                                    if coql_query.lower().startswith("select "):
                                        import re
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
                                    res = await client.get(f"{base_url}/crm/v6/{source_object}?page={page}&per_page=200&fields={fields_str}", headers=z_headers)
                                    
                                if res.status_code == 429:
                                    await send_log("⚠️ Zoho Rate Limit. Pausing 30s...", "Paused")
                                    await asyncio.sleep(30)
                                    continue
                                    
                                res.raise_for_status()
                                data = res.json()
                                raw_records = data.get("data") or []
                                
                                if not raw_records: break
                                
                                # Flatten Zoho Data
                                for r in raw_records:
                                    flat_rec = {}
                                    for k, v in r.items():
                                        if isinstance(v, dict) and "id" in v:
                                            flat_rec[k] = v.get("name", v["id"])
                                        else:
                                            flat_rec[k] = v
                                    source_records.append(flat_rec)
                                    
                                await send_log(f"[{target_object}] Extracted {len(source_records)} records so far...")
                                    
                                info = data.get("info", {})
                                more_records = info.get("more_records", False)
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
                            # Search API Extraction Loop
                            safe_obj_singular = safe_obj.rstrip('s')
                            import re
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
                # Salesforce Upload Function
                # ------------------------------------------
                async def execute_sf_bulk(sf_payload, sf_op, pass_name="Standard"):
                    nonlocal total_success, total_error
                    if not sf_payload: return

                    await send_log(f"[{target_object}] {pass_name}: Initializing {sf_op.upper()}...")
                    sf_headers = {"X-SFDC-Session": sf_token, "Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"}
                    bulk_base_url = f"{sf_instance.rstrip('/')}/services/async/60.0"

                    job_config = {"operation": sf_op, "object": target_object, "contentType": "JSON"}
                    if sf_op == "upsert": job_config["externalIdFieldName"] = target_ext_id_field

                    job_res = await client.post(f"{bulk_base_url}/job", json=job_config, headers=sf_headers)
                    if job_res.status_code != 201:
                        await send_log(f"[{target_object}] Salesforce Job Failed: {job_res.text}")
                        return
                    job_id = job_res.json().get("id")

                    chunks = list(chunk_dataset(sf_payload, batch_size))
                    await send_log(f"[{target_object}] {pass_name}: Executing {len(chunks)} batches (Max 6 concurrent threads)...")

                    # THE THROTTLE: Strictly limit to 6 parallel uploads at a time
                    semaphore = asyncio.Semaphore(6)

                    async def upload_chunk(chunk_data):
                        async with semaphore:
                            just_sf_records = [c["sfRecord"] for c in chunk_data]
                            b_res = await client.post(f"{bulk_base_url}/job/{job_id}/batch", json=just_sf_records, headers=sf_headers)
                            b_res.raise_for_status()
                            return b_res.json().get("id")

                    # Fire the safely throttled tasks
                    batch_ids = await asyncio.gather(*[upload_chunk(c) for c in chunks])
                    await client.post(f"{bulk_base_url}/job/{job_id}", json={"state": "Closed"}, headers=sf_headers)

                    # Poll for completion with Exponential Backoff
                    poll_delay = 1.0
                    while True:
                        await asyncio.sleep(poll_delay)
                        status_res = await asyncio.gather(*[client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}", headers=sf_headers) for b_id in batch_ids])
                        states = [r.json().get("state") for r in status_res]
                        if all(s == "Completed" for s in states) or any(s in ["Failed", "NotProcessed"] for s in states):
                            break
                        poll_delay = min(poll_delay * 1.5, 4.0)

                    # Fetch Results
                    for i, b_id in enumerate(batch_ids):
                        res = await client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}/result", headers=sf_headers)
                        results = res.json()
                        original_chunk = chunks[i]

                        for row_data, sf_result in zip(original_chunk, results):
                            orig_record = source_records[row_data["originalIndex"]]
                            if sf_result.get("success"):
                                orig_record["Salesforce_Id"] = sf_result.get("id")
                                all_success_data.append(orig_record)
                                total_success += 1
                            else:
                                err_msg = sf_result.get("errors", [{"message": "Unknown"}])[0].get("message")
                                orig_record["Salesforce_Error"] = err_msg
                                all_error_data.append(orig_record)
                                total_error += 1


                # ------------------------------------------
                # STEP 2 & 3: THE 3-PASS ROUTER
                # ------------------------------------------
                has_self_ref = any(m.get("type") == "reference" and target_object in m.get("referenceTo", []) for m in mappings)

                if is_pass3_patch:
                    payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "onlyReferencesTo": only_references_to, "operationMode": "upsert"})
                    await execute_sf_bulk(payload, "upsert", "Pass 3 (Circular Patch)")

                elif operation_mode == "delete":
                    payload = build_payload(source_records, mappings, {"targetObject": target_object, "operationMode": "delete"})
                    await execute_sf_bulk(payload, "delete", "Deletion")

                elif has_self_ref:
                    sf_op = "upsert" if (target_ext_id_field and target_ext_id_field != "Id") else operation_mode
                    p1_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "excludeReferencesTo": defer_references_to, "skipSelfReferencing": True, "operationMode": sf_op})
                    await execute_sf_bulk(p1_payload, sf_op, "Pass 1 (Base Data)")

                    p2_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "onlySelfReferencing": True, "operationMode": "upsert"})
                    await execute_sf_bulk(p2_payload, "upsert", "Pass 2 (Hierarchy Patch)")

                else:
                    sf_op = "upsert" if (target_ext_id_field and target_ext_id_field != "Id") else operation_mode
                    std_payload = build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": target_ext_id_field, "excludeReferencesTo": defer_references_to, "operationMode": sf_op})
                    await execute_sf_bulk(std_payload, sf_op, "Standard Sync")

            # Final Summary
            if total_error > 0:
                await send_log(f"Completed with Errors: {total_success} inserted/updated, {total_error} failed.", "Finished")
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

            # 1. EXTRACT DB IDs & CLEAN PAYLOAD
            db_ids_to_delete = []
            for rec in fixed_records:
                if "_db_id" in rec:
                    db_ids_to_delete.append(rec.pop("_db_id")) # Remove ID so it doesn't break Salesforce schema

            # 2. Process the fixed records through the validation engine
            chunk_result = process_validation_batch(fixed_records, mappings, dedupe_key, sf_rules, "")

            # 3. DELETE ONLY THE SPECIFIC 500 ROWS THE USER JUST FIXED
            if db_ids_to_delete:
                placeholders = ','.join(['?'] * len(db_ids_to_delete))
                cursor.execute(f"DELETE FROM records WHERE id IN ({placeholders})", db_ids_to_delete)

            # 4. Insert the newly tested records (If they failed again, they go back to errors)
            valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
            invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]

            conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
            conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
            conn.commit()

            # 5. Recalculate totals directly from the database
            cursor.execute("SELECT COUNT(*) FROM records")
            total_count = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM records WHERE is_valid = 1")
            valid_count = cursor.fetchone()[0]
            cursor.execute("SELECT COUNT(*) FROM records WHERE is_valid = 0")
            invalid_count = cursor.fetchone()[0]

            # 6. GRAB THE NEXT 500 ERRORS FOR THE CONTINUOUS INBOX
            cursor.execute("SELECT id, data, errors FROM records WHERE is_valid = 0 LIMIT 500")
            db_errors = cursor.fetchall()
            
            all_invalid_records = []
            for row in db_errors:
                rec_data = json.loads(row[1])
                rec_data["_db_id"] = row[0] # Inject DB ID for the next round
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
        # --- END OF RE-VALIDATION LOGIC ---

        # --- ORIGINAL LOGIC FOR FRESH RUNS ---
        crm_id = payload.get("crmId", "").lower()
        obj_name = payload.get("objectName", "")
        query = payload.get("query", "").strip()
        mappings = payload.get("mappings", [])
        dedupe_key = payload.get("dedupeKey", "")
        sf_rules = payload.get("sfRules", {})
        
        sf_token = payload.get("sfToken", "")
        sf_instance = payload.get("sfInstance", "")
        zd_token = payload.get("zdToken", "")
        zd_subdomain = payload.get("zdSubdomain", "")
        zoho_token = payload.get("zohoToken", "")
        zoho_api_domain = payload.get("zohoDomain", "")

        # Generate Smart Session ID
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
                safe_obj_singular = safe_obj[:-1] if safe_obj.endswith('s') else safe_obj
                import re
                clean_query = re.sub(r'type:[a-zA-Z0-9_]+', '', query, flags=re.IGNORECASE).strip()
                final_query = f"{clean_query} type:{safe_obj_singular}".strip()
                safe_query = urllib.parse.quote(final_query)
                url = f"https://{zd_subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
                zd_headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
                
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
                                for cf in v: flat_rec[f"custom_field_{cf['id']}"] = cf.get("value")
                            elif not isinstance(v, (dict, list)):
                                flat_rec[k] = v
                        chunk_records.append(flat_rec)

                    if not chunk_records: break
                    chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "")

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
                    
                    meta = data.get("meta")
                    if meta and meta.get("has_more"):
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
                    chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "")
                    
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
                more_records = True

                while more_records:
                    if query:
                        coql_query = query.strip()
                        if coql_query.lower().startswith("select "):
                            import re
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
                        res = await client.get(f"{base_url}/crm/v6/{obj_name}?page={page}&per_page=200&fields={fields_str}", headers=headers)

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
                            if isinstance(v, dict) and "id" in v:
                                flat_rec[k] = v.get("name", v["id"]) 
                            else:
                                flat_rec[k] = v
                        chunk_records.append(flat_rec)

                    chunk_result = process_validation_batch(chunk_records, mappings, dedupe_key, sf_rules, "")
                    
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
            rec_data["_db_id"] = row[0] # Inject DB ID
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