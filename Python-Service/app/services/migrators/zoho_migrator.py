import re
import asyncio
from app.services.crm_service import CrmService

# --- FIXED: Restored 'yield' to make it a proper batch generator ---
def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZohoMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        token = creds.get("access_token")
        user_id = creds.get("user_id") 
        domain = creds.get("api_domain", "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"): domain = f"https://{domain}"
        
        headers = {"Authorization": f"Zoho-oauthtoken {token}"}
        headers_list = [m["sourceField"] if "sourceField" in m else m["csvField"] for m in mappings if m.get("sourceField") or m.get("csvField")]
        safe_fields = headers_list[:40] if headers_list else ["id"]
        fields_str = ",".join(safe_fields)
        
        source_records = []
        page, page_token, more_records = 1, None, True
        
        # --- NEW SMART QUERY PARSER ---
        user_limit = None
        base_coql = ""
        if query:
            base_coql = query.strip()
            if base_coql.lower().startswith("select "):
                if "*" in base_coql: 
                    base_coql = base_coql.replace("*", fields_str, 1)
                
                # Safely extract the user's limit before Zoho pagination overrides it
                limit_match = re.search(r'(?i)\s+limit\s+(\d+)', base_coql)
                if limit_match:
                    user_limit = int(limit_match.group(1))
                    base_coql = re.sub(r'(?i)\s+limit\s+\d+', '', base_coql)
                
                # Fix spacing issues if any exist in the SELECT clause
                match = re.match(r'(?i)select\s+(.*?)\s+from\s+', base_coql)
                if match:
                    clean_select = match.group(1).replace(" ", "")
                    base_coql = base_coql.replace(match.group(1), clean_select, 1)

                if " where " not in base_coql.lower(): 
                    base_coql += " where id is not null"
            else:
                base_coql = f"select {fields_str} from {obj_name} where {base_coql}"
        # ------------------------------

        while more_records:
            if query:
                fetch_limit = 200
                if user_limit is not None:
                    remaining = user_limit - len(source_records)
                    if remaining <= 0:
                        break # Stop extracting if we hit the user's exact limit!
                    fetch_limit = min(200, remaining)

                paginated_coql = f"{base_coql} limit {fetch_limit} offset {(page - 1) * 200}"
                
            # --- Silent Retry Loop for Extraction ---
            while True:
                if query:
                    res = await client.post(f"{domain}/crm/v6/coql", headers=headers, json={"select_query": paginated_coql})
                else:
                    if page_token:
                        res = await client.get(f"{domain}/crm/v6/{obj_name}?page_token={page_token}&per_page=200&fields={fields_str}", headers=headers)
                    else:
                        res = await client.get(f"{domain}/crm/v6/{obj_name}?page=1&per_page=200&fields={fields_str}", headers=headers)
                
                if res.status_code == 401:
                    await send_log(" 🔑 Zoho token expired during extraction. Silently refreshing...")
                    token = await CrmService.refresh_crm_token(user_id, "zoho", "source")
                    headers["Authorization"] = f"Zoho-oauthtoken {token}"
                    continue 
                
                if res.status_code == 429:
                    await send_log(" ⏳ Zoho Rate Limit. Pausing 30s...")
                    await asyncio.sleep(30)
                    continue
                
                break 
                
            res.raise_for_status()
            data = res.json()
            raw_records = data.get("data") or []
            if not raw_records: break
            
            for r in raw_records:
                flat_rec = {}
                for k, v in r.items():
                    if isinstance(v, dict): 
                        flat_rec[k] = v.get("id", v.get("name", str(v)))
                    elif isinstance(v, list): 
                        flat_rec[k] = ";".join([str(i.get("id", i.get("name", i))) if isinstance(i, dict) else str(i) for i in v])
                    else: 
                        flat_rec[k] = v
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
        user_id = options.get("userId") 
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
        
        if op_mode == "upsert":
            api_path = f"{domain}/crm/v6/{normalized_obj}/upsert"
            http_method = "POST"
        elif op_mode == "update":
            api_path = f"{domain}/crm/v6/{normalized_obj}"
            http_method = "PUT"
        else: # insert
            api_path = f"{domain}/crm/v6/{normalized_obj}"
            http_method = "POST"

        for chunk in chunks:
            zoho_data_rows = [c["targetRecord"] for c in chunk]
            
            try:
                req_payload = {"data": zoho_data_rows}
                if op_mode == "upsert" and options.get("targetExtIdField"):
                   req_payload["duplicate_check_fields"] = [options["targetExtIdField"]]

                # --- Silent Retry Loop for Uploads (Token Refresh & Rate Limits) ---
                while True:
                    if http_method == "PUT":
                        res = await client.put(api_path, json=req_payload, headers=headers)
                    else:
                        res = await client.post(api_path, json=req_payload, headers=headers)
                    
                    if res.status_code == 401:
                        await send_log(" 🔑 Zoho token expired mid-migration. Silently refreshing...")
                        token = await CrmService.refresh_crm_token(user_id, "zoho", "target")
                        headers["Authorization"] = f"Zoho-oauthtoken {token}"
                        continue 
                        
                    if res.status_code == 429:
                        await send_log(" ⏳ Zoho API Rate Limit reached during upload. Pausing 30s...")
                        await asyncio.sleep(30)
                        continue
                        
                    break 
                
                if res.status_code in [200, 201, 202, 207]:
                    for item, z_res in zip(chunk, res.json().get("data", [])):
                        orig_record = source_records[item["originalIndex"]]
                        
                        if z_res.get("status") == "success":
                            # FIX: Force the ID into a string to protect it from JS precision limits
                            raw_id = z_res.get("details", {}).get("id")
                            orig_record["Target_Id"] = str(raw_id) if raw_id else "Success"
                            
                            all_success_data.append(orig_record)
                            total_success += 1
                        else:
                            # --- FIX: Deeply parse Zoho's error structure ---
                            err_msg = z_res.get("message") or z_res.get("code", "Unknown Error")
                            details = z_res.get("details", {})
                            
                            # Intelligently extract the field name if Zoho provides it
                            if isinstance(details, dict):
                                api_name = details.get("api_name")
                                if api_name:
                                    err_msg = f"[{api_name}] {err_msg}"
                                elif details:
                                    # Fallback for other nested details
                                    err_msg = f"{err_msg} | Details: {str(details)}"
                                    
                            orig_record["Target_Error"] = f"Zoho Error: {err_msg}"
                            all_error_data.append(orig_record)
                            total_error += 1
                else:
                    error_text = res.text
                    try: error_text = res.json().get("message", res.json().get("errors", [{}])[0].get("message", res.text))
                    except: pass
                    
                    await send_log(f" ⚠️ Zoho API Rejected Batch ({res.status_code}): {error_text}")
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