import re
import asyncio
from app.services.crm_service import CrmService

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZohoMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        user_id = creds.get("user_id") # <-- Need this to refresh!
        domain = creds.get("api_domain", "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"): domain = f"https://{domain}"
        
        headers = {"Authorization": f"Zoho-oauthtoken {token}"}
        headers_list = [m["sourceField"] if "sourceField" in m else m["csvField"] for m in mappings if m.get("sourceField") or m.get("csvField")]
        safe_fields = headers_list[:40] if headers_list else ["id"]
        fields_str = ",".join(safe_fields)
        
        source_records = []
        page, page_token, more_records = 1, None, True
        
        while more_records:
            if query:
                coql_query = query.strip()
                if coql_query.lower().startswith("select "):
                    if "*" in coql_query: coql_query = coql_query.replace("*", fields_str, 1)
                    match = re.match(r'(?i)select\s+(.*?)\s+from\s+', coql_query)
                    if match:
                        clean_select = match.group(1).replace(" ", "")
                        coql_query = coql_query.replace(match.group(1), clean_select, 1)
                    if " where " not in coql_query.lower(): coql_query += " where id is not null"
                    coql_query = re.sub(r'(?i)\s+limit\s+\d+', '', coql_query)
                else:
                    coql_query = f"select {fields_str} from {obj_name} where {coql_query}"
                    
                paginated_coql = f"{coql_query} limit 200 offset {(page - 1) * 200}"
                
            # --- FIX: Silent Retry Loop for Extraction ---
            while True:
                if query:
                    res = await client.post(f"{domain}/crm/v6/coql", headers=headers, json={"select_query": paginated_coql})
                else:
                    if page_token:
                        res = await client.get(f"{domain}/crm/v6/{obj_name}?page_token={page_token}&per_page=200&fields={fields_str}", headers=headers)
                    else:
                        res = await client.get(f"{domain}/crm/v6/{obj_name}?page=1&per_page=200&fields={fields_str}", headers=headers)
                
                # Catch Expiration Mid-Extract
                if res.status_code == 401:
                    await send_log(" Zoho token expired during extraction. Silently refreshing...")
                    token = await CrmService.refresh_crm_token(user_id, "zoho", "source")
                    headers["Authorization"] = f"Zoho-oauthtoken {token}"
                    continue # Retry the request with the new token
                
                if res.status_code == 429:
                    await send_log(" Zoho Rate Limit. Pausing 30s...")
                    await asyncio.sleep(30)
                    continue
                
                break # Exit retry loop on success or hard error
                
            res.raise_for_status()
            data = res.json()
            raw_records = data.get("data") or []
            if not raw_records: break
            
            for r in raw_records:
                flat_rec = {}
                for k, v in r.items():
                    if isinstance(v, dict): flat_rec[k] = v.get("name", v.get("id", str(v)))
                    elif isinstance(v, list): flat_rec[k] = ";".join([str(i.get("name", i.get("id", i))) if isinstance(i, dict) else str(i) for i in v])
                    else: flat_rec[k] = v
                source_records.append(flat_rec)
                
            if len(source_records) % 200 == 0:
                await send_log(f"[{obj_name}] Extracted {len(source_records)} records...")
            info = data.get("info", {})
            more_records = info.get("more_records", False)
            page_token = info.get("next_page_token")
            page += 1 

        await send_log(f"[{obj_name}] Extraction Complete! Total: {len(source_records)}")
        return source_records


    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, [], []

        target_object = options["targetObject"]
        token = options["token"]
        user_id = options.get("userId") # <-- Need this to refresh!
        domain = options["instance_url"].rstrip('/')
        source_records = options["sourceRecords"]

        if not domain.startswith("http"): domain = f"https://{domain}"
        
        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        normalized_obj = target_object.strip()
        if not normalized_obj.endswith('s') and normalized_obj.lower() != 'data':
            plurals = {'lead': 'Leads', 'contact': 'Contacts', 'account': 'Accounts', 'deal': 'Deals'}
            normalized_obj = plurals.get(normalized_obj.lower(), normalized_obj.capitalize() + 's')

        await send_log(f"[{normalized_obj}] {pass_name}: Injecting data stream into Zoho CRM...")
        headers = {"Authorization": f"Zoho-oauthtoken {token}", "Content-Type": "application/json"}
        
        chunks = list(chunk_dataset(payload, 100))
        api_path = f"{domain}/crm/v6/{normalized_obj}/upsert" if op_mode == "upsert" else f"{domain}/crm/v6/{normalized_obj}"

        for chunk in chunks:
            zoho_data_rows = [c["targetRecord"] for c in chunk]
            
            try:
                req_payload = {"data": zoho_data_rows}
                if op_mode == "upsert" and options.get("targetExtIdField"):
                   req_payload["duplicate_check_fields"] = [options["targetExtIdField"]]

                # --- FIX: Silent Retry Loop for Uploads ---
                while True:
                    res = await client.post(api_path, json=req_payload, headers=headers)
                    
                    # Catch Expiration Mid-Upload
                    if res.status_code == 401:
                        await send_log(" Zoho token expired mid-migration. Silently refreshing...")
                        token = await CrmService.refresh_crm_token(user_id, "zoho", "target")
                        headers["Authorization"] = f"Zoho-oauthtoken {token}"
                        continue # Retry the exact same chunk
                        
                    break # Success or hard error
                
                if res.status_code in [200, 201, 202, 207]:
                    for item, z_res in zip(chunk, res.json().get("data", [])):
                        orig_record = source_records[item["originalIndex"]]
                        if z_res.get("status") == "success":
                            orig_record["Target_Id"] = z_res.get("details", {}).get("id")
                            all_success_data.append(orig_record)
                            total_success += 1
                        else:
                            orig_record["Target_Error"] = f"Zoho Error: {z_res.get('message') or z_res.get('code')}"
                            all_error_data.append(orig_record)
                            total_error += 1
                else:
                    error_text = res.text
                    try: error_text = res.json().get("message", res.json().get("errors", [{}])[0].get("message", res.text))
                    except: pass
                    
                    await send_log(f" Zoho API Rejected Batch ({res.status_code}): {error_text}")
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

        return total_success, total_error, all_success_data, all_error_data