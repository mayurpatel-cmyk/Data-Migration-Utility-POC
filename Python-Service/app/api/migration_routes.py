import asyncio
import httpx
import traceback
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from app.services.validator_service import process_validation_batch
from app.utils.config import supabase
from app.services.crm_service import CrmService

# Import our Migrators!
from app.services.migrators.salesforce_migrator import SalesforceMigrator
from app.services.migrators.zoho_migrator import ZohoMigrator
from app.services.migrators.zendesk_migrator import ZendeskMigrator
from app.services.migrators.hubspot_migrator import HubspotMigrator
from app.services.payload_builder import PayloadBuilderService

import uuid
import sqlite3
import urllib.parse
import os
import io
import json
import csv
from datetime import datetime
from fastapi.responses import StreamingResponse

router = APIRouter()
BASE_STAGING_DIR = os.path.join(os.getcwd(), "SureShift_staging_databases")

MIGRATORS = {
    "salesforce": SalesforceMigrator(),
    "zoho": ZohoMigrator(),
    "zendesk": ZendeskMigrator(),
    "hubspot": HubspotMigrator()
}

def get_db_path(session_id: str):
    parts = session_id.split('_')
    crm_folder = parts[0] if len(parts) > 0 else "uncategorized"
    obj_folder = parts[1] if len(parts) > 1 else "unknown_object"
    target_dir = os.path.join(BASE_STAGING_DIR, crm_folder, obj_folder)
    os.makedirs(target_dir, exist_ok=True)
    return os.path.join(target_dir, f"{session_id}.db")

def chunk_dataset(data: list, chunk_size: int = 5000):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

def sort_jobs_by_dependency(jobs):
    sorted_jobs, pass3_jobs = [], []
    visited, visiting = set(), set()

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

    for job in jobs: visit(job)
    return sorted_jobs + pass3_jobs

# ==========================================
# CORE MIGRATION ROUTE
# ==========================================
@router.websocket("/ws/migrate")
async def websocket_migration(websocket: WebSocket):
    await websocket.accept()
    
    try:
        await websocket.send_json({"log": "System: Multi-Object Engine Initialized.", "status": "Initializing..."})
        payload = await websocket.receive_json()
        
        raw_queue = payload.get("queue") or [payload] 
        auth_token = payload.get("authToken") or raw_queue[0].get("authToken")
        
        user_res = supabase.auth.get_user(auth_token)
        if not user_res or not user_res.user:
            await websocket.send_json({"log": "FATAL: Invalid or expired session.", "status": "Failed"})
            await websocket.close()
            return
            
        user_id = user_res.user.id
        source_crm = raw_queue[0].get("sourceCrmId", "zendesk").lower() 
        target_crm = raw_queue[0].get("targetCrmId", "salesforce").lower() 
        
        source_creds = CrmService.get_active_crm_credentials(user_id, source_crm, "source")
        target_creds = CrmService.get_active_crm_credentials(user_id, target_crm, "target")

        source_migrator = MIGRATORS.get(source_crm)
        target_migrator = MIGRATORS.get(target_crm)

        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        execution_queue = sort_jobs_by_dependency(raw_queue)

        async with httpx.AsyncClient(timeout=120.0, verify=False) as client:
            all_success_data, all_error_data = [], []

            for job in execution_queue:
                target_object = job.get("targetObject")
                source_object = job.get("sourceObject", "")
                extraction_query = job.get("extractionQuery", "").strip()
                mappings = [m for m in job.get("mappings", []) if m.get("targetField")]
                op_mode = job.get("operationMode", "insert")
                batch_size = int(job.get("batchSize", 5000))
                ext_id_field = job.get("externalIdField", "")
                
                if not mappings: continue
                source_records = []

                session_id = job.get("sessionId")
                if session_id:
                    db_path = get_db_path(session_id)
                    conn = sqlite3.connect(db_path)
                    cursor = conn.cursor()
                    cursor.execute("SELECT data FROM records WHERE is_valid = 1")
                    source_records = [json.loads(row[0]) for row in cursor.fetchall()]
                    conn.close()
                    await send_log(f"[{target_object}] Loaded {len(source_records)} valid records from staging.")
                else:
                    await send_log(f"[{target_object}] Direct API extraction from {source_crm.capitalize()}...")
                    source_records = await source_migrator.extract(client, source_creds, source_object, extraction_query, mappings, send_log)

                options_base = {
                    "targetObject": target_object, "targetExtIdField": ext_id_field, "operationMode": op_mode,
                    "token": target_creds.get("access_token"), "instance_url": target_creds.get("instance_url") or target_creds.get("api_domain") or target_creds.get("subdomain"),
                    "batchSize": batch_size, "sourceRecords": source_records, "userId": user_id
                }

                async def execute_upload(payload_data, current_op, pass_name):
                    options_pass = dict(options_base)
                    _, _, succ, err = await target_migrator.upload(client, payload_data, current_op, pass_name, options_pass, send_log)
                    all_success_data.extend(succ)
                    all_error_data.extend(err)

                has_self_ref = any(m.get("type") == "reference" and target_object in m.get("referenceTo", []) for m in mappings)
                
                if job.get("isPass3Patch", False):
                    p_load = PayloadBuilderService.build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": ext_id_field, "onlyReferencesTo": job.get("onlyReferencesTo", []), "operationMode": "upsert"}, target_crm)
                    await execute_upload(p_load, "upsert", "Pass 3 (Patch)")
                elif op_mode == "delete":
                    p_load = PayloadBuilderService.build_payload(source_records, mappings, {"targetObject": target_object, "operationMode": "delete"}, target_crm)
                    await execute_upload(p_load, "delete", "Deletion")
                elif has_self_ref:
                    p1_load = PayloadBuilderService.build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": ext_id_field, "excludeReferencesTo": job.get("deferReferencesTo", []), "skipSelfReferencing": True, "operationMode": op_mode}, target_crm)
                    await execute_upload(p1_load, op_mode, "Pass 1")
                    p2_load = PayloadBuilderService.build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": ext_id_field, "onlySelfReferencing": True, "operationMode": "upsert"}, target_crm)
                    await execute_upload(p2_load, "upsert", "Pass 2")
                else:
                    p_load = PayloadBuilderService.build_payload(source_records, mappings, {"targetObject": target_object, "targetExtIdField": ext_id_field, "excludeReferencesTo": job.get("deferReferencesTo", []), "operationMode": op_mode}, target_crm)
                    await execute_upload(p_load, op_mode, "Standard Sync")

            await send_log(f"QUEUE COMPLETE! {len(all_success_data)} successes, {len(all_error_data)} rejections.", "Finished")
            await websocket.send_json({
                "log": "System: Generating downloadable execution logs...",
                "status": "Finished",
                "successData": all_success_data,
                "errorData": all_error_data
            })
        await websocket.close()
        
    except WebSocketDisconnect:
        pass
    except Exception as e:
        traceback.print_exc()
        try:
            await websocket.send_json({"log": f"SYSTEM CRASH: {str(e)}", "status": "Failed"})
            await websocket.close()
        except: pass


# ==========================================
# MASSIVE STREAMING VALIDATION (WS)
# ==========================================
@router.websocket("/ws/validate-stream")
async def websocket_validate_stream(websocket: WebSocket):
    await websocket.accept()
    
    try:
        payload = await websocket.receive_json()
        is_revalidation = payload.get("isRevalidation", False)
        session_id = payload.get("sessionId", "")

        # --- RE-VALIDATION ROUTE ---
        if is_revalidation and session_id:
            db_path = get_db_path(session_id) 
            if not os.path.exists(db_path):
                await websocket.send_json({"log": "Error: Staging session expired.", "status": "Validation Failed"})
                await websocket.close()
                return

            fixed_records = payload.get("fixedRecords", [])
            mappings = payload.get("mappings", [])
            dedupe_key = payload.get("dedupeKey", "")
            sf_rules = payload.get("sfRules", {})
            target_crm = payload.get("targetCrmId", "salesforce").lower()

            await websocket.send_json({"log": "System: Re-validating UI fixes...", "status": "Validating"})

            conn = sqlite3.connect(db_path)
            cursor = conn.cursor()

            db_ids_to_delete = [rec.pop("_db_id") for rec in fixed_records if "_db_id" in rec]

            chunk_result = process_validation_batch(fixed_records, mappings, dedupe_key, sf_rules, "", target_crm)

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
            all_invalid_records = [{"originalRow": dict(json.loads(row[1]), _db_id=row[0]), "errors": row[2]} for row in cursor.fetchall()]
            conn.close()

            await websocket.send_json({
                "log": f"Re-validation Complete: Fixed {len(valid_inserts)} records.",
                "status": "Validation Passed" if invalid_count == 0 else "Validation Warning",
                "stats": {"total": total_count, "valid": valid_count, "invalid": invalid_count, "duplicates": chunk_result["stats"].get("duplicates", 0)},
                "invalidRecords": all_invalid_records,
                "sessionId": session_id
            })
            await websocket.close()
            return

        # --- INITIAL VALIDATION ROUTE (DYNAMIC) ---
        auth_token = payload.get("authToken")
        user_res = supabase.auth.get_user(auth_token)
        if not user_res or not user_res.user:
            await websocket.send_json({"log": "FATAL: Invalid or expired session.", "status": "Validation Failed"})
            await websocket.close()
            return
        
        user_id = user_res.user.id
        source_crm = payload.get("crmId", "").lower()
        target_crm = payload.get("targetCrmId", "salesforce").lower()
        obj_name = payload.get("objectName", "")
        query = payload.get("query", "").strip()
        mappings = payload.get("mappings", [])
        dedupe_key = payload.get("dedupeKey", "")
        sf_rules = payload.get("sfRules", {})

        source_creds = CrmService.get_active_crm_credentials(user_id, source_crm, "source")
        source_migrator = MIGRATORS.get(source_crm)

        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        safe_obj = ''.join(e for e in obj_name if e.isalnum()).lower() or "unknown"
        session_id = f"{source_crm}_{safe_obj}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(uuid.uuid4())[:8]}"
        
        db_path = get_db_path(session_id)
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, is_valid BOOLEAN, data TEXT, errors TEXT)")
        
        aggregate_stats = {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}
        await send_log(f"System: Initializing Streaming Validation...", "Connecting")

        async with httpx.AsyncClient(verify=False, timeout=60.0) as client:
            try:
                # 1. DYNAMIC API EXTRACTION
                raw_records = await source_migrator.extract(client, source_creds, obj_name, query, mappings, send_log)
                
                if not raw_records:
                    await send_log("No records found matching criteria.", "Validation Passed")
                    await websocket.close()
                    return

                # 2. BATCH VALIDATE AND DB INSERTION
                chunks = list(chunk_dataset(raw_records, 1000))
                for chunk in chunks:
                    chunk_result = process_validation_batch(chunk, mappings, dedupe_key, sf_rules, "", target_crm)
                    
                    valid_inserts = [(True, json.dumps(rec), "") for rec in chunk_result.get("validRecords", [])]
                    invalid_inserts = [(False, json.dumps(rec["originalRow"]), rec["errors"]) for rec in chunk_result.get("invalidRecords", [])]
        
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", valid_inserts)
                    conn.executemany("INSERT INTO records (is_valid, data, errors) VALUES (?, ?, ?)", invalid_inserts)
                    conn.commit()
                    
                    aggregate_stats["total"] += chunk_result["stats"]["total"]
                    aggregate_stats["valid"] += chunk_result["stats"]["valid"]
                    aggregate_stats["invalid"] += chunk_result["stats"]["invalid"]
                    aggregate_stats["duplicates"] += chunk_result["stats"]["duplicates"]

                    await send_log(f"Validated {aggregate_stats['total']} records so far...", "Validating")

            except Exception as e:
                await send_log(f"Validation Extraction Failed: {str(e)}", "Validation Failed")
                await websocket.close()
                return

        # 3. GRAB INITIAL UI ERRORS
        cursor = conn.cursor()
        cursor.execute("SELECT id, data, errors FROM records WHERE is_valid = 0 LIMIT 500")
        all_invalid_records = [{"originalRow": dict(json.loads(row[1]), _db_id=row[0]), "errors": row[2]} for row in cursor.fetchall()]
        conn.close()

        await websocket.send_json({
            "log": f"Stream Validation Complete: {aggregate_stats['total']} total records.",
            "status": "Validation Passed" if aggregate_stats["invalid"] == 0 else "Validation Warning",
            "stats": aggregate_stats,
            "invalidRecords": all_invalid_records,
            "sessionId": session_id
        })
        await websocket.close()
        
    except WebSocketDisconnect:
        pass
    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            await websocket.send_json({"log": f"Stream Crash: {str(e)}", "status": "Validation Failed"})
            await websocket.close()
        except: pass


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