import urllib.parse
import re
import asyncio

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZendeskMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        subdomain = creds.get("subdomain")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        safe_obj = obj_name.lower()
        source_records = []
        
        try:
            safe_obj_singular = safe_obj.rstrip('s')
            clean_query = re.sub(r'type:[a-zA-Z0-9_]+', '', query, flags=re.IGNORECASE).strip()
            final_query = f"{clean_query} type:{safe_obj_singular}".strip()
            safe_query = urllib.parse.quote(final_query)
            
            url = f"https://{subdomain}.zendesk.com/api/v2/search/export.json?filter[type]={safe_obj_singular}&query={safe_query}&page[size]=1000"
            
            while url:
                res = await client.get(url, headers=headers)
                if res.status_code == 429:
                    retry_after = int(res.headers.get("Retry-After", 60))
                    await send_log(f"⚠️ [Zendesk Rate Limit] Pausing for {retry_after}s...")
                    await asyncio.sleep(retry_after)
                    continue
                    
                res.raise_for_status()
                data = res.json()
                records = data.get("results", [])
                
                if not records: break
                
                for rec in records:
                    flat_rec = {}
                    for k, v in rec.items():
                        if k == "custom_fields" and isinstance(v, list):
                            for cf in v: 
                                val = cf.get("value")
                                if isinstance(val, list): val = ";".join([str(i) for i in val])
                                flat_rec[f"custom_field_{cf['id']}"] = val
                        elif not isinstance(v, (dict, list)): flat_rec[k] = v
                        elif isinstance(v, list): flat_rec[k] = ";".join([str(i) for i in v])
                    source_records.append(flat_rec)
                
                if len(source_records) % 1000 == 0:
                    await send_log(f"[{obj_name}] Extracted {len(source_records)} records...")
                
                url = data.get("links", {}).get("next") if data.get("meta", {}).get("has_more") else None
                
            await send_log(f"[{obj_name}] Extraction Complete! Total: {len(source_records)}")
            return source_records
        except Exception as e:
            await send_log(f"[{obj_name}] Extract Failed: {str(e)}")
            raise e

    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, [], []

        target_object = options["targetObject"]
        token = options["token"]
        subdomain = options["instance_url"] # Used to pass subdomain
        source_records = options["sourceRecords"]

        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        await send_log(f"[{target_object}] {pass_name}: Pushing data to Zendesk...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        # Determine the correct bulk endpoint. E.g., "tickets", "users", "organizations"
        safe_obj = target_object.lower()
        if not safe_obj.endswith('s'): safe_obj += 's'

        # Zendesk bulk limits: 100 per request
        chunks = list(chunk_dataset(payload, 100))
        
        # Update endpoint changes logic
        if op_mode in ["update", "upsert"]:
            endpoint = f"https://{subdomain}.zendesk.com/api/v2/{safe_obj}/update_many.json"
        else:
            endpoint = f"https://{subdomain}.zendesk.com/api/v2/{safe_obj}/create_many.json"

        for chunk in chunks:
            zd_records = [c["targetRecord"] for c in chunk]
            
            # Wrap the payload in the object name (Zendesk requirement)
            req_payload = {safe_obj: zd_records}
            
            try:
                res = await client.post(endpoint, json=req_payload, headers=headers)
                
                if res.status_code == 429:
                    retry_after = int(res.headers.get("Retry-After", 60))
                    await send_log(f"⚠️ [Zendesk Rate Limit] Pausing for {retry_after}s...")
                    await asyncio.sleep(retry_after)
                    res = await client.post(endpoint, json=req_payload, headers=headers) # Retry

                if res.status_code in [200, 201]:
                    data = res.json()
                    job_status_id = data.get("job_status", {}).get("id")
                    
                    # Zendesk processes bulk jobs asynchronously, so we wait for completion
                    if job_status_id:
                        poll_url = f"https://{subdomain}.zendesk.com/api/v2/job_statuses/{job_status_id}.json"
                        while True:
                            await asyncio.sleep(2)
                            status_res = await client.get(poll_url, headers=headers)
                            status_data = status_res.json().get("job_status", {})
                            if status_data.get("status") in ["completed", "failed", "killed"]:
                                
                                results = status_data.get("results", [])
                                for item, z_res in zip(chunk, results):
                                    orig_record = source_records[item["originalIndex"]]
                                    if z_res.get("success") or status_data.get("status") == "completed":
                                        orig_record["Target_Id"] = z_res.get("id", "Success")
                                        all_success_data.append(orig_record)
                                        total_success += 1
                                    else:
                                        orig_record["Target_Error"] = z_res.get("details", "Failed")
                                        all_error_data.append(orig_record)
                                        total_error += 1
                                break
                    else:
                        # Fallback if job_status isn't returned
                        for item in chunk:
                            orig_record = source_records[item["originalIndex"]]
                            orig_record["Target_Id"] = "Success"
                            all_success_data.append(orig_record)
                            total_success += 1
                else:
                    error_text = res.text
                    await send_log(f"⚠️ Zendesk API Rejected Batch ({res.status_code}): {error_text}")
                    for item in chunk:
                        orig_record = source_records[item["originalIndex"]]
                        orig_record["Target_Error"] = f"Zendesk API Error: {error_text}"
                        all_error_data.append(orig_record)
                        total_error += 1
                        
            except Exception as exc:
                for item in chunk:
                    orig_record = source_records[item["originalIndex"]]
                    orig_record["Target_Error"] = str(exc)
                    all_error_data.append(orig_record)
                    total_error += 1

        return total_success, total_error, all_success_data, all_error_data