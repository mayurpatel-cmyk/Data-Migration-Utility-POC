import urllib.parse
import re
import asyncio
import json
from app.services.crm_service import CrmService

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZendeskMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        subdomain = creds.get("subdomain")
        user_id = creds.get("user_id")
        if not subdomain and creds.get("api_domain"):
            subdomain = creds.get("api_domain").replace(".zendesk.com", "").replace("https://", "")
        
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        safe_obj = obj_name.strip().lower()
        source_records = []
        
        # 1. Determine if this is a standard object or a custom object
        standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
        is_standard = safe_obj in standard_objects or f"{safe_obj}s" in standard_objects
        
        try:
            if is_standard:
                # ==========================================
                # STANDARD OBJECT EXTRACTION
                # ==========================================
                safe_obj_singular = safe_obj[:-1] if safe_obj.endswith('s') else safe_obj
                
                clean_query = re.sub(r'type:[a-zA-Z0-9_]+', '', query, flags=re.IGNORECASE).strip() if query else ""
                final_query = f"{clean_query} type:{safe_obj_singular}".strip()
                safe_query = urllib.parse.quote(final_query)
                
                url = f"https://{subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
                
                while url:
                    while True:
                        res = await client.get(url, headers=headers)
                        if res.status_code == 401:
                            await send_log(" Zendesk token expired. Silently refreshing...")
                            token = await CrmService.refresh_crm_token(user_id, "zendesk", "source")
                            headers["Authorization"] = f"Bearer {token}"
                            continue
                        if res.status_code == 429:
                            await send_log(" ⏳ Zendesk Rate Limit hit. Pausing 30s...")
                            await asyncio.sleep(30)
                            continue
                        break
                        
                    res.raise_for_status()
                    data = res.json()
                    
                    results = data.get("results", [])
                    if not results: break
                    
                    for r in results:
                        flat_rec = {}
                        for k, v in r.items():
                            if isinstance(v, dict):
                                flat_rec[k] = v.get("id", v.get("name", str(v)))
                            elif isinstance(v, list):
                                flat_rec[k] = ";".join([str(i.get("id", i.get("name", i))) if isinstance(i, dict) else str(i) for i in v])
                            else:
                                flat_rec[k] = v
                        source_records.append(flat_rec)
                        
                    if len(source_records) % 500 == 0:
                        await send_log(f"[{safe_obj}] Extracted {len(source_records)} records...")
                        
                    url = data.get("links", {}).get("next")
                    if not data.get("meta", {}).get("has_more"):
                        break

            else:
                # ==========================================
                # CUSTOM OBJECT EXTRACTION
                # ==========================================
                is_search = bool(query and query.strip())
                json_payload = {}
                
                if is_search:
                    try:
                        json_payload = json.loads(query)
                    except json.JSONDecodeError:
                        raise Exception("Invalid JSON payload in Zendesk query for custom objects.")
                    
                    url = f"https://{subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records/search?page[size]=100"
                else:
                    url = f"https://{subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records?page[size]=100"

                while url:
                    while True:
                        if is_search:
                            res = await client.post(url, headers=headers, json=json_payload)
                        else:
                            res = await client.get(url, headers=headers)

                        if res.status_code == 401:
                            await send_log(" Zendesk token expired. Silently refreshing...")
                            token = await CrmService.refresh_crm_token(user_id, "zendesk", "source")
                            headers["Authorization"] = f"Bearer {token}"
                            continue
                        if res.status_code == 429:
                            await send_log(" ⏳ Zendesk Rate Limit hit. Pausing 30s...")
                            await asyncio.sleep(30)
                            continue
                        break

                    res.raise_for_status()
                    data = res.json()

                    results = data.get("custom_object_records", [])
                    if not results: break

                    for rec in results:
                        flat_rec = {}
                        for k, v in rec.items():
                            if k == "custom_fields" and isinstance(v, list):
                                for cf in v: flat_rec[f"custom_field_{cf['id']}"] = cf.get("value")
                            elif k == "custom_object_fields" and isinstance(v, dict):
                                for cf_key, cf_val in v.items(): flat_rec[cf_key] = cf_val
                            elif not isinstance(v, (dict, list)): 
                                flat_rec[k] = v
                        source_records.append(flat_rec)

                    if len(source_records) % 100 == 0:
                        await send_log(f"[{safe_obj}] Extracted {len(source_records)} records...")

                    url = data.get("links", {}).get("next")
                    if not data.get("meta", {}).get("has_more"):
                        break

        except Exception as e:
            await send_log(f" Zendesk Extraction Error: {str(e)}")
            
        await send_log(f"[{safe_obj}] Extraction Complete! Total: {len(source_records)}")
        return source_records


    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, 0, [], [], []

        target_object = options["targetObject"].strip().lower()

        token = options["token"]
        domain = options.get("instance_url", "").replace(".zendesk.com", "").replace("https://", "").strip('/')
        source_records = options["sourceRecords"]
        target_ext_id_field = options.get("targetExtIdField", "")
        user_id = options.get("userId")

        await send_log(f"[{target_object}] {pass_name}: Injecting data stream into Zendesk...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        total_success, total_error, total_skipped = 0, 0, 0
        all_success_data, all_error_data, all_skipped_data = [], [], []
        ids_to_revert = []

        chunks = list(chunk_dataset(payload, 100))

        is_update_only = (op_mode == "update")
        wire_op_mode = "upsert" if is_update_only else op_mode

        if wire_op_mode == "upsert" and not target_ext_id_field:
            await send_log(
                f"[{target_object}] {pass_name}: No unique/external ID field configured -- "
                f"cannot match existing records for {op_mode.upper()}."
            )
            return 0, len(payload), 0, [], [source_records[item["originalIndex"]] for item in payload], []

        standard_objects = {"tickets", "users", "organizations", "groups", "macros", "triggers", "views"}
        is_standard_object = target_object in standard_objects or f"{target_object}s" in standard_objects

        if is_standard_object:
            endpoint = "create_or_update_many.json" if wire_op_mode == "upsert" else "create_many.json"
            api_path = f"https://{domain}.zendesk.com/api/v2/{target_object}/{endpoint}"
        else:
            job_action = "create_or_update_by_external_id" if wire_op_mode == "upsert" else "create"
            api_path = f"https://{domain}.zendesk.com/api/v2/custom_objects/{target_object}/jobs"

        async def process_chunk(chunk):
            if is_standard_object:
                # DYNAMIC JSON WRAPPER: Zendesk root keys MUST match the object name exactly
                zendesk_data_rows = [c["targetRecord"] for c in chunk]
                req_payload = {target_object: zendesk_data_rows}
            else:
                items = [c["targetRecord"] for c in chunk]
                req_payload = {"job": {"action": job_action, "items": items}}

            nonlocal token
            while True:
                res = await client.post(api_path, json=req_payload, headers=headers)

                if res.status_code == 401:
                    await send_log(" Zendesk token expired mid-migration. Silently refreshing...")
                    token = await CrmService.refresh_crm_token(user_id, "zendesk", "target")
                    headers["Authorization"] = f"Bearer {token}"
                    continue

                if res.status_code == 429:
                    await send_log(" ⏳ Zendesk API Rate Limit reached. Pausing 30s...")
                    await asyncio.sleep(30)
                    continue
                break

            if res.status_code in [200, 201, 202]:
                data = res.json()
                
                # ASYNC JOB POLLING: Bulk API endpoints return a Job Status ID
                if "job_status" in data:
                    job_id = data["job_status"]["id"]
                    await send_log(f" 🔄 Batch accepted. Waiting for Zendesk Background Job: {job_id}...")
                    
                    while True:
                        job_res = await client.get(f"https://{domain}.zendesk.com/api/v2/job_statuses/{job_id}.json", headers=headers)
                        if job_res.status_code == 429:
                            await asyncio.sleep(30)
                            continue
                            
                        job_data = job_res.json().get("job_status", {})
                        if job_data.get("status") in ["completed", "failed", "killed"]:
                            return {"chunk": chunk, "status": "completed", "results": job_data.get("results", [])}
                        
                        await asyncio.sleep(3) # Poll every 3 seconds
                else:

                    fallback_results = data.get(target_object, []) if is_standard_object else data.get("results", [])
                    return {"chunk": chunk, "status": "completed", "results": fallback_results}
            else:
                return {"chunk": chunk, "status": "error", "message": res.text}

        # Fire off batches concurrently (5 chunks at a time to respect limits)
        batch_results = []
        for i in range(0, len(chunks), 5):
            concurrent_batch = chunks[i:i+5]
            results = await asyncio.gather(*[process_chunk(chunk) for chunk in concurrent_batch])
            batch_results.extend(results)

        for batch_res in batch_results:
            chunk = batch_res["chunk"]
            
            if batch_res["status"] == "error":
                for item in chunk:
                    orig_record = source_records[item["originalIndex"]]
                    orig_record["Target_Error"] = f"Zendesk API Error: {batch_res.get('message')}"
                    all_error_data.append(orig_record)
                    total_error += 1
            else:
                for item, z_res in zip(chunk, batch_res.get("results", [])):
                    orig_record = source_records[item["originalIndex"]]

                    is_success = z_res.get("success") == True or z_res.get("status") in ["Created", "Updated"]

   
                    if is_success and is_update_only and z_res.get("action") == "create":
                        orig_record["Target_SkipReason"] = (
                            f"No matching record found in Zendesk. "
                            f"Skipped because Update mode does not create new records."
                        )
                        all_skipped_data.append(orig_record)
                        total_skipped += 1
                        raw_id = z_res.get("id")
                        if raw_id:
                            ids_to_revert.append(str(raw_id))
                        continue

                    if is_success:
                        # --- Strict String Cast ---
                        raw_id = z_res.get("id")
                        orig_record["Target_Id"] = str(raw_id) if raw_id else "Success"
                        
                        all_success_data.append(orig_record)
                        total_success += 1
                    elif z_res.get("error"):
                        orig_record["Target_Error"] = str(z_res.get("details") or z_res.get("error"))
                        all_error_data.append(orig_record)
                        total_error += 1
                    else: 
                        # ---  Strict String Cast ---
                        raw_id = z_res.get("id")
                        orig_record["Target_Id"] = str(raw_id) if raw_id else "Success"
                        
                        all_success_data.append(orig_record)
                        total_success += 1

        if ids_to_revert:
            await send_log(
                f"[{target_object}] {pass_name}: Update mode found {len(ids_to_revert)} record(s) with no "
                f"match — reverting the records Zendesk auto-created for them..."
            )
            await self._delete_records(client, domain, headers, target_object, ids_to_revert, send_log)

        return total_success, total_error, total_skipped, all_success_data, all_error_data, all_skipped_data

    async def _delete_records(self, client, domain, headers, target_object, record_ids, send_log):
        """Bulk-deletes records Zendesk auto-created that 'update' mode should
        never have created in the first place (destroy_many accepts <=100
        ids per call)."""
        for chunk in chunk_dataset(record_ids, 100):
            try:
                ids_param = ",".join(chunk)
                url = f"https://{domain}.zendesk.com/api/v2/{target_object}/destroy_many.json?ids={ids_param}"
                res = await client.delete(url, headers=headers)

                if res.status_code not in [200, 202, 204]:
                    await send_log(f"[{target_object}] Revert batch failed: {res.text}")
            except Exception as e:
                await send_log(f"[{target_object}] Revert Failed: {str(e)}")