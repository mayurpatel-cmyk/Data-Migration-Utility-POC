import math
import logging

logger = logging.getLogger(__name__)

class PayloadBuilderService:
    @staticmethod
    def build_payload(raw_records, mappings, options, target_crm="salesforce"):
        mappings = PayloadBuilderService._dedupe_target_fields(mappings)

        skip_self_ref = options.get("skipSelfReferencing", False)
        only_self_ref = options.get("onlySelfReferencing", False)
        exclude_refs = options.get("excludeReferencesTo", [])
        only_refs = options.get("onlyReferencesTo", [])
        target_object = options.get("targetObject", "")
        target_ext_id_field = options.get("targetExtIdField", "")
        op_mode = options.get("operationMode", "insert")

        payload = []
        is_patch_mode = only_self_ref or len(only_refs) > 0

        for idx, raw_row in enumerate(raw_records):
            target_record = {}
            has_patch_data = False

            for mapping in mappings:
                # ---  Support BOTH API Mapping and CSV Mapping formats ---
                target_field = mapping.get("targetField") or mapping.get("sfField")
                if not target_field: continue

                source_field = mapping.get("sourceField") or mapping.get("csvField")
                
                # 1. Try fetching by the original CSV Header
                csv_val = raw_row.get(source_field)

                # 2. FALLBACK: If data was already transformed by the Validator
                if csv_val is None and target_field in raw_row:
                    csv_val = raw_row.get(target_field)

                # --- ULTIMATE TYPE ENFORCEMENT & SANITIZER ---
                if csv_val is not None:
                    # Catch Math NaNs
                    if isinstance(csv_val, float) and math.isnan(csv_val):
                        csv_val = None
                    
                    # Catch String "nulls" and trailing ".0"
                    if isinstance(csv_val, str):
                        csv_val = csv_val.strip()
                        if csv_val.lower() in ["nan", "null", "none", "nat", "<na>", "undefined", ""]:
                            csv_val = None
                        elif csv_val.endswith(".0") and csv_val[:-2].isdigit():
                            csv_val = csv_val[:-2]

                # 3. Force exact JSON Types required by the CRM API
                if csv_val is not None:
                    expected_type = mapping.get("type", "string").lower()
                    
                    # Force strings for Phone, Email, Picklists, etc.
                    if expected_type in ["string", "phone", "email", "text", "picklist", "textarea", "reference"]:
                        if isinstance(csv_val, float) and csv_val.is_integer():
                            csv_val = str(int(csv_val))
                        else:
                            csv_val = str(csv_val)
                            
                    # Force numbers (Handle Integer vs Float for Zoho strictness)
                    elif expected_type in ["number", "integer", "double", "currency", "percent", "float"]:
                        try:
                            num_val = float(csv_val)
                            # If it's a perfect whole number (like 400.0) or explicitly an integer, cast to int!
                            if num_val.is_integer() or expected_type == "integer":
                                csv_val = int(num_val)
                            else:
                                csv_val = num_val
                        except (ValueError, TypeError):
                            csv_val = None
                            
                    # Force true booleans for Checkboxes
                    elif expected_type == "boolean":
                        if str(csv_val).lower() in ["true", "1", "yes", "y"]: csv_val = True
                        elif str(csv_val).lower() in ["false", "0", "no", "n"]: csv_val = False
                        else: csv_val = bool(csv_val)

                    elif expected_type in ["date", "datetime"]:
                        try:
                            import pandas as pd
                            parsed_date = pd.to_datetime(csv_val, errors='coerce')
                            if pd.notna(parsed_date):
                                if expected_type == "date":
                                    csv_val = parsed_date.strftime('%Y-%m-%d')
                                else:
                                    csv_val = parsed_date.strftime('%Y-%m-%dT%H:%M:%S.000Z')
                        except Exception:
                            pass

                if is_patch_mode and target_field in ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'created_at', 'updated_at']:
                    continue

                # Prevent empty strings/None from wiping out data (unless it's the external ID)
                if csv_val is None and target_field != target_ext_id_field: 
                    continue

                is_self_ref = mapping.get("type") == "reference" and target_object in (mapping.get("referenceTo") or [])
                refs_other = (mapping.get("referenceTo") or []) if mapping.get("type") == "reference" else []

                is_excluded_cross = any(obj in refs_other for obj in exclude_refs)
                is_only_target_cross = len(only_refs) > 0 and any(obj in refs_other for obj in only_refs)

                if skip_self_ref and is_self_ref: continue
                if only_self_ref and not is_self_ref: continue
                if is_excluded_cross: continue
                if len(only_refs) > 0 and not is_only_target_cross: continue

                # ==========================================
                # CRM-SPECIFIC PAYLOAD FORMATTING
                # ==========================================
                if target_crm == "salesforce":
                    rel_name = mapping.get("relationshipName")
                    if not rel_name and target_field:
                        if target_field.endswith('Id'): rel_name = target_field[:-2]
                        elif target_field.endswith('__c'): rel_name = target_field.replace('__c', '__r')

                    rel_ext_id = mapping.get("relationalExtIdField")
                    
                    if rel_ext_id:
                        if rel_ext_id.lower() == "id":
                            target_record[target_field] = csv_val
                        else:
                            target_record[rel_name] = {rel_ext_id: csv_val}
                            
                        if is_patch_mode: has_patch_data = True
                    else:
                        target_record[target_field] = csv_val
                
                elif target_crm == "zoho":
                    rel_ext_id = mapping.get("relationalExtIdField")
                    
                    #  If rel_ext_id exists, always treat it as a lookup dictionary
                    if rel_ext_id:
                        if rel_ext_id.lower() == "id":
                            target_record[target_field] = csv_val
                        else:
                            # Safely wrap it in the Zoho External ID dictionary
                            target_record[target_field] = {rel_ext_id: csv_val}
                            
                        if is_patch_mode: has_patch_data = True
                    else:
                        target_record[target_field] = csv_val
                        
                    if is_patch_mode and mapping.get("type") == "reference": has_patch_data = True
                
                elif target_crm == "zendesk":
                    zd_standard_objects = {"tickets", "users", "organizations", "groups", "macros", "triggers", "views"}
                    zd_obj_lower = (target_object or "").strip().lower()
                    zd_is_standard = zd_obj_lower in zd_standard_objects or f"{zd_obj_lower}s" in zd_standard_objects

                    if target_ext_id_field and target_field == target_ext_id_field:
                        target_record["external_id"] = csv_val
                        if is_patch_mode: has_patch_data = True
                    elif target_field.startswith("custom_field_"):
                        if "custom_fields" not in target_record:
                            target_record["custom_fields"] = []
                        
                        cf_id = int(target_field.replace("custom_field_", ""))
                        target_record["custom_fields"].append({"id": cf_id, "value": csv_val})
                    elif not zd_is_standard and target_field not in ("name", "external_id", "id"):
                        if "custom_object_fields" not in target_record:
                            target_record["custom_object_fields"] = {}
                        target_record["custom_object_fields"][target_field] = csv_val
                    else:
                        target_record[target_field] = csv_val
                        
                    if is_patch_mode and mapping.get("type") == "reference": has_patch_data = True

                elif target_crm == "hubspot":
                    if mapping.get("type") == "reference":
                        pass 
                    else:
                        target_record[target_field] = csv_val
                    
                    if is_patch_mode and mapping.get("type") == "reference": 
                        has_patch_data = True

            # Ensure External ID is present for Upserts
            if target_ext_id_field and target_ext_id_field not in target_record:
                target_record[target_ext_id_field] = None

            # Handle Delete mode payloads
            if op_mode == "delete":
                if "Id" in target_record: target_record = {"Id": target_record["Id"]}
                elif "id" in target_record: target_record = {"id": target_record["id"]}
                else: target_record = {}

            if target_record:
                if not is_patch_mode or (is_patch_mode and has_patch_data):
                    payload.append({"originalIndex": idx, "targetRecord": target_record})

        return payload

    @staticmethod
    def _dedupe_target_fields(mappings):
        """
        Two mapping rows pointed at the same target field silently overwrite each
        other inside the per-record loop below -- only the LAST one in list order
        ever actually reaches the target CRM, and the earlier source column's data
        is dropped with no error anywhere. The mapping UI now blocks this at
        selection time, but this is a backstop for mapping arrays assembled
        outside that flow (recovered sessions, direct API calls, older saved
        mappings). Keeps the LAST occurrence per target field, mirroring the
        "last row wins" convention used by dedupe_by_unique_key below.
        """
        seen: dict = {}
        no_target: list = []

        for m in mappings:
            target_field = m.get("targetField") or m.get("sfField")
            if not target_field:
                no_target.append(m)
                continue
            seen[target_field] = m

        dropped = len([m for m in mappings if (m.get("targetField") or m.get("sfField"))]) - len(seen)
        if dropped > 0:
            logger.warning(
                "[PAYLOAD BUILDER] %d duplicate target-field mapping(s) collapsed to their last occurrence.",
                dropped
            )

        return list(seen.values()) + no_target

    @staticmethod
    def dedupe_by_unique_key(payload, source_records, key_field):
        """
        Guards UPDATE/UPSERT batches against sending two rows with the same
        unique-key value in a single request. Bulk/batch upsert APIs (Salesforce
        Bulk API, HubSpot batch upsert, Zoho bulk upsert, Zendesk
        create_or_update_many / custom object jobs) don't guarantee deterministic
        behavior when two rows in the *same* call match the same key -- results
        range from a hard API rejection to one row silently overwriting the
        other with no error.

        Keeps the LAST occurrence of each key value (mirrors "last row in the
        source file wins") and reports every earlier occurrence as skipped so
        it shows up in the audit trail instead of disappearing.

        Returns (deduped_payload, skipped_records). skipped_records are ready to
        append directly to all_skipped_data.
        """
        if not key_field:
            return payload, []

        last_index_for_key = {}
        for item in payload:
            key_val = item["targetRecord"].get(key_field)
            if key_val in (None, ""):
                continue
            last_index_for_key[key_val] = item["originalIndex"]

        winning_indices = set(last_index_for_key.values())

        deduped_payload = []
        skipped_records = []

        for item in payload:
            key_val = item["targetRecord"].get(key_field)
            if key_val in (None, "") or item["originalIndex"] in winning_indices:
                deduped_payload.append(item)
            else:
                orig_record = dict(source_records[item["originalIndex"]])
                orig_record["Target_SkipReason"] = (
                    f"[{key_field}] Duplicate value '{key_val}' appeared more than once in this "
                    f"batch. Only the last occurrence was sent; this row was skipped to avoid an "
                    f"ambiguous match."
                )
                skipped_records.append(orig_record)

        return deduped_payload, skipped_records