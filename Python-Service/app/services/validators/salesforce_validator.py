import pandas as pd
import numpy as np
import pycountry
from app.utils.constants import is_valid_email

class SalesforceValidator:
    def __init__(self):
        self.SF_COUNTRY_MAP, self.SF_STATE_MAP = self._build_iso_maps()

    def _build_iso_maps(self):
        c_map = {}
        for c in pycountry.countries:
            c_map[c.name.lower()] = c.alpha_2
            if hasattr(c, 'official_name') and c.official_name:
                c_map[c.official_name.lower()] = c.alpha_2
        
        c_map.update({
            'usa': 'US', 'uk': 'GB', 'uae': 'AE', 
            'united states of america': 'US', 'great britain': 'GB',
            'south korea': 'KR', 'north korea': 'KP', 'russia': 'RU'
        })

        s_map = {}
        for s in pycountry.subdivisions:
            s_map[s.name.lower()] = s.code.split('-')[-1]
            
        return c_map, s_map

    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        sf_rules = target_rules
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

        is_multi_currency_org = 'CurrencyIsoCode' in sf_rules
        iso_code_mapped = any(m.get('sfField') == 'CurrencyIsoCode' for m in mappings)

        for mapping in mappings:
            csv_col = mapping.get('csvField')
            sf_field = mapping.get('sfField', mapping.get('targetField')) # Adapted for new mappings schema
            
            if csv_col not in df.columns or not sf_field:
                continue
            if mapping.get('skipValidation'):
                continue
             
            df[csv_col] = df[csv_col].astype(object)
                
            field_rules = sf_rules.get(sf_field, {})
            sf_type = field_rules.get('type', mapping.get('type', 'string'))
            
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat')

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

            elif sf_type in ['string', 'textarea', 'phone', 'url']:
                raw_len = mapping.get('maxLength')
                if not raw_len: raw_len = field_rules.get('length')
                
                if not raw_len: max_len = 32768 if sf_type == 'textarea' else 255
                else: max_len = int(float(raw_len)) 
                
                if 'country' in sf_field.lower():
                    df[csv_col] = df[csv_col].astype(str).str.lower().map(self.SF_COUNTRY_MAP).fillna(df[csv_col])
                elif ('state' in sf_field.lower() or 'province' in sf_field.lower()):
                    df[csv_col] = df[csv_col].astype(str).str.lower().map(self.SF_STATE_MAP).fillna(df[csv_col])
                    
                str_lengths = df[csv_col].astype(str).str.len()
                is_too_long = (str_lengths > max_len) & ~is_empty
                
                if is_too_long.any():
                    df.loc[is_too_long, '_errors'] += f"[{csv_col}: Text is too long. Maximum allowed is {max_len} characters.] "
                    valid_mask &= ~is_too_long
                
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str)
                
                if sf_type == 'url':
                    needs_http = ~df[csv_col].astype(str).str.startswith('http', na=False) & ~is_empty
                    df.loc[needs_http, csv_col] = 'https://' + df.loc[needs_http, csv_col].astype(str)
                    
                    url_regex = r'^https?://(?:[a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,63}(?:/[^\s]*)?$'
                    is_invalid_url = ~df[csv_col].astype(str).str.match(url_regex) & ~is_empty
                    
                    if is_invalid_url.any():
                        df.loc[is_invalid_url, '_errors'] += f"[{csv_col}: Invalid URL format.] "
                        valid_mask &= ~is_invalid_url

            elif sf_type == 'picklist':
                valid_values = field_rules.get('picklistValues', [])
                is_restricted = field_rules.get('restrictedPicklist', True) 
                
                if valid_values and is_restricted:
                    is_invalid_picklist = ~df[csv_col].astype(str).str.lower().str.strip().isin(valid_values) & ~is_empty
                    df.loc[is_invalid_picklist, '_errors'] += f"[{csv_col}: Invalid Picklist Value. This field is restricted.] "
                    valid_mask &= ~is_invalid_picklist

                if field_rules.get('controllerName') and field_rules.get('dependentValues'):
                    controller_sf_name = field_rules.get('controllerName')
                    controller_csv_col = next((m.get('csvField') for m in mappings if m.get('sfField') == controller_sf_name), None)
                    
                    if controller_csv_col and controller_csv_col in df.columns:
                        dep_map = field_rules.get('dependentValues')
                        
                        def is_valid_dependency(row):
                            dep_val = str(row[csv_col]).strip().lower()
                            if pd.isna(row[csv_col]) or dep_val in ['none', 'nan', '', '<na>']: return True
                            ctrl_val = str(row[controller_csv_col]).strip().lower()
                            return dep_val in dep_map.get(ctrl_val, [])
                        
                        is_invalid_dep = ~df.apply(is_valid_dependency, axis=1) & ~is_empty
                        df.loc[is_invalid_dep, '_errors'] += f"[{csv_col}: Invalid dependent picklist value.] "
                        valid_mask &= ~is_invalid_dep

            elif sf_type == 'multipicklist':
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.replace(r'[,|]', ';', regex=True)
                has_junk = df[csv_col].astype(str).str.contains(r'[^a-zA-Z0-9\s;_-]', regex=True) & ~is_empty
                if has_junk.any():
                    df.loc[has_junk, '_errors'] += f"[{csv_col}: Contains invalid special characters.] "
                    valid_mask &= ~has_junk
                
                valid_values = field_rules.get('picklistValues', mapping.get('picklistValues', []))
                if valid_values:
                    def is_valid_multipicklist(val):
                        if pd.isna(val) or str(val).strip() == '' or str(val).lower() == 'none': return True
                        items = [i.strip().lower() for i in str(val).split(';')]
                        return all(item in valid_values for item in items if item)

                    is_invalid_multi = ~df[csv_col].apply(is_valid_multipicklist) & ~is_empty & ~has_junk
                    if is_invalid_multi.any():
                        df.loc[is_invalid_multi, '_errors'] += f"[{csv_col}: Invalid Multi-Select value.] "
                        valid_mask &= ~is_invalid_multi
                
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
                    try: return len(str(int(abs(float(val))))) <= max_int_digits
                    except: return False

                is_invalid_precision = ~numeric_col.apply(check_precision) & ~is_invalid & ~is_empty

                df[csv_col] = df[csv_col].astype(object)
                df.loc[~is_invalid & ~is_empty, csv_col] = numeric_col[~is_invalid & ~is_empty]
                
                df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Number.] "
                valid_mask &= ~is_invalid

                df.loc[is_invalid_precision, '_errors'] += f"[{csv_col}: Limit is {max_int_digits} integer digits.] "
                valid_mask &= ~is_invalid_precision

                if sf_type == 'currency' and is_multi_currency_org and not iso_code_mapped:
                    df.loc[~is_empty, '_errors'] += f"[{csv_col}: Multi-Currency Org Detected. Missing 'CurrencyIsoCode'.] "
                    valid_mask &= is_empty

            elif sf_type in ['date', 'datetime']:
                parsed_dates = pd.to_datetime(df[csv_col], errors='coerce')
                numeric_str = pd.to_numeric(df[csv_col].astype(str).str.strip().str.replace(r'\.0$', '', regex=True), errors='coerce')
                
                is_serial_date = numeric_str.notna() & (numeric_str > 0) & (numeric_str < 3000000) & ~is_empty
                if is_serial_date.any():
                    parsed_dates.update(pd.to_datetime(numeric_str[is_serial_date], unit='D', origin='1899-12-30', errors='coerce'))

                is_invalid = parsed_dates.isna() & ~is_empty

                if sf_type == 'date':
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%d')
                else:
                    df.loc[~is_invalid & ~is_empty, csv_col] = parsed_dates[~is_invalid & ~is_empty].dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')

                df.loc[is_invalid, '_errors'] += f"[{csv_col}: Invalid Date Format.] "
                valid_mask &= ~is_invalid

            elif sf_type in ['id', 'reference']:
                df.loc[~is_empty, csv_col] = df.loc[~is_empty, csv_col].astype(str).str.strip()
                is_invalid_id = ~(df[csv_col].astype(str).str.len().isin([15, 18]) & df[csv_col].astype(str).str.isalnum()) & ~is_empty

                df.loc[is_invalid_id, '_errors'] += f"[{csv_col}: Invalid Salesforce ID.] "
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
                    "rowNumber": row_numbers[invalid_indices[i]] 
                })

        return {
            "stats": {"total": initial_count, "valid": len(valid_df), "invalid": len(invalid_df), "duplicates": duplicates_removed},
            "validRecords": valid_df.to_dict(orient="records"),
            "invalidRecords": invalid_records_output
        }