import pandas as pd
import numpy as np
from app.utils.constants import is_valid_email

def process_validation_batch(records: list, mappings: list, dedupe_key: str, country_map: dict, state_map: dict, sf_rules: dict) -> dict:
    if not records:
        return {"stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}, "validRecords": [], "invalidRecords": []}

    df = pd.DataFrame(records)
    initial_count = len(df)

    df['_errors'] = ""
    valid_mask = pd.Series(True, index=df.index)

    duplicates_removed = 0
    if dedupe_key and dedupe_key in df.columns:
        is_duplicate = df.duplicated(subset=[dedupe_key], keep='first')
        duplicates_removed = int(is_duplicate.sum())
        
        if duplicates_removed > 0:
            df.loc[is_duplicate, '_errors'] += f"[{dedupe_key}: Duplicate Record. A prior row already uses this exact value.] "
            valid_mask &= ~is_duplicate

    clean_country_map = {str(k).lower(): str(v) for k, v in country_map.items()}
    clean_state_map = {str(k).lower(): str(v) for k, v in state_map.items()}

    for mapping in mappings:
        csv_col = mapping.get('csvField')
        sf_field = mapping.get('sfField')
        
        if csv_col not in df.columns or not sf_field:
            continue
            
        field_rules = sf_rules.get(sf_field, {})
        sf_type = field_rules.get('type', mapping.get('type', 'string'))
        
        # 💡 FIX: Safely detect empty values
        is_empty = df[csv_col].isna() | (df[csv_col].astype(str).str.strip() == '') | (df[csv_col].astype(str).str.lower() == 'nan')

        # --- REQUIRED & UNIQUE CHECKS ---
        is_required = field_rules.get('required', False)
        if is_required:
            df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is required in Salesforce but is empty.] "
            valid_mask &= ~is_empty

        is_unique = field_rules.get('unique', False)
        is_external_id = field_rules.get('externalId', False)
        
        if is_unique or is_external_id:
            is_col_duplicate = df.duplicated(subset=[csv_col], keep=False)
            invalid_duplicates = is_col_duplicate & ~is_empty
            
            if invalid_duplicates.any():
                df.loc[invalid_duplicates, '_errors'] += f"[{csv_col}: Must be Unique.] "
                valid_mask &= ~invalid_duplicates

        # --- STRINGS & TEXTAREAS ---
        if sf_type in ['string', 'textarea', 'phone', 'url']:
            max_len = field_rules.get('length', 255 if sf_type != 'textarea' else 32768)
            
            if 'country' in sf_field.lower() and clean_country_map:
                df[csv_col] = df[csv_col].astype(str).str.lower().map(clean_country_map).fillna(df[csv_col])
            elif ('state' in sf_field.lower() or 'province' in sf_field.lower()) and clean_state_map:
                df[csv_col] = df[csv_col].astype(str).str.lower().map(clean_state_map).fillna(df[csv_col])
                
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str[:max_len]
            
            if sf_type == 'url':
                needs_http = ~df[csv_col].astype(str).str.startswith('http', na=False) & ~is_empty
                df.loc[needs_http, csv_col] = 'https://' + df.loc[needs_http, csv_col].astype(str)

        # --- PICKLISTS ---
        elif sf_type == 'picklist':
            valid_values = field_rules.get('picklistValues', [])
            if valid_values:
                is_invalid_picklist = ~df[csv_col].astype(str).str.lower().str.strip().isin(valid_values) & ~is_empty
                df.loc[is_invalid_picklist, '_errors'] += f"[{csv_col}: Invalid Picklist Value.] "
                valid_mask &= ~is_invalid_picklist

        elif sf_type == 'multipicklist':
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
            valid_values = field_rules.get('picklistValues', [])
            
            if valid_values:
                def is_valid_multipicklist(val):
                    if pd.isna(val) or str(val).strip() == '': return True
                    items = [i.strip().lower() for i in str(val).split(';')]
                    return all(item in valid_values for item in items if item)

                is_valid_multi = df[csv_col].apply(is_valid_multipicklist)
                is_invalid_multi = ~is_valid_multi & ~is_empty
                
                df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select value.] "
                valid_mask &= ~is_invalid_multi
            
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s*;\s*', ';', regex=True)

        # --- EMAILS ---
        elif sf_type == 'email':
            df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', '', regex=True)
            
            # Only run email validation on non-empty rows to prevent crashes and false-positives
            is_invalid_email = pd.Series(False, index=df.index)
            if (~is_empty).any():
                is_invalid_email[~is_empty] = ~df.loc[~is_empty, csv_col].apply(is_valid_email)
            
            df.loc[is_invalid_email, '_errors'] += f"[{csv_col}: Invalid Email format.] "
            valid_mask &= ~is_invalid_email

        # --- BOOLEANS ---
        elif sf_type == 'boolean':
            lower_col = df[csv_col].astype(str).str.lower().str.strip()
            is_true = lower_col.isin(['true', '1', 'yes', 'y'])
            is_false = lower_col.isin(['false', '0', 'no', 'n'])
            
            valid_bools = is_true | is_false | is_empty
            df.loc[is_true, csv_col] = True
            df.loc[is_false, csv_col] = False
            df.loc[is_empty, csv_col] = None

            df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
            valid_mask &= valid_bools

        # --- NUMBERS ---
        elif sf_type in ['currency', 'double', 'int', 'percent']:
            cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
            numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
            is_invalid = numeric_col.isna() & ~is_empty
            
            df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty]
            df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Number.] "
            valid_mask &= ~is_invalid

        # --- DATES ---
        elif sf_type in ['date', 'datetime']:
            parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
            is_invalid = parsed_dates.isna() & ~is_empty

            if sf_type == 'date':
                df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%d')
            else:
                df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')

            df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Date Format.] "
            valid_mask &= ~is_invalid

    #  Safely replace BOTH NaN and NaT with None so JSON serialization doesn't crash FastAPI
    df = df.astype(object).where(pd.notnull(df), None)

    valid_df = df[valid_mask].drop(columns=['_errors'])
    invalid_df = df[~valid_mask]

    invalid_records_output = []
    for index, row in invalid_df.iterrows():
        error_msg = str(row['_errors']).strip()
        row_data = row.drop(labels=['_errors']).to_dict()
        invalid_records_output.append({
            "originalRow": row_data,
            "errors": error_msg,
            "rowNumber": index + 2 
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