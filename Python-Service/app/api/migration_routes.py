import asyncio
import httpx
import traceback # <--- Added to track exact errors
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

@router.websocket("/ws/migrate")
async def websocket_migration(websocket: WebSocket):
    await websocket.accept()
    print("\n" + "="*50)
    print("1. WEBSOCKET CONNECTED SUCCESSFULLY")
    
    try:
        # Prove the pipe works by sending an instant message
        await websocket.send_json({"log": "Logs Opened!", "status": "Initializing..."})
        
        print("2. WAITING FOR PAYLOAD FROM ANGULAR...")
        payload = await websocket.receive_json()
        print(f"3. PAYLOAD RECEIVED! Target Object: {payload.get('targetObject')}")
        
        mappings = payload.get("mappings", [])
        sf_token = payload.get("sfToken")
        sf_instance = payload.get("sfInstance")
        target_object = payload.get("targetObject")

        # SECURITY CHECK: Did Angular send the credentials?
        if not sf_token or not sf_instance:
            print("❌ ERROR: Missing Salesforce Credentials!")
            await websocket.send_json({"log": "FATAL: Missing Salesforce Credentials. Please reconnect SFDC.", "status": "Failed"})
            await websocket.close()
            return
            
        active_mappings = [m for m in mappings if m.get("targetField")]

        async def send_log(msg: str, status: str = "Running"):
            await websocket.send_json({"log": msg, "status": status})

        await send_log("Authenticating with Salesforce Bulk API...")
        await asyncio.sleep(0.5)
        
        transformed_records = [
            {m["targetField"]: f"Sample Data {i}" for m in active_mappings} 
            for i in range(1, 6) 
        ]
        
        await send_log(f"Extracted and mapped {len(transformed_records)} records.")

        sf_headers = {
            "X-SFDC-Session": sf_token,
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json"
        }
        
        # Make sure the URL doesn't crash if it's empty
        base_url = sf_instance.rstrip('/')
        bulk_base_url = f"{base_url}/services/async/60.0"
        print(f"4. ATTEMPTING TO HIT SALESFORCE URL: {bulk_base_url}")
        
        async with httpx.AsyncClient(timeout=120.0) as client:
            
            # CREATE JOB
            await send_log("Creating Salesforce Bulk API v1 Job...")
            job_payload = {"operation": "insert", "object": target_object, "contentType": "JSON"}
            job_res = await client.post(f"{bulk_base_url}/job", json=job_payload, headers=sf_headers)
            
            if job_res.status_code != 201:
                print(f"❌ SFDC API ERROR: {job_res.text}")
                await send_log(f"FATAL: Failed to create Bulk Job. {job_res.text}", "Failed")
                await websocket.close()
                return
                
            job_id = job_res.json().get("id")
            print(f"5. JOB CREATED: {job_id}")

            # UPLOAD BATCH
            await send_log(f"Uploading Batch to Salesforce [Job: {job_id}]...")
            batch_res = await client.post(f"{bulk_base_url}/job/{job_id}/batch", json=transformed_records, headers=sf_headers)
            
            if batch_res.status_code != 201:
                await send_log("FATAL: Failed to upload batch data.", "Failed")
                await websocket.close()
                return
                
            batch_id = batch_res.json().get("id")
            print(f"6. BATCH UPLOADED: {batch_id}")

            # CLOSE JOB
            await send_log("Closing Job to trigger processing...")
            await client.post(f"{bulk_base_url}/job/{job_id}", json={"state": "Closed"}, headers=sf_headers)
            
            # POLL PROGRESS
            await send_log("Waiting for Salesforce to process the queue...")
            while True:
                await asyncio.sleep(3)
                status_res = await client.get(f"{bulk_base_url}/job/{job_id}/batch/{batch_id}", headers=sf_headers)
                state = status_res.json().get("state")
                print(f"7. SALESFORCE PROCESSING STATE: {state}")
                
                if state == "Completed":
                    await send_log("Salesforce finished processing. Fetching results...")
                    break
                elif state in ["Failed", "NotProcessed"]:
                    await send_log(f"Salesforce rejected the batch. State: {state}", "Failed")
                    await websocket.close()
                    return
                else:
                    await send_log(f"Salesforce is currently: {state}...")

            # DOWNLOAD RESULTS
            result_res = await client.get(f"{bulk_base_url}/job/{job_id}/batch/{batch_id}/result", headers=sf_headers)
            results = result_res.json()
            
            success_count = sum(1 for r in results if r.get("success"))
            error_count = len(results) - success_count
            
            if error_count > 0:
                first_error = next(r for r in results if not r.get("success"))
                err_msg = first_error.get("errors", [{"message": "Unknown"}])[0].get("message")
                await send_log(f"Partial Success: {success_count} inserted, {error_count} failed.", "Completed with Errors")
                await send_log(f"SFDC ERROR REASON: {err_msg}", "Completed with Errors")
            else:
                await send_log(f"Success! All {success_count} records inserted perfectly.", "Completed")

        print("8. JOB COMPLETED SUCCESSFULLY")
        await websocket.close()
        
    except WebSocketDisconnect:
        print("❌ ANGULAR CLIENT DISCONNECTED PREMATURELY")
    except Exception as e:
        print("\n❌ PYTHON CRASHED! See error below:")
        traceback.print_exc() # <--- PRINTS EXACT ERROR TO TERMINAL
        try:
            await websocket.send_json({"log": f"SYSTEM ERROR: {str(e)}", "status": "Failed"})
            await websocket.close()
        except:
            pass