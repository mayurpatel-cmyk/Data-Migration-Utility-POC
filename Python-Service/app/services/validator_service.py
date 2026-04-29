import pandas as pd
import numpy as np
import pycountry
from app.utils.constants import is_valid_email

def build_iso_maps():
    c_map = {}
    for c in pycountry.countries:
        c_map[c.name.lower()] = c.alpha_2
        if hasattr(c, 'official_name') and c.official_name:
            c_map[c.official_name.lower()] = c.alpha_2
    
    # Add common aliases users frequently type in CSVs
    c_map.update({
        'usa': 'US', 'uk': 'GB', 'uae': 'AE', 
        'united states of america': 'US', 'great britain': 'GB',
        'south korea': 'KR', 'north korea': 'KP', 'russia': 'RU'
    })

    s_map = {}
    for s in pycountry.subdivisions:
        # ISO-3166-2 codes look like 'US-CA'. Salesforce StateCode expects just 'CA'.
        s_map[s.name.lower()] = s.code.split('-')[-1]
        
    return c_map, s_map

# Build these massive dictionaries exactly once when the server boots
SF_COUNTRY_MAP, SF_STATE_MAP = build_iso_maps()

def process_validation_batch(records: list, mappings: list, dedupe_key: str, sf_rules: dict, date_format: str = "") -> dict:
    if not records:
        return {"stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}, "validRecords": [], "invalidRecords": []}

    df = pd.DataFrame(records)
    initial_count = len(df)

    df['_errors'] = ""
    valid_mask = pd.Series(True, index=df.index)

    duplicates_removed = 0

    is_duplicate = df.duplicated(keep='first') 
    duplicates_removed = int(is_duplicate.sum())
    
    if duplicates_removed > 0:
        
        df.loc[is_duplicate, '_errors'] += "[Row: Duplicate Record. This exact row appears multiple times in the file.] "
        valid_mask &= ~is_duplicate

    # ==========================================
    # NEW: Detect Multi-Currency Org
    # ==========================================
    is_multi_currency_org = 'CurrencyIsoCode' in sf_rules
    iso_code_mapped = any(m.get('sfField') == 'CurrencyIsoCode' for m in mappings)

    for mapping in mappings:
        csv_col = mapping.get('csvField')
        sf_field = mapping.get('sfField')
        column_date_format = mapping.get('dateFormat', '') 
        
        if csv_col not in df.columns or not sf_field:
            continue
        # NEW: Skip all checks (format, length, etc.) if skipValidation is True
        if mapping.get('skipValidation'):
            continue
         
        df[csv_col] = df[csv_col].astype(object)
            
        field_rules = sf_rules.get(sf_field, {})
        sf_type = field_rules.get('type', mapping.get('type', 'string'))
        
        str_col = df[csv_col].astype(str).str.strip().str.lower()
        is_empty = df[csv_col].isna() | (str_col == '') | (str_col == 'nan') | (str_col == 'none') | (str_col == '<na>') | (str_col == 'nat')

        is_required = field_rules.get('required', mapping.get('isRequired', False))
        if is_required:
            df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is required in Salesforce but is empty.] "
            valid_mask &= ~is_empty

        is_unique = field_rules.get('unique', False)
        is_external_id = field_rules.get('externalId', False)
        
        if is_unique or is_external_id:
            is_col_duplicate = str_col.duplicated(keep=False)
            invalid_duplicates = is_col_duplicate & ~is_empty
            
            if invalid_duplicates.any():
                df.loc[invalid_duplicates, '_errors'] += f"[{csv_col}: Duplicate value found inside the CSV. This field must be Unique.] "
                valid_mask &= ~invalid_duplicates

        is_calculated = field_rules.get('calculated', False)
        is_autonumber = field_rules.get('autoNumber', False)
        is_createable = field_rules.get('createable', True)
        is_updateable = field_rules.get('updateable', True)

        if is_calculated or is_autonumber or (not is_createable and not is_updateable):
            df.loc[~is_empty, '_errors'] += f"[{csv_col}: This field is strictly Read-Only in Salesforce (e.g., Formula). You cannot map data to it.] "
            valid_mask &= is_empty 

        if sf_type in ['string', 'textarea', 'phone', 'url']:
            max_len = field_rules.get('length', 255 if sf_type != 'textarea' else 32768)
            
            if 'country' in sf_field.lower():
                df[csv_col] = df[csv_col].astype(str).str.lower().map(SF_COUNTRY_MAP).fillna(df[csv_col])
            elif ('state' in sf_field.lower() or 'province' in sf_field.lower()):
                df[csv_col] = df[csv_col].astype(str).str.lower().map(SF_STATE_MAP).fillna(df[csv_col])
                
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str[:max_len]
            
            if sf_type == 'url':
                
                needs_http = ~df[csv_col].astype(str).str.startswith('http', na=False) & ~is_empty
                df.loc[needs_http, csv_col] = 'https://' + df.loc[needs_http, csv_col].astype(str)
                
                url_regex = r'^https?://(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,63}(?:/[^\s]*)?$'
                
                is_invalid_url = ~df[csv_col].astype(str).str.match(url_regex) & ~is_empty
                
                if is_invalid_url.any():
                    df.loc[is_invalid_url, '_errors'] += f"[{csv_col}: Invalid URL format. Must be a valid web address (e.g., www.example.com).] "
                    valid_mask &= ~is_invalid_url

        elif sf_type == 'picklist':
            valid_values = field_rules.get('picklistValues', [])
            is_restricted = field_rules.get('restrictedPicklist', True) 
            
            # Standard Picklist Validation
            if valid_values and is_restricted:
                is_invalid_picklist = ~df[csv_col].astype(str).str.lower().str.strip().isin(valid_values) & ~is_empty
                df.loc[is_invalid_picklist, '_errors'] += f"[{csv_col}: Invalid Picklist Value. This field is restricted.] "
                valid_mask &= ~is_invalid_picklist

            # ==========================================
            # NEW: Dependent Picklist Validation
            # ==========================================
            if field_rules.get('controllerName') and field_rules.get('dependentValues'):
                controller_sf_name = field_rules.get('controllerName')
                # Find which CSV column the user mapped the controller to
                controller_csv_col = next((m.get('csvField') for m in mappings if m.get('sfField') == controller_sf_name), None)
                
                if controller_csv_col and controller_csv_col in df.columns:
                    dep_map = field_rules.get('dependentValues')
                    
                    def is_valid_dependency(row):
                        dep_val = str(row[csv_col]).strip().lower()
                        if pd.isna(row[csv_col]) or dep_val in ['none', 'nan', '', '<na>']: return True
                        
                        ctrl_val = str(row[controller_csv_col]).strip().lower()
                        allowed_values = dep_map.get(ctrl_val, [])
                        return dep_val in allowed_values
                    
                    is_valid_dep = df.apply(is_valid_dependency, axis=1)
                    is_invalid_dep = ~is_valid_dep & ~is_empty
                    
                    df.loc[is_invalid_dep, '_errors'] += f"[{csv_col}: Invalid dependent picklist value. It is not allowed for the selected '{controller_sf_name}' in this row.] "
                    valid_mask &= ~is_invalid_dep

        elif sf_type == 'multipicklist':
            # 1. Clean up common mistakes: Turn commas (,) and pipes (|) into Salesforce semicolons (;)
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
          
            has_junk = df[csv_col].astype(str).str.contains(r'[^a-zA-Z0-9\s;_-]', regex=True) & ~is_empty
            if has_junk.any():
                df.loc[has_junk, '_errors'] += f"[{csv_col}: Contains invalid special characters (e.g., #, @). Please use clean text separated by semicolons.] "
                valid_mask &= ~has_junk
            
            # 3. Try to get the rules from Salesforce
            valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
            
            # 4. ONLY run strict validation if we successfully downloaded the rules from Salesforce
            if valid_values:
                def is_valid_multipicklist(val):
                    if pd.isna(val) or str(val).strip() == '' or str(val).lower() == 'none': return True
                    items = [i.strip().lower() for i in str(val).split(';')]
                    return all(item in valid_values for item in items if item)

                is_valid_multi = df[csv_col].apply(is_valid_multipicklist)
                
                # We only want to flag invalid words if they haven't ALREADY been flagged for junk characters
                is_invalid_multi = ~is_valid_multi & ~is_empty & ~has_junk
                
                if is_invalid_multi.any():
                    df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select value. You must use exact allowed values separated by a semicolon (;)] "
                    valid_mask &= ~is_invalid_multi
            
            # 5. Format the final valid data perfectly for the Salesforce API
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s*;\s*', ';', regex=True)

        elif sf_type == 'email':
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', '', regex=True)
            
            is_invalid_email = pd.Series(False, index=df.index)
            if (~is_empty).any():
                is_invalid_email[~is_empty] = ~df.loc[~is_empty, csv_col].apply(is_valid_email)
            
            df.loc[is_invalid_email, '_errors'] += f"[{csv_col}: Invalid Email format.] "
            valid_mask &= ~is_invalid_email

        elif sf_type == 'boolean':
            lower_col = df[csv_col].astype(str).str.lower().str.strip()
            is_true = lower_col.isin(['true', '1', 'yes', 'y'])
            is_false = lower_col.isin(['false', '0', 'no', 'n'])
            
            valid_bools = is_true | is_false | is_empty
            
            df[csv_col] = df[csv_col].astype(object)
            
            df.loc[is_true, csv_col] = True
            df.loc[is_false, csv_col] = False
            
            # Map empty Boolean rows to False instead of Null to satisfy Salesforce strict rules
            df.loc[is_empty, csv_col] = False 

            df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
            valid_mask &= valid_bools

        elif sf_type in ['currency', 'double', 'int', 'percent']:
            cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
            numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
            is_invalid = numeric_col.isna() & ~is_empty
            
            precision = field_rules.get('precision', 18)
            scale = field_rules.get('scale', 0)
            max_int_digits = precision - scale

            def check_precision(val):
                if pd.isna(val): return True
                try:
                    int_part = str(int(abs(float(val))))
                    return len(int_part) <= max_int_digits
                except:
                    return False

            is_precision_valid = numeric_col.apply(check_precision)
            is_invalid_precision = ~is_precision_valid & ~is_invalid & ~is_empty

            df[csv_col] = df[csv_col].astype(object)
            df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty]
            
            df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Number.] "
            valid_mask &= ~is_invalid

            df.loc[is_invalid_precision, '_errors'] += f"[{csv_col}: Number too large. Limit is {max_int_digits} integer digits.] "
            valid_mask &= ~is_invalid_precision

            # ==========================================
            # NEW: Multi-Currency Validation Enforcement
            # ==========================================
            if sf_type == 'currency' and is_multi_currency_org and not iso_code_mapped:
                df.loc[~is_empty, '_errors'] += f"[{csv_col}: Multi-Currency Org Detected. You mapped a currency amount, but forgot to map the 'CurrencyIsoCode' field. Salesforce may reject this row.] "
                valid_mask &= is_empty

        elif sf_type in ['date', 'datetime']:
            # 1. Let Pandas auto-detect and parse standard string dates
            parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')

            # 2. THE FIX: Catch Excel Serial Dates, but BLOCK giant numbers that crash Python
            cleaned_str = df[csv_col].astype(str).str.strip().str.replace(r'\.0$', '', regex=True)
            numeric_str = pd.to_numeric(cleaned_str, errors='coerce')
            
            # Excel dates are usually between 1 (Year 1900) and 2958465 (Year 9999). 
            # If it's bigger than 3 million, it's a random phone number/ID, not a date!
            is_serial_date = numeric_str.notna() & (numeric_str > 0) & (numeric_str < 3000000) & ~is_empty
            
            if is_serial_date.any():
                excel_dates = pd.to_datetime(numeric_str[is_serial_date], unit='D', origin='1899-12-30', errors='coerce')
                parsed_dates.update(excel_dates)

            is_invalid = parsed_dates.isna() & ~is_empty

            # 3. Format exactly as Salesforce requires
            if sf_type == 'date':
                df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%d')
            else:
                df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')

            df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Date Format.] "
            valid_mask &= ~is_invalid

        elif sf_type == 'time':
            parsed_times = pd.to_datetime(df[csv_col], errors='coerce')
            is_invalid = parsed_times.isna() & ~is_empty
            
            df.loc[~is_invalid & ~is_empty, csv_col] = parsed_times[~is_invalid & ~is_empty].dt.strftime('%H:%M:%S.000Z')
            df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Time Format.] "
            valid_mask &= ~is_invalid

        elif sf_type in ['id', 'reference']:
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.strip()
            
            is_15_or_18 = df[csv_col].astype(str).str.len().isin([15, 18])
            is_alphanumeric = df[csv_col].astype(str).str.isalnum()
            
            is_invalid_id = ~(is_15_or_18 & is_alphanumeric) & ~is_empty

            df.loc[is_invalid_id, '_errors'] += f"[{csv_col}: Invalid Salesforce ID. Must be exactly 15 or 18 alphanumeric characters.] "
            valid_mask &= ~is_invalid_id

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
                "originalRow": invalid_row_dicts[i],
                "errors": str(invalid_errors[i]).strip(),
                "rowNumber": invalid_indices[i] + 2 
            })

    return {
        "stats": {
            "total": initial_count,
            "valid": len(valid_df),
            "invalid": len(invalid_df),
            "duplicates": duplicates_removed
        },
        "validRecords": valid_df.to_dict(orient="records"),
        "invalidRecords": invalid_records_output
    }