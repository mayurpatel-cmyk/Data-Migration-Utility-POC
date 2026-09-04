import pandas as pd
import numpy as np
import re

class HubspotValidator:
    def __init__(self):
        self.HS_VALID_TYPES = ['string', 'number', 'date', 'datetime', 'enumeration', 'bool', 'phone_number']

    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        hs_rules = target_rules
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
            target_field = mapping.get('sfField', mapping.get('targetField')) # Handle both UI keys safely
            
            if not target_field or csv_col not in df.columns or mapping.get('skipValidation'):
                continue
             
            df[csv_col] = df[csv_col].astype(object)
                
            field_rules = hs_rules.get(target_field, {})
            hs_type = field_rules.get('type', mapping.get('type', 'string')).lower()
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat') | (str_col == 'none')

            is_required = field_rules.get('required', mapping.get('isRequired', False))
            if is_required:
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is required in HubSpot but is empty.] "
                valid_mask &= ~is_empty

            is_unique = field_rules.get('unique', False)
            if is_unique or target_field == dedupe_key:
                is_col_duplicate = str_col.duplicated(keep=False)
                invalid_duplicates = is_col_duplicate & ~is_empty
                if invalid_duplicates.any():
                    df.loc[invalid_duplicates, '_errors'] += f"[{csv_col}: Duplicate value found. This HubSpot property must be unique.] "
                    valid_mask &= ~invalid_duplicates

            if hs_type in ['string', 'text']:
                max_len = int(field_rules.get('length', mapping.get('maxLength', 65536))) 
                str_lengths = df[csv_col].astype(str).str.len()
                is_too_long = (str_lengths > max_len) & ~is_empty
                if is_too_long.any():
                    df.loc[is_too_long, '_errors'] += f"[{csv_col}: Text is too long. Max allowed is {max_len} characters.] "
                    valid_mask &= ~is_too_long

            elif hs_type in ['enumeration', 'picklist', 'dropdown', 'radio']:
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                
                if valid_values:
                    is_invalid_dropdown = ~str_col.isin([str(v).lower() for v in valid_values]) & ~is_empty
                    if is_invalid_dropdown.any():
                        df.loc[is_invalid_dropdown, '_errors'] += f"[{csv_col}: Invalid Dropdown value. Must match a valid HubSpot internal option.] "
                        valid_mask &= ~is_invalid_dropdown

            elif hs_type in ['multipicklist', 'multiple_checkboxes']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
                valid_values = [str(v).lower() for v in field_rules.get('picklistValues', mapping.get('picklistValues', []))]
                
                if valid_values:
                    def is_valid_multiselect(val):
                        if pd.isna(val) or str(val).strip() == '': return True
                        items = [i.strip().lower() for i in str(val).split(';')]
                        return all(item in valid_values for item in items if item)

                    is_invalid_multi = ~df[csv_col].apply(is_valid_multiselect) & ~is_empty
                    if is_invalid_multi.any():
                        df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select. Items must exactly match HubSpot options.] "
                        valid_mask &= ~is_invalid_multi
                
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s*;\s*', ';', regex=True).str.strip(';')

            elif hs_type in ['number']:
                cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
                numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
                is_invalid = numeric_col.isna() & ~is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty].astype(float)
                
                if is_invalid.any():
                    df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Number format.] "
                    valid_mask &= ~is_invalid

            elif hs_type in ['bool', 'boolean']:
                is_true = str_col.isin(['true', '1', 'yes', 'y'])
                is_false = str_col.isin(['false', '0', 'no', 'n'])
                valid_bools = is_true | is_false | is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                df.loc[is_true, csv_col] = True
                df.loc[is_false, csv_col] = False
                df.loc[is_empty, csv_col] = False 

                df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
                valid_mask &= valid_bools

            elif hs_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                
                numeric_str = pd.to_numeric(df[csv_col].astype(str).str.strip().str.replace(r'\.0$', '', regex=True), errors='coerce')
                is_serial_date = numeric_str.notna() & (numeric_str > 0) & (numeric_str < 3000000) & ~is_empty
                if is_serial_date.any():
                    parsed_dates.update(pd.to_datetime(numeric_str[is_serial_date], unit='D', origin='1899-12-30', errors='coerce'))

                is_invalid = parsed_dates.isna() & ~is_empty

                if hs_type == 'date':
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%d')
                else:
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%SZ')

                df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Date Format. Could not parse.] "
                valid_mask &= ~is_invalid

            elif hs_type == 'email' or target_field == 'email':
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', '', regex=True)
                email_regex = r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
                is_invalid_email = ~df[csv_col].astype(str).str.match(email_regex) & ~is_empty
                
                if is_invalid_email.any():
                    df.loc[is_invalid_email, '_errors'] += f"[{csv_col}: Invalid Email format. HubSpot will reject this.] "
                    valid_mask &= ~is_invalid_email

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
                    "rowNumber": row_numbers[invalid_indices[i]] 
                })

        return {
            "stats": {"total": initial_count, "valid": len(valid_df), "invalid": len(invalid_df), "duplicates": duplicates_removed},
            "validRecords": valid_df.to_dict(orient="records"),
            "invalidRecords": invalid_records_output
        }