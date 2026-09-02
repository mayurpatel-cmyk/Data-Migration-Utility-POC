"""
Field-level access (FLS) guard for mapped target fields.

Salesforce (and, to the extent each CRM exposes it, Zoho/HubSpot) enforces
field-level security independently of object-level CRUD permissions: a
user's profile/permission set can grant them access to an object while
still denying create and/or edit rights on individual fields.
crm_metadata_service.py already surfaces this per field as `createable` /
`updateable` booleans pulled straight from each CRM's describe/fields
metadata when the mapping UI first loads the target object's fields.

Without a check here, a field the connected user can't write to sails
straight through mapping and validation, and the failure only surfaces
when the target CRM's insert/update API call actually rejects the record
-- per record, deep into a possibly multi-hour migration, after
everything else about that row was already good.

This is meant to run BEFORE extraction/validation starts (see
migration_routes.py's `/ws/validate-stream` handler), using the `sfRules`
field-metadata dict the frontend already sends alongside every mapping
payload -- the same dict validator_service.py consults for type/
required-field checks. No extra CRM call is needed: the metadata was
already fetched when the mapping UI loaded.
"""
from typing import Dict, List


def find_non_writable_mapped_fields(
    mappings: List[dict],
    sf_rules: Dict[str, dict],
    operation_mode: str
) -> List[dict]:
    """
    Returns one entry per mapped target field the connected user cannot
    write to for the given operation_mode, as:
        {"field": <api name>, "label": <display label>, "reason": <str>}

    Which flag gates which mode:
      - insert            -> requires `createable`
      - update / upsert   -> requires `updateable`. Upsert can insert OR
        update a given row, but we gate it on `updateable` alone (the
        stricter of the two) rather than also requiring `createable` --
        requiring both would reject a legitimate update-only field (one
        an admin deliberately locked from creation, e.g. a field only
        ever set post-creation by automation) just because upsert could
        theoretically also insert.
      - delete             -> no field values are written at all, only
        the match key is read; nothing to check.

    A mapped field missing from sf_rules entirely (shouldn't happen in
    practice -- sf_rules is built from the same targetFields list the
    mapping UI populated its dropdown from -- but defensive rather than
    letting a KeyError take down validation) is treated as writable and
    skipped: we only fail closed on an explicit `False`, never on the
    field being unknown or on the flag being absent from the metadata,
    since some CRMs/field-types simply don't carry an FLS signal for
    every entry.

    Deduplicates by target field name so a field mapped from two source
    columns (or reappearing across mapping arrays merged upstream) only
    produces one violation entry.
    """
    if operation_mode == "delete":
        return []

    flag = "createable" if operation_mode == "insert" else "updateable"
    verb = "created" if operation_mode == "insert" else "updated"

    violations: List[dict] = []
    seen_fields = set()

    for mapping in mappings:
        target_field = mapping.get("targetField") or mapping.get("sfField")
        if not target_field or target_field in seen_fields:
            continue

        rule = sf_rules.get(target_field)
        if not rule:
            continue

        if rule.get(flag) is False:
            seen_fields.add(target_field)
            label = rule.get("label") or target_field
            violations.append({
                "field": target_field,
                "label": label,
                "reason": (
                    f"'{label}' ({target_field}) can't be {verb} by the connected account -- "
                    f"it's read-only for this user/profile in the target CRM. Remove it from "
                    f"the mapping, or connect with a user that has field-level write access."
                )
            })

    return violations