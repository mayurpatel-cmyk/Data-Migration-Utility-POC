import httpx
import re
import json
from fastapi import HTTPException
import urllib.parse

from app.services.time_filter_service import (
    merge_time_clause,
    build_salesforce_time_clause,
    build_zoho_time_clause,
    TimeFilterError,
)

class CrmQueryService:

    @staticmethod
    async def execute_salesforce_query(creds: dict, obj_name: str, query: str, headers_list: list, limit: int, time_filter: dict = None):
        sf_token = creds.get("access_token")
        sf_instance = (creds.get("instance_url") or "").rstrip('/')
        
        try:
            time_clause = build_salesforce_time_clause(time_filter)
        except TimeFilterError as e:
            raise HTTPException(status_code=400, detail=str(e))

        if query.lower().startswith("select "):
            soql = query
            if time_clause:
                soql = merge_time_clause(soql, time_clause, where_kw="WHERE", and_kw="AND")
                    
            if " * " in soql.lower() or soql.lower().startswith("select *"):
                safe_fields = headers_list[:40] if headers_list else ["Id", "Name"]
                fields_str = ", ".join(safe_fields)
                soql = re.sub(r'(?i)select\s+\*\s+from', f'SELECT {fields_str} FROM', soql)
            
            if "limit " not in soql.lower():
                soql += f" LIMIT {limit}"
        else:
            fields_str = ", ".join(headers_list) if headers_list else "Id, Name"
            
            where_parts = []
            if query: where_parts.append(f"({query})")
            if time_clause: where_parts.append(time_clause)
            where_combined = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
            
            soql = f"SELECT {fields_str} FROM {obj_name}{where_combined} LIMIT {limit}"
        
        safe_soql = urllib.parse.quote(soql)
        url = f"{sf_instance}/services/data/v60.0/query?q={safe_soql}"
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(url, headers={"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"})
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Salesforce rejected query: {res.text}")
            
            records = res.json().get("records", [])
            for r in records:
                r.pop("attributes", None)
            return {"records": records, "queryUsed": soql}

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
                explicit_fields = None
                if query.strip():
                    try:
                        json_payload = json.loads(query)
                    except json.JSONDecodeError:
                        raise HTTPException(status_code=400, detail="Invalid JSON payload in Zendesk query.")

                    raw_fields = json_payload.pop("fields", None)
                    if isinstance(raw_fields, list) and raw_fields:
                        cleaned = {str(f).strip() for f in raw_fields if str(f).strip()}
                        if cleaned:
                            explicit_fields = cleaned

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
                    if explicit_fields is not None:
                        always_keep = {"id", "name", "external_id"}
                        flat_rec = {k: v for k, v in flat_rec.items() if k in explicit_fields or k in always_keep}
                    flattened_records.append(flat_rec)
                return {"records": flattened_records}

    @staticmethod
    async def execute_zoho_query(creds: dict, obj_name: str, query: str, headers_list: list, limit: int, time_filter: dict = None):
        zoho_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"): domain = f"https://{domain}"

        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}
        if limit > 200: limit = 200

        try:
            time_clause = build_zoho_time_clause(time_filter)
        except TimeFilterError as e:
            raise HTTPException(status_code=400, detail=str(e))

        async with httpx.AsyncClient(timeout=30.0) as client:
            coql_query = query.strip() if query else ""
            used_coql = None

            if coql_query or time_clause:
                if coql_query.lower().startswith("select "):
                    if time_clause:
                        coql_query = merge_time_clause(coql_query, time_clause, where_kw="where", and_kw="and")
                    if "limit " not in coql_query.lower():
                        coql_query += f" limit {limit}"
                else:
                    where_parts = []
                    if coql_query:
                        where_parts.append(f"({coql_query})")
                    if time_clause:
                        where_parts.append(time_clause)
                    combined_where = " and ".join(where_parts)
                    safe_fields = headers_list[:40] if headers_list else ["id"]
                    coql_query = f"select {','.join(safe_fields)} from {obj_name} where {combined_where} limit {limit}"

                used_coql = coql_query
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

            return {"records": sample_records, "queryUsed": used_coql}

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

                    explicit_properties = query_dict.get("properties")
                    if isinstance(explicit_properties, list) and explicit_properties:
                        cleaned = [str(p).strip() for p in explicit_properties if str(p).strip()]
                        if cleaned:
                            payload["properties"] = cleaned[:50]
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

    @staticmethod
    async def get_object_count(creds: dict, obj_name: str, crm_type: str, query: str = "", time_filter: dict = None) -> int:
        crm = crm_type.lower()

        if crm == "salesforce":
            return await CrmQueryService._salesforce_count(creds, obj_name, query, time_filter)
        elif crm == "zoho":
            return await CrmQueryService._zoho_count(creds, obj_name, query, time_filter)
        elif crm == "zendesk":
            return await CrmQueryService._zendesk_count(creds, obj_name, query)
        elif crm == "hubspot":
            return await CrmQueryService._hubspot_count(creds, obj_name, query)
        else:
            raise HTTPException(status_code=400, detail="Unsupported CRM Engine")

    @staticmethod
    async def _salesforce_count(creds: dict, obj_name: str, query: str, time_filter: dict = None) -> int:
        sf_token = creds.get("access_token")
        sf_instance = (creds.get("instance_url") or "").rstrip('/')

        try:
            time_clause = build_salesforce_time_clause(time_filter)
        except TimeFilterError as e:
            raise HTTPException(status_code=400, detail=str(e))

        stripped = (query or "").strip()

        if stripped.lower().startswith("select "):
            count_soql = re.sub(r'(?i)^select\s+.*?\s+from\s+', 'SELECT COUNT() FROM ', stripped, count=1)
            count_soql = re.sub(r'(?i)\blimit\b\s+\d+', '', count_soql).strip()
            if time_clause:
                count_soql = merge_time_clause(count_soql, time_clause, where_kw="WHERE", and_kw="AND")
        else:
            where_parts = []
            if stripped:
                where_parts.append(f"({stripped})")
            if time_clause:
                where_parts.append(time_clause)
            where_combined = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""
            count_soql = f"SELECT COUNT() FROM {obj_name}{where_combined}"

        url = f"{sf_instance}/services/data/v60.0/query?q={urllib.parse.quote(count_soql)}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(url, headers={"Authorization": f"Bearer {sf_token}", "Content-Type": "application/json"})
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Salesforce rejected count query: {res.text}")
            return res.json().get("totalSize", 0)

    @staticmethod
    async def _zoho_count(creds: dict, obj_name: str, query: str = "", time_filter: dict = None) -> int:
        zoho_token = creds.get("access_token")
        domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip('/')
        if not domain.startswith("http"):
            domain = f"https://{domain}"

        headers = {"Authorization": f"Zoho-oauthtoken {zoho_token}"}

        try:
            time_clause = build_zoho_time_clause(time_filter)
        except TimeFilterError as e:
            raise HTTPException(status_code=400, detail=str(e))

        stripped = (query or "").strip()

        # No filter at all -> the cheap unfiltered module total.
        if not stripped and not time_clause:
            url = f"{domain}/crm/v6/{obj_name}/actions/count"
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.get(url, headers=headers)
                if res.status_code != 200:
                    raise HTTPException(status_code=400, detail=f"Zoho rejected count request: {res.text}")
                return res.json().get("count", 0)

        # Otherwise run a filtered COQL aggregate count so it matches the
        # preview's record set exactly instead of the unfiltered module total.
        if stripped.lower().startswith("select "):
            coql_query = re.sub(r'(?i)^select\s+.*?\s+from\s+', 'select COUNT(id) from ', stripped, count=1)
            coql_query = re.sub(r'(?i)\blimit\b\s+\d+', '', coql_query).strip()
            if time_clause:
                coql_query = merge_time_clause(coql_query, time_clause, where_kw="where", and_kw="and")
        else:
            where_parts = []
            if stripped:
                where_parts.append(f"({stripped})")
            if time_clause:
                where_parts.append(time_clause)
            coql_query = f"select COUNT(id) from {obj_name} where {' and '.join(where_parts)}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(f"{domain}/crm/v6/coql", headers=headers, json={"select_query": coql_query})
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Zoho rejected count query: {res.text}")
            rows = res.json().get("data", [])
            if not rows:
                return 0
            for value in rows[0].values():
                if isinstance(value, (int, float)):
                    return int(value)
            return 0

    @staticmethod
    async def _zendesk_count(creds: dict, obj_name: str, query: str = "") -> int:
        zd_token = creds.get("access_token")
        zd_subdomain = creds.get("subdomain")
        safe_obj = obj_name.lower()
        headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}

        standard_objects = ["tickets", "users", "organizations", "groups", "macros", "triggers", "views"]
        is_standard = safe_obj in standard_objects or f"{safe_obj}s" in standard_objects

        async with httpx.AsyncClient(timeout=30.0) as client:
            if is_standard:
                singular = safe_obj[:-1] if safe_obj.endswith("s") else safe_obj
                clean_query = re.sub(r'(?i)^(select\s+.*\s+from\s+[a-zA-Z0-9_]+\s*(where\s+)?)', '', (query or "")).strip()

                if clean_query:
                    full_query = f"{clean_query} type:{singular}"
                    url = f"https://{zd_subdomain}.zendesk.com/api/v2/search.json?query={urllib.parse.quote(full_query)}&per_page=1"
                    res = await client.get(url, headers=headers)
                    if res.status_code != 200:
                        raise HTTPException(status_code=400, detail=f"Zendesk rejected count request: {res.text}")
                    return res.json().get("count", 0)

                plural = safe_obj if safe_obj.endswith("s") else f"{safe_obj}s"
                url = f"https://{zd_subdomain}.zendesk.com/api/v2/{plural}/count.json"
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
                pass  

        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.post(url, headers=headers, json=payload)
            if res.status_code != 200:
                raise HTTPException(status_code=400, detail=f"HubSpot rejected count request: {res.text}")
            return res.json().get("total", 0)