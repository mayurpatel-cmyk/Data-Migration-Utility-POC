# app/services/validators/zoho_validator.py

import pandas as pd
import numpy as np
import re

class ZohoValidator:
    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        zoho_rules = target_rules
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

        # 1. Global Duplicate Check
        is_duplicate = df.duplicated(keep='first') 
        duplicates_removed = int(is_duplicate.sum())
        if duplicates_removed > 0:
            df.loc[is_duplicate, '_errors'] += "[Row: Duplicate Record. This exact row appears multiple times in the file.] "
            valid_mask &= ~is_duplicate

        for mapping in mappings:
            csv_col = mapping.get('csvField')
            target_field = mapping.get('sfField', mapping.get('targetField')) # Safely handle both mapping schemas
            
            if not target_field or csv_col not in df.columns or mapping.get('skipValidation'):
                continue
             
            df[csv_col] = df[csv_col].astype(object)
            field_rules = zoho_rules.get(target_field, {})
            zoho_type = field_rules.get('type', mapping.get('type', 'string')).lower()
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat') | (str_col == 'none')

            # --- REQUIRED CHECK ---
            is_required = field_rules.get('required', mapping.get('isRequired', False))
            if is_required:
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is strictly required in Zoho CRM but is empty.] "
                valid_mask &= ~is_empty

            # --- UNIQUE CHECK ---
            is_unique = field_rules.get('unique', False)
            if is_unique or target_field == dedupe_key:
                is_col_duplicate = str_col.duplicated(keep=False)
                invalid_duplicates = is_col_duplicate & ~is_empty
                if invalid_duplicates.any():
                    df.loc[invalid_duplicates, '_errors'] += f"[{csv_col}: Duplicate value found. This Zoho field must be Unique.] "
                    valid_mask &= ~invalid_duplicates

            # --- READ-ONLY / SYSTEM FIELDS ---
            is_readonly = field_rules.get('read_only', False)
            if zoho_type in ['autonumber', 'formula'] or is_readonly:
                df.loc[~is_empty, '_errors'] += f"[{csv_col}: This field is strictly Read-Only in Zoho (e.g., Auto-Number). You cannot map data to it.] "
                valid_mask &= is_empty

            # --- STRINGS & TEXT ---
            elif zoho_type in ['string', 'text', 'textarea', 'profileimage']:
                max_len = int(field_rules.get('length', mapping.get('maxLength', 255)))
                str_lengths = df[csv_col].astype(str).str.len()
                is_too_long = (str_lengths > max_len) & ~is_empty
                if is_too_long.any():
                    df.loc[is_too_long, '_errors'] += f"[{csv_col}: Text exceeds Zoho limit of {max_len} characters.] "
                    valid_mask &= ~is_too_long

            # --- EMAILS ---
            elif zoho_type == 'email':
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', '', regex=True)
                email_regex = r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
                is_invalid_email = ~df[csv_col].astype(str).str.match(email_regex) & ~is_empty
                if is_invalid_email.any():
                    df.loc[is_invalid_email, '_errors'] += f"[{csv_col}: Invalid Email format.] "
                    valid_mask &= ~is_invalid_email

            # --- WEBSITES / URLS ---
            elif zoho_type in ['website', 'url']:
                needs_http = ~df[csv_col].astype(str).str.startswith('http', na=False) & ~is_empty
                df.loc[needs_http, csv_col] = 'https://' + df.loc[needs_http, csv_col].astype(str)
                
                url_regex = r'^https?://(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,63}(?:/[^\s]*)?$'
                is_invalid_url = ~df[csv_col].astype(str).str.match(url_regex) & ~is_empty
                if is_invalid_url.any():
                    df.loc[is_invalid_url, '_errors'] += f"[{csv_col}: Invalid Website URL format.] "
                    valid_mask &= ~is_invalid_url

            # --- PICKLISTS ---
            elif zoho_type == 'picklist':
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                if valid_values:
                    # Zoho picklists are generally case-sensitive on insert depending on settings, 
                    # but we do a strict check against the lowercase values extracted by the metadata API
                    is_invalid_picklist = ~str_col.isin([v.lower() for v in valid_values]) & ~is_empty
                    if is_invalid_picklist.any():
                        df.loc[is_invalid_picklist, '_errors'] += f"[{csv_col}: Invalid Picklist Value. Must match a valid Zoho dropdown option.] "
                        valid_mask &= ~is_invalid_picklist

            # --- MULTI-SELECT PICKLISTS ---
            elif zoho_type in ['multiselectpicklist', 'multiselectlookup']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                
                if valid_values:
                    valid_lower = [v.lower() for v in valid_values]
                    def is_valid_multipicklist(val):
                        if pd.isna(val) or str(val).strip() == '': return True
                        items = [i.strip().lower() for i in str(val).split(';')]
                        return all(item in valid_lower for item in items if item)

                    is_invalid_multi = ~df[csv_col].apply(is_valid_multipicklist) & ~is_empty
                    if is_invalid_multi.any():
                        df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select value. Items must match Zoho dropdown options.] "
                        valid_mask &= ~is_invalid_multi
                
                # Cleanup formatting for the API payload
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s*;\s*', ';', regex=True)

            # --- NUMERICS (Integer, Double, Currency, Percent) ---
            elif zoho_type in ['integer', 'double', 'currency', 'number', 'percent']:
                cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
                numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
                is_invalid_num = numeric_col.isna() & ~is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                
                if zoho_type == 'integer':
                    is_float = (numeric_col % 1 != 0) & ~is_invalid_num & ~is_empty
                    if is_float.any():
                        df.loc[is_float, '_errors'] += f"[{csv_col}: Must be a whole number (Integer).] "
                        valid_mask &= ~is_float
                    df.loc[~is_invalid_num & ~is_empty, csv_col] = numeric_col[~is_invalid_num & ~is_empty].astype(int).astype(str)
                else:
                    df.loc[~is_invalid_num & ~is_empty, csv_col] = numeric_col[~is_invalid_num & ~is_empty].astype(float)
                
                df.loc[is_invalid_num, '_errors'] += f"[{csv_col}: Invalid Number.] "
                valid_mask &= ~is_invalid_num

            # --- BOOLEANS ---
            elif zoho_type == 'boolean':
                is_true = str_col.isin(['true', '1', 'yes', 'y'])
                is_false = str_col.isin(['false', '0', 'no', 'n'])
                valid_bools = is_true | is_false | is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                df.loc[is_true, csv_col] = True
                df.loc[is_false, csv_col] = False
                df.loc[is_empty, csv_col] = False 

                df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
                valid_mask &= valid_bools

            # --- DATES & DATETIMES ---
            elif zoho_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                
                # Excel serial date handling
                numeric_str = pd.to_numeric(df[csv_col].astype(str).str.strip().str.replace(r'\.0$', '', regex=True), errors='coerce')
                is_serial_date = numeric_str.notna() & (numeric_str > 0) & (numeric_str < 3000000) & ~is_empty
                if is_serial_date.any():
                    parsed_dates.update(pd.to_datetime(numeric_str[is_serial_date], unit='D', origin='1899-12-30', errors='coerce'))

                is_invalid_date = parsed_dates.isna() & ~is_empty
                
                if zoho_type == 'date':
                    # Zoho v6 API expects strict YYYY-MM-DD for standard dates
                    df.loc[~is_invalid_date & ~is_empty, csv_col] = parsed_dates[~is_invalid_date & ~is_empty].dt.strftime('%Y-%m-%d')
                else:
                    # Zoho v6 API expects ISO 8601 with offset for datetimes
                    df.loc[~is_invalid_date & ~is_empty, csv_col] = parsed_dates[~is_invalid_date & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%S+00:00')

                df.loc[is_invalid_date, '_errors'] += f"[{csv_col}: Invalid Date Format for Zoho.] "
                valid_mask &= ~is_invalid_date

            # --- LOOKUPS & IDS ---
            elif zoho_type in ['lookup', 'ownerlookup', 'userlookup', 'id']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
                
                # Zoho IDs are strictly numerical and almost always 18 or 19 digits.
                # If they are mapping to the native ID field, enforce strict length.
                is_not_zoho_id = ~df[csv_col].astype(str).str.match(r'^\d{18,19}$') & ~is_empty
                
                if is_not_zoho_id.any():
                    # We check `target_field` to ensure we don't accidentally block mappings to custom external text ID fields.
                    if target_field.lower() in ['id', 'ownerid', 'createdby', 'modifiedby'] or zoho_type == 'ownerlookup':
                        df.loc[is_not_zoho_id, '_errors'] += f"[{csv_col}: Invalid Zoho ID. Standard Zoho IDs must be exactly 18 or 19 digits (e.g., 4150868000004938001).] "
                        valid_mask &= ~is_not_zoho_id

        # Final Formatting for UI consumption
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