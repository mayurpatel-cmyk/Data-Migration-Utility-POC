import urllib.parse
import re
import asyncio
import json

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class HubspotMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        safe_obj = obj_name.lower()
        source_records = []
        
        # Build the exact list of properties we need to extract based on the mapping
        # We always want the standard ID
        properties = ["hs_object_id"]
        for mapping in mappings:
            # We check for sourceField since this is an extraction task
            source_field = mapping.get("sourceField")
            if source_field and source_field not in properties:
                properties.append(source_field)

        try:
            url = f"{domain}/crm/v3/objects/{safe_obj}/search"
            
            # Setup base payload for the Search API
            payload = {
                "limit": 100,
                "properties": properties[:100] # HubSpot max limit is 100 properties per request
            }
            
            # Handle user-defined filtering
            if query and query.strip():
                try:
                    query_dict = json.loads(query)
                    if "filterGroups" in query_dict:
                        payload["filterGroups"] = query_dict["filterGroups"]
                    if "sorts" in query_dict:
                        payload["sorts"] = query_dict["sorts"]
                except json.JSONDecodeError:
                    await send_log(f"⚠️ [HubSpot Extraction] Invalid query filter format. Ignoring custom filters.")

            # Pagination Loop using "after" cursors
            while True:
                res = await client.post(url, headers=headers, json=payload)
                
                # Handle standard rate limit
                if res.status_code == 429:
                    retry_after = int(res.headers.get("Retry-After", 10))
                    await send_log(f"⚠️ [HubSpot Rate Limit] Pausing extraction for {retry_after}s...")
                    await asyncio.sleep(retry_after)
                    continue
                    
                res.raise_for_status()
                data = res.json()
                records = data.get("results", [])
                
                if not records: 
                    break
                
                # Flatten the data specifically for HubSpot's nested 'properties' object
                for rec in records:
                    flat_rec = {"id": rec.get("id")}
                    props = rec.get("properties", {})
                    if props:
                        for k, v in props.items():
                            flat_rec[k] = v
                    source_records.append(flat_rec)
                
                if len(source_records) % 1000 == 0:
                    await send_log(f"[{obj_name}] Extracted {len(source_records)} records...")
                
                # Update payload for the next page
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
        dedupe_key = options.get("dedupeKey", "email") # Common default

        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        await send_log(f"[{target_object}] {pass_name}: Pushing data to HubSpot (Concurrent Mode)...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        safe_obj = target_object.lower()

        chunks = list(chunk_dataset(payload, 100)) # HubSpot max batch size is 100

        # HubSpot uses specific endpoints for batch create vs update/upsert
        if op_mode == "update":
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/update"
        elif op_mode == "upsert":
            # For upsert, we MUST provide an idProperty in the URL so HubSpot knows what field to check
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/upsert?idProperty={dedupe_key}"
        else:
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/create"

        # --- CONCURRENCY UPGRADE: Process 10 chunks at a time ---
        semaphore = asyncio.Semaphore(10) 

        async def process_chunk(chunk):
            async with semaphore:
                # Format payload based on the operation mode
                if op_mode == "update":
                    hs_records = [{"id": c["targetRecord"].pop("id"), "properties": c["targetRecord"]} for c in chunk if "id" in c["targetRecord"]]
                elif op_mode == "upsert":
                    # For Upsert, idProperty is defined in the URL, but the actual lookup ID is passed here
                    hs_records = [{"id": str(c["targetRecord"].pop(dedupe_key)), "properties": c["targetRecord"]} for c in chunk if dedupe_key in c["targetRecord"]]
                else:
                    hs_records = [{"properties": c["targetRecord"]} for c in chunk]

                # If the chunk ended up empty because of missing IDs in update mode
                if not hs_records:
                    return {"chunk": chunk, "status": "error", "message": "Missing required record IDs for operation."}

                req_payload = {"inputs": hs_records}
                
                try:
                    while True:
                        res = await client.post(endpoint, json=req_payload, headers=headers)
                        
                        # Handle Rate Limiting gracefully
                        if res.status_code == 429:
                            retry_after = int(res.headers.get("Retry-After", 10))
                            await send_log(f"⚠️ [HubSpot Rate Limit] Pausing batch for {retry_after}s...")
                            await asyncio.sleep(retry_after)
                            continue
                            
                        break

                    # 207 Multi-Status occurs when some succeed and some fail in the batch
                    if res.status_code not in [201, 200, 207]:
                        # A 400 Bad Request here usually means the entire batch failed validation
                        error_body = res.json()
                        error_msg = error_body.get("message", res.text)
                        return {"chunk": chunk, "status": "error", "message": error_msg}
                        
                    data = res.json()
                    
                    # Map the results to our chunk data for easy tracking
                    results = []
                    
                    # HubSpot returns successful creations/updates in "results"
                    successes = data.get("results", [])
                    success_map = {str(i): s for i, s in enumerate(successes)}
                    
                    # HubSpot returns errors in "errors" (status code 207)
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
                            # In case it's missing from both arrays, assume success if the batch passed
                            results.append({"success": True, "id": "Success"})
                            
                    return {"chunk": chunk, "status": "completed", "results": results}
                        
                except Exception as exc:
                    return {"chunk": chunk, "status": "error", "message": str(exc)}

        # Execute all batches concurrently
        batch_results = await asyncio.gather(*[process_chunk(chunk) for chunk in chunks])

        # Loop through the completed results and map them back to the source records
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