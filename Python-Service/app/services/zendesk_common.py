"""
Shared Zendesk helpers: subdomain handling, object classification, record flattening and the
system-field catalog. Used by the migrator, metadata, query preview, file adapter and payload builder
so extraction, preview and mapping always agree on field names.

Field naming (what the mapping UI sees and the payload builder consumes):
  tickets        custom_field_<id>            -> ticket.custom_fields[{id, value}]
  users          user_field_<key>             -> user.user_fields{key: value}
  organizations  organization_field_<key>     -> organization.organization_fields{key: value}
  custom objects <field key>                  -> record.custom_object_fields{key: value}
"""
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

STANDARD_OBJECTS = ("tickets", "users", "organizations", "groups", "macros", "triggers", "views")
SEARCH_EXPORT_TYPES = {"tickets": "ticket", "users": "user", "organizations": "organization"}
LIST_ENDPOINT_OBJECTS = ("groups", "macros", "triggers", "views")
WRITABLE_STANDARD = ("tickets", "users", "organizations", "groups")   # macros/triggers/views are source-only

_SUBDOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def normalize_subdomain(value: Optional[str]) -> str:
    """'acme', 'acme.zendesk.com' or 'https://acme.zendesk.com/x' -> 'acme'. ValueError if it is not a valid subdomain."""
    s = (value or "").strip().lower()
    s = re.sub(r"^https?://", "", s).split("/")[0].split("?")[0].split("#")[0]
    if s.endswith(".zendesk.com"):
        s = s[: -len(".zendesk.com")]
    if not _SUBDOMAIN_RE.fullmatch(s):
        raise ValueError(f"'{value}' is not a valid Zendesk subdomain.")
    return s


def resolve_subdomain(creds: Dict[str, Any]) -> str:
    for key in ("subdomain", "instance_url", "api_domain"):
        if creds.get(key):
            return normalize_subdomain(creds[key])
    raise ValueError("No Zendesk subdomain on this connection.")


def api_base(subdomain: str) -> str:
    return f"https://{normalize_subdomain(subdomain)}.zendesk.com/api/v2"


def classify_object(name: str) -> Tuple[str, str]:
    """('standard', 'tickets') for tickets/ticket/..., ('custom', '<object key>') otherwise."""
    n = (name or "").strip().lower()
    for plural in STANDARD_OBJECTS:
        if n in (plural, plural[:-1]):
            return "standard", plural
    return "custom", n


def singular(plural: str) -> str:
    return plural[:-1] if plural.endswith("s") else plural


def _flatten_value(v: Any) -> Any:
    if isinstance(v, dict):
        if "id" in v:
            return v["id"]
        if "name" in v:
            return v["name"]
        return json.dumps(v, default=str)
    if isinstance(v, list):
        return ";".join(
            str(i.get("id", i.get("name", json.dumps(i, default=str)))) if isinstance(i, dict) else str(i) for i in v
        )
    return v


def flatten_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    """One Zendesk record -> flat dict with the field names documented at the top of this module."""
    flat: Dict[str, Any] = {}
    for k, v in rec.items():
        if k == "custom_fields" and isinstance(v, list):
            for cf in v:
                if isinstance(cf, dict) and cf.get("id") is not None:
                    flat[f"custom_field_{cf['id']}"] = _flatten_value(cf.get("value"))
        elif k == "user_fields" and isinstance(v, dict):
            for fk, fv in v.items():
                flat[f"user_field_{fk}"] = _flatten_value(fv)
        elif k == "organization_fields" and isinstance(v, dict):
            for fk, fv in v.items():
                flat[f"organization_field_{fk}"] = _flatten_value(fv)
        elif k == "custom_object_fields" and isinstance(v, dict):
            for fk, fv in v.items():
                flat[fk] = _flatten_value(fv)
        else:
            flat[k] = _flatten_value(v)
    return flat


# --------------------------------------------------------------------------------------------
# System-field catalog. Metadata no longer depends on sample records, so an empty account still
# exposes every field, and read-only fields are flagged correctly for the FLS guard.
# (name, label, type, required, writable, referenceTo, options)
# --------------------------------------------------------------------------------------------
_TICKET_STATUS = ["new", "open", "pending", "hold", "solved", "closed"]
_TICKET_PRIORITY = ["low", "normal", "high", "urgent"]
_TICKET_TYPE = ["question", "incident", "problem", "task"]
_USER_ROLE = ["end-user", "agent", "admin"]

_F = lambda name, label, type_="string", required=False, writable=True, ref=None, options=None: (  # noqa: E731
    name, label, type_, required, writable, ref, options)

SYSTEM_FIELDS: Dict[str, List[tuple]] = {
    "tickets": [
        _F("id", "Ticket ID", "number", writable=False),
        _F("subject", "Subject"), _F("description", "Description", "textarea"),
        _F("status", "Status", "picklist", options=_TICKET_STATUS),
        _F("priority", "Priority", "picklist", options=_TICKET_PRIORITY),
        _F("type", "Type", "picklist", options=_TICKET_TYPE),
        _F("requester_id", "Requester", "reference", ref=["users"]),
        _F("submitter_id", "Submitter", "reference", ref=["users"]),
        _F("assignee_id", "Assignee", "reference", ref=["users"]),
        _F("organization_id", "Organization", "reference", ref=["organizations"]),
        _F("group_id", "Group", "reference", ref=["groups"]),
        _F("problem_id", "Linked Problem", "reference", ref=["tickets"]),
        _F("external_id", "External ID"), _F("tags", "Tags", "multipicklist"),
        _F("due_at", "Due Date", "datetime"), _F("recipient", "Recipient Email", "email"),
        _F("brand_id", "Brand", "number"), _F("ticket_form_id", "Ticket Form", "number"),
        _F("created_at", "Created At", "datetime"), _F("updated_at", "Updated At", "datetime"),
        _F("solved_at", "Solved At", "datetime"),
        _F("url", "URL", writable=False), _F("generated_timestamp", "Generated Timestamp", "number", writable=False),
        _F("via", "Channel", writable=False), _F("has_incidents", "Has Incidents", "boolean", writable=False),
    ],
    "users": [
        _F("id", "User ID", "number", writable=False),
        _F("name", "Name", required=True), _F("email", "Email", "email"), _F("phone", "Phone"),
        _F("role", "Role", "picklist", options=_USER_ROLE),
        _F("organization_id", "Organization", "reference", ref=["organizations"]),
        _F("default_group_id", "Default Group", "reference", ref=["groups"]),
        _F("external_id", "External ID"), _F("alias", "Alias"), _F("details", "Details", "textarea"),
        _F("notes", "Notes", "textarea"), _F("time_zone", "Time Zone"), _F("locale", "Locale"),
        _F("tags", "Tags", "multipicklist"), _F("verified", "Verified", "boolean"),
        _F("suspended", "Suspended", "boolean"), _F("custom_role_id", "Custom Role", "number"),
        _F("shared_phone_number", "Shared Phone Number", "boolean"),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False),
        _F("last_login_at", "Last Login", "datetime", writable=False),
        _F("active", "Active", "boolean", writable=False), _F("url", "URL", writable=False),
    ],
    "organizations": [
        _F("id", "Organization ID", "number", writable=False),
        _F("name", "Name", required=True), _F("external_id", "External ID"),
        _F("details", "Details", "textarea"), _F("notes", "Notes", "textarea"),
        _F("domain_names", "Domain Names", "multipicklist"), _F("tags", "Tags", "multipicklist"),
        _F("group_id", "Group", "reference", ref=["groups"]),
        _F("shared_tickets", "Shared Tickets", "boolean"), _F("shared_comments", "Shared Comments", "boolean"),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False), _F("url", "URL", writable=False),
    ],
    "groups": [
        _F("id", "Group ID", "number", writable=False),
        _F("name", "Name", required=True), _F("description", "Description", "textarea"),
        _F("is_public", "Is Public", "boolean"),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False), _F("url", "URL", writable=False),
    ],
    "macros": [
        _F("id", "Macro ID", "number", writable=False), _F("title", "Title", writable=False),
        _F("active", "Active", "boolean", writable=False), _F("description", "Description", writable=False),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False),
    ],
    "triggers": [
        _F("id", "Trigger ID", "number", writable=False), _F("title", "Title", writable=False),
        _F("active", "Active", "boolean", writable=False), _F("position", "Position", "number", writable=False),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False),
    ],
    "views": [
        _F("id", "View ID", "number", writable=False), _F("title", "Title", writable=False),
        _F("active", "Active", "boolean", writable=False), _F("position", "Position", "number", writable=False),
        _F("created_at", "Created At", "datetime", writable=False),
        _F("updated_at", "Updated At", "datetime", writable=False),
    ],
}

CUSTOM_OBJECT_SYSTEM_FIELDS: List[tuple] = [
    _F("id", "Record ID", writable=False), _F("name", "Name"), _F("external_id", "External ID"),
    _F("created_at", "Created At", "datetime", writable=False), _F("updated_at", "Updated At", "datetime", writable=False),
]

# Zendesk custom-field / custom-object-field type -> the type names the rest of the tool already understands
FIELD_TYPE_MAP = {
    "text": "string", "textarea": "textarea", "tagger": "picklist", "dropdown": "picklist",
    "multiselect": "multipicklist", "checkbox": "boolean", "integer": "integer", "decimal": "double",
    "date": "date", "regexp": "regexp", "lookup": "reference",
    "partialcreditcard": "string", "multiline": "textarea",
}

# ticket-field types that are SYSTEM fields (their ids look custom but they must not be written as custom_fields)
SYSTEM_TICKET_FIELD_TYPES = {
    "subject", "description", "status", "tickettype", "priority", "group", "assignee", "custom_status",
    "basic_priority", "partialcreditcard",
}

LOOKUP_TARGETS = {"zen:user": "users", "zen:organization": "organizations", "zen:ticket": "tickets"}


def lookup_target(relationship_target_type: Optional[str]) -> Optional[str]:
    if not relationship_target_type:
        return None
    if relationship_target_type in LOOKUP_TARGETS:
        return LOOKUP_TARGETS[relationship_target_type]
    if relationship_target_type.startswith("zen:custom_object:"):
        return relationship_target_type.split(":", 2)[2]
    return None


def in_time_bounds(rec: Dict[str, Any], bounds) -> bool:
    """Client-side date filter: bounds = (field, start_dt, end_dt) from time_filter_service.zendesk_time_bounds (naive UTC)."""
    if not bounds:
        return True
    field, start, end = bounds
    raw = rec.get(field)
    if not raw:
        return False
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return False
    if dt.tzinfo:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return start <= dt <= end