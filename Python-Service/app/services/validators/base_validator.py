import pandas as pd
import json

class BaseValidator:
    def validate(self, records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "") -> dict:
        if not records:
            return {"stats": {"total": 0, "valid": 0, "invalid": 0, "duplicates": 0}, "validRecords": [], "invalidRecords": []}

        df = pd.DataFrame(records)
        initial_count = len(df)
        df['_errors'] = ""
        valid_mask = pd.Series(True, index=df.index)

        is_duplicate = df.duplicated(keep='first') 
        duplicates_removed = int(is_duplicate.sum())
        if duplicates_removed > 0:
            df.loc[is_duplicate, '_errors'] += "[Row: Duplicate Record found in CSV.] "
            valid_mask &= ~is_duplicate

        for mapping in mappings:
            csv_col = mapping.get('csvField')
            target_field = mapping.get('targetField', mapping.get('sfField')) # Fallback for old mappings
            if not target_field or csv_col not in df.columns or mapping.get('skipValidation'):
                continue
                
            field_rules = target_rules.get(target_field, {})
            str_col = df[csv_col].astype(str).str.strip().str.lower()
            is_empty = df[csv_col].isna() | (str_col == '') | (str_col == '<na>') | (str_col == 'nat')

            if field_rules.get('required', mapping.get('isRequired', False)):
                df.loc[is_empty, '_errors'] += f"[{csv_col}: Field is required but empty.] "
                valid_mask &= ~is_empty

        valid_df = df[valid_mask].drop(columns=['_errors']).replace({np.nan: None})
        invalid_df = df[~valid_mask].replace({np.nan: None})
        
        invalid_records_output = []
        if not invalid_df.empty:
            invalid_dicts = invalid_df.drop(columns=['_errors']).to_dict(orient="records")
            errors_list = invalid_df['_errors'].tolist()
            for i, rec in enumerate(invalid_dicts):
                invalid_records_output.append({"originalRow": rec, "errors": str(errors_list[i]).strip()})

        return {
            "stats": {"total": initial_count, "valid": len(valid_df), "invalid": len(invalid_df), "duplicates": duplicates_removed},
            "validRecords": valid_df.to_dict(orient="records"),
            "invalidRecords": invalid_records_output
        }