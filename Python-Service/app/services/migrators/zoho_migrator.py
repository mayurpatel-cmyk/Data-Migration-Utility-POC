import re
import asyncio
from app.services.crm_service import CrmService

#  Restored 'yield' to make it a proper batch generator ---
def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class ZohoMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log):
        import re
        zoho_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"):
            domain = f"https://{domain}"
            
        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        
        # Determine fields to extract based on UI mappings
        target_fields = [m.get("sourceField") or m.get("csvField") for m in mappings if m.get("sourceField") or m.get("csvField")]
        safe_fields = target_fields[:40] if target_fields else ["id"]

        try:
            if query and query.strip():
                coql_query = query.strip()
                if coql_query.lower().startswith("select "):
                    if " * " in coql_query.lower() or coql_query.lower().startswith("select *"):
                        fields_str = ",".join(safe_fields)
                        coql_query = re.sub(r'(?i)select\s+\*\s+from', f'select {fields_str} from', coql_query)
                        
                    if " where " not in coql_query.lower():
                        if " order by " in coql_query.lower():
                            coql_query = re.sub(r'(?i)(\border\s+by\b)', r'where id is not null \1', coql_query, count=1)
                        else:
                            coql_query += " where id is not null"
                else:
                    coql_query = f"select {','.join(safe_fields)} from {obj_name} where {coql_query}"

                if " limit " not in coql_query.lower():
                    # Zoho limits COQL to 2000 records per request max
                    coql_query += " limit 200"

                await send_log(f"Extracting data from Zoho using COQL...")
                
                # CRITICAL FIX: This must be client.post() for the /coql endpoint
                res = await client.post(f"{domain}/crm/v6/coql", headers=headers, json={"select_query": coql_query})
                
                if res.status_code != 200:
                    raise Exception(f"Zoho COQL Error: {res.text}")
                    
                data = res.json().get("data", [])
            else:
                await send_log(f"Extracting data from Zoho (Standard API)...")
                data = []
                page = 1
                while True:
                    res = await client.get(f"{domain}/crm/v6/{obj_name}?page={page}&per_page=200&fields={','.join(safe_fields)}", headers=headers)
                    if res.status_code == 204:
                        break
                    
                    if res.status_code != 200:
                        raise Exception(f"Zoho API Error: {res.text}")
                        
                    batch = res.json().get("data", [])
                    if not batch: 
                        break
                    data.extend(batch)
                    
                    if not res.json().get("info", {}).get("more_records"):
                        break
                    page += 1

            # Flatten Zoho Lookups for the frontend UI
            processed_data = []
            for r in data:
                flat_rec = {}
                for k, v in r.items():
                    if isinstance(v, dict) and "id" in v:
                        flat_rec[k] = v.get("name", v["id"])
                    else:
                        flat_rec[k] = v
                processed_data.append(flat_rec)

            return processed_data

        except Exception as e:
            raise Exception(f"Failed to extract from Zoho: {str(e)}")


    async def upload(self, client, payload, op_mode, pass_name, options, send_log):
        if not payload: return 0, 0, 0, [], [], []

        target_object = options["targetObject"]
        token = options["token"]
        user_id = options.get("userId") 
        domain = options["instance_url"].rstrip('/')
        source_records = options["sourceRecords"]

        if not domain.startswith("http"): domain = f"https://{domain}"
        
        total_success, total_error, total_skipped = 0, 0, 0
        all_success_data, all_error_data, all_skipped_data = [], [], []
        ids_to_revert = []  # records Zoho inserted that "update" mode must not keep

        normalized_obj = target_object.strip()
        if not normalized_obj.endswith('s') and normalized_obj.lower() != 'data':
            plurals = {'lead': 'Leads', 'contact': 'Contacts', 'account': 'Accounts', 'deal': 'Deals'}
            normalized_obj = plurals.get(normalized_obj.lower(), normalized_obj.capitalize() + 's')

        await send_log(f"[{normalized_obj}] {pass_name}: Injecting data stream into Zoho CRM...")
        headers = {"Authorization": f"Zoho-oauthtoken {token}", "Content-Type": "application/json"}
        
        chunks = list(chunk_dataset(payload, 100))

        # --- FIX: Zoho's plain "update" (PUT) endpoint can ONLY match records by
        # Zoho's own internal "id" field -- it has no way to match by a custom
        # external key. Only the "/upsert" endpoint supports duplicate_check_fields.
        # Since our payloads are keyed by the user's chosen Ext ID field (not
        # Zoho's internal id), a real "update" call here would reject every row.
        # So -- same fix as Salesforce -- we run "update" on the wire as an
        # upsert (the only endpoint that can match on the Ext ID field), then
        # police the "don't create new records" promise ourselves below using
        # Zoho's per-record "action" flag (insert vs update).
        is_update_only = (op_mode == "update")
        wire_op_mode = "upsert" if is_update_only else op_mode

        if not options.get("targetExtIdField") and op_mode in ("update", "upsert"):
            await send_log(f"[{normalized_obj}] {pass_name}: No External ID field configured -- cannot match existing records for {op_mode.upper()}.")
            return 0, len(payload), 0, [], [r for r in source_records], []

        if wire_op_mode == "upsert":
            api_path = f"{domain}/crm/v6/{normalized_obj}/upsert"
            http_method = "POST"
        else: # insert
            api_path = f"{domain}/crm/v6/{normalized_obj}"
            http_method = "POST"

        for chunk in chunks:
            zoho_data_rows = [c["targetRecord"] for c in chunk]
            
            try:
                req_payload = {"data": zoho_data_rows}
                if wire_op_mode == "upsert" and options.get("targetExtIdField"):
                   req_payload["duplicate_check_fields"] = [options["targetExtIdField"]]

                # --- Silent Retry Loop for Uploads (Token Refresh & Rate Limits) ---
                while True:
                    if http_method == "PUT":
                        res = await client.put(api_path, json=req_payload, headers=headers)
                    else:
                        res = await client.post(api_path, json=req_payload, headers=headers)
                    
                    if res.status_code == 401:
                        await send_log("  Zoho token expired mid-migration. Silently refreshing...")
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
                            raw_id = z_res.get("details", {}).get("id")

                            # --- FIX: "update" mode must skip (not create) records with
                            # no existing match. Zoho's upsert response tells us which
                            # action it actually took per record via "action".
                            if is_update_only and z_res.get("action") == "insert":
                                orig_record["Target_SkipReason"] = (
                                    f"[{options.get('targetExtIdField')}] No matching record found in Zoho. "
                                    f"Skipped because Update mode does not create new records."
                                )
                                all_skipped_data.append(orig_record)
                                total_skipped += 1
                                if raw_id:
                                    ids_to_revert.append(str(raw_id))
                                continue

                            #  Force the ID into a string to protect it from JS precision limits
                            orig_record["Target_Id"] = str(raw_id) if raw_id else "Success"
                            
                            all_success_data.append(orig_record)
                            total_success += 1
                        else:
                            #  Deeply parse Zoho's error structure ---
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

        if ids_to_revert:
            await send_log(
                f"[{normalized_obj}] {pass_name}: Update mode found {len(ids_to_revert)} record(s) with no "
                f"match — reverting the records Zoho auto-created for them..."
            )
            await self._delete_records(client, domain, headers, normalized_obj, ids_to_revert, user_id, send_log)

        return total_success, total_error, total_skipped, all_success_data, all_error_data, all_skipped_data

    async def _delete_records(self, client, domain, headers, normalized_obj, record_ids, user_id, send_log):
        """Deletes records Zoho auto-created that 'update' mode should never
        have created in the first place (Zoho's bulk delete takes <=100 ids/call)."""
        for chunk in chunk_dataset(record_ids, 100):
            try:
                ids_param = ",".join(chunk)
                res = await client.delete(f"{domain}/crm/v6/{normalized_obj}?ids={ids_param}", headers=headers)

                if res.status_code == 401:
                    token = await CrmService.refresh_crm_token(user_id, "zoho", "target")
                    headers["Authorization"] = f"Zoho-oauthtoken {token}"
                    res = await client.delete(f"{domain}/crm/v6/{normalized_obj}?ids={ids_param}", headers=headers)

                if res.status_code not in [200, 202]:
                    await send_log(f"[{normalized_obj}] Revert batch failed: {res.text}")
            except Exception as e:
                await send_log(f"[{normalized_obj}] Revert Failed: {str(e)}")