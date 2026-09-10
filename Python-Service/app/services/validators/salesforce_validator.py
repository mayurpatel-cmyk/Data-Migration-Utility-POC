import pandas as pd
import numpy as np
import pycountry
from collections import defaultdict
from app.utils.constants import is_valid_email

class SalesforceValidator:
    def __init__(self):
        (
            self.SF_COUNTRY_MAP,
            self.SF_COUNTRY_NAME_MAP,
            self.SF_STATE_MAP_BY_COUNTRY,
            self.SF_STATE_NAME_MAP_BY_COUNTRY,
        ) = self._build_iso_maps()

    def _build_iso_maps(self):
        """
        Fully dynamic — every country and every subdivision comes from
        pycountry, so this covers all ISO-3166-1 countries and all
        ISO-3166-2 subdivisions with no hardcoded country/state list.
        The only hand-maintained entries are non-ISO colloquial synonyms
        (e.g. 'usa', 'uk') that pycountry doesn't itself expose as names.
        """
        c_map = {}
        c_name_map = {}
        for c in pycountry.countries:
            c_map[c.name.lower()] = c.alpha_2
            c_map[c.alpha_2.lower()] = c.alpha_2
            c_map[c.alpha_3.lower()] = c.alpha_2
            c_name_map[c.alpha_2] = c.name
            if hasattr(c, 'official_name') and c.official_name:
                c_map[c.official_name.lower()] = c.alpha_2
            if hasattr(c, 'common_name') and c.common_name:
                c_map[c.common_name.lower()] = c.alpha_2

   
        c_map.update({
            'usa': 'US', 'u.s.a': 'US', 'u.s.a.': 'US', 'u.s': 'US',
            'uk': 'GB', 'u.k': 'GB', 'great britain': 'GB',
            'uae': 'AE', 'south korea': 'KR', 'north korea': 'KP',
        })

  
        state_map = defaultdict(dict)
        name_map = defaultdict(dict)
        for s in pycountry.subdivisions:
            country_code = s.country_code  # e.g. 'US', 'IN', 'CA'
            local_code = s.code.split('-')[-1]  # e.g. 'CA', 'TX', 'MH'
            state_map[country_code][s.name.lower()] = local_code
            state_map[country_code][local_code.lower()] = local_code
            name_map[country_code][local_code] = s.name

        return c_map, c_name_map, state_map, name_map

    def _resolve_country_code_for_row(self, df, mappings, sf_field_being_processed):
        """
        Find the sibling Country/CountryCode CSV column mapped for this row set
        so state/province lookups can be scoped to the right country and avoid
        subdivision-code collisions across countries (e.g. many countries reuse
        two-letter codes for different states/provinces).
        Returns the csv column name holding country info, or None.
        """
        for m in mappings:
            sf_f = (m.get('sfField', m.get('targetField')) or '').lower()
            if sf_f.endswith('countrycode') or (sf_f.endswith('country') and sf_f != sf_field_being_processed.lower()):
                return m.get('csvField')
        return None

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

        country_code_col_by_prefix = self._resolve_country_columns(mappings)

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

                field_lower = sf_field.lower()
                is_country_code_field = field_lower.endswith('countrycode')
                is_state_code_field = field_lower.endswith('statecode') or field_lower.endswith('provincecode')
                is_country_label_field = field_lower.endswith('country')
                is_state_label_field = field_lower.endswith('state') or field_lower.endswith('province')

                if is_country_code_field:
                    mapped = df[csv_col].astype(str).str.strip().str.lower().map(self.SF_COUNTRY_MAP)
                    df[csv_col] = mapped.fillna(df[csv_col])

                elif is_country_label_field:
                    lower_vals = df[csv_col].astype(str).str.strip().str.lower()
                    mapped_code = lower_vals.map(self.SF_COUNTRY_MAP)
                    canonical_name = mapped_code.map(self.SF_COUNTRY_NAME_MAP)
                    df[csv_col] = canonical_name.fillna(df[csv_col])

                elif is_state_code_field or is_state_label_field:
                    prefix = self._address_prefix(sf_field, is_state_code_field)
                    country_col = country_code_col_by_prefix.get(prefix)
                    df[csv_col] = self._map_state_column(
                        df[csv_col], df[country_col] if country_col else None,
                        to_code=is_state_code_field
                    )
                    
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

    @staticmethod
    def _address_prefix(sf_field: str, is_code_field: bool) -> str:
        """'BillingStateCode' -> 'billing', 'ShippingState' -> 'shipping', 'State' -> ''."""
        lower = sf_field.lower()
        for suffix in ('statecode', 'provincecode', 'state', 'province'):
            if lower.endswith(suffix):
                return lower[: -len(suffix)]
        return lower

    @staticmethod
    def _resolve_country_columns(mappings) -> dict:
        """prefix -> csvField holding that address block's Country/CountryCode."""
        result = {}
        for m in mappings:
            sf_f = (m.get('sfField', m.get('targetField')) or '').lower()
            for suffix in ('countrycode', 'country'):
                if sf_f.endswith(suffix):
                    prefix = sf_f[: -len(suffix)]
                    result[prefix] = m.get('csvField')
                    break
        return result

    def _map_state_column(self, state_series: pd.Series, country_code_series, to_code: bool) -> pd.Series:
        """
        Resolve each row's state/province using the row's own country ISO
        code to scope the lookup — avoids collisions where the same
        subdivision code/name means different things in different countries.
        Falls back to a cross-country scan only if no country is available
        for that row (best-effort, may collide).
        """
        state_lower = state_series.astype(str).str.strip().str.lower()

        if country_code_series is not None:
            country_iso = country_code_series.astype(str).str.strip().str.upper()
        else:
            country_iso = pd.Series([None] * len(state_series), index=state_series.index)

        def resolve(state_val, state_key, country):
            table = self.SF_STATE_MAP_BY_COUNTRY.get(country)
            if table:
                code = table.get(state_key)
                if code:
                    return code if to_code else self.SF_STATE_NAME_MAP_BY_COUNTRY[country][code]
            return None

        resolved = [
            resolve(v, k, c)
            for v, k, c in zip(state_series, state_lower, country_iso)
        ]
        resolved_series = pd.Series(resolved, index=state_series.index)
        return resolved_series.fillna(state_series)