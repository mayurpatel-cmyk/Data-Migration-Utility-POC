import urllib.parse
import re
import asyncio
import json
from app.services.crm_service import CrmService

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class HubspotMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        user_id = creds.get("user_id") # <-- Needed for refresh
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        safe_obj = obj_name.lower()
        source_records = []
        
        properties = ["hs_object_id"]
        for mapping in mappings:
            source_field = mapping.get("sourceField")
            if source_field and source_field not in properties:
                properties.append(source_field)

        try:
            url = f"{domain}/crm/v3/objects/{safe_obj}/search"
            payload = {
                "limit": 100,
                "properties": properties[:100] 
            }
            
            if query and query.strip():
                try:
                    query_dict = json.loads(query)
                    if "filterGroups" in query_dict: payload["filterGroups"] = query_dict["filterGroups"]
                    if "sorts" in query_dict: payload["sorts"] = query_dict["sorts"]
                except json.JSONDecodeError:
                    await send_log(f"⚠️ [HubSpot Extraction] Invalid query format. Ignoring.")

            while True:
                # --- FIX: Silent Retry Loop for Extraction ---
                while True:
                    res = await client.post(url, headers=headers, json=payload)
                    
                    if res.status_code == 401:
                        await send_log(f"⚠️ HubSpot token expired. Silently refreshing...")
                        token = await CrmService.refresh_crm_token(user_id, "hubspot", "source")
                        headers["Authorization"] = f"Bearer {token}"
                        continue

                    if res.status_code == 429:
                        retry_after = int(res.headers.get("Retry-After", 10))
                        await send_log(f"⚠️ [HubSpot Rate Limit] Pausing extraction for {retry_after}s...")
                        await asyncio.sleep(retry_after)
                        continue
                        
                    break # Break retry loop
                    
                res.raise_for_status()
                data = res.json()
                records = data.get("results", [])
                
                if not records: break
                
                for rec in records:
                    flat_rec = {"id": rec.get("id")}
                    props = rec.get("properties", {})
                    if props:
                        for k, v in props.items(): flat_rec[k] = v
                    source_records.append(flat_rec)
                
                if len(source_records) % 1000 == 0:
                    await send_log(f"[{obj_name}] Extracted {len(source_records)} records...")
                
                paging = data.get("paging", {}).get("next", {})
                if "after" in paging:
                    payload["after"] = paging["after"]
                else:
                    break
                    
            await send_log(f"[{obj_name}] Extraction Complete! Total: {len(source_records)}")
            return source_records
            
        except Exception as e:
            await send_log(f"[{obj_name}] Extract Failed: {str(e)}")
            raise e

    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, [], []

        target_object = options["targetObject"]
        token = options["token"]
        domain = (options.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        source_records = options["sourceRecords"]
        dedupe_key = options.get("dedupeKey", "email")
        
        user_id = options.get("userId") # <-- Needed for refresh

        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        await send_log(f"[{target_object}] {pass_name}: Pushing data to HubSpot (Concurrent Mode)...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        safe_obj = target_object.lower()

        chunks = list(chunk_dataset(payload, 100))

        if op_mode == "update":
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/update"
        elif op_mode == "upsert":
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/upsert?idProperty={dedupe_key}"
        else:
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/create"

        semaphore = asyncio.Semaphore(10) 

        async def process_chunk(chunk):
            async with semaphore:
                if op_mode == "update":
                    hs_records = [{"id": c["targetRecord"].pop("id"), "properties": c["targetRecord"]} for c in chunk if "id" in c["targetRecord"]]
                elif op_mode == "upsert":
                    hs_records = [{"id": str(c["targetRecord"].pop(dedupe_key)), "properties": c["targetRecord"]} for c in chunk if dedupe_key in c["targetRecord"]]
                else:
                    hs_records = [{"properties": c["targetRecord"]} for c in chunk]

                if not hs_records:
                    return {"chunk": chunk, "status": "error", "message": "Missing required record IDs for operation."}

                req_payload = {"inputs": hs_records}
                
                try:
                    # --- FIX: Silent Retry Loop for Uploads ---
                    while True:
                        res = await client.post(endpoint, json=req_payload, headers=headers)
                        
                        # Catch Expiration Mid-Upload
                        if res.status_code == 401:
                            await send_log(f"⚠️ HubSpot token expired mid-migration. Silently refreshing...")
                            token = await CrmService.refresh_crm_token(user_id, "hubspot", "target")
                            headers["Authorization"] = f"Bearer {token}"
                            continue # Retry exact chunk

                        if res.status_code == 429:
                            retry_after = int(res.headers.get("Retry-After", 10))
                            await send_log(f"⚠️ [HubSpot Rate Limit] Pausing batch for {retry_after}s...")
                            await asyncio.sleep(retry_after)
                            continue
                            
                        break

                    if res.status_code not in [201, 200, 207]:
                        error_body = res.json()
                        error_msg = error_body.get("message", res.text)
                        return {"chunk": chunk, "status": "error", "message": error_msg}
                        
                    data = res.json()
                    results = []
                    
                    successes = data.get("results", [])
                    success_map = {str(i): s for i, s in enumerate(successes)}
                    
                    errors = data.get("errors", [])
                    error_map = {str(e.get("index")): e for e in errors}
                    
                    for i in range(len(chunk)):
                        index_str = str(i)
                        if index_str in error_map:
                            results.append({
                                "success": False, 
                                "details": error_map[index_str].get("message", "Validation failed")
                            })
                        elif index_str in success_map:
                            results.append({
                                "success": True, 
                                "id": success_map[index_str].get("id")
                            })
                        else:
                            results.append({"success": True, "id": "Success"})
                            
                    return {"chunk": chunk, "status": "completed", "results": results}
                        
                except Exception as exc:
                    return {"chunk": chunk, "status": "error", "message": str(exc)}

        batch_results = await asyncio.gather(*[process_chunk(chunk) for chunk in chunks])

        for batch_res in batch_results:
            chunk = batch_res["chunk"]
            
            if batch_res["status"] == "error":
                for item in chunk:
                    orig_record = source_records[item["originalIndex"]]
                    orig_record["Target_Error"] = f"HubSpot API Error: {batch_res.get('message')}"
                    all_error_data.append(orig_record)
                    total_error += 1
            else:
                for item, hs_res in zip(chunk, batch_res.get("results", [])):
                    orig_record = source_records[item["originalIndex"]]
                    if hs_res.get("success"):
                        orig_record["Target_Id"] = hs_res.get("id", "Success")
                        all_success_data.append(orig_record)
                        total_success += 1
                    else:
                        orig_record["Target_Error"] = hs_res.get("details", "Failed")
                        all_error_data.append(orig_record)
                        total_error += 1

        return total_success, total_error, all_success_data, all_error_data