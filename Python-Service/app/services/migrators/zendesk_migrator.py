import urllib.parse
import re
import asyncio
import json

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZendeskMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        subdomain = creds.get("subdomain")
        if not subdomain and creds.get("api_domain"):
            subdomain = creds.get("api_domain").replace(".zendesk.com", "").replace("https://", "")
        
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        # 1. PURE DYNAMIC NAME HANDLING
        safe_obj = obj_name.strip().lower()
        source_records = []
        
        try:
            # Drop the plural 's' dynamically for the Zendesk search filter 
            safe_obj_singular = safe_obj[:-1] if safe_obj.endswith('s') else safe_obj
            
            clean_query = re.sub(r'type:[a-zA-Z0-9_]+', '', query, flags=re.IGNORECASE).strip() if query else ""
            final_query = f"{clean_query} type:{safe_obj_singular}".strip()
            safe_query = urllib.parse.quote(final_query)
            
            url = f"https://{subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
            
            while url:
                while True:
                    res = await client.get(url, headers=headers)
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

        except Exception as e:
            await send_log(f" Zendesk Extraction Error: {str(e)}")
            
        await send_log(f"[{safe_obj}] Extraction Complete! Total: {len(source_records)}")
        return source_records


    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, [], []

        # 2. NO HARDCODING: Uses exactly what the frontend passes (e.g., "users", "tickets")
        target_object = options["targetObject"].strip().lower()
        
        token = options["token"]
        domain = options.get("instance_url", "").replace(".zendesk.com", "").replace("https://", "").strip('/')
        source_records = options["sourceRecords"]

        await send_log(f"[{target_object}] {pass_name}: Injecting data stream into Zendesk...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        chunks = list(chunk_dataset(payload, 100))

        # 3. DYNAMIC URL BUILDER 
        if op_mode == "upsert":
            endpoint = "create_or_update_many.json"
        elif op_mode == "update":
            endpoint = "update_many.json"
        else:
            endpoint = "create_many.json"
            
        api_path = f"https://{domain}.zendesk.com/api/v2/{target_object}/{endpoint}"

        async def process_chunk(chunk):
            # 4. DYNAMIC JSON WRAPPER: Zendesk root keys MUST match the object name exactly
            zendesk_data_rows = [c["targetRecord"] for c in chunk]
            req_payload = {target_object: zendesk_data_rows}

            while True:
                if op_mode == "update":
                    res = await client.put(api_path, json=req_payload, headers=headers)
                else:
                    res = await client.post(api_path, json=req_payload, headers=headers)

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
                    # Synchronous response (fallback)
                    return {"chunk": chunk, "status": "completed", "results": data.get(target_object, [])}
            else:
                return {"chunk": chunk, "status": "error", "message": res.text}

        # Fire off batches concurrently (5 chunks at a time to respect limits)
        batch_results = []
        for i in range(0, len(chunks), 5):
            concurrent_batch = chunks[i:i+5]
            results = await asyncio.gather(*[process_chunk(chunk) for chunk in concurrent_batch])
            batch_results.extend(results)

        # Map Results back to original UI rows
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
                    
                    # Zendesk async results yield 'success', sync results usually just yield an 'id'
                    if z_res.get("success") == True or z_res.get("status") in ["Created", "Updated"]:
                        orig_record["Target_Id"] = z_res.get("id")
                        all_success_data.append(orig_record)
                        total_success += 1
                    elif z_res.get("error"):
                        orig_record["Target_Error"] = str(z_res.get("details") or z_res.get("error"))
                        all_error_data.append(orig_record)
                        total_error += 1
                    else: 
                        orig_record["Target_Id"] = z_res.get("id", "Success")
                        all_success_data.append(orig_record)
                        total_success += 1

        return total_success, total_error, all_success_data, all_error_data