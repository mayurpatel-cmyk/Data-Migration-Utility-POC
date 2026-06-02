import httpx
from fastapi import HTTPException
import os

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
        
        # 1. Standard Objects
        objects = [
            {"name": "tickets", "label": "Tickets"},
            {"name": "users", "label": "Users"},
            {"name": "organizations", "label": "Organizations"},
            {"name": "groups", "label": "Groups"},
            {"name": "macros", "label": "Macros"},
            {"name": "triggers", "label": "Triggers"},
            {"name": "views", "label": "Views"}
        ]
        
        if not zd_token or not subdomain:
            print("Notice: Missing Zendesk credentials. Returning standard objects only.")
            return sorted(objects, key=lambda x: x["label"])
        
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        
        # 2. Modern Native Custom Objects (Admin Center)
        url = f"https://{subdomain}.zendesk.com/api/v2/custom_objects"
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    for custom_obj in res.json().get("custom_objects", []):
                        objects.append({
                            "name": custom_obj["key"], 
                            "label": custom_obj.get("title", custom_obj["key"])
                        })
        except Exception as e:
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
                schema_fields_map = {}
                sample_records = []
                
                # Check if it's a standard Zendesk object or a Native Custom Object
                standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
                is_standard = safe_object_name in standard_objects
                
                if is_standard:
                    # ==========================================
                    # STANDARD ZENDESK OBJECTS
                    # ==========================================
                    singular_name = safe_object_name[:-1] if safe_object_name.endswith('s') else safe_object_name
                    
                    # 1. Fetch Schema
                    if safe_object_name in ["tickets", "users", "organizations"]:
                        meta_url = f"{base_url}/{singular_name}_fields.json"
                        meta_res = await client.get(meta_url, headers=headers)
                        
                        if meta_res.status_code == 200:
                            for f in meta_res.json().get(f"{singular_name}_fields", []):
                                field_id = f.get("id")
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
                                
                    # 2. Fetch Sample Data
                    data_url = f"{base_url}/{safe_object_name}.json?per_page=5"
                    data_res = await client.get(data_url, headers=headers)
                    data_res.raise_for_status()
                    
                    raw_records = data_res.json().get(safe_object_name, [])
                    for rec in raw_records:
                        flat_rec = {}
                        for k, v in rec.items():
                            if k == "custom_fields" and isinstance(v, list):
                                for cf in v:
                                    flat_rec[f"custom_field_{cf['id']}"] = cf.get("value")
                            elif not isinstance(v, (dict, list)): 
                                flat_rec[k] = v
                                # Discover missing system fields dynamically
                                if k not in schema_fields_map:
                                    field_type = "boolean" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "string"
                                    schema_fields_map[k] = {
                                        "name": k, "label": k.replace("_", " ").title(), "type": field_type,
                                        "isRequired": k == "id", "custom": False, "referenceTo": None
                                    }
                        sample_records.append(flat_rec)

                else:
                    # ==========================================
                    # NATIVE CUSTOM OBJECTS (Admin Center)
                    # ==========================================
                    # 1. Fetch Schema using the modern endpoint
                    meta_url = f"{base_url}/custom_objects/{safe_object_name}/fields"
                    meta_res = await client.get(meta_url, headers=headers)
                    
                    if meta_res.status_code == 200:
                        for f in meta_res.json().get("custom_object_fields", []):
                            api_name = f.get("key")
                            schema_fields_map[api_name] = {
                                "name": api_name,
                                "label": f.get("title", api_name),
                                "type": f.get("type", "string"),
                                "isRequired": False,
                                "custom": True,
                                "referenceTo": None
                            }
                            
                    # 2. Fetch Sample Data using the modern records endpoint
                    data_url = f"{base_url}/custom_objects/{safe_object_name}/records?per_page=5"
                    data_res = await client.get(data_url, headers=headers)
                    data_res.raise_for_status()
                    
                    raw_records = data_res.json().get("custom_object_records", [])
                    for rec in raw_records:
                        # Extract standard native system fields
                        flat_rec = {
                            "id": rec.get("id"), 
                            "name": rec.get("name"), 
                            "created_at": rec.get("created_at"), 
                            "updated_at": rec.get("updated_at")
                        }
                        
                        # Flatten custom_object_fields payload
                        c_fields = rec.get("custom_object_fields", {})
                        for k, v in c_fields.items():
                            flat_rec[k] = v
                            
                        # Discover missing system fields dynamically
                        for k, v in flat_rec.items():
                            if k not in schema_fields_map:
                                field_type = "boolean" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "string"
                                schema_fields_map[k] = {
                                    "name": k, "label": k.replace("_", " ").title(), "type": field_type,
                                    "isRequired": k == "id", "custom": False, "referenceTo": None
                                }
                        sample_records.append(flat_rec)

                # Format and Sort Output to match Salesforce structure
                fields_list = list(schema_fields_map.values())
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
    
    # =========================================================
    # HUBSPOT METADATA ENGINE WITH AUTOMATED RETRY/REFRESH
    # =========================================================
    @staticmethod
    async def refresh_hubspot_token(refresh_token: str) -> str:
        """Exchanges a long-lived refresh token for a fresh access token seamlessly."""
        client_id = os.getenv("HS_CLIENT_ID", "").strip()
        client_secret = os.getenv("HS_CLIENT_SECRET", "").strip()
        
        async with httpx.AsyncClient(verify=False) as client:
            res = await client.post(
                "https://api.hubapi.com/oauth/v1/token",
                data={
                    "grant_type": "refresh_token",
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "refresh_token": refresh_token
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"}
            )
            if res.status_code != 200:
                raise HTTPException(status_code=401, detail="HubSpot session expired. Please reconnect your account.")
            
            return res.json().get("access_token")

    @staticmethod
    async def fetch_hubspot_objects(access_token: str, refresh_token: str = None):
        """Queries the schema catalog to load target entities dynamically."""
        objects = [
            {"name": "contacts", "label": "Contacts"},
            {"name": "companies", "label": "Companies"},
            {"name": "deals", "label": "Deals"},
            {"name": "tickets", "label": "Tickets"}
        ]
        
        headers = {"Authorization": f"Bearer {access_token}"}
        new_token = None
        
        try:
            async with httpx.AsyncClient(verify=False, timeout=15.0) as client:
                res = await client.get("https://api.hubapi.com/crm/v3/schemas", headers=headers)
                
                # 🔄 Access token expired? Catch 401 and auto-refresh!
                if res.status_code == 401 and refresh_token:
                    new_token = await CrmMetadataService.refresh_hubspot_token(refresh_token)
                    headers["Authorization"] = f"Bearer {new_token}"
                    res = await client.get("https://api.hubapi.com/crm/v3/schemas", headers=headers)

                if res.status_code == 200:
                    for schema in res.json().get("results", []):
                        if schema.get("name") not in ["contacts", "companies", "deals", "tickets"]:
                            objects.append({
                                "name": schema["name"],
                                "label": f"{schema['labels']['plural']} (Custom)"
                            })
                return sorted(objects, key=lambda x: x["label"]), new_token
        except Exception:
            return sorted(objects, key=lambda x: x["label"]), None

    @staticmethod
    async def fetch_hubspot_fields(access_token: str, refresh_token: str, object_name: str):
        """Dynamically pulls fields from the v3 properties directory mapping."""
        headers = {"Authorization": f"Bearer {access_token}"}
        url = f"https://api.hubapi.com/crm/v3/properties/{object_name.lower()}"
        new_token = None
        
        async with httpx.AsyncClient(verify=False, timeout=20.0) as client:
            res = await client.get(url, headers=headers)
            
            if res.status_code == 401 and refresh_token:
                new_token = await CrmMetadataService.refresh_hubspot_token(refresh_token)
                headers["Authorization"] = f"Bearer {new_token}"
                res = await client.get(url, headers=headers)
                
            if res.status_code != 200:
                raise HTTPException(status_code=res.status_code, detail=f"HubSpot properties query failed: {res.text}")
                
            fields_raw = res.json().get("results", [])
            parsed_fields = []
            select_fields_list = []
            
            type_map = {
                "string": "string", "number": "number", "date": "date", "datetime": "date",
                "booleancheckbox": "boolean", "enumeration": "picklist"
            }
            
            for f in fields_raw:
                if f.get("hidden") or not f.get("name"): continue
                
                api_name = f["name"]
                select_fields_list.append(api_name)
                
                is_req = api_name in ["email", "lastname", "name", "hs_object_id", "dealname"]
                
                parsed_fields.append({
                    "name": api_name,
                    "label": f.get("label") or api_name,
                    "type": type_map.get(f.get("type"), "string"),
                    "required": is_req
                })
                
            return {
                "headers": select_fields_list[:12],
                "sampleRecords": [], 
                "fields": sorted(parsed_fields, key=lambda x: x["required"], reverse=True)
            }, new_token