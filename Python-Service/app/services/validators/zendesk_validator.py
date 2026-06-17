# app/services/validators/zendesk_validator.py

import pandas as pd
import numpy as np
import json

class ZendeskValidator:
    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        if not records:
            return {"stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}, "validRecords": [], "invalidRecords": []}

        df = pd.DataFrame(records)
        initial_count = len(df)
        df['_errors'] = ""
        valid_mask = pd.Series(True, index=df.index)

        if '_originalRowNumber' in df.columns:
            row_numbers = df['_originalRowNumber'].tolist()
            df = df.drop(columns=['_originalRowNumber'])
        else:
            row_numbers = [(i + 2) for i in df.index]

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
            zd_type = field_rules.get('type', mapping.get('type', 'string')).lower()
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat')

            # 1. Required Check
            if field_rules.get('required', mapping.get('isRequired', False)):
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is strictly required in Zendesk but is empty.] "
                valid_mask &= ~is_empty

            # 2. Zendesk Tag Validation (Cannot contain spaces)
            if target_field == "tags":
                has_spaces = df[csv_col].astype(str).str.contains(r'\s') & ~is_empty
                if has_spaces.any():
                    df.loc[has_spaces, '_errors'] += f"[{csv_col}: Zendesk tags cannot contain spaces. Use underscores (e.g., 'vip_customer').] "
                    valid_mask &= ~has_spaces
                    
                # Standardize tags: Lowercase and replace commas with spaces (Zendesk API format)
                df.loc[~has_spaces & ~is_empty, csv_col] = df.loc[~has_spaces & ~is_empty, csv_col].astype(str).str.lower().str.replace(',', ' ')

            # 3. Zendesk System Fields (Boolean handling)
            elif zd_type == 'boolean':
                is_true = str_col.isin(['true', '1', 'yes', 'y'])
                is_false = str_col.isin(['false', '0', 'no', 'n'])
                valid_bools = is_true | is_false | is_empty
                
                df.loc[is_true, csv_col] = True
                df.loc[is_false, csv_col] = False
                df.loc[is_empty, csv_col] = False 
                df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
                valid_mask &= valid_bools

            # 4. Dates
            elif zd_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                is_invalid_date = parsed_dates.isna() & ~is_empty
                df.loc[~is_invalid_date & ~is_empty, csv_col] = parsed_dates[~is_invalid_date & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%SZ')
                df.loc[is_invalid_date, '_errors'] += f"[{csv_col}: Invalid Date Format for Zendesk.] "
                valid_mask &= ~is_invalid_date

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