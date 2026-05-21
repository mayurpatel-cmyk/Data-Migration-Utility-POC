import httpx
from fastapi import HTTPException

class CrmMetadataService:
    
    # =========================================================
    # SALESFORCE METADATA EXTRACTION ENGINE (Fully Dynamic)
    # =========================================================
    @staticmethod
    async def fetch_salesforce_objects(sf_token: str, instance_url: str):
        if not sf_token or not instance_url:
            raise HTTPException(status_code=401, detail="Missing Salesforce session credentials.")
        
        headers = {"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"}
        url = f"{instance_url.rstrip('/')}/services/data/v60.0/sobjects"
        
        async with httpx.AsyncClient(verify=False) as client:
            response = await client.get(url, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Failed to pull Salesforce object tree.")
            
            data = response.json()
            objects = [
                {"name": obj["name"], "label": obj["label"]}
                for obj in data.get("sobjects", [])
                if obj.get("queryable") and obj.get("replicateable")
            ]
            return sorted(objects, key=lambda x: x["label"])

    @staticmethod
    async def fetch_salesforce_fields(sf_token: str, instance_url: str, object_name: str):
        headers = {"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"}
        base_url = instance_url.rstrip('/')
        
        async with httpx.AsyncClient(verify=False) as client:
            describe_url = f"{base_url}/services/data/v60.0/sobjects/{object_name}/describe"
            desc_res = await client.get(describe_url, headers=headers)
            if desc_res.status_code != 200:
                raise HTTPException(status_code=desc_res.status_code, detail=f"Salesforce schema describe error for {object_name}")
            
            fields_raw = desc_res.json().get("fields", [])
            
            type_mapping = {
                "string": "string", "textarea": "string", "phone": "string", "email": "string", "url": "string",
                "double": "number", "int": "number", "currency": "number", "percent": "number",
                "date": "date", "datetime": "date",
                "boolean": "boolean",
                "picklist": "picklist", "multipicklist": "picklist",
                "reference": "reference"
            }
            
            parsed_fields = []
            select_fields_list = []
            
            for f in fields_raw:
                if f["type"] in ["address", "location"]:
                    continue

                if f.get("createable") or f.get("updateable") or f.get("name") == "Id":
                    select_fields_list.append(f["name"])
                    parsed_fields.append({
                        "name": f["name"],
                        "label": f["label"],
                        "type": type_mapping.get(f["type"], "string"),
                        "required": not f["nillable"] if f["name"] != "Id" else False
                    })

            sample_fields = select_fields_list[:15]
            soql = f"SELECT {', '.join(sample_fields)} FROM {object_name} LIMIT 5"
            query_url = f"{base_url}/services/data/v60.0/query/?q={soql}"
            
            query_res = await client.get(query_url, headers=headers)
            sample_records = []
            if query_res.status_code == 200:
                raw_records = query_res.json().get("records", [])
                for r in raw_records:
                    r.pop("attributes", None)
                    sample_records.append(r)

            return {
                "headers": sample_fields[:12],
                "sampleRecords": sample_records,
                "fields": sorted(parsed_fields, key=lambda x: x["required"], reverse=True)
            }


    # =========================================================
    # ZENDESK METADATA EXTRACTION ENGINE (Fully Dynamic)
    # =========================================================
    @staticmethod
    async def fetch_zendesk_objects(zd_token: str = None, subdomain: str = None):
        # Zendesk core entities (Requires direct URL access by API design)
        objects = [
            {"name": "tickets", "label": "Tickets"},
            {"name": "users", "label": "Users"},
            {"name": "organizations", "label": "Organizations"}
        ]
        
        # DYNAMICALLY fetch Zendesk Custom Objects (Sunshine API)
        if zd_token and subdomain:
            headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
            url = f"https://{subdomain}.zendesk.com/api/v2/custom_objects/object_types"
            
            async with httpx.AsyncClient(verify=False) as client:
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    for custom_obj in res.json().get("object_types", []):
                        objects.append({
                            "name": custom_obj["key"], 
                            "label": custom_obj.get("title", custom_obj["key"])
                        })
                        
        return sorted(objects, key=lambda x: x["label"])

    @staticmethod
    async def fetch_zendesk_fields(zd_token: str, subdomain: str, object_name: str):
        if not zd_token or not subdomain:
            raise HTTPException(status_code=401, detail="Missing active Zendesk session parameters.")
            
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        base_url = f"https://{subdomain}.zendesk.com/api/v2"
        safe_object_name = object_name.lower()
        
        async with httpx.AsyncClient(verify=False) as client:
            
            # 1. Fetch live records FIRST to dynamically read the JSON keys (No Static Dictionaries)
            data_url = f"{base_url}/{safe_object_name}.json?per_page=5"
            data_res = await client.get(data_url, headers=headers)
            
            if data_res.status_code != 200:
                raise HTTPException(status_code=data_res.status_code, detail=f"Failed to fetch data for {safe_object_name}")
                
            raw_records = data_res.json().get(safe_object_name, [])
            
            # 2. Fetch custom field metadata to get human-readable names for UI mapping
            singular_name = safe_object_name[:-1] if safe_object_name.endswith('s') else safe_object_name
            meta_url = f"{base_url}/{singular_name}_fields.json"
            meta_res = await client.get(meta_url, headers=headers)
            
            meta_dict = {}
            if meta_res.status_code == 200:
                for f in meta_res.json().get(f"{singular_name}_fields", []):
                    meta_dict[str(f["id"])] = {
                        "label": f.get("title", f"Custom Field {f['id']}"),
                        "type": f.get("type", "string")
                    }

            sample_records = []
            dynamic_fields_map = {}

            # 3. Build schema dynamically from the API payload structure
            if len(raw_records) > 0:
                for rec in raw_records:
                    flat_rec = {}
                    for k, v in rec.items():
                        
                        # Handle Zendesk's nested custom_fields dynamically
                        if k == "custom_fields" and isinstance(v, list):
                            for cf in v:
                                cf_id = str(cf['id'])
                                cf_key = f"custom_field_{cf_id}"
                                flat_rec[cf_key] = cf.get("value")
                                
                                meta = meta_dict.get(cf_id, {})
                                dynamic_fields_map[cf_key] = {
                                    "name": cf_key,
                                    "label": meta.get("label", f"Custom Field {cf_id}"),
                                    "type": "string",
                                    "required": False
                                }
                                
                        # Handle standard fields dynamically by inspecting data types
                        elif not isinstance(v, (dict, list)): 
                            flat_rec[k] = v
                            
                            # Guess field type based on payload
                            field_type = "string"
                            if isinstance(v, bool): field_type = "boolean"
                            elif isinstance(v, (int, float)): field_type = "number"
                            
                            dynamic_fields_map[k] = {
                                "name": k,
                                "label": k.replace("_", " ").title(),
                                "type": field_type,
                                "required": k in ["id", "email", "name"]
                            }
                            
                    sample_records.append(flat_rec)
            
            fields_list = list(dynamic_fields_map.values())
            headers_preview = [f["name"] for f in fields_list[:12]] # Max 12 columns for UI cleanliness
            
        return {
            "headers": headers_preview,
            "sampleRecords": sample_records,
            "fields": sorted(fields_list, key=lambda x: x["name"])
        }