import httpx
from fastapi import HTTPException

class CrmMetadataService:
    
    # =========================================================
    # SALESFORCE METADATA EXTRACTION ENGINE 
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
                
                # Node.js Logic Applied: Map all objects directly, add keyPrefix, and identify custom/metadata types
                objects = [
                    {
                        "name": obj["name"], 
                        "label": obj["label"],
                        "keyPrefix": obj.get("keyPrefix"),
                        "isCustomMetadata": str(obj["name"]).endswith("__mdt"),
                        "isCustomObject": str(obj["name"]).endswith("__c")
                    }
                    for obj in data.get("sobjects", [])
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
                
                parsed_fields = []
                select_fields_list = []
                
                for f in fields_raw:
                    # Skip compound fields that break SOQL queries
                    if f["type"] in ["address", "location"]:
                        continue

                    # Grab fields for sample records
                    if f.get("createable") or f.get("updateable") or f.get("name") == "Id":
                        select_fields_list.append(f["name"])
                        
                    #  Extract length, custom flag, exact isRequired logic, and referenceTo
                    is_required = (not f.get("nillable", True)) and f.get("createable", False) and (not f.get("defaultedOnCreate", False))
                    
                    parsed_fields.append({
                        "name": f["name"],
                        "label": f["label"],
                        "type": f["type"],
                        "length": f.get("length"),
                        "custom": f.get("custom"),
                        "isRequired": is_required,
                        "referenceTo": f.get("referenceTo") if f.get("referenceTo") else None
                    })

                # 2. Fetch Sample Data
                sample_fields = select_fields_list[:15]
                sample_records = []
                
                if sample_fields:
                    soql = f"SELECT {', '.join(sample_fields)} FROM {object_name} LIMIT 5"
                    query_url = f"{base_url}/services/data/v60.0/query/?q={soql}"
                    
                    query_res = await client.get(query_url, headers=headers)
                    if query_res.status_code == 200:
                        raw_records = query_res.json().get("records", [])
                        for r in raw_records:
                            r.pop("attributes", None)
                            sample_records.append(r)

                return {
                    "headers": sample_fields[:12],
                    "sampleRecords": sample_records,
                    "fields": sorted(parsed_fields, key=lambda x: x["isRequired"], reverse=True)
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
                
                # 1. Identify the correct schema endpoint based on the object
                meta_url = None
                meta_key = None
                singular_name = safe_object_name[:-1] if safe_object_name.endswith('s') else safe_object_name
                
                if safe_object_name in ["tickets", "users", "organizations"]:
                    meta_url = f"{base_url}/{singular_name}_fields.json"
                    meta_key = f"{singular_name}_fields"
                elif safe_object_name not in ["groups", "macros", "triggers", "views"]:
                    # Sunshine Custom Objects Schema
                    meta_url = f"{base_url}/custom_objects/object_types/{safe_object_name}"
                    meta_key = "schema"

                # 2. Fetch and parse the live Metadata Schema
                schema_fields_map = {}
                if meta_url:
                    meta_res = await client.get(meta_url, headers=headers)
                    if meta_res.status_code == 200:
                        data = meta_res.json()
                        
                        # Parse Standard Objects (Tickets, Users, Orgs)
                        if meta_key in ["ticket_fields", "user_fields", "organization_fields"]:
                            for f in data.get(meta_key, []):
                                field_id = f.get("id")
                                # Zendesk custom fields use numeric IDs, standard system fields use strings (e.g. "status")
                                is_custom = isinstance(field_id, int)
                                
                                api_name = f"custom_field_{field_id}" if is_custom else str(field_id)
                                
                                schema_fields_map[api_name] = {
                                    "name": api_name,
                                    "label": f.get("title", api_name),
                                    "type": f.get("type", "string"),
                                    "isRequired": f.get("required", False) or f.get("required_in_portal", False),
                                    "custom": is_custom,
                                    "referenceTo": None
                                }
                                
                        # Parse Sunshine Custom Objects
                        elif meta_key == "schema":
                            schema = data.get("schema", {})
                            properties = schema.get("properties", {})
                            required_fields = schema.get("required", [])
                            
                            for prop_key, prop_val in properties.items():
                                schema_fields_map[prop_key] = {
                                    "name": prop_key,
                                    "label": prop_val.get("title", prop_key.replace("_", " ").title()),
                                    "type": prop_val.get("type", "string"),
                                    "isRequired": prop_key in required_fields,
                                    "custom": True,
                                    "referenceTo": None
                                }

                # 3. Fetch Sample Data (crucial for getting hidden system fields like 'id' and 'created_at')
                data_url = f"{base_url}/{safe_object_name}.json?per_page=5"
                data_res = await client.get(data_url, headers=headers)
                data_res.raise_for_status()
                    
                raw_records = data_res.json().get(safe_object_name, [])
                sample_records = []

                # 4. Flatten data & discover missing system fields
                if len(raw_records) > 0:
                    for rec in raw_records:
                        flat_rec = {}
                        for k, v in rec.items():
                            
                            # Flatten Zendesk's nested 'custom_fields' array into direct keys
                            if k == "custom_fields" and isinstance(v, list):
                                for cf in v:
                                    cf_key = f"custom_field_{cf['id']}"
                                    flat_rec[cf_key] = cf.get("value")
                            
                            # Grab all other standard non-nested fields
                            elif not isinstance(v, (dict, list)): 
                                flat_rec[k] = v
                                
                                # If this data key wasn't in the schema API (e.g., 'id', 'url', 'created_at'), add it manually
                                if k not in schema_fields_map:
                                    field_type = "string"
                                    if isinstance(v, bool): field_type = "boolean"
                                    elif isinstance(v, (int, float)): field_type = "number"
                                    
                                    schema_fields_map[k] = {
                                        "name": k,
                                        "label": k.replace("_", " ").title(),
                                        "type": field_type,
                                        "isRequired": k == "id",
                                        "custom": False,
                                        "referenceTo": None
                                    }
                                
                        sample_records.append(flat_rec)
                
                # 5. Format and Sort Output to match Salesforce structure
                fields_list = list(schema_fields_map.values())
                
                # Sort rules: Required fields go to the top, then sort alphabetically
                fields_list = sorted(fields_list, key=lambda x: (not x["isRequired"], x["name"]))
                
                headers_preview = [f["name"] for f in fields_list[:12]] 
                
            return {
                "headers": headers_preview,
                "sampleRecords": sample_records,
                "fields": fields_list
            }
            
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=e.response.status_code, detail=f"Zendesk data fetch error for '{object_name}': {e.response.text}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Zendesk network connection failed: {str(e)}")