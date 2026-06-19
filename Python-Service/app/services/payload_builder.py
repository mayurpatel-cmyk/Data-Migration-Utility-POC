class PayloadBuilderService:
    @staticmethod
    def build_payload(raw_records, mappings, options, target_crm="salesforce"):
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
                target_field = mapping.get("targetField")
                if not target_field: continue

                csv_val = raw_row.get(mapping.get("sourceField"))

                if is_patch_mode and target_field in ['CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'created_at', 'updated_at']:
                    continue

                # Prevent empty strings from wiping out data (unless it's the external ID)
                if (csv_val is None or str(csv_val).strip() == "") and target_field != target_ext_id_field: 
                    continue

                is_self_ref = mapping.get("type") == "reference" and target_object in mapping.get("referenceTo", [])
                refs_other = mapping.get("referenceTo", []) if mapping.get("type") == "reference" else []

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
                    
                    # --- SALESFORCE FIX: Handle V1 Bulk Relationships ---
                    if mapping.get("type") == "reference" and rel_ext_id:
                        if rel_ext_id.lower() == "id":
                            # Native ID mapping (e.g., AccountId = "001...")
                            target_record[target_field] = csv_val
                        else:
                            # External ID mapping requires nested JSON for Bulk API V1
                            target_record[rel_name] = {rel_ext_id: csv_val}
                            
                        if is_patch_mode: has_patch_data = True
                    else:
                        target_record[target_field] = csv_val
                
                elif target_crm == "zoho":
                    target_record[target_field] = csv_val
                    if is_patch_mode and mapping.get("type") == "reference": has_patch_data = True
                
                elif target_crm == "zendesk":
                    # --- ZENDESK FIX: Group custom fields into the required array ---
                    if target_field.startswith("custom_field_"):
                        if "custom_fields" not in target_record:
                            target_record["custom_fields"] = []
                        
                        # Extract just the numeric ID from the string
                        cf_id = int(target_field.replace("custom_field_", ""))
                        target_record["custom_fields"].append({"id": cf_id, "value": csv_val})
                    else:
                        target_record[target_field] = csv_val
                        
                    if is_patch_mode and mapping.get("type") == "reference": has_patch_data = True

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