import pandas as pd
import numpy as np
import re

class ZendeskValidator:
    def __init__(self):
        self.ZD_TICKET_STATUSES = ['new', 'open', 'pending', 'hold', 'solved', 'closed']
        self.ZD_TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent']
        self.ZD_TICKET_TYPES = ['question', 'incident', 'problem', 'task']

    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "", strict_mode: bool = True) -> dict:

        zd_rules = target_rules
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
                
            field_rules = zd_rules.get(target_field, {})
            zd_type = field_rules.get('type', mapping.get('type', 'string')).lower()
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat') | (str_col == 'none')

            is_required = field_rules.get('required', mapping.get('isRequired', False))
            if is_required:
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is required in Zendesk but is empty.] "
                valid_mask &= ~is_empty

            is_unique = field_rules.get('unique', False)
            if is_unique or target_field == dedupe_key:
                is_col_duplicate = str_col.duplicated(keep=False)
                invalid_duplicates = is_col_duplicate & ~is_empty
                if invalid_duplicates.any():
                    df.loc[invalid_duplicates, '_errors'] += f"[{csv_col}: Duplicate value found. This Zendesk field must be Unique.] "
                    valid_mask &= ~invalid_duplicates

            if target_field == 'status':
                is_invalid_status = ~str_col.isin(self.ZD_TICKET_STATUSES) & ~is_empty
                if is_invalid_status.any():
                    df.loc[is_invalid_status, '_errors'] += f"[{csv_col}: Invalid status. Allowed: {', '.join(self.ZD_TICKET_STATUSES)}.] "
                    valid_mask &= ~is_invalid_status
                    
            elif target_field == 'priority':
                is_invalid_prio = ~str_col.isin(self.ZD_TICKET_PRIORITIES) & ~is_empty
                if is_invalid_prio.any():
                    df.loc[is_invalid_prio, '_errors'] += f"[{csv_col}: Invalid priority. Allowed: {', '.join(self.ZD_TICKET_PRIORITIES)}.] "
                    valid_mask &= ~is_invalid_prio

            elif target_field == 'type' and 'ticket' in field_rules.get('context', 'ticket'):
                is_invalid_type = ~str_col.isin(self.ZD_TICKET_TYPES) & ~is_empty
                if is_invalid_type.any():
                    df.loc[is_invalid_type, '_errors'] += f"[{csv_col}: Invalid ticket type. Allowed: {', '.join(self.ZD_TICKET_TYPES)}.] "
                    valid_mask &= ~is_invalid_type

            elif target_field == 'tags':
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.lower().str.replace(r'[,;]', ' ', regex=True)
                has_invalid_chars = df[csv_col].astype(str).str.contains(r'[^a-z0-9_\-\s/]') & ~is_empty
                if has_invalid_chars.any():
                    df.loc[has_invalid_chars, '_errors'] += f"[{csv_col}: Zendesk tags cannot contain special characters (like !, @, #). Use underscores or hyphens.] "
                    valid_mask &= ~has_invalid_chars
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', ' ', regex=True).str.strip()

            elif zd_type in ['text', 'textarea', 'string']:
                max_len = int(field_rules.get('length', mapping.get('maxLength', 65536))) # Zendesk standard max
                str_lengths = df[csv_col].astype(str).str.len()
                is_too_long = (str_lengths > max_len) & ~is_empty
                if is_too_long.any():
                    df.loc[is_too_long, '_errors'] += f"[{csv_col}: Text is too long. Max allowed is {max_len} characters.] "
                    valid_mask &= ~is_too_long

            elif zd_type == 'regexp':
                regex_pattern = field_rules.get('regexp_for_validation')
                if regex_pattern:
                    is_invalid_regex = ~df[csv_col].astype(str).str.match(regex_pattern) & ~is_empty
                    if is_invalid_regex.any():
                        df.loc[is_invalid_regex, '_errors'] += f"[{csv_col}: Fails custom Zendesk Regex validation pattern.] "
                        valid_mask &= ~is_invalid_regex

            elif zd_type in ['tagger', 'dropdown', 'picklist']:
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                
                if valid_values:
                    is_invalid_dropdown = ~str_col.isin(valid_values) & ~is_empty
                    if is_invalid_dropdown.any():
                        df.loc[is_invalid_dropdown, '_errors'] += f"[{csv_col}: Invalid Dropdown value. Must match a Zendesk field Tag.] "
                        valid_mask &= ~is_invalid_dropdown

            elif zd_type in ['multiselect', 'multipicklist']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                
                if valid_values:
                    def is_valid_multiselect(val):
                        if pd.isna(val) or str(val).strip() == '': return True
                        items = [i.strip().lower() for i in str(val).split(';')]
                        return all(item in valid_values for item in items if item)

                    is_invalid_multi = ~df[csv_col].apply(is_valid_multiselect) & ~is_empty
                    if is_invalid_multi.any():
                        df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select value. Items must exactly match Zendesk Tags.] "
                        valid_mask &= ~is_invalid_multi
                
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s*;\s*', ';', regex=True)

            elif zd_type in ['integer', 'decimal', 'numeric']:
                cleaned_nums = df[csv_col].astype(str).str.replace(r'[^\d\.-]', '', regex=True)
                numeric_col = pd.to_numeric(cleaned_nums, errors='coerce')
                is_invalid = numeric_col.isna() & ~is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                
                if zd_type == 'integer':
                    is_float = (numeric_col % 1 != 0) & ~is_invalid & ~is_empty
                    if is_float.any():
                        df.loc[is_float, '_errors'] += f"[{csv_col}: Must be a whole number (Integer).] "
                        valid_mask &= ~is_float
                    df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty].astype(int).astype(str)
                else:
                    df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty].astype(float)
                
                if is_invalid.any():
                    df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Number format.] "
                    valid_mask &= ~is_invalid

            elif zd_type in ['checkbox', 'boolean']:
                is_true = str_col.isin(['true', '1', 'yes', 'y'])
                is_false = str_col.isin(['false', '0', 'no', 'n'])
                valid_bools = is_true | is_false | is_empty
                
                df[csv_col] = df[csv_col].astype(object)
                df.loc[is_true, csv_col] = True
                df.loc[is_false, csv_col] = False
                df.loc[is_empty, csv_col] = False 

                df.loc[~valid_bools, '_errors'] += f"[{csv_col}: Must be TRUE/FALSE/Yes/No.] "
                valid_mask &= valid_bools

            elif zd_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                
                numeric_str = pd.to_numeric(df[csv_col].astype(str).str.strip().str.replace(r'\.0$', '', regex=True), errors='coerce')
                is_serial_date = numeric_str.notna() & (numeric_str > 0) & (numeric_str < 3000000) & ~is_empty
                if is_serial_date.any():
                    parsed_dates.update(pd.to_datetime(numeric_str[is_serial_date], unit='D', origin='1899-12-30', errors='coerce'))

                is_invalid = parsed_dates.isna() & ~is_empty

                if zd_type == 'date':
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%d')
                else:
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%SZ')

                df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Date Format. Could not parse to Zendesk standard.] "
                valid_mask &= ~is_invalid

            elif zd_type == 'email':
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'\s+', '', regex=True)
                email_regex = r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$"
                is_invalid_email = ~df[csv_col].astype(str).str.match(email_regex) & ~is_empty
                
                if is_invalid_email.any():
                    df.loc[is_invalid_email, '_errors'] += f"[{csv_col}: Invalid Email format.] "
                    valid_mask &= ~is_invalid_email

            elif zd_type in ['lookup', 'id']:
                cleaned_ids = df[csv_col].astype(str).str.replace(r'\.0$', '', regex=True).str.strip()
                df.loc[~is_empty, csv_col] = cleaned_ids[~is_empty]
                is_not_numeric = ~cleaned_ids.str.isnumeric() & ~is_empty
                
                if is_not_numeric.any():
                    df.loc[is_not_numeric, '_errors'] += f"[{csv_col}: Zendesk lookup IDs must be purely numeric.] "
                    valid_mask &= ~is_not_numeric

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