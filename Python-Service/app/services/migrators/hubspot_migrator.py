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
        user_id = creds.get("user_id")
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        
        safe_obj = obj_name.lower()
        source_records = []
        
        
        properties = ["hs_object_id"]
        for mapping in mappings:
            source_field = mapping.get("sourceField") or mapping.get("csvField")
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
                    await send_log(f" [HubSpot Extraction] Invalid query format. Ignoring.")

            while True:
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
                            if isinstance(v, dict):
                                flat_rec[k] = str(v)
                            elif isinstance(v, list):
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
        target_ext_id_field = options.get("targetExtIdField") or options.get("dedupeKey")

        user_id = options.get("userId")

        total_success, total_error, total_skipped = 0, 0, 0
        all_success_data, all_error_data, all_skipped_data = [], [], []
        ids_to_revert = []

        await send_log(f"[{target_object}] {pass_name}: Pushing data to HubSpot (Concurrent Mode)...")
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        safe_obj = target_object.lower()

        chunks = list(chunk_dataset(payload, 100))

        is_update_only = (op_mode == "update")
        wire_op_mode = "upsert" if is_update_only else op_mode

        if wire_op_mode == "upsert" and not target_ext_id_field:
            await send_log(
                f"[{target_object}] {pass_name}: No unique/external ID field configured -- "
                f"cannot match existing records for {op_mode.upper()}."
            )
            return 0, len(payload), 0, [], [source_records[item["originalIndex"]] for item in payload], []

        dedupe_key = target_ext_id_field

        if wire_op_mode == "upsert":
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/upsert"
        else:
            endpoint = f"{domain}/crm/v3/objects/{safe_obj}/batch/create"

        semaphore = asyncio.Semaphore(10) 

        async def process_chunk(chunk):
            async with semaphore:
                hs_records = []
                included_indices = []

                if wire_op_mode == "upsert":
                    for i, c in enumerate(chunk):
                        dedupe_val = c["targetRecord"].get(dedupe_key)
                        if dedupe_val:
                            hs_records.append({
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
                    while True:
                        res = await client.post(endpoint, json=req_payload, headers=headers)
                        
                        if res.status_code == 401:
                            await send_log(f" HubSpot token expired mid-migration. Silently refreshing...")
                            token = await CrmService.refresh_crm_token(user_id, "hubspot", "target")
                            headers["Authorization"] = f"Bearer {token}"
                            continue

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