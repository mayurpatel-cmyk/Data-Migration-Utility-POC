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
        
        # --- THE FIX: Support both UI mapping formats ---
        properties = ["hs_object_id"]
        for mapping in mappings:
            source_field = mapping.get("sourceField") or mapping.get("csvField")
            if source_field and source_field not in properties:
                properties.append(source_field)
        # ------------------------------------------------

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
                    await send_log(f" [HubSpot Extraction] Invalid query format. Ignoring.")

            while True:
                # Silent Retry Loop for Extraction
                while True:
                    res = await client.post(url, headers=headers, json=payload)
                    
                    if res.status_code == 401:
                        await send_log(f" HubSpot token expired. Silently refreshing...")
                        token = await CrmService.refresh_crm_token(user_id, "hubspot", "source")
                        headers["Authorization"] = f"Bearer {token}"
                        continue

                    if res.status_code == 429:
                        retry_after = int(res.headers.get("Retry-After", 10))
                        await send_log(f" [HubSpot Rate Limit] Pausing extraction for {retry_after}s...")
                        await asyncio.sleep(retry_after)
                        continue
                        
                    break 
                    
                res.raise_for_status()
                data = res.json()
                records = data.get("results", [])
                
                if not records: break
                
                for rec in records:
                    flat_rec = {"id": rec.get("id")}
                    props = rec.get("properties", {})
                    if props:
                        for k, v in props.items(): 
                            # --- FIX: Safeguard against nested objects in HubSpot ---
                            if isinstance(v, dict):
                                flat_rec[k] = str(v)
                            elif isinstance(v, list):
                                # Convert lists to semicolon-separated strings (standard for CSVs)
                                flat_rec[k] = ";".join([str(i) for i in v])
                            else:
                                flat_rec[k] = v
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
        if not payload: return 0, 0, 0, [], [], []

        target_object = options["targetObject"]
        token = options["token"]
        domain = (options.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        source_records = options["sourceRecords"]
        dedupe_key = options.get("targetExtIdField") or options.get("dedupeKey") or "email"
        
        user_id = options.get("userId") # <-- Needed for refresh

        total_success, total_error, total_skipped = 0, 0, 0
        all_success_data, all_error_data, all_skipped_data = [], [], []
        ids_to_revert = []  # records HubSpot inserted that "update" mode must not keep

        await send_log(f"[{target_object}] {pass_name}: Pushing data to HubSpot (Concurrent Mode)...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        safe_obj = target_object.lower()

        chunks = list(chunk_dataset(payload, 100))

        # --- FIX: HubSpot's "batch/update" endpoint can ONLY match records by
        # HubSpot's own internal "id" -- it has no way to match by a custom Ext ID
        # property. Since our payloads are keyed by whatever field the user chose
        # (e.g. "email"), a real "update" call here would reject/skip every row
        # for lacking an "id". HubSpot's "batch/upsert" endpoint is the only one
        # that supports matching via idProperty, so -- same fix as the other three
        # CRMs -- we run "update" on the wire as an upsert, then police the
        # "don't create new records" promise ourselves using HubSpot's per-record
        # "new" flag (true when HubSpot had to create the record).
        is_update_only = (op_mode == "update")
        wire_op_mode = "upsert" if is_update_only else op_mode

        if wire_op_mode == "upsert":
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/upsert" 
        else:
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/create"

        semaphore = asyncio.Semaphore(10) 

        async def process_chunk(chunk):
            async with semaphore:
                # Track which original `chunk` position each hs_record came from,
                # since rows missing the id/dedupe value get filtered out below.
                # Without this, HubSpot's response indices (which only count
                # included rows) get zipped against the full chunk further down,
                # silently misattributing success/error results to the wrong rows.
                hs_records = []
                included_indices = []

                if wire_op_mode == "upsert":
                    for i, c in enumerate(chunk):
                        dedupe_val = c["targetRecord"].get(dedupe_key)
                        if dedupe_val:
                            hs_records.append({
                                # Use .get() instead of .pop() to keep the email in the properties body!
                                "id": str(dedupe_val),
                                "idProperty": dedupe_key,
                                "properties": c["targetRecord"]
                            })
                            included_indices.append(i)
                else:
                    hs_records = [{"properties": c["targetRecord"]} for c in chunk]
                    included_indices = list(range(len(chunk)))

                skipped_indices = [i for i in range(len(chunk)) if i not in set(included_indices)]
                missing_field_label = dedupe_key

                if not hs_records:
                    return {
                        "chunk": chunk,
                        "status": "error",
                        "message": f"Missing required '{missing_field_label}' value for every record in this batch."
                    }

                req_payload = {"inputs": hs_records}
                
                try:
                    # --- FIX: Silent Retry Loop for Uploads ---
                    while True:
                        res = await client.post(endpoint, json=req_payload, headers=headers)
                        
                        # Catch Expiration Mid-Upload
                        if res.status_code == 401:
                            await send_log(f" HubSpot token expired mid-migration. Silently refreshing...")
                            token = await CrmService.refresh_crm_token(user_id, "hubspot", "target")
                            headers["Authorization"] = f"Bearer {token}"
                            continue # Retry exact chunk

                        if res.status_code == 429:
                            retry_after = int(res.headers.get("Retry-After", 10))
                            await send_log(f" [HubSpot Rate Limit] Pausing batch for {retry_after}s...")
                            await asyncio.sleep(retry_after)
                            continue
                            
                        break

                    if res.status_code not in [201, 200, 207]:
                        error_body = res.json()
                        error_msg = error_body.get("message", res.text)
                        return {"chunk": chunk, "status": "error", "message": error_msg}
                        
                    data = res.json()
                    
                    successes = data.get("results", [])
                    success_map = {str(i): s for i, s in enumerate(successes)}
                    
                    errors = data.get("errors", [])
                    error_map = {str(e.get("index")): e for e in errors}
                    
                    # Map HubSpot's response (indexed within the filtered hs_records
                    # array) back to the correct ORIGINAL chunk position.
                    results_by_index = {}
                    for hs_pos, orig_idx in enumerate(included_indices):
                        idx_str = str(hs_pos)
                        if idx_str in error_map:
                            results_by_index[orig_idx] = {
                                "success": False,
                                "details": error_map[idx_str].get("message", "Validation failed")
                            }
                        elif idx_str in success_map:
                            s = success_map[idx_str]
                            # --- FIX: "update" mode must skip (not create) records with
                            # no existing match. HubSpot's batch upsert response tells us
                            # via "new": true whether it had to create the record.
                            if is_update_only and s.get("new") is True:
                                results_by_index[orig_idx] = {
                                    "success": True,
                                    "skipped": True,
                                    "id": s.get("id")
                                }
                            else:
                                results_by_index[orig_idx] = {
                                    "success": True,
                                    "id": s.get("id")
                                }
                        else:
                            results_by_index[orig_idx] = {"success": True, "id": "Success"}

                    # Rows we never sent must be reported as explicit errors, not
                    # silently defaulted to "success".
                    for orig_idx in skipped_indices:
                        results_by_index[orig_idx] = {
                            "success": False,
                            "details": f"Skipped: missing required '{missing_field_label}' value."
                        }

                    results = [results_by_index[i] for i in range(len(chunk))]

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

                    if hs_res.get("skipped"):
                        orig_record["Target_SkipReason"] = (
                            f"[{dedupe_key}] No matching record found in HubSpot. "
                            f"Skipped because Update mode does not create new records."
                        )
                        all_skipped_data.append(orig_record)
                        total_skipped += 1
                        raw_id = hs_res.get("id")
                        if raw_id:
                            ids_to_revert.append(str(raw_id))
                        continue

                    if hs_res.get("success"):
                        # --- FIX: Strict String Cast ---
                        raw_id = hs_res.get("id")
                        orig_record["Target_Id"] = str(raw_id) if raw_id else "Success"
                        
                        all_success_data.append(orig_record)
                        total_success += 1
                    else:
                        orig_record["Target_Error"] = hs_res.get("details", "Failed")
                        all_error_data.append(orig_record)
                        total_error += 1

        if ids_to_revert:
            await send_log(
                f"[{target_object}] {pass_name}: Update mode found {len(ids_to_revert)} record(s) with no "
                f"match — reverting the records HubSpot auto-created for them..."
            )
            await self._archive_records(client, domain, headers, safe_obj, ids_to_revert, user_id, send_log)

        return total_success, total_error, total_skipped, all_success_data, all_error_data, all_skipped_data

    async def _archive_records(self, client, domain, headers, safe_obj, record_ids, user_id, send_log):
        """Archives (soft-deletes) records HubSpot auto-created that 'update'
        mode should never have created in the first place. HubSpot's batch
        archive endpoint accepts up to 100 ids per call."""
        for chunk in chunk_dataset(record_ids, 100):
            try:
                url = f"{domain}/crm/v3/objects/{safe_obj}/batch/archive"
                req_payload = {"inputs": [{"id": rid} for rid in chunk]}
                res = await client.post(url, json=req_payload, headers=headers)

                if res.status_code == 401:
                    token = await CrmService.refresh_crm_token(user_id, "hubspot", "target")
                    headers["Authorization"] = f"Bearer {token}"
                    res = await client.post(url, json=req_payload, headers=headers)

                if res.status_code not in [204, 200]:
                    await send_log(f"[{safe_obj}] Revert batch failed: {res.text}")
            except Exception as e:
                await send_log(f"[{safe_obj}] Revert Failed: {str(e)}")