import json
import os
import tempfile
import shutil
import pandas as pd
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Request
from app.services.validator_service import process_validation_batch

router = APIRouter()

# ==========================================
# ROUTE 1: FAST HEADER EXTRACTION
# ==========================================
@router.post("/api/python/extract-headers")
async def extract_headers(file: UploadFile = File(...)):
    """
    Reads ONLY the headers of a massive CSV or XLSX file 
    without loading the actual data into memory.
    """
    temp_file = tempfile.NamedTemporaryFile(delete=False)
    
    try:
        # Save the file temporarily
        with open(temp_file.name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        sheets = []
        headers_map = {}

        if file.filename.endswith('.csv'):
            # nrows=0 tells Pandas to ONLY read the column names, using almost 0 memory
            df = pd.read_csv(temp_file.name, nrows=0)
            sheets = ["Sheet1"]
            headers_map["Sheet1"] = df.columns.tolist()
            
        elif file.filename.endswith(('.xlsx', '.xls')):
            # Read sheet names first
            xls = pd.ExcelFile(temp_file.name)
            sheets = xls.sheet_names
            
            # Extract headers for each sheet
            for sheet in sheets:
                df = pd.read_excel(xls, sheet_name=sheet, nrows=0)
                headers_map[sheet] = df.columns.tolist()
        else:
            raise HTTPException(status_code=400, detail="Unsupported file format. Please upload CSV or XLSX.")

        return {
            "sheets": sheets,
            "headersMap": headers_map
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        # Always clean up the temporary file
        file.file.close()
        if os.path.exists(temp_file.name):
            os.remove(temp_file.name)


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
    dynamic_country_map = payload.get("validCountries", {})
    dynamic_state_map = payload.get("validStates", {})
    sf_rules = payload.get("sfRules", {})

    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".csv")
    try:
        with open(temp_file.name, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        total_count = 0
        total_valid = 0
        total_invalid_count = 0
        total_duplicates = 0
        all_invalid_records = []

        # Process the file in safe chunks of 10,000 rows
        chunk_iterator = pd.read_csv(temp_file.name, chunksize=10000)

        for chunk_df in chunk_iterator:
            chunk_records = chunk_df.replace({pd.NA: None}).to_dict(orient="records")

            result = process_validation_batch(
                records=chunk_records, 
                mappings=mappings, 
                dedupe_key=dedupe_key, 
                country_map=dynamic_country_map, 
                state_map=dynamic_state_map, 
                sf_rules=sf_rules
            )

            total_count += result["stats"]["total"]
            total_valid += result["stats"]["valid"]
            total_invalid_count += result["stats"]["invalid"]
            total_duplicates += result["stats"]["duplicates"]
            all_invalid_records.extend(result["invalidRecords"])

        return {
            "stats": {
                "total": total_count,
                "valid": total_valid,
                "invalid": total_invalid_count,
                "duplicates": total_duplicates
            },
            "invalidRecords": all_invalid_records
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        file.file.close()
        if os.path.exists(temp_file.name):
            os.remove(temp_file.name)


# ==========================================
# ROUTE 3: QUICK RE-VALIDATION (JSON)
# ==========================================
@router.post("/api/python/revalidate")
async def revalidate_batch_json(request: Request):
    payload = await request.json()
    records = payload.get("records", [])
    mappings = payload.get("mappings", [])
    dedupe_key = payload.get("dedupeKey", "")
    dynamic_country_map = payload.get("validCountries", {})
    dynamic_state_map = payload.get("validStates", {})
    sf_rules = payload.get("sfRules", {})

    result = process_validation_batch(
        records=records, 
        mappings=mappings, 
        dedupe_key=dedupe_key, 
        country_map=dynamic_country_map, 
        state_map=dynamic_state_map, 
        sf_rules=sf_rules
    )
    
    return result