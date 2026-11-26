"""
Zendesk field metadata for the mapping UI / validators / FLS guard.

Improvements over the old inline implementation:
  * system fields come from a static catalog, so an empty account still exposes every field and read-only
    fields are really flagged createable/updateable = False (the guard used to see True for everything);
  * ticket SYSTEM fields (subject, status, ...) are no longer mis-named custom_field_<id>;
  * user / organization custom fields use user_field_<key> / organization_field_<key> (they are NOT custom_fields);
  * picklistValues (dropdown options, status/priority/type/role enums), referenceTo (requester -> users, ...),
    a 'context' tag and normalized types are provided, so the validator and reference remap have data to work with.
Raises httpx.HTTPStatusError / httpx.RequestError exactly like the old code (CrmMetadataService wraps them).
"""
from typing import Any, Dict, List, Optional

import httpx

from app.services.zendesk_common import (
    CUSTOM_OBJECT_SYSTEM_FIELDS, FIELD_TYPE_MAP, SYSTEM_FIELDS, SYSTEM_TICKET_FIELD_TYPES, api_base, classify_object,
    flatten_record, lookup_target, singular,
)

_CONTEXT = {"tickets": "ticket", "users": "user", "organizations": "organization", "groups": "group"}
_EXTERNAL_ID_NAMES = {"id", "external_id"}


def _entry(name, label, type_, *, required=False, custom=False, ref=None, writable=True, options=None,
           context="", external_id=False, unique=False) -> Dict[str, Any]:
    return {
        "name": name, "label": label, "type": type_, "isRequired": required, "custom": custom,
        "referenceTo": ref, "externalId": external_id, "unique": unique,
        "createable": writable, "updateable": writable and name != "id",
        "picklistValues": options or [], "context": context,
    }


def _options(f: Dict[str, Any]) -> List[str]:
    return [str(o.get("value")) for o in (f.get("custom_field_options") or []) if o.get("value") not in (None, "")]


async def _get_all(client, url, headers, key) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    while url:
        res = await client.get(url, headers=headers)
        if res.status_code in (401, 403):
            res.raise_for_status()
        if res.status_code != 200:
            return out          # e.g. no permission on the field list: fall back to the catalog
        data = res.json()
        out.extend(data.get(key) or [])
        url = (data.get("links") or {}).get("next") if (data.get("meta") or {}).get("has_more") else None
    return out


async def fetch_fields(zd_token: str, subdomain: str, object_name: str) -> Dict[str, Any]:
    base = api_base(subdomain)
    headers = {"Authorization": f"Bearer {zd_token}", "Content-Type": "application/json"}
    kind, name = classify_object(object_name)
    fields: Dict[str, Dict[str, Any]] = {}
    samples: List[Dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=20.0) as client:
        if kind == "standard":
            ctx = _CONTEXT.get(name, name)
            for fname, label, type_, required, writable, ref, options in SYSTEM_FIELDS[name]:
                fields[fname] = _entry(fname, label, type_, required=required, ref=ref, writable=writable,
                                       options=options, context=ctx,
                                       external_id=fname in _EXTERNAL_ID_NAMES or (fname == "email" and name == "users"),
                                       unique=fname == "external_id")

            if name == "tickets":
                for f in await _get_all(client, f"{base}/ticket_fields.json?page[size]=100", headers, "ticket_fields"):
                    if f.get("type") in SYSTEM_TICKET_FIELD_TYPES or f.get("removable") is False:
                        continue
                    api = f"custom_field_{f['id']}"
                    fields[api] = _entry(api, f.get("title") or api, FIELD_TYPE_MAP.get(f.get("type"), "string"),
                                         custom=True, options=_options(f), context=ctx,
                                         writable=f.get("active", True))
            elif name in ("users", "organizations"):
                prefix = f"{singular(name)}_field_"
                for f in await _get_all(client, f"{base}/{singular(name)}_fields.json?page[size]=100", headers, f"{singular(name)}_fields"):
                    api = f"{prefix}{f['key']}"
                    fields[api] = _entry(api, f.get("title") or api, FIELD_TYPE_MAP.get(f.get("type"), "string"),
                                         custom=True, options=_options(f), context=ctx, writable=f.get("active", True))

            res = await client.get(f"{base}/{name}.json?per_page=5", headers=headers)
            if res.status_code in (401, 403):
                res.raise_for_status()
            if res.status_code == 200:
                samples = [flatten_record(r) for r in res.json().get(name, [])]
            unknown_writable = False
        else:
            ctx = "custom_object"
            for fname, label, type_, required, writable, ref, options in CUSTOM_OBJECT_SYSTEM_FIELDS:
                fields[fname] = _entry(fname, label, type_, writable=writable, context=ctx,
                                       external_id=fname in _EXTERNAL_ID_NAMES, unique=fname == "external_id")
            meta = await client.get(f"{base}/custom_objects/{name}/fields", headers=headers)
            if meta.status_code in (401, 403):
                meta.raise_for_status()
            if meta.status_code == 200:
                for f in meta.json().get("custom_object_fields", []):
                    key = f.get("key")
                    if not key or key in fields:
                        continue
                    target = lookup_target(f.get("relationship_target_type"))
                    fields[key] = _entry(key, f.get("title") or key, "reference" if target else FIELD_TYPE_MAP.get(f.get("type"), "string"),
                                         required=bool(f.get("required")), custom=True, ref=[target] if target else None,
                                         options=_options(f), context=ctx, writable=f.get("active", True))
            data = await client.get(f"{base}/custom_objects/{name}/records?page[size]=5", headers=headers)
            data.raise_for_status() if data.status_code in (401, 403) else None
            if data.status_code == 200:
                samples = [flatten_record(r) for r in data.json().get("custom_object_records", [])]

    for rec in samples:        # keys the catalog doesn't know (new Zendesk system fields): readable, never writable
        for k, v in rec.items():
            if k not in fields:
                t = "boolean" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "string"
                fields[k] = _entry(k, k.replace("_", " ").title(), t, writable=False, context=_CONTEXT.get(name, "custom_object"))

    fields_list = sorted(fields.values(), key=lambda x: (not x["isRequired"], x["name"]))
    return {"headers": [f["name"] for f in fields_list[:12]], "sampleRecords": samples, "fields": fields_list}