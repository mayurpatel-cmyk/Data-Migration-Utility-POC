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
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                
                data = response.json()
                objects = [
                    {"name": obj["name"], "label": obj["label"]}
                    for obj in data.get("sobjects", [])
                    if obj.get("queryable") and obj.get("replicateable")
                ]
                return sorted(objects, key=lambda x: x["label"])
                
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Salesforce rejected object request: {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Network error connecting to Salesforce: {str(e)}")

    @staticmethod
    async def fetch_salesforce_fields(sf_token: str, instance_url: str, object_name: str):
        if not sf_token or not instance_url:
            raise HTTPException(status_code=401, detail="Missing Salesforce session credentials.")
            
        headers = {"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"}
        base_url = instance_url.rstrip('/')
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
                # 1. Fetch Schema
                describe_url = f"{base_url}/services/data/v60.0/sobjects/{object_name}/describe"
                desc_res = await client.get(describe_url, headers=headers)
                desc_res.raise_for_status()
                
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

                # 2. Fetch Sample Data
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
                
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Salesforce schema error: {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Network error connecting to Salesforce: {str(e)}")


   # =========================================================
    # ZENDESK METADATA EXTRACTION ENGINE
    # =========================================================
    @staticmethod
    async def fetch_zendesk_objects(zd_token: str = None, subdomain: str = None):
        
        # 1. Standard Objects (Always available, even if credentials are still loading)
        objects = [
            {"name": "tickets", "label": "Tickets"},
            {"name": "users", "label": "Users"},
            {"name": "organizations", "label": "Organizations"},
            {"name": "groups", "label": "Groups"},
            {"name": "macros", "label": "Macros"},
            {"name": "triggers", "label": "Triggers"},
            {"name": "views", "label": "Views"}
        ]
        
        # If tokens are missing, don't crash! Just return the standard objects.
        if not zd_token or not subdomain:
            print("Notice: Missing Zendesk credentials. Returning standard objects only.")
            return sorted(objects, key=lambda x: x["label"])
        
        # 2. DYNAMICALLY fetch Zendesk Custom Objects (Sunshine API)
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        url = f"https://{subdomain}.zendesk.com/api/v2/custom_objects/object_types"
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
                res = await client.get(url, headers=headers)
                res.raise_for_status() 
                
                for custom_obj in res.json().get("object_types", []):
                    objects.append({
                        "name": custom_obj["key"], 
                        "label": custom_obj.get("title", custom_obj["key"])
                    })
        except httpx.HTTPStatusError as e:
            # If 403/404, the user's tier might not support Custom Objects. 
            print(f"Notice: Custom Objects not available or unauthorized for this Zendesk tier (HTTP {e.response.status_code})")
        except httpx.RequestError as e:
            print(f"Notice: Network error fetching Zendesk custom objects: {str(e)}")
            
        return sorted(objects, key=lambda x: x["label"])

    @staticmethod
    async def fetch_zendesk_fields(zd_token: str, subdomain: str, object_name: str):
        if not zd_token or not subdomain:
            raise HTTPException(status_code=401, detail="Missing active Zendesk session parameters.")
            
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        base_url = f"https://{subdomain}.zendesk.com/api/v2"
        safe_object_name = object_name.lower()
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
                
                # 1. Fetch live records FIRST to dynamically read JSON keys
                data_url = f"{base_url}/{safe_object_name}.json?per_page=5"
                data_res = await client.get(data_url, headers=headers)
                data_res.raise_for_status()
                    
                raw_records = data_res.json().get(safe_object_name, [])
                
                # 2. Fetch custom field metadata for UI mapping (if applicable)
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
                            elif not isinstance(v, (dict, list)): 
                                flat_rec[k] = v
                                
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
                headers_preview = [f["name"] for f in fields_list[:12]] 
                
            return {
                "headers": headers_preview,
                "sampleRecords": sample_records,
                "fields": sorted(fields_list, key=lambda x: x["name"])
            }
            
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Zendesk data fetch error for '{object_name}': {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Zendesk network connection failed: {str(e)}")



    # =========================================================
    # ZOHO CRM METADATA EXTRACTION ENGINE
    # =========================================================
    @staticmethod
    async def fetch_zoho_objects(zoho_token: str, api_domain: str):
        if not zoho_token or not api_domain:
            raise HTTPException(status_code=401, detail="Missing Zoho session credentials.")

        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        # Assuming api_domain is structured like "https://www.zohoapis.com"
        url = f"{api_domain.rstrip('/')}/crm/v3/settings/modules"

        try:
            async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()

                data = response.json()
                objects = [
                    {"name": mod["api_name"], "label": mod["module_name"]}
                    for mod in data.get("modules", [])
                    if mod.get("api_supported")
                ]
                return sorted(objects, key=lambda x: x["label"])

        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Zoho rejected module request: {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Network error connecting to Zoho: {str(e)}")

    @staticmethod
    async def fetch_zoho_fields(zoho_token: str, api_domain: str, module_name: str):
        if not zoho_token or not api_domain:
            raise HTTPException(status_code=401, detail="Missing Zoho session credentials.")

        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        base_url = f"{api_domain.rstrip('/')}/crm/v3"

        try:
            async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
                # 1. Fetch Field Metadata Schema
                fields_url = f"{base_url}/settings/fields?module={module_name}"
                fields_res = await client.get(fields_url, headers=headers)
                fields_res.raise_for_status()

                fields_raw = fields_res.json().get("fields", [])

                type_mapping = {
                    "text": "string", "textarea": "string", "email": "string", "phone": "string", "website": "string",
                    "integer": "number", "double": "number", "currency": "number", "percent": "number",
                    "date": "date", "datetime": "date",
                    "boolean": "boolean",
                    "picklist": "picklist", "multiselectpicklist": "picklist",
                    "lookup": "reference", "ownerlookup": "reference"
                }

                parsed_fields = []
                select_fields_list = []

                for f in fields_raw:
                    if not f.get("api_name"):
                        continue

                    select_fields_list.append(f["api_name"])
                    parsed_fields.append({
                        "name": f["api_name"],
                        "label": f["field_label"],
                        "type": type_mapping.get(f["data_type"], "string"),
                        "required": f.get("system_mandatory", False) or f.get("required", False)
                    })

                # 2. Fetch Sample Data
                records_url = f"{base_url}/{module_name}?page=1&per_page=5"
                records_res = await client.get(records_url, headers=headers)
                sample_records = []

                if records_res.status_code == 200:
                    raw_records = records_res.json().get("data", [])
                    for r in raw_records:
                        flat_rec = {}
                        for k, v in r.items():
                            # Flatten Zoho's nested dictionary structures for Lookups/Owners
                            if isinstance(v, dict) and "id" in v:
                                flat_rec[k] = v.get("name", v["id"]) 
                            else:
                                flat_rec[k] = v
                        sample_records.append(flat_rec)

                return {
                    "headers": select_fields_list[:12],
                    "sampleRecords": sample_records,
                    "fields": sorted(parsed_fields, key=lambda x: x["required"], reverse=True)
                }

        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Zoho schema error: {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Network error connecting to Zoho: {str(e)}")