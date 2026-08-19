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
        
        async with httpx.AsyncClient(timeout=30.0) as client:
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

        async with httpx.AsyncClient(timeout=30.0) as client:
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
        
        #  Zoho strictly rejects COQL queries over 200 records.
        if limit > 200:
            limit = 200
            
        async with httpx.AsyncClient(timeout=30.0) as client:
            if query:
                coql_query = query.strip()
                if coql_query.lower().startswith("select "):
                    if " * " in coql_query.lower() or coql_query.lower().startswith("select *"):
                        safe_fields = headers_list[:40] if headers_list else ["id"]
                        fields_str = ",".join(safe_fields)
                        coql_query = re.sub(r'(?i)select\s+\*\s+from', f'select {fields_str} from', coql_query)
                        
                    #  Inject WHERE clause properly so it doesn't break ORDER BY
                    if " where " not in coql_query.lower():
                        if " order by " in coql_query.lower():
                            coql_query = re.sub(r'(?i)(\border\s+by\b)', r'where id is not null \1', coql_query, count=1)
                        else:
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
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            properties = headers_list[:50] if headers_list else ["hs_object_id", "createdate", "lastmodifieddate"]
            url = f"{domain}/crm/v3/objects/{obj_name}/search"
            
            payload = {
                "limit": limit,
                "properties": properties
            }
            
            if query and query.strip():
                try:
                    query_dict = json.loads(query)
                    if "filterGroups" in query_dict:
                        payload["filterGroups"] = query_dict["filterGroups"]
                    if "sorts" in query_dict:
                        payload["sorts"] = query_dict["sorts"]
                except json.JSONDecodeError:
                    raise HTTPException(status_code=400, detail="Invalid JSON payload provided for HubSpot Search filter.")
            
            res = await client.post(url, headers=headers, json=payload)
            
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"HubSpot rejected search query: {res.text}")
                
            raw_results = res.json().get("results", [])
            
            flattened_records = []
            for r in raw_results:
                flat_rec = {"id": r.get("id")}
                props = r.get("properties", {})
                if props:
                    for k, v in props.items():
                        flat_rec[k] = v
                flattened_records.append(flat_rec)
                
            return {"records": flattened_records}

    # =========================================================
    # OBJECT RECORD COUNT (per-CRM totals for object selector / preview)
    # =========================================================
    @staticmethod
    async def get_object_count(creds: dict, obj_name: str, crm_type: str, query: str = "") -> int:
        crm = crm_type.lower()

        if crm == "salesforce":
            return await CrmQueryService._salesforce_count(creds, obj_name, query)
        elif crm == "zoho":
            return await CrmQueryService._zoho_count(creds, obj_name)
        elif crm == "zendesk":
            return await CrmQueryService._zendesk_count(creds, obj_name)
        elif crm == "hubspot":
            return await CrmQueryService._hubspot_count(creds, obj_name, query)
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM Engine")

    @staticmethod
    async def _salesforce_count(creds: dict, obj_name: str, query: str) -> int:
        sf_token = creds.get("access_token")
        sf_instance = (creds.get("instance_url") or "").rstrip('/')

        where_clause = ""
        if query and query.strip():
            stripped = query.strip()
            if stripped.lower().startswith("select "):
                # Reuse the WHERE clause from the user's SOQL, drop SELECT list / LIMIT
                match = re.search(r'(?i)\bwhere\b(.*?)(\blimit\b.*)?$', stripped)
                if match and match.group(1).strip():
                    where_clause = f" WHERE {match.group(1).strip()}"
            else:
                where_clause = f" WHERE {stripped}"

        soql = f"SELECT COUNT() FROM {obj_name}{where_clause}"
        url = f"{sf_instance}/services/data/v60.0/query?q={urllib.parse.quote(soql)}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(url, headers={"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"})
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Salesforce rejected count query: {res.text}")
            return res.json().get("totalSize", 0)

    @staticmethod
    async def _zoho_count(creds: dict, obj_name: str) -> int:
        zoho_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"):
            domain = f"https://{domain}"

        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        url = f"{domain}/crm/v6/{obj_name}/actions/count"

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(url, headers=headers)
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Zoho rejected count request: {res.text}")
            return res.json().get("count", 0)

    @staticmethod
    async def _zendesk_count(creds: dict, obj_name: str) -> int:
        zd_token = creds.get("access_token")
        zd_subdomain = creds.get("subdomain")
        safe_obj = obj_name.lower()
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}

        standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
        is_standard = safe_obj in standard_objects or f"{safe_obj}s" in standard_objects

        async with httpx.AsyncClient(timeout=30.0) as client:
            if is_standard:
                if not safe_obj.endswith("s"):
                    safe_obj = f"{safe_obj}s"
                url = f"https://{zd_subdomain}.zendesk.com/api/v2/{safe_obj}/count.json"
            else:
                url = f"https://{zd_subdomain}.zendesk.com/api/v2/custom_objects/{safe_obj}/records/count"

            res = await client.get(url, headers=headers)
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Zendesk rejected count request: {res.text}")
            return res.json().get("count", {}).get("value", 0)

    @staticmethod
    async def _hubspot_count(creds: dict, obj_name: str, query: str) -> int:
        hs_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')

        headers = {"Authorization": f"Bearer {hs_token}", "Content-Type": "application/json"}
        url = f"{domain}/crm/v3/objects/{obj_name}/search"

        payload: dict = {"limit": 1, "properties": []}
        if query and query.strip():
            try:
                query_dict = json.loads(query)
                if "filterGroups" in query_dict:
                    payload["filterGroups"] = query_dict["filterGroups"]
            except json.JSONDecodeError:
                pass  # fall back to unfiltered total

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(url, headers=headers, json=payload)
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"HubSpot rejected count request: {res.text}")
            # HubSpot search caps `total` at 10,000 due to API limits on deep pagination.
            return res.json().get("total", 0)