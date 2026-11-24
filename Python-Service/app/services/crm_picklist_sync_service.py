import asyncio
import logging
import re
from typing import Any, Dict, List, Optional

import httpx
from fastapi import HTTPException

from app.services.crm_service import CrmService
from app.services.picklist_sync_service import (
    PicklistSyncError,
    PicklistSyncService,
    _SalesforceSession,
)

logger = logging.getLogger(__name__)


class _CrmSession:
    """Authenticated REST session for one side (source/target) of a HubSpot, Zoho or Zendesk connection."""

    def __init__(self, client: httpx.AsyncClient, crm: str, creds: Dict[str, Any], user_id: str, role: str):
        self.client = client
        self.crm = crm
        self.user_id = user_id
        self.role = role
        self.token: str = creds.get("access_token") or ""
        self.cache: Dict[str, Any] = {}

        if crm == "hubspot":
            self.base = (creds.get("api_domain") or "https://api.hubapi.com").rstrip("/")
        elif crm == "zoho":
            domain = (creds.get("api_domain") or "https://www.zohoapis.com").rstrip("/")
            self.base = domain if domain.startswith("http") else f"https://{domain}"
        elif crm == "zendesk":
            subdomain = creds.get("subdomain")
            self.base = f"https://{subdomain}.zendesk.com/api/v2" if subdomain else ""
        else:
            self.base = ""

        if not self.token or not self.base:
            raise PicklistSyncError(f"Missing {crm.capitalize()} credentials for {role} connection.")

    def _headers(self) -> Dict[str, str]:
        scheme = "Zoho-oauthtoken" if self.crm == "zoho" else "Bearer"
        return {"Authorization": f"{scheme} {self.token}", "Content-Type": "application/json"}

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        url = f"{self.base}{path}"
        for attempt in range(3):
            res = await self.client.request(method, url, headers=self._headers(), **kwargs)

            if res.status_code == 401 and attempt == 0:
                try:
                    self.token = await CrmService.refresh_crm_token(self.user_id, self.crm, self.role)
                except HTTPException as e:
                    raise PicklistSyncError(f"{self.role} token expired and could not be refreshed: {e.detail}")
                continue

            if res.status_code == 429 and attempt < 2:
                await asyncio.sleep(min(int(res.headers.get("Retry-After", 5)), 30))
                continue

            if res.status_code >= 400:
                raise PicklistSyncError(f"{method} {path} -> {res.status_code}: {res.text[:500]}")
            return res
        raise PicklistSyncError(f"{method} {path} failed after retries.")


class _BaseProvider:
    @staticmethod
    def normalize(value: str) -> str:
        return str(value).strip()

    @staticmethod
    def _present(values: List[Dict[str, Any]]) -> set:
        return {str(v.get("value", "")).strip().lower() for v in values}


# =========================================================
# HUBSPOT: /crm/v3/properties/{object}/{property}
# =========================================================
class _HubspotProvider(_BaseProvider):
    @staticmethod
    async def read_field(session: _CrmSession, obj: str, field: str) -> Optional[Dict[str, Any]]:
        res = await session.request("GET", f"/crm/v3/properties/{obj}/{field}")
        prop = res.json()
        if prop.get("type") != "enumeration" or prop.get("fieldType") == "booleancheckbox":
            return None
        values = [
            {
                "value": str(o.get("value", "")),
                "label": str(o.get("label") or o.get("value", "")),
                "active": not o.get("hidden", False),
            }
            for o in prop.get("options") or []
        ]
        return {"values": values, "raw": prop, "multi": prop.get("fieldType") == "checkbox"}

    @classmethod
    async def add(cls, session, obj, field, info, missing) -> List[str]:
        prop = info["raw"]
        if (prop.get("modificationMetadata") or {}).get("readOnlyOptions"):
            raise PicklistSyncError(f"'{field}' options are read-only in HubSpot.")
        if prop.get("externalOptions"):
            raise PicklistSyncError(f"'{field}' gets its options from an external source and can't be edited.")

        options = [dict(o) for o in prop.get("options") or []]
        present = cls._present(options)
        max_order = max((o.get("displayOrder", -1) for o in options), default=-1)

        added: List[str] = []
        for m in missing:
            if m["value"].lower() in present:
                continue
            order = max_order + 1 + len(added) if max_order >= 0 else -1
            options.append({"label": m["label"], "value": m["value"], "displayOrder": order, "hidden": False})
            added.append(m["value"])

        if added:
            await session.request("PATCH", f"/crm/v3/properties/{obj}/{field}", json={"options": options})
        return added


# =========================================================
# ZOHO: /crm/v6/settings/fields
# =========================================================
class _ZohoProvider(_BaseProvider):
    PICKLIST_TYPES = {"picklist", "multiselectpicklist"}

    @staticmethod
    def _module(session: _CrmSession, obj: str) -> str:
        # Mirrors ZohoMigrator.upload: the target module name is pluralised the same way.
        name = obj.strip()
        if session.role == "target" and not name.endswith("s") and name.lower() != "data":
            plurals = {"lead": "Leads", "contact": "Contacts", "account": "Accounts", "deal": "Deals"}
            name = plurals.get(name.lower(), name.capitalize() + "s")
        return name

    @classmethod
    async def _fields(cls, session: _CrmSession, module: str, refresh: bool = False) -> List[Dict[str, Any]]:
        key = f"zoho_fields::{module}"
        if refresh or key not in session.cache:
            res = await session.request("GET", "/crm/v6/settings/fields", params={"module": module})
            session.cache[key] = res.json().get("fields", [])
        return session.cache[key]

    @classmethod
    async def read_field(cls, session: _CrmSession, obj: str, field: str) -> Optional[Dict[str, Any]]:
        module = cls._module(session, obj)
        fields = await cls._fields(session, module, refresh=True)
        f = next((x for x in fields if x.get("api_name") == field), None)
        if not f or f.get("data_type") not in cls.PICKLIST_TYPES:
            return None

        values = []
        for v in f.get("pick_list_values") or []:
            actual, display = v.get("actual_value"), v.get("display_value")
            if actual in (None, "") or actual == "-None-":
                continue
            values.append({"value": str(actual), "label": str(display or actual), "active": True})
        return {"values": values, "raw": f, "module": module, "multi": f.get("data_type") == "multiselectpicklist"}

    @classmethod
    async def add(cls, session, obj, field, info, missing) -> List[str]:
        f, module = info["raw"], info["module"]
        if not f.get("id"):
            raise PicklistSyncError(f"Zoho field '{field}' has no id; can't update it.")

        pick_list: List[Dict[str, Any]] = []
        for v in f.get("pick_list_values") or []:
            entry = {"display_value": v.get("display_value"), "actual_value": v.get("actual_value")}
            if v.get("id"):
                entry["id"] = v["id"]
            pick_list.append(entry)

        present = cls._present([{"value": v.get("actual_value")} for v in pick_list])
        added: List[str] = []
        for m in missing:
            if m["value"].lower() in present:
                continue
            pick_list.append({"display_value": m["label"], "actual_value": m["value"]})
            added.append(m["value"])

        if added:
            res = await session.request(
                "PATCH",
                f"/crm/v6/settings/fields/{f['id']}",
                params={"module": module},
                json={"fields": [{"pick_list_values": pick_list}]},
            )
            for item in res.json().get("fields", []):
                if str(item.get("status", "")).lower() == "error":
                    raise PicklistSyncError(f"Zoho rejected the update: {item.get('message') or item.get('code')}")
        return added


# =========================================================
# ZENDESK: ticket/user/organization fields + custom object fields
# =========================================================
class _ZendeskProvider(_BaseProvider):
    STANDARD = {"tickets": "ticket_fields", "users": "user_fields", "organizations": "organization_fields"}
    PICKLIST_TYPES = {"tagger", "dropdown", "multiselect"}

    @staticmethod
    def normalize(value: str) -> str:
        # Zendesk option values are tags: lowercase, no whitespace.
        return re.sub(r"\s+", "_", str(value).strip().lower())

    @classmethod
    def _locate(cls, obj: str, field: str) -> Dict[str, str]:
        o = obj.strip().lower()
        if o in cls.STANDARD:
            m = re.fullmatch(r"custom_field_(\d+)", field)
            if not m:
                raise PicklistSyncError(f"'{field}' is a Zendesk system field; only custom dropdown/multi-select fields can be extended.")
            collection = cls.STANDARD[o]
            return {"kind": "standard", "path": f"/{collection}/{m.group(1)}", "wrap": collection[:-1], "method": "PUT"}
        return {
            "kind": "custom_object",
            "path": f"/custom_objects/{obj}/fields/{field}",
            "wrap": "custom_object_field",
            "method": "PATCH",
        }

    @classmethod
    async def read_field(cls, session: _CrmSession, obj: str, field: str) -> Optional[Dict[str, Any]]:
        loc = cls._locate(obj, field)
        res = await session.request("GET", loc["path"])
        data = res.json().get(loc["wrap"]) or {}
        if data.get("type") not in cls.PICKLIST_TYPES:
            return None
        values = [
            {"value": str(o.get("value", "")), "label": str(o.get("name") or o.get("value", "")), "active": True}
            for o in data.get("custom_field_options") or []
        ]
        return {"values": values, "raw": data, "loc": loc, "multi": data.get("type") == "multiselect"}

    @classmethod
    async def add(cls, session, obj, field, info, missing) -> List[str]:
        loc = info["loc"]
        options: List[Dict[str, Any]] = []
        for o in info["raw"].get("custom_field_options") or []:
            entry = {"name": o.get("name"), "value": o.get("value")}
            if o.get("id") is not None:
                entry["id"] = o["id"]
            options.append(entry)

        present = cls._present(options)
        added: List[str] = []
        for m in missing:
            if m["value"].lower() in present:
                continue
            options.append({"name": m["label"], "value": m["value"]})
            added.append(m["value"])

        if added:
            await session.request(loc["method"], loc["path"], json={loc["wrap"]: {"custom_field_options": options}})
        return added

# =========================================================
# SALESFORCE (source: describe, target: StandardValueSet / CustomField / GlobalValueSet)
# =========================================================
class _SalesforceProvider(_BaseProvider):
    PICKLIST_TYPES = {"picklist", "multipicklist"}

    @classmethod
    async def read_field(cls, session: _SalesforceSession, obj: str, field: str) -> Optional[Dict[str, Any]]:
        fields = await session.describe_fields(obj)
        f = fields.get(field)
        if not f or f.get("type") not in cls.PICKLIST_TYPES:
            return None
        values = [
            {
                "value": str(v["value"]),
                "label": str(v.get("label") or v["value"]),
                "active": v.get("active", True),
            }
            for v in f.get("picklistValues") or []
            if v.get("value") is not None
        ]
        return {
            "values": values,
            "multi": f.get("type") == "multipicklist",
            "controlled": bool(f.get("controllerName")),
            "meta": f,  # the raw describe entry; PicklistSyncService._add_values needs it as `field_meta`
        }

    @classmethod
    async def add(cls, session: _SalesforceSession, obj, field, info, missing) -> List[str]:
        meta = info.get("meta") or {}
        # _add_values(session, obj, field, <values>, field_meta): the 4th argument is normally the list of
        # {"value", "label"} dicts; if this version of the service wants plain strings, retry with those.
        try:
            added = await PicklistSyncService._add_values(session, obj, field, missing, meta)
        except (TypeError, KeyError, AttributeError):
            added = await PicklistSyncService._add_values(session, obj, field, [m["value"] for m in missing], meta)
        if added:
            try:
                await PicklistSyncService._add_to_record_types(session, obj, field, added)
            except Exception as e:  # never fail the whole sync because record-type assignment failed
                logger.warning("Record type assignment failed for %s.%s: %s", obj, field, e)
        return added


def _make_session(client: httpx.AsyncClient, crm: str, creds: Dict[str, Any], user_id: str, role: str):
    if crm == "salesforce":
        return _SalesforceSession(client, creds, user_id, role)
    return _CrmSession(client, crm, creds, user_id, role)

# Values that the validators treat as "empty" must never become picklist options.
_EMPTY_TOKENS = {"", "none", "nan", "nat", "<na>", "null"}

# Guard rails for CSV-driven creation: a wrongly toggled free-text column (e.g. Description) must not
# flood a picklist. Salesforce itself caps a picklist at 1,000 values.
MAX_NEW_PICKLIST_VALUES = 200

# Mapping types that can never be a picklist: skipped without any API call in auto mode.
_NON_PICKLIST_TYPES = {
    "reference", "date", "datetime", "boolean", "int", "integer", "double", "currency", "percent", "number",
    "email", "phone", "url", "id", "textarea", "base64", "time", "location", "address",
}
MAX_PICKLIST_VALUE_LENGTH = 255


class MultiCrmPicklistSyncService:
    PROVIDERS = {
        "salesforce": _SalesforceProvider,
        "hubspot": _HubspotProvider,
        "zoho": _ZohoProvider,
        "zendesk": _ZendeskProvider,
    }
    SUPPORTED_CRMS = set(PROVIDERS.keys())

    @staticmethod
    def _missing(target_provider, source_info: Dict[str, Any], target_info: Dict[str, Any]) -> List[Dict[str, str]]:
        existing = {target_provider.normalize(v["value"]).lower() for v in target_info["values"]}
        missing, seen = [], set()
        for v in source_info["values"]:
            if not v.get("active", True):
                continue
            value = target_provider.normalize(v["value"])
            key = value.lower()
            if not key or key in existing or key in seen:
                continue
            seen.add(key)
            missing.append({"value": value, "label": v["label"] or value})
        return missing

    @classmethod
    async def sync(
        cls,
        client: httpx.AsyncClient,
        source_crm: str,
        target_crm: str,
        source_creds: Dict[str, Any],
        target_creds: Dict[str, Any],
        user_id: str,
        source_object: str,
        target_object: str,
        mappings: List[Dict[str, Any]],
        send_log,
    ) -> Dict[str, Dict[str, Any]]:
        source_crm, target_crm = source_crm.lower(), target_crm.lower()
        created: Dict[str, List[str]] = {}
        failed: Dict[str, str] = {}

        def result():
            return {"created": created, "failed": failed}

        source_provider = cls.PROVIDERS.get(source_crm)
        target_provider = cls.PROVIDERS.get(target_crm)
        if not source_provider or not target_provider:
            await send_log(f"[{target_object}] Picklist Sync: {source_crm} -> {target_crm} is not supported.")
            return result()

        try:
            source = _make_session(client, source_crm, source_creds, user_id, "source")
            target = _make_session(client, target_crm, target_creds, user_id, "target")
        except PicklistSyncError as e:
            await send_log(f"[{target_object}] Picklist Sync skipped: {e}")
            return result()

        if target_crm == "zendesk" and source_crm != "zendesk":
            await send_log(
                f"[{target_object}] Picklist Sync: Zendesk stores option values as lowercase tags, so created "
                f"values are normalized (e.g. 'New York' -> 'new_york'). Record values must match them."
            )

        for m in mappings:
            src_name, tgt_name = m.get("sourceField"), m.get("targetField")
            if not src_name or not tgt_name:
                continue

            try:
                src_info = await source_provider.read_field(source, source_object, src_name)
                tgt_info = await target_provider.read_field(target, target_object, tgt_name)
            except PicklistSyncError as e:
                await send_log(f"[{target_object}] Picklist Sync: could not read {src_name} -> {tgt_name}: {e}")
                continue

            if not src_info or not tgt_info:
                await send_log(f"[{target_object}] Picklist Sync: {src_name} -> {tgt_name} is not a picklist pair; skipped.")
                continue

            missing = cls._missing(target_provider, src_info, tgt_info)
            if not missing:
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name} already contains all source values.")
                continue

            await send_log(
                f"[{target_object}] Picklist Sync: creating {len(missing)} missing value(s) in {tgt_name}: "
                f"{', '.join(v['value'] for v in missing)}"
            )
            try:
                added = await target_provider.add(target, target_object, tgt_name, tgt_info, missing)
                created[tgt_name] = added
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name} updated ({len(added)} value(s) added).")
            except PicklistSyncError as e:
                logger.warning("Picklist sync failed for %s.%s: %s", target_object, tgt_name, e)
                await send_log(f"[{target_object}] Picklist Sync failed for {tgt_name}: {e}")
                failed[tgt_name] = str(e)

        return result()

    # ------------------------------------------------------------------
    # CSV UPLOADS: the "source picklist" is the set of distinct values found in the file
    # ------------------------------------------------------------------
    @staticmethod
    def collect_distinct_values(rows: List[Dict[str, Any]], csv_field: str, multi: bool) -> Dict[str, int]:
        """Distinct, non-empty values of one CSV column (case-insensitive, first spelling wins) with their row
        counts. Multi-select cells are split on ';'."""
        seen: Dict[str, List[Any]] = {}
        for row in rows:
            raw = row.get(csv_field)
            if raw is None or (isinstance(raw, float) and raw != raw):  # None / NaN
                continue
            text = str(raw).strip()
            parts = [p.strip() for p in text.split(";")] if multi else [text]
            for part in parts:
                if part.lower() in _EMPTY_TOKENS:
                    continue
                key = part.lower()
                if key in seen:
                    seen[key][1] += 1
                else:
                    seen[key] = [part, 1]
        return {v[0]: v[1] for v in seen.values()}

    @classmethod
    async def sync_from_rows(
        cls,
        client: httpx.AsyncClient,
        target_crm: str,
        target_creds: Dict[str, Any],
        user_id: str,
        target_object: str,
        mappings: List[Dict[str, Any]],
        rows: List[Dict[str, Any]],
        send_log,
        dry_run: bool = False,
        max_new_values: int = MAX_NEW_PICKLIST_VALUES,
        auto: bool = False,
    ) -> Dict[str, Dict[str, Any]]:
        """
        Create, in the TARGET org, every picklist value that appears in the CSV rows but not in the target field.
        Only mappings with syncPicklistValues=true are touched. Accepts both mapping shapes
        (csvField/sfField from the CSV screens, sourceField/targetField from the API-mapping screen).

        Returns {"created": {field: [values]}, "failed": {field: msg}, "skipped": {field: msg},
                 "preview": {field: {...}}}.
        `failed` aborts the run (credentials / permission / API problems, or too many new values);
        `skipped` is a field this service cannot change (dependent, State/Country, not a picklist): rows with
        unknown values are then rejected by the normal picklist guard instead.
        With dry_run=True nothing is written; `preview` shows what would be created.
        With auto=True no per-field flag is needed: every mapped field that turns out to be a picklist in the
        target is synced; non-picklist fields are skipped silently and an over-the-cap field is skipped
        (its rows are then rejected by the picklist guard) instead of aborting the run.
        """
        target_crm = target_crm.lower()
        created: Dict[str, List[str]] = {}
        failed: Dict[str, str] = {}
        skipped: Dict[str, str] = {}
        preview: Dict[str, Dict[str, Any]] = {}

        def result():
            return {"created": created, "failed": failed, "skipped": skipped, "preview": preview}

        provider = cls.PROVIDERS.get(target_crm)
        if not provider:
            await send_log(f"[{target_object}] Picklist Sync: {target_crm} is not supported as a target.")
            return result()

        try:
            target = _make_session(client, target_crm, target_creds, user_id, "target")
        except PicklistSyncError as e:
            await send_log(f"[{target_object}] Picklist Sync: {e}")
            if auto:
                failed["(connection)"] = str(e)
            else:
                for m in mappings:
                    if m.get("syncPicklistValues"):
                        failed[m.get("targetField") or m.get("sfField") or "?"] = str(e)
            return result()

        done_targets = set()
        for m in mappings:
            if not auto and not m.get("syncPicklistValues"):
                continue
            csv_field = m.get("sourceField") or m.get("csvField")
            tgt_name = m.get("targetField") or m.get("sfField")
            if not csv_field or not tgt_name or tgt_name in done_targets:
                continue
            if auto and str(m.get("type") or "").lower() in _NON_PICKLIST_TYPES:
                continue
            done_targets.add(tgt_name)

            if target_crm == "salesforce" and tgt_name.endswith(("StateCode", "CountryCode")):
                skipped[tgt_name] = "State/Country picklist values are managed in Setup > State and Country Picklists."
                if not auto:
                    await send_log(f"[{target_object}] Picklist Sync: {tgt_name} skipped. {skipped[tgt_name]}")
                continue

            try:
                info = await provider.read_field(target, target_object, tgt_name)
            except (PicklistSyncError, httpx.HTTPError) as e:
                failed[tgt_name] = f"could not read target field: {e}"
                await send_log(f"[{target_object}] Picklist Sync: could not read {tgt_name}: {e}")
                continue
            if not info:
                skipped[tgt_name] = "not a picklist in the target"
                if not auto:
                    await send_log(f"[{target_object}] Picklist Sync: {tgt_name} is not a picklist in the target; skipped.")
                continue
            if info.get("controlled"):
                skipped[tgt_name] = "dependent picklist (values must also be assigned to a controlling value)"
                await send_log(
                    f"[{target_object}] Picklist Sync: {tgt_name} is a dependent picklist; new values would not be valid "
                    f"for any controlling value. Create them in Setup first. Skipped."
                )
                continue

            multi = bool(info.get("multi"))
            found = cls.collect_distinct_values(rows, csv_field, multi)
            existing_active = {provider.normalize(v["value"]).lower() for v in info["values"] if v.get("active", True)}
            existing_inactive = {provider.normalize(v["value"]).lower() for v in info["values"] if not v.get("active", True)}

            missing: List[Dict[str, str]] = []
            inactive: List[str] = []
            too_long: List[str] = []
            for value in found:
                norm = provider.normalize(value)
                key = norm.lower()
                if key in existing_active:
                    continue
                if key in existing_inactive:
                    inactive.append(value)
                    continue
                if len(norm) > MAX_PICKLIST_VALUE_LENGTH:
                    too_long.append(value[:40] + "...")
                    continue
                missing.append({"value": norm, "label": value})

            preview[tgt_name] = {
                "csvField": csv_field,
                "multi": multi,
                "distinctInFile": len(found),
                "missing": [v["value"] for v in missing],
                "missingRowCounts": {v["value"]: found.get(v["label"], 0) for v in missing},
                "inactive": inactive,
                "tooLong": too_long,
            }

            if inactive:
                await send_log(
                    f"[{target_object}] Picklist Sync: {tgt_name}: {len(inactive)} value(s) exist but are INACTIVE in the "
                    f"target and will not be recreated ({', '.join(inactive[:5])}). Reactivate them or fix the data."
                )
            if too_long:
                await send_log(
                    f"[{target_object}] Picklist Sync: {tgt_name}: {len(too_long)} value(s) longer than "
                    f"{MAX_PICKLIST_VALUE_LENGTH} characters were not created."
                )
            if not missing:
                if not auto:
                    await send_log(f"[{target_object}] Picklist Sync: {tgt_name} already contains every value in '{csv_field}'.")
                continue
            if len(missing) > max_new_values:
                (skipped if auto else failed)[tgt_name] = (
                    f"'{csv_field}' has {len(missing)} distinct new values (limit {max_new_values}); this looks like a "
                    f"free-text column. Turn off 'Create missing values' for it or clean the data."
                )
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name}: {(skipped if auto else failed)[tgt_name]}")
                continue

            sample = ", ".join(v["value"] for v in missing[:20]) + (" ..." if len(missing) > 20 else "")
            if dry_run:
                await send_log(f"[{target_object}] Picklist Sync (dry run): would create {len(missing)} value(s) in {tgt_name}: {sample}")
                continue

            await send_log(f"[{target_object}] Picklist Sync: creating {len(missing)} missing value(s) in {tgt_name}: {sample}")
            try:
                added = await provider.add(target, target_object, tgt_name, info, missing)
                created[tgt_name] = added
                await send_log(f"[{target_object}] Picklist Sync: {tgt_name} updated ({len(added)} value(s) added).")
            except (PicklistSyncError, httpx.HTTPError) as e:
                logger.warning("CSV picklist sync failed for %s.%s: %s", target_object, tgt_name, e)
                failed[tgt_name] = str(e)
                await send_log(f"[{target_object}] Picklist Sync failed for {tgt_name}: {e}")

        return result()