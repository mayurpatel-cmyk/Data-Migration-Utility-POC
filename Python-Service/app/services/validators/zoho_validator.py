# app/services/validators/zoho_validator.py

import pandas as pd
import numpy as np
import json

class ZohoValidator:
    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        if not records:
            return {"stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}, "validRecords": [], "invalidRecords": []}

        df = pd.DataFrame(records)
        initial_count = len(df)
        df['_errors'] = ""
        valid_mask = pd.Series(True, index=df.index)

        # Retain Row Numbers for UI
        if '_originalRowNumber' in df.columns:
            row_numbers = df['_originalRowNumber'].tolist()
            df = df.drop(columns=['_originalRowNumber'])
        else:
            row_numbers = [(i + 2) for i in df.index]

        # Duplicate Check
        is_duplicate = df.duplicated(keep='first') 
        duplicates_removed = int(is_duplicate.sum())
        if duplicates_removed > 0:
            df.loc[is_duplicate, '_errors'] += "[Row: Duplicate Record. This exact row appears multiple times in the file.] "
            valid_mask &= ~is_duplicate

        for mapping in mappings:
            csv_col = mapping.get('csvField')
            target_field = mapping.get('targetField')
            
            if not target_field or csv_col not in df.columns or mapping.get('skipValidation'):
                continue
             
            df[csv_col] = df[csv_col].astype(object)
            field_rules = target_rules.get(target_field, {})
            zoho_type = field_rules.get('type', mapping.get('type', 'string')).lower()
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat')

            # 1. Required Field Check
            is_required = field_rules.get('required', mapping.get('isRequired', False))
            if is_required:
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is strictly required in Zoho CRM but is empty.] "
                valid_mask &= ~is_empty

            # 2. String Validation
            if zoho_type in ['string', 'text', 'website', 'email', 'phone']:
                max_len = int(field_rules.get('length', mapping.get('maxLength', 255)))
                is_too_long = (df[csv_col].astype(str).str.len() > max_len) & ~is_empty
                if is_too_long.any():
                    df.loc[is_too_long, '_errors'] += f"[{csv_col}: Text exceeds Zoho limit of {max_len} characters.] "
                    valid_mask &= ~is_too_long

            # 3. Numeric Validation (Integer, Double, Currency)
            elif zoho_type in ['integer', 'double', 'currency', 'number']:
                cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
                numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
                is_invalid_num = numeric_col.isna() & ~is_empty
                
                df.loc[~is_invalid_num & ~is_empty, csv_col] = numeric_col[~is_invalid_num & ~is_empty]
                df.loc[is_invalid_num, '_errors'] += f"[{csv_col}: Invalid Number.] "
                valid_mask &= ~is_invalid_num

            # 4. Date & Datetime Validation (Zoho ISO 8601 Format)
            elif zoho_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                is_invalid_date = parsed_dates.isna() & ~is_empty
                
                if zoho_type == 'date':
                    df.loc[~is_invalid_date & ~is_empty, csv_col] = parsed_dates[~is_invalid_date & ~is_empty].dt.strftime('%Y-%m-%d')
                else:
                    # Zoho prefers standard ISO datetime with offsets, defaulting to Z
                    df.loc[~is_invalid_date & ~is_empty, csv_col] = parsed_dates[~is_invalid_date & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%S+00:00')

                df.loc[is_invalid_date, '_errors'] += f"[{csv_col}: Invalid Date Format for Zoho.] "
                valid_mask &= ~is_invalid_date

            # 5. Reference/Lookup Validation (Zoho IDs are usually numerical 19-digit strings)
            elif zoho_type in ['lookup', 'ownerlookup', 'reference']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.strip()
                
                # Check if it's purely digits (Zoho standard ID)
                is_not_digits = ~df[csv_col].astype(str).str.isdigit() & ~is_empty
                
                # Only flag if it's mapping to 'id' directly (sometimes users map to external ID text fields)
                if target_field == "id" and is_not_digits.any():
                    df.loc[is_not_digits, '_errors'] += f"[{csv_col}: Invalid Zoho ID. Standard Zoho IDs must be numerical (e.g., 4150868000004938001).] "
                    valid_mask &= ~is_not_digits

        # Final Formatting
        df = df.astype(object).where(pd.notna(df), None)
        valid_df = df[valid_mask].drop(columns=['_errors'])
        invalid_df = df[~valid_mask]

        invalid_records_output = []
        if not invalid_df.empty:
            invalid_row_dicts = invalid_df.drop(columns=['_errors']).to_dict(orient="records")
            invalid_errors = invalid_df['_errors'].tolist()
            invalid_indices = invalid_df.index.tolist()
            for i in range(len(invalid_row_dicts)):
                invalid_records_output.append({
                    "originalRow": invalid_row_dicts[i], "errors": str(invalid_errors[i]).strip(), "rowNumber": row_numbers[invalid_indices[i]] 
                })

        return {
            "stats": {"total": initial_count, "valid": len(valid_df), "invalid": len(invalid_df), "duplicates": duplicates_removed},
            "validRecords": valid_df.to_dict(orient="records"),
            "invalidRecords": invalid_records_output
        }