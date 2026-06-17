import asyncio
import httpx
import os
from app.services.crm_service import CrmService

def chunk_dataset(data: list, chunk_size: int = 5000):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]

class TargetUploadService:
    
    @staticmethod
    async def upload_to_salesforce(client, payload, sf_op, pass_name, options, send_log):
        """Your exact existing Salesforce Bulk V2 logic, perfectly preserved."""
        if not payload: return 0, 0, [], []
        
        target_object = options["targetObject"]
        target_ext_id_field = options["targetExtIdField"]
        sf_token = options["token"]
        sf_instance = options["instance_url"]
        batch_size = options.get("batchSize", 5000)
        source_records = options["sourceRecords"]
        user_id = options["userId"]

        total_success, total_error = 0, 0
        all_success_data, all_error_data = [], []

        await send_log(f"[{target_object}] {pass_name}: Initializing {sf_op.upper()} to Salesforce...")
        sf_headers = {"X-SFDC-Session": sf_token, "Content-Type": "application/json; charset=UTF-8", "Accept": "application/json"}
        bulk_base_url = f"{sf_instance.rstrip('/')}/services/async/60.0"

        job_config = {"operation": sf_op, "object": target_object, "contentType": "JSON"}
        if sf_op == "upsert": job_config["externalIdFieldName"] = target_ext_id_field

        job_res = await client.post(f"{bulk_base_url}/job", json=job_config, headers=sf_headers)
        
        # Silent Refresh
        if job_res.status_code == 401:
            await send_log(f"[{target_object}] Session Expired. Silently refreshing SF Token...")
            sf_token = await CrmService.refresh_crm_token(user_id, "salesforce", "target")
            sf_headers["X-SFDC-Session"] = sf_token
            job_res = await client.post(f"{bulk_base_url}/job", json=job_config, headers=sf_headers)

        if job_res.status_code != 201:
            await send_log(f"[{target_object}] Salesforce Job Failed: {job_res.text}")
            return 0, len(payload), [], [r for r in source_records]
            
        job_id = job_res.json().get("id")
        chunks = list(chunk_dataset(payload, batch_size))
        await send_log(f"[{target_object}] {pass_name}: Executing {len(chunks)} batches...")

        semaphore = asyncio.Semaphore(6)

        async def upload_chunk(chunk_data):
            async with semaphore:
                just_records = [c["targetRecord"] for c in chunk_data]
                b_res = await client.post(f"{bulk_base_url}/job/{job_id}/batch", json=just_records, headers=sf_headers)
                b_res.raise_for_status()
                return b_res.json().get("id")

        batch_ids = await asyncio.gather(*[upload_chunk(c) for c in chunks])
        await client.post(f"{bulk_base_url}/job/{job_id}", json={"state": "Closed"}, headers=sf_headers)

        poll_delay = 1.0
        while True:
            await asyncio.sleep(poll_delay)
            status_res = await asyncio.gather(*[client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}", headers=sf_headers) for b_id in batch_ids])
            states = [r.json().get("state") for r in status_res]
            if all(s == "Completed" for s in states) or any(s in ["Failed", "NotProcessed"] for s in states):
                break
            poll_delay = min(poll_delay * 1.5, 4.0)

        for i, b_id in enumerate(batch_ids):
            res = await client.get(f"{bulk_base_url}/job/{job_id}/batch/{b_id}/result", headers=sf_headers)
            results = res.json()
            original_chunk = chunks[i]

            for row_data, sf_result in zip(original_chunk, results):
                orig_record = source_records[row_data["originalIndex"]]
                if sf_result.get("success"):
                    orig_record["Target_Id"] = sf_result.get("id")
                    all_success_data.append(orig_record)
                    total_success += 1
                else:
                    err_msg = sf_result.get("errors", [{"message": "Unknown"}])[0].get("message")
                    orig_record["Target_Error"] = err_msg
                    all_error_data.append(orig_record)
                    total_error += 1
                    
        return total_success, total_error, all_success_data, all_error_data


    @staticmethod
    async def upload_to_zoho(client, payload, op_mode, pass_name, options, send_log):
        """Placeholder for Zoho Bulk Logic using /crm/v6/{module}/upsert"""
        await send_log(f"[{options['targetObject']}] Zoho Upload Logic goes here...")
        # Implementation is similar, chunking arrays of 100 records and POSTing to Zoho
        return 0, 0, [], []

    @staticmethod
    async def upload_to_zendesk(client, payload, op_mode, pass_name, options, send_log):
        """Placeholder for Zendesk Bulk Logic using /api/v2/{object}/create_many"""
        await send_log(f"[{options['targetObject']}] Zendesk Upload Logic goes here...")
        return 0, 0, [], []