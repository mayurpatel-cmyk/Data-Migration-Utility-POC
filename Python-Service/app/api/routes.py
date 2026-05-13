import json
import os
import tempfile
import shutil
import pandas as pd
from openpyxl import load_workbook # <--- ADDED: For memory-efficient Excel streaming
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Request
from app.services.validator_service import process_validation_batch
from concurrent.futures import ProcessPoolExecutor
import asyncio
import numpy as np
router = APIRouter()
executor = ProcessPoolExecutor(max_workers=4)

# ==========================================
# ROUTE 1: FAST HEADER EXTRACTION
# ==========================================
@router.post("/api/python/extract-headers")
async def extract_headers(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower()
    
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    temp_file_name = temp_file.name
    temp_file.close() 
    
    try:
        with open(temp_file_name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        sheets = []
        headers_map = {}

        if ext == '.csv':
            df = pd.read_csv(temp_file_name, nrows=0)
            sheets = ["Sheet1"]
            headers_map["Sheet1"] = df.columns.tolist()
            
        elif ext in ['.xlsx', '.xls']:
            # FIX: Stream headers safely without loading the whole file
            wb = load_workbook(temp_file_name, read_only=True, data_only=True)
            sheets = wb.sheetnames
            for sheet in sheets:
                ws = wb[sheet]
                # Grab just the very first row for headers
                first_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), [])
                headers_map[sheet] = [str(h) if h is not None else f"Unnamed_{i}" for i, h in enumerate(first_row)]
            wb.close()
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format.")

        return {
            "sheets": sheets,
            "headersMap": headers_map
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        file.file.close()
        if os.path.exists(temp_file_name):
            try:
                os.remove(temp_file_name)
            except PermissionError:
                pass


# ==========================================
# ROUTE 2: MASSIVE DATA VALIDATION (CHUNKS)
# ==========================================
@router.post("/api/python/validate")
async def validate_batch(
    file: UploadFile = File(...),
    config: str = Form(...) 
):
    try:
        payload = json.loads(config)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid configuration format")

    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    sheet_name = payload.get("sheetName", "")
    sf_rules = payload.get("sfRules", {})
    date_format = payload.get("dateFormat", "") # <--- PREPARED: For UI Date Selection later

    ext = os.path.splitext(file.filename)[1].lower()

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    temp_file_name = temp_file.name
    temp_file.close()

    try:
        with open(temp_file_name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        total_count = 0
        total_valid = 0
        total_invalid_count = 0
        total_duplicates = 0
        all_invalid_records = []
        all_valid_records = []

        # if ext == '.csv':
        #     chunk_iterator = pd.read_csv(temp_file_name, chunksize=10000)
            
        #     for chunk_df in chunk_iterator:
        #         chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
        #         chunk_records = chunk_df.to_dict(orient="records")
                
        #         result = process_validation_batch(
        #             records=chunk_records, mappings=mappings, dedupe_key=dedupe_key, 
        #             country_map=dynamic_country_map, state_map=dynamic_state_map, sf_rules=sf_rules,
        #             date_format=date_format
        #         )
                
        #         total_count += result["stats"]["total"]
        #         total_valid += result["stats"]["valid"]
        #         total_invalid_count += result["stats"]["invalid"]
        #         total_duplicates += result["stats"]["duplicates"]
        #         all_invalid_records.extend(result["invalidRecords"])
        #         all_valid_records.extend(result["validRecords"])

        # elif ext in ['.xlsx', '.xls']:
            # FIX: Open the Excel file in read-only streaming mode to prevent RAM spikes
            # wb = load_workbook(temp_file_name, read_only=True, data_only=True)
            # ws = wb[sheet_name] if sheet_name in wb.sheetnames else wb.active
            
            # rows_iter = ws.iter_rows(values_only=True)
            # headers_raw = next(rows_iter, [])
            # headers = [str(h) if h is not None else f"Unnamed_{i}" for i, h in enumerate(headers_raw)]

            # chunk_records = []
            
            # # Manually stream and chunk the rows
            # for row in rows_iter:
            #     # Skip entirely blank rows at the bottom of sheets
            #     if not any(row): continue 
                
            #     chunk_records.append(dict(zip(headers, row)))
                
            #     # Yield when we hit 10,000 records
            #     if len(chunk_records) == 10000:
            #         chunk_df = pd.DataFrame(chunk_records)
            #         chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                    
            #         result = process_validation_batch(
            #             records=chunk_df.to_dict(orient="records"), mappings=mappings, dedupe_key=dedupe_key, 
            #              sf_rules=sf_rules,
            #             date_format=date_format
            #         )
                    
            #         total_count += result["stats"]["total"]
            #         total_valid += result["stats"]["valid"]
            #         total_invalid_count += result["stats"]["invalid"]
            #         total_duplicates += result["stats"]["duplicates"]
            #         all_invalid_records.extend(result["invalidRecords"])
            #         all_valid_records.extend(result["validRecords"])
                    
            #         chunk_records = [] # Reset for next batch
            
            # # Process the final leftover records
            # if chunk_records:
            #     chunk_df = pd.DataFrame(chunk_records)
            #     chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                
            #     result = process_validation_batch(
            #         records=chunk_df.to_dict(orient="records"), mappings=mappings, dedupe_key=dedupe_key, 
            #          sf_rules=sf_rules,
            #         date_format=date_format
            #     )
                
            #     total_count += result["stats"]["total"]
            #     total_valid += result["stats"]["valid"]
            #     total_invalid_count += result["stats"]["invalid"]
            #     total_duplicates += result["stats"]["duplicates"]
            #     all_invalid_records.extend(result["invalidRecords"])
            #     all_valid_records.extend(result["validRecords"])
                
            # wb.close()

        if ext == '.csv':
            chunk_iterator = pd.read_csv(temp_file_name, chunksize=10000)
            tasks = []
            loop = asyncio.get_event_loop()

            for chunk_df in chunk_iterator:
                chunk_df = chunk_df.astype(object).where(pd.notna(chunk_df), None)
                chunk_records = chunk_df.to_dict(orient="records")
                
                # THREADING: Submit the chunk to the parallel executor
                task = loop.run_in_executor(
                    executor, 
                    process_validation_batch, 
                    chunk_records, mappings, dedupe_key, sf_rules, date_format
                )
                tasks.append(task)
            
            # Wait for all parallel "threads" to finish
            chunk_results = await asyncio.gather(*tasks)
            
            # Combine the results from all parallel tasks
            for result in chunk_results:
                total_count += result["stats"]["total"]
                total_valid += result["stats"]["valid"]
                total_invalid_count += result["stats"]["invalid"]
                total_duplicates += result["stats"]["duplicates"]
                all_invalid_records.extend(result["invalidRecords"])
                all_valid_records.extend(result["validRecords"])
        elif ext in ['.xlsx', '.xls']:
            wb = load_workbook(temp_file_name, read_only=True, data_only=True)
            ws = wb[sheet_name] if sheet_name in wb.sheetnames else wb.active
            
            rows_iter = ws.iter_rows(values_only=True)
            headers_raw = next(rows_iter, [])
            headers = [str(h) if h is not None else f"Unnamed_{i}" for i, h in enumerate(headers_raw)]

            chunk_records = []
            tasks = []
            loop = asyncio.get_event_loop()
            
            for row in rows_iter:
                if not any(row): continue 
                chunk_records.append(dict(zip(headers, row)))
                
                # When we hit 10,000 records, submit a parallel task
                if len(chunk_records) == 10000:
                    tasks.append(loop.run_in_executor(
                        executor, process_validation_batch, 
                        chunk_records, mappings, dedupe_key, sf_rules, date_format
                    ))
                    chunk_records = [] # Reset for next parallel chunk
            
            # Submit final leftover records
            if chunk_records:
                tasks.append(loop.run_in_executor(
                    executor, process_validation_batch, 
                    chunk_records, mappings, dedupe_key, sf_rules, date_format
                ))
                
            # Wait for all parallel Excel chunks to finish
            chunk_results = await asyncio.gather(*tasks)
            
            for result in chunk_results:
                total_count += result["stats"]["total"]
                total_valid += result["stats"]["valid"]
                total_invalid_count += result["stats"]["invalid"]
                total_duplicates += result["stats"]["duplicates"]
                all_invalid_records.extend(result["invalidRecords"])
                all_valid_records.extend(result["validRecords"])
                
            wb.close()
        return {
            "stats": {
                "total": total_count,
                "valid": total_valid,
                "invalid": total_invalid_count,
                "duplicates": total_duplicates
            },
            "invalidRecords": all_invalid_records,
            "validRecords": all_valid_records
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        file.file.close()
        if os.path.exists(temp_file_name):
            try:
                os.remove(temp_file_name)
            except PermissionError:
                pass


# ==========================================
# ROUTE 3: QUICK RE-VALIDATION (JSON)
# ==========================================
# @router.post("/api/python/revalidate")
# async def revalidate_batch_json(request: Request):
#     payload = await request.json()
#     records = payload.get("records", [])
#     mappings = payload.get("mappings", [])
#     dedupe_key = payload.get("dedupeKey", "")
#     sf_rules = payload.get("sfRules", {})
#     date_format = payload.get("dateFormat", "")

#     result = process_validation_batch(
#         records=records, 
#         mappings=mappings, 
#         dedupe_key=dedupe_key,  
#         sf_rules=sf_rules,
#         date_format=date_format
#     )
    
#     return result

@router.post("/api/python/revalidate")
async def revalidate_batch_json(request: Request):
    payload = await request.json()
    records = payload.get("records", [])
    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    sf_rules = payload.get("sfRules", {})
    date_format = payload.get("dateFormat", "")

    # THREADING: If there are many errors to fix, split them into parallel chunks
    if len(records) > 1000:
        # Split into chunks of 2,000 records
        chunks = [records[i:i + 2000] for i in range(0, len(records), 2000)]
        loop = asyncio.get_event_loop()
        
        tasks = [
            loop.run_in_executor(executor, process_validation_batch, c, mappings, dedupe_key, sf_rules, date_format)
            for c in chunks
        ]
        
        chunk_results = await asyncio.gather(*tasks)
        
        # Combine the results from the parallel threads
        combined = {
            "stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0},
            "validRecords": [],
            "invalidRecords": []
        }
        for res in chunk_results:
            combined["stats"]["total"] += res["stats"]["total"]
            combined["stats"]["valid"] += res["stats"]["valid"]
            combined["validRecords"].extend(res["validRecords"])
            combined["invalidRecords"].extend(res["invalidRecords"])
        return combined
    else:
        # Small error sets run in a single thread
        return process_validation_batch(records, mappings, dedupe_key, sf_rules, date_format)