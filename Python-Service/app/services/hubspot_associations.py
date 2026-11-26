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