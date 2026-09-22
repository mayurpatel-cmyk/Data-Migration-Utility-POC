import urllib.parse
import re
import asyncio
import json
from app.services.crm_service import CrmService
from app.services.time_filter_service import build_hubspot_time_filters, TimeFilterError

def chunk_dataset(data: list, chunk_size: int = 100):
    for i in range(0, len(data), chunk_size):
        yield data[i:i + chunk_size]


def _merge_hubspot_time_filters(filter_groups, time_filters: list) -> list:
    """ANDs time_filters into every existing filterGroup (HubSpot ORs across
    groups, ANDs within one), or creates a single group if none existed.
    Mirrors CrmQueryService._merge_hubspot_time_filters so live preview and
    actual extraction apply the identical date range."""
    if not filter_groups:
        return [{"filters": list(time_filters)}]
    return [
        {**group, "filters": list(group.get("filters", [])) + time_filters}
        for group in filter_groups
    ]


class HubspotMigrator:

    async def extract(self, client, creds, obj_name, query, mappings, send_log, time_filter=None):
        token = creds.get("access_token")
        user_id = creds.get("user_id")
        domain = (creds.get("api_domain") or "https://api.hubapi.com").rstrip('/')
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        safe_obj = obj_name.lower()
        source_records = []

        properties = ["hs_object_id"]
        for mapping in mappings:
            source_field = mapping.get("sourceField") or mapping.get("csvField")
            if source_field and source_field not in properties:
                properties.append(source_field)

        try:
            time_filters = build_hubspot_time_filters(time_filter)
        except TimeFilterError as e:
            await send_log(f"[{obj_name}] Invalid migration filter: {e}")
            raise

        try:
            url = f"{domain}/crm/v3/objects/{safe_obj}/search"
            payload = {
                "limit": 100,
                "properties": properties[:100]
            }

            if query and query.strip():
                try:
                    query_dict = json.loads(query)
                    if "filterGroups" in query_dict: payload["filterGroups"] = query_dict["filterGroups"]
                    if "sorts" in query_dict: payload["sorts"] = query_dict["sorts"]
                except json.JSONDecodeError:
                    await send_log(f" [HubSpot Extraction] Invalid query format. Ignoring.")

            if time_filters:
                payload["filterGroups"] = _merge_hubspot_time_filters(payload.get("filterGroups"), time_filters)

            effective_query = json.dumps(
                {k: v for k, v in payload.items() if k != "after"},
                sort_keys=True
            )

            while True:
                while True:
                    res = await client.post(url, headers=headers, json=payload)

                    if res.status_code == 401:
                        await send_log(f" HubSpot token expired. Silently refreshing...")
                        token = await CrmService.refresh_crm_token(user_id, "hubspot", "source")
                        headers["Authorization"] = f"Bearer {token}"
                        continue

                    if res.status_code == 429:
                        retry_after = int(res.headers.get("Retry-After", 10))
                        await send_log(f" [HubSpot Rate Limit] Pausing extraction for {retry_after}s...")
                        await asyncio.sleep(retry_after)
                        continue

                    break

                res.raise_for_status()
                data = res.json()
                records = data.get("results", [])

                if not records: break

                for rec in records:
                    flat_rec = {"id": rec.get("id")}
                    props = rec.get("properties", {})
                    if props:
                        for k, v in props.items():
                            if isinstance(v, dict):
                                flat_rec[k] = str(v)
                            elif isinstance(v, list):
                                flat_rec[k] = ";".join([str(i) for i in v])
                            else:
                                flat_rec[k] = v
                    source_records.append(flat_rec)

                if len(source_records) % 1000 == 0:
                    await send_log(f"[{obj_name}] Extracted {len(source_records)} records...")

                paging = data.get("paging", {}).get("next", {})
                if "after" in paging:
                    payload["after"] = paging["after"]
                else:
                    break

            await send_log(f"[{obj_name}] Extraction Complete! Total: {len(source_records)}")
            return source_records, effective_query

        except Exception as e:
            await send_log(f"[{obj_name}] Extract Failed: {str(e)}")
            raise e