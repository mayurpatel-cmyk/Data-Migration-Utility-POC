"""
HubSpot associations (record-to-record links).

HubSpot stores relationships as ASSOCIATIONS (crm v4), not as properties, so a source lookup such as Salesforce
Contact.AccountId has no HubSpot property to land in. This module adds one pseudo-field per association target,
named `__assoc__<object>` (e.g. `__assoc__companies`):

  * as a TARGET field   the mapped source value (already remapped to the new HubSpot id by the reference remap) is
                        turned into a default association right after the record is written;
  * as a SOURCE field   extraction fills it with the record's associated id (the Primary association when there is one),
                        so HubSpot -> Salesforce / Zoho / Zendesk can map it onto a lookup field.

Nothing here changes how ordinary properties are written or read.
"""
import re
from typing import Any, Dict, List, Tuple

ASSOC_PREFIX = "__assoc__"
READ_BATCH = 1000          # inputs per association batch/read call
WRITE_BATCH = 100          # inputs per batch/associate/default call

STANDARD_ASSOCIATIONS: Dict[str, List[str]] = {
    "contacts": ["companies", "deals", "tickets"],
    "companies": ["contacts", "deals", "tickets"],
    "deals": ["contacts", "companies", "tickets"],
    "tickets": ["contacts", "companies", "deals"],
}
_LABELS = {"contacts": "Contact", "companies": "Company", "deals": "Deal", "tickets": "Ticket"}


def is_assoc_field(name: Any) -> bool:
    return isinstance(name, str) and name.startswith(ASSOC_PREFIX)


def is_internal_field(name: Any) -> bool:
    """Keys that instruct the migrator and must never be sent to HubSpot as properties."""
    return is_assoc_field(name) or name == "__relext__"


def assoc_target(name: str) -> str:
    return name[len(ASSOC_PREFIX):].strip().lower()


def pseudo_fields(object_name: str) -> List[Dict[str, Any]]:
    """Metadata entries (same shape as real HubSpot fields) for the associations this object can have."""
    key = (object_name or "").strip().lower()
    key = {"contact": "contacts", "company": "companies", "deal": "deals", "ticket": "tickets"}.get(key, key)
    out = []
    for to_obj in STANDARD_ASSOCIATIONS.get(key, []):
        out.append({
            "name": f"{ASSOC_PREFIX}{to_obj}", "label": f"Associated {_LABELS[to_obj]}",
            "type": "reference", "isRequired": False, "custom": False,
            "referenceTo": [to_obj], "unique": False, "externalId": False,
            "createable": True, "updateable": True, "isAssociation": True,
        })
    return out


def clean_id(value: Any) -> str:
    """'123', 123, '123.0' -> '123'; anything that is not a plain HubSpot id -> ''."""
    s = str(value).strip() if value is not None else ""
    s = re.sub(r"\.0+$", "", s)
    return s if s.isdigit() else ""


def _chunks(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


async def associate_default(migrator, client, headers: dict, base: str, user_id, send_log,
                            from_obj: str, to_obj: str, pairs: List[Tuple[str, str]]) -> List[Tuple[str, str]]:
    """Creates default (unlabelled) associations. Idempotent, so safe to repeat. Returns the pairs that failed."""
    failed: List[Tuple[str, str]] = []
    url = f"{base}/crm/v4/associations/{from_obj}/{to_obj}/batch/associate/default"
    for chunk in _chunks(list(dict.fromkeys(pairs)), WRITE_BATCH):
        res = await migrator._request(
            client, "POST", url, headers, user_id, "target", send_log,
            json={"inputs": [{"from": {"id": a}, "to": {"id": b}} for a, b in chunk]})
        body: Dict[str, Any] = {}
        try:
            body = res.json()
        except ValueError:
            pass
        if res.status_code in (200, 201, 202) and not body.get("errors") and not body.get("numErrors"):
            continue
        for a, b in chunk:     # partial (207) or rejected batch: settle each pair on its own
            single = await migrator._request(
                client, "PUT", f"{base}/crm/v4/objects/{from_obj}/{a}/associations/default/{to_obj}/{b}",
                headers, user_id, "target", send_log)
            if single.status_code not in (200, 201):
                failed.append((a, b))
                await send_log(f"[Associations] {from_obj}/{a} -> {to_obj}/{b} failed "
                               f"({single.status_code}): {single.text[:200]}")
    return failed


async def read_associations(migrator, client, headers: dict, base: str, user_id, send_log,
                            from_obj: str, to_obj: str, ids: List[str]) -> Dict[str, str]:
    """{from_id: associated to_id} (Primary association preferred, otherwise the first one)."""
    out: Dict[str, str] = {}
    url = f"{base}/crm/v4/associations/{from_obj}/{to_obj}/batch/read"
    for chunk in _chunks([str(i) for i in ids if i not in (None, "")], READ_BATCH):
        res = await migrator._request(client, "POST", url, headers, user_id, "source", send_log,
                                      json={"inputs": [{"id": i} for i in chunk]})
        if res.status_code not in (200, 207):
            raise RuntimeError(f"HubSpot association read failed ({res.status_code}): {res.text[:300]}")
        for r in res.json().get("results") or []:
            targets = r.get("to") or []
            if not targets:
                continue
            primary = next((t for t in targets if any((a.get("label") or "").lower() == "primary"
                                                      for a in (t.get("associationTypes") or []))), targets[0])
            out[str((r.get("from") or {}).get("id"))] = str(primary.get("toObjectId"))
    return out


PARENT_ID_CACHE: Dict[Tuple[str, str, str, str], str] = {}     # (api base, object, property, value) -> HubSpot id
_PARENT_CACHE_MAX = 100_000
_SEARCH_PAGE = 100


async def resolve_parent_ids(migrator, client, headers: dict, base: str, user_id, send_log,
                             obj: str, key: str, values: List[str]) -> Dict[str, str]:
    """{value of `key` -> HubSpot id} for parents matched by a business key ('Match <parent> By <key>'), looked up with
    the Search API (IN, case-insensitive, oldest record wins when the key is not actually unique).
    `id` / `hs_object_id` need no lookup."""
    key_l = (key or "").strip().lower()
    values = [str(v) for v in dict.fromkeys(values) if v not in (None, "")]
    if key_l in ("id", "hs_object_id"):
        return {v: clean_id(v) for v in values if clean_id(v)}

    found: Dict[str, str] = {}
    todo: List[str] = []
    for v in values:
        hit = PARENT_ID_CACHE.get((base, obj, key_l, v))
        if hit:
            found[v] = hit
        else:
            todo.append(v)

    by_lower: Dict[str, str] = {}
    for v in todo:
        by_lower.setdefault(v.strip().lower(), v)
    wanted = list(by_lower)
    url = f"{base}/crm/v3/objects/{obj}/search"
    for chunk in _chunks(wanted, _SEARCH_PAGE):
        after = None
        while True:
            body: Dict[str, Any] = {
                "filterGroups": [{"filters": [{"propertyName": key, "operator": "IN", "values": chunk}]}],
                "properties": [key], "limit": _SEARCH_PAGE,
                "sorts": [{"propertyName": "hs_object_id", "direction": "ASCENDING"}],
            }
            if after:
                body["after"] = after
            res = await migrator._request(client, "POST", url, headers, user_id, "target", send_log, json=body)
            if res.status_code != 200:
                raise RuntimeError(f"HubSpot lookup of {obj} by '{key}' failed ({res.status_code}): {res.text[:300]}")
            data = res.json()
            for r in data.get("results") or []:
                raw = (r.get("properties") or {}).get(key)
                original = by_lower.get(str(raw or "").strip().lower())
                if original is not None and original not in found:
                    found[original] = str(r["id"])
                    PARENT_ID_CACHE[(base, obj, key_l, original)] = str(r["id"])
            after = ((data.get("paging") or {}).get("next") or {}).get("after")
            if not after:
                break
    if len(PARENT_ID_CACHE) > _PARENT_CACHE_MAX:
        PARENT_ID_CACHE.clear()
    return found