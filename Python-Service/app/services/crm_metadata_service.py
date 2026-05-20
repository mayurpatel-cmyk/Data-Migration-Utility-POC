# app/services/crm_metadata_service.py
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
        
        async with httpx.AsyncClient() as client:
            response = await client.get(url, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Failed to pull Salesforce object tree.")
            
            data = response.json()
            # Filter to user-accessible, queryable database entities (Accounts, Contacts, Custom Objects, etc.)
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
        
        async with httpx.AsyncClient() as client:
            # 1. Fetch Schema Descriptions (Describe API)
            describe_url = f"{base_url}/services/data/v60.0/sobjects/{object_name}/describe"
            desc_res = await client.get(describe_url, headers=headers)
            if desc_res.status_code != 200:
                raise HTTPException(status_code=desc_res.status_code, detail=f"Salesforce schema describe error for {object_name}")
            
            fields_raw = desc_res.json().get("fields", [])
            
            # Map Salesforce data types directly to the Angular Frontend model schema contracts
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
                if f.get("createable") or f.get("updateable") or f.get("name") == "Id":
                    select_fields_list.append(f["name"])
                    parsed_fields.append({
                        "name": f["name"],
                        "label": f["label"],
                        "type": type_mapping.get(f["type"], "string"),
                        "required": not f["nillable"] if f["name"] != "Id" else False
                    })

            # 2. Extract Sample Records Live (SOQL execution)
            # Limit fields to avoid hitting massive query length payload boundaries
            sample_fields = select_fields_list[:15] 
            soql = f"SELECT {', '.join(sample_fields)} FROM {object_name} LIMIT 5"
            query_url = f"{base_url}/services/data/v60.0/query/?q={soql}"
            
            query_res = await client.get(query_url, headers=headers)
            sample_records = []
            if query_res.status_code == 200:
                raw_records = query_res.json().get("records", [])
                # Strip out Salesforce metadata attributes tracking references
                for r in raw_records:
                    r.pop("attributes", None)
                    sample_records.append(r)

            return {
                "headers": sample_fields,
                "sampleRecords": sample_records,
                "fields": sorted(parsed_fields, key=lambda x: x["required"], reverse=True)
            }


    # =========================================================
    # ZENDESK METADATA EXTRACTION ENGINE
    # =========================================================
    @staticmethod
    async def fetch_zendesk_objects():
        # Zendesk handles data through static native endpoints rather than generic open data models
        return [
            {"name": "tickets", "label": "Tickets / Support Cases"},
            {"name": "users", "label": "Users (Customers & Agents)"},
            {"name": "organizations", "label": "Organizations / Companies"}
        ]

    @staticmethod
    async def fetch_zendesk_fields(zd_token: str, subdomain: str, object_name: str):
        if not zd_token or not subdomain:
            raise HTTPException(status_code=401, detail="Missing active Zendesk session parameters.")
            
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        base_url = f"https://{subdomain}.zendesk.com/api/v2"
        
        # Hardcoded dictionary definitions for standard structural system fields
        standard_schemas = {
            "tickets": [
                {"name": "id", "label": "Ticket ID", "type": "number", "required": False},
                {"name": "subject", "label": "Subject Text", "type": "string", "required": True},
                {"name": "description", "label": "Initial Description", "type": "string", "required": True},
                {"name": "status", "label": "Status", "type": "picklist", "required": False},
                {"name": "priority", "label": "Priority Level", "type": "picklist", "required": False},
                {"name": "type", "label": "Ticket Type", "type": "picklist", "required": False},
                {"name": "requester_id", "label": "Requester (User ID)", "type": "reference", "required": True},
                {"name": "organization_id", "label": "Organization ID", "type": "reference", "required": False}
            ],
            "users": [
                {"name": "id", "label": "User ID", "type": "number", "required": False},
                {"name": "name", "label": "Full Name", "type": "string", "required": True},
                {"name": "email", "label": "Email Address", "type": "string", "required": True},
                {"name": "role", "label": "System Role", "type": "picklist", "required": True},
                {"name": "phone", "label": "Phone Number", "type": "string", "required": False},
                {"name": "organization_id", "label": "Organization ID", "type": "reference", "required": False}
            ],
            "organizations": [
                {"name": "id", "label": "Organization ID", "type": "number", "required": False},
                {"name": "name", "label": "Organization Name", "type": "string", "required": True},
                {"name": "domain_names", "label": "Whitelisted Email Domains", "type": "string", "required": False},
                {"name": "details", "label": "Internal Details / Notes", "type": "string", "required": False}
            ]
        }

        fields = standard_schemas.get(object_name.lower(), [])
        
        async with httpx.AsyncClient() as client:
            # Fetch Custom Fields if the user selects Tickets or Users to safely merge custom configurations
            if object_name.lower() == "tickets":
                custom_url = f"{base_url}/ticket_fields.json"
                res = await client.get(custom_url, headers=headers)
                if res.status_code == 200:
                    for cf in res.json().get("ticket_fields", []):
                        if cf.get("active"):
                            # Translate custom type structures cleanly
                            c_type = "string"
                            if cf["type"] in ["integer", "decimal"]: c_type = "number"
                            elif cf["type"] == "checkbox": c_type = "boolean"
                            elif cf["type"] == "date": c_type = "date"
                            elif cf["type"] in ["tagger", "dropdown"]: c_type = "picklist"
                            
                            fields.append({
                                "name": f"custom_field_{cf['id']}",
                                "label": cf["title"],
                                "type": c_type,
                                "required": cf.get("required_in_portal", False)
                            })

            # Fetch Real Sample Live Records for UI Previews
            data_url = f"{base_url}/{object_name}.json?per_page=5"
            data_res = await client.get(data_url, headers=headers)
            sample_records = []
            if data_res.status_code == 200:
                sample_records = data_res.json().get(object_name, [])

            headers_preview = [f["name"] for f in fields]
            
            return {
                "headers": headers_preview,
                "sampleRecords": sample_records,
                "fields": fields
            }