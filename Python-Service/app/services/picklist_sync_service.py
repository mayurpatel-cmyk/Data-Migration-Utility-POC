import logging
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple
from xml.sax.saxutils import escape as xml_escape

import httpx

from app.services.crm_service import CrmService

logger = logging.getLogger(__name__)

PICKLIST_TYPES = {"picklist", "multipicklist"}
# Metadata API requires StandardValue child elements in alphabetical order (fullName first).
_SVS_ENTRY_FIELDS = [
    "fullName", "allowEmail", "closed", "color", "converted", "cssExposed", "default",
    "description", "forecastCategory", "groupingString", "highPriority", "isActive",
    "label", "probability", "reverseRole", "reviewed", "won",
]

# object (lower) -> field API name -> StandardValueSet name. Extend per object as needed.
STANDARD_VALUE_SET_NAMES: Dict[str, Dict[str, str]] = {
    "account": {
        "Industry": "Industry",
        "Type": "AccountType",
        "Rating": "AccountRating",
        "Ownership": "AccountOwnership",
        "AccountSource": "LeadSource",
    },
}


class PicklistSyncError(Exception):
    pass


def _soql_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


class _SalesforceSession:
    API_VERSION = "v60.0"

    def __init__(self, client: httpx.AsyncClient, creds: Dict[str, Any], user_id: str, role: str):
        self.client = client
        self.token: str = creds.get("access_token") or ""
        self.instance_url: str = (creds.get("instance_url") or "").rstrip("/")
        self.user_id = user_id
        self.role = role
        self._describe_cache: Dict[str, Dict[str, Dict[str, Any]]] = {}

        if not self.token or not self.instance_url:
            raise PicklistSyncError(f"Missing Salesforce credentials for {role} org.")

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        url = f"{self.instance_url}/services/data/{self.API_VERSION}{path}"
        for attempt in range(2):
            res = await self.client.request(
                method,
                url,
                headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
                **kwargs,
            )
            if res.status_code == 401 and attempt == 0:
                self.token = await CrmService.refresh_crm_token(self.user_id, "salesforce", self.role)
                continue
            if res.status_code >= 400:
                raise PicklistSyncError(f"{method} {path} -> {res.status_code}: {res.text[:500]}")
            return res
        raise PicklistSyncError(f"{method} {path} failed after token refresh.")

    async def describe_fields(self, object_name: str) -> Dict[str, Dict[str, Any]]:
        if object_name not in self._describe_cache:
            res = await self.request("GET", f"/sobjects/{object_name}/describe")
            self._describe_cache[object_name] = {f["name"]: f for f in res.json().get("fields", [])}
        return self._describe_cache[object_name]

    async def tooling_query(self, soql: str) -> List[Dict[str, Any]]:
        res = await self.request("GET", "/tooling/query/", params={"q": soql})
        return res.json().get("records", [])

    async def tooling_patch_metadata(self, sobject: str, record_id: str, metadata: Dict[str, Any]) -> None:
        await self.request("PATCH", f"/tooling/sobjects/{sobject}/{record_id}", json={"Metadata": metadata})

    @staticmethod
    def _svs_entry_xml(entry: Dict[str, Any]) -> str:
        normalized = dict(entry)
        if "valueName" in normalized:
            normalized["fullName"] = normalized.pop("valueName")

        parts = []
        for key in _SVS_ENTRY_FIELDS:
            value = normalized.get(key)
            if value is None:
                continue
            text = str(value).lower() if isinstance(value, bool) else xml_escape(str(value))
            parts.append(f"<meta:{key}>{text}</meta:{key}>")
        return f"<meta:standardValue>{''.join(parts)}</meta:standardValue>"

    async def metadata_update_standard_value_set(
        self, full_name: str, sorted_flag: bool, entries: List[Dict[str, Any]]
    ) -> None:
        url = f"{self.instance_url}/services/Soap/m/{self.API_VERSION.lstrip('v')}"

        for attempt in range(2):
            envelope = (
                '<?xml version="1.0" encoding="utf-8"?>'
                '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" '
                'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
                'xmlns:meta="http://soap.sforce.com/2006/04/metadata">'
                f"<env:Header><meta:SessionHeader><meta:sessionId>{xml_escape(self.token)}</meta:sessionId>"
                "</meta:SessionHeader></env:Header>"
                "<env:Body><meta:updateMetadata>"
                '<meta:metadata xsi:type="meta:StandardValueSet">'
                f"<meta:fullName>{xml_escape(full_name)}</meta:fullName>"
                f"<meta:sorted>{'true' if sorted_flag else 'false'}</meta:sorted>"
                f"{''.join(self._svs_entry_xml(e) for e in entries)}"
                "</meta:metadata></meta:updateMetadata></env:Body></env:Envelope>"
            )
            res = await self.client.post(
                url,
                content=envelope.encode("utf-8"),
                headers={"Content-Type": "text/xml; charset=UTF-8", "SOAPAction": '""'},
            )
            if "INVALID_SESSION_ID" in res.text and attempt == 0:
                self.token = await CrmService.refresh_crm_token(self.user_id, "salesforce", self.role)
                continue
            break

        try:
            root = ET.fromstring(res.text)
        except ET.ParseError:
            raise PicklistSyncError(f"Metadata API returned an unreadable response ({res.status_code}): {res.text[:300]}")

        def texts(tag: str) -> List[str]:
            return [(el.text or "").strip() for el in root.iter() if el.tag.split("}")[-1] == tag]

        faults = texts("faultstring")
        if faults:
            raise PicklistSyncError(f"Metadata API fault: {faults[0]}")
        if "true" not in [s.lower() for s in texts("success")]:
            raise PicklistSyncError(f"updateMetadata failed: {'; '.join(texts('message')) or res.text[:300]}")


class PicklistSyncService:
    @staticmethod
    def _split_api_name(field_name: str) -> Tuple[Optional[str], str]:
        base = field_name[:-3] if field_name.endswith("__c") else field_name
        if "__" in base:
            ns, dev = base.split("__", 1)
            return ns, dev
        return None, base

    @staticmethod
    def _missing_values(source_field: Dict[str, Any], target_field: Dict[str, Any]) -> List[Dict[str, str]]:
        existing = {
            str(v.get("value", "")).strip().lower()
            for v in (target_field.get("picklistValues") or [])
            if v.get("active", True)
        }
        missing, seen = [], set()
        for v in source_field.get("picklistValues") or []:
            value = v.get("value")
            if value is None or not v.get("active", True):
                continue
            key = str(value).strip().lower()
            if not key or key in existing or key in seen:
                continue
            seen.add(key)
            missing.append({"value": str(value), "label": str(v.get("label") or value)})
        return missing

    @staticmethod
    def _append_entries(entries: List[Dict[str, Any]], missing: List[Dict[str, str]]) -> List[str]:
        index = {str(e.get("valueName", "")).strip().lower(): e for e in entries}
        added = []
        for m in missing:
            key = m["value"].strip().lower()
            existing = index.get(key)
            if existing is not None:
                if existing.get("isActive") is False:
                    existing["isActive"] = True
                    added.append(m["value"])
                continue
            entries.append({
                "label": m["label"],
                "valueName": m["value"],
                "default": False,
                "isActive": True,
                "color": None,
                "description": None,
            })
            added.append(m["value"])
        return added

    @classmethod
    async def _add_to_global_value_set(cls, session: _SalesforceSession, name: str, missing) -> List[str]:
        recs = await session.tooling_query(
            f"SELECT Id, Metadata FROM GlobalValueSet WHERE DeveloperName = '{_soql_escape(name)}'"
        )
        if not recs:
            raise PicklistSyncError(f"Global value set '{name}' not found in destination org.")
        metadata = recs[0]["Metadata"]
        metadata["customValue"] = metadata.get("customValue") or []
        added = cls._append_entries(metadata["customValue"], missing)
        if added:
            await session.tooling_patch_metadata("GlobalValueSet", recs[0]["Id"], metadata)
        return added

    @classmethod
    async def _add_to_standard_value_set(cls, session: _SalesforceSession, name: str, missing) -> List[str]:
        recs = await session.tooling_query(
            f"SELECT Id, Metadata FROM StandardValueSet WHERE MasterLabel = '{_soql_escape(name)}'"
        )
        if not recs:
            raise PicklistSyncError(f"Standard value set '{name}' not found in destination org.")

        metadata = recs[0]["Metadata"]
        entries = metadata.get("standardValue") or []
        added = cls._append_entries(entries, missing)
        if added:
            await session.metadata_update_standard_value_set(
                name, bool(metadata.get("sorted", False)), entries
            )
        return added

    @classmethod
    async def _add_to_custom_field(cls, session: _SalesforceSession, obj: str, field_name: str, missing) -> List[str]:
        ns, dev = cls._split_api_name(field_name)
        where = (
            f"EntityDefinition.QualifiedApiName = '{_soql_escape(obj)}' "
            f"AND DeveloperName = '{_soql_escape(dev)}'"
        )
        if ns:
            where += f" AND NamespacePrefix = '{_soql_escape(ns)}'"
        recs = await session.tooling_query(f"SELECT Id, Metadata FROM CustomField WHERE {where}")
        if not recs:
            raise PicklistSyncError(f"Custom field '{obj}.{field_name}' not found in destination org.")

        metadata = recs[0]["Metadata"]
        value_set = metadata.get("valueSet") or {}

        if value_set.get("valueSetName"):
            return await cls._add_to_global_value_set(session, value_set["valueSetName"], missing)

        definition = value_set.get("valueSetDefinition") or {"sorted": False, "value": []}
        definition["value"] = definition.get("value") or []
        added = cls._append_entries(definition["value"], missing)
        if added:
            value_set["valueSetDefinition"] = definition
            metadata["valueSet"] = value_set
            await session.tooling_patch_metadata("CustomField", recs[0]["Id"], metadata)
        return added

    @classmethod
    async def _add_values(cls, session: _SalesforceSession, obj: str, field_name: str, missing) -> List[str]:
        std_set = STANDARD_VALUE_SET_NAMES.get(obj.lower(), {}).get(field_name)
        if std_set:
            return await cls._add_to_standard_value_set(session, std_set, missing)
        if field_name.endswith("__c"):
            return await cls._add_to_custom_field(session, obj, field_name, missing)
        raise PicklistSyncError(
            f"'{obj}.{field_name}' is a standard picklist without a known StandardValueSet mapping."
        )

    @classmethod
    async def sync(
        cls,
        client: httpx.AsyncClient,
        source_creds: Dict[str, Any],
        target_creds: Dict[str, Any],
        user_id: str,
        source_object: str,
        target_object: str,
        mappings: List[Dict[str, Any]],
        send_log,
    ) -> Dict[str, List[str]]:
        created: Dict[str, List[str]] = {}
        try:
            source = _SalesforceSession(client, source_creds, user_id, "source")
            target = _SalesforceSession(client, target_creds, user_id, "target")
            source_fields = await source.describe_fields(source_object)
            target_fields = await target.describe_fields(target_object)
        except PicklistSyncError as e:
            await send_log(f"[{target_object}] Picklist Sync skipped: {e}")
            return created

        for m in mappings:
            src_name, tgt_name = m.get("sourceField"), m.get("targetField")
            src_meta, tgt_meta = source_fields.get(src_name), target_fields.get(tgt_name)

            if not src_meta or not tgt_meta:
                await send_log(f"[{target_object}] Picklist Sync: field metadata not found for {src_name} -> {tgt_name}.")
                continue
            if src_meta.get("type") not in PICKLIST_TYPES or tgt_meta.get("type") not in PICKLIST_TYPES:
                await send_log(f"[{target_object}] Picklist Sync: {src_name} -> {tgt_name} is not a picklist pair; skipped.")
                continue

            missing = cls._missing_values(src_meta, tgt_meta)
            if not missing:
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name} already contains all source values.")
                continue

            await send_log(
                f"[{target_object}] Picklist Sync: creating {len(missing)} missing value(s) in {tgt_name}: "
                f"{', '.join(v['value'] for v in missing)}"
            )
            try:
                added = await cls._add_values(target, target_object, tgt_name, missing)
                created[tgt_name] = added
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name} updated ({len(added)} value(s) added).")
            except PicklistSyncError as e:
                logger.warning("Picklist sync failed for %s.%s: %s", target_object, tgt_name, e)
                await send_log(f"[{target_object}] Picklist Sync failed for {tgt_name}: {e}")

        return created