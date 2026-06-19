import httpx
import re
import json
from fastapi import HTTPException
import urllib.parse

class CrmQueryService:
    
    @staticmethod
    async def execute_salesforce_query(creds: dict, obj_name: str, query: str, headers_list: list, limit: int):
        sf_token = creds.get("access_token")
        sf_instance = (creds.get("instance_url") or "").rstrip('/')
        
        if query.lower().startswith("select "):
            soql = query
            
            
            if " * " in soql.lower() or soql.lower().startswith("select *"):
                # Grab top 40 fields to prevent massive URL sizes
                safe_fields = headers_list[:40] if headers_list else ["Id", "Name"]
                fields_str = ", ".join(safe_fields)
                soql = re.sub(r'(?i)select\s+\*\s+from', f'SELECT {fields_str} FROM', soql)
            
            
            if "limit " not in soql.lower():
                soql += f" LIMIT {limit}"
        else:
            fields_str = ", ".join(headers_list) if headers_list else "Id, Name"
            where_clause = f" WHERE {query}" if query else ""
            soql = f"SELECT {fields_str} FROM {obj_name}{where_clause} LIMIT {limit}"
        
        safe_soql = urllib.parse.quote(soql)
        url = f"{sf_instance}/services/data/v60.0/query?q={safe_soql}"
        
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            res = await client.get(url, headers={"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"})
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Salesforce rejected query: {res.text}")
            
            records = res.json().get("records", [])
            for r in records:
                r.pop("attributes", None)
            return {"records": records}


    @staticmethod
    async def execute_zendesk_query(creds: dict, obj_name: str, query: str, limit: int):
        zd_token = creds.get("access_token")
        zd_subdomain = creds.get("subdomain")
        safe_obj = obj_name.lower()
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
        
        standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
        is_standard = safe_obj in standard_objects or f"{safe_obj}s" in standard_objects

        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            if is_standard:
                if safe_obj.endswith("s"): safe_obj = safe_obj[:-1]
                clean_query = re.sub(r'(?i)^(select\s+.*\s+from\s+[a-zA-Z0-9_]+\s*(where\s+)?)', '', query).strip()
                full_query = f"{clean_query} type:{safe_obj}" if clean_query else f"type:{safe_obj}"
                
                url = f"https://{zd_subdomain}.zendesk.com/api/v2/search.json?query={urllib.parse.quote(full_query)}&per_page={limit}"
                res = await client.get(url, headers=headers)
                
                if res.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"Zendesk Error: {res.text}")
                return {"records": res.json().get("results", [])}
                
            else:
                # Custom Objects Logic
                if query.strip():
                    try:
                        json_payload = json.loads(query)
                    except json.JSONDecodeError:
                        raise HTTPException(status_code=400, detail="Invalid JSON payload in Zendesk query.")
                    
                    url = f"https://{zd_subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records/search?page[size]={limit}"
                    res = await client.post(url, headers=headers, json=json_payload)
                else:
                    url = f"https://{zd_subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records?page[size]={limit}"
                    res = await client.get(url, headers=headers)

                if res.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"Zendesk Custom Object Error: {res.text}")
                
                # Flatten the payload
                flattened_records = []
                for rec in res.json().get("custom_object_records", []):
                    flat_rec = {}
                    for k, v in rec.items():
                        if k == "custom_fields" and isinstance(v, list):
                            for cf in v: flat_rec[f"custom_field_{cf['id']}"] = cf.get("value")
                        elif k == "custom_object_fields" and isinstance(v, dict):
                            for cf_key, cf_val in v.items(): flat_rec[cf_key] = cf_val
                        elif not isinstance(v, (dict, list)): 
                            flat_rec[k] = v
                    flattened_records.append(flat_rec)
                return {"records": flattened_records}


    @staticmethod
    async def execute_zoho_query(creds: dict, obj_name: str, query: str, headers_list: list, limit: int):
        zoho_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"): domain = f"https://{domain}"
        
        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            if query:
                coql_query = query.strip()
                if coql_query.lower().startswith("select "):
                    if " * " in coql_query.lower() or coql_query.lower().startswith("select *"):
                        safe_fields = headers_list[:40] if headers_list else ["id"]
                        fields_str = ",".join(safe_fields)
                        coql_query = re.sub(r'(?i)select\s+\*\s+from', f'select {fields_str} from', coql_query)
                        
                    # Auto-inject ID if limit is required by Zoho
                    if " where " not in coql_query.lower():
                        coql_query += " where id is not null"
                    if " limit " not in coql_query.lower():
                        coql_query += f" limit {limit}"
                else:
                    safe_fields = headers_list[:40] if headers_list else ["id"]
                    coql_query = f"select {','.join(safe_fields)} from {obj_name} where {coql_query} limit {limit}"

                res = await client.post(f"{domain}/crm/v6/coql", headers=headers, json={"select_query": coql_query})
            else:
                safe_fields = headers_list[:40] if headers_list else ["id"]
                res = await client.get(f"{domain}/crm/v6/{obj_name}?page=1&per_page={limit}&fields={','.join(safe_fields)}", headers=headers)

            if res.status_code not in [200, 204]:
                raise HTTPException(status_code=400, detail=f"Zoho rejected query: {res.text}")
            
            raw_records = [] if res.status_code == 204 else res.json().get("data", [])
            
            # Flatten Zoho Lookups
            sample_records = []
            for r in raw_records:
                flat_rec = {}
                for k, v in r.items():
                    if isinstance(v, dict) and "id" in v:
                        flat_rec[k] = v.get("name", v["id"]) 
                    else:
                        flat_rec[k] = v
                sample_records.append(flat_rec)
                
            return {"records": sample_records}

    @staticmethod
    async def execute_hubspot_query(creds: dict, obj_name: str, query: str, headers_list: list, limit: int):
        import json
        hs_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        
        headers = {
            "Authorization": f"Bearer {hs_token}",
            "Content-Type": "application/json"
        }
        
        async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
            # 1. Define properties to return
            # HubSpot requires explicit properties. If headers_list is empty, we must fetch schema first or request standard fields.
            # For safety, we request top 50 fields if headers_list exists, otherwise basic fields.
            properties = headers_list[:50] if headers_list else ["hs_object_id", "createdate", "lastmodifieddate"]
            
            # 2. Build the request payload
            # The Search API requires a POST request
            url = f"{domain}/crm/v3/objects/{obj_name}/search"
            
            payload = {
                "limit": limit,
                "properties": properties
            }
            
            # 3. Handle Filtering
            if query and query.strip():
                try:
                    # Expect the frontend to pass a valid HubSpot Search JSON payload for the query
                    # Example frontend query: {"filterGroups":[{"filters":[{"propertyName":"email","operator":"EQ","value":"test@test.com"}]}]}
                    query_dict = json.loads(query)
                    
                    # Merge the query dict with our base payload
                    if "filterGroups" in query_dict:
                        payload["filterGroups"] = query_dict["filterGroups"]
                    if "sorts" in query_dict:
                        payload["sorts"] = query_dict["sorts"]
                        
                except json.JSONDecodeError:
                    raise HTTPException(status_code=400, detail="Invalid JSON payload provided for HubSpot Search filter.")
            
            # 4. Execute POST request
            res = await client.post(url, headers=headers, json=payload)
            
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"HubSpot rejected search query: {res.text}")
                
            raw_results = res.json().get("results", [])
            
            # 5. Flatten the records for the frontend
            flattened_records = []
            for r in raw_results:
                flat_rec = {"id": r.get("id")}
                props = r.get("properties", {})
                if props:
                    for k, v in props.items():
                        flat_rec[k] = v
                flattened_records.append(flat_rec)
                
            return {"records": flattened_records}