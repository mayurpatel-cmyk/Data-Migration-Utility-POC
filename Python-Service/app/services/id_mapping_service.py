"""
Persists old_source_id -> new_target_id record mappings across SEPARATE
migration runs, backed by a per-user SQLite database.

Why this exists: the API-based single-object mapping flow only ever submits
one job at a time (`payload = { queue: [job] }` in API-mapping_component.ts),
so migration_routes.py's `sort_jobs_by_dependency()` -- which reorders and
auto-splits reference fields across a multi-job *queue* -- never has more
than one job to work with there. Migrating a parent object (Contact) and a
dependent object (Account, with a lookup to Contact) as two separate
sessions still needs SOME way for the second run's reference field to
resolve to the *new* Contact Id the first run actually created in the
target org.

This is that mechanism -- an alternative to the `relationalExtIdField`
shared-external-id-field path already in payload_builder.py: instead of
requiring both CRMs to already carry a matching external-id field on the
related object, we just remember the (source_id -> target_id) pairing
ourselves the moment we create that record, and translate any later
reference to it automatically. No CRM-side setup required, at the cost of
needing the parent object's migration to have already run through this
tool (a record created by hand, or migrated before this existed, won't be
in the map, and is left untouched rather than guessed at).

One SQLite file per user (not per session/object like the validation
staging DBs in migration_routes.py) so a mapping written by today's Contact
run is still there next month when Account gets migrated.

Known edge cases this module handles, and how:

- Same CRM type, different physical org (a sandbox today, production next
  month -- both report crm_type "salesforce"). `source_crm`/`target_crm`
  alone can't tell those apart, so every read/write is also scoped by
  `source_instance`/`target_instance` -- whatever per-connection identifier
  the CRM exposes (Salesforce: instance_url; Zoho: api_domain; Zendesk:
  subdomain). A mapping saved against one org is invisible to a run against
  a different one, on purpose -- reusing it would mean sending an Id that
  either doesn't exist in the new org, or (far less likely, but still
  wrong) happens to collide with an unrelated record.

- Salesforce's 15-char (case-sensitive) vs 18-char (case-insensitive,
  checksum-suffixed) Id forms. SOQL extraction always returns 18-char, but
  a value arriving from anywhere else might only have the 15-char form --
  a strict string match would miss an otherwise-correct hit. Every key is
  normalized to its first 15 characters before being stored or looked up
  (Salesforce guarantees those 15 characters alone are already unique
  within an org), so either form resolves to the same entry.

- Polymorphic lookups (a field whose `referenceTo` lists more than one
  object type, e.g. a "Related To" field that can point at either Contact
  or Lead). Resolving against only `referenceTo[0]` for the whole batch
  would silently miss every row that's actually the second type. Each row
  is instead checked against every candidate parent's map in turn, so a
  batch that mixes both types resolves correctly row by row.

What this module deliberately does NOT handle (see migration_routes.py
callers and the conversation history for the manual workarounds):
  - Self-referencing lookups within the SAME batch (e.g. Account.ParentId
    pointing at another Account in the same insert) -- the map for an
    object is only written after that object's own job finishes, so a
    sibling row in the same batch has no target Id yet. Needs a manual
    two-pass run: insert without the self-ref field, then update with only
    that field mapped.
  - Staleness -- if a previously-migrated target record is later deleted
    outside this tool, the saved mapping still points at it, and the next
    run that depends on it will get a normal per-row "invalid reference"
    error from the target CRM. Nothing here detects or prunes that
    automatically.
"""
import os
import sqlite3
from typing import Any, Dict, List, Optional, Tuple

BASE_ID_MAP_DIR = os.path.join(os.getcwd(), "SureShift_id_maps")

_SF_ID_KEY_LENGTH = 15


class IdMappingService:

    @staticmethod
    def _db_path(user_id: str) -> str:
        safe_user_id = "".join(c for c in (user_id or "") if c.isalnum() or c in ("-", "_")) or "unknown_user"
        os.makedirs(BASE_ID_MAP_DIR, exist_ok=True)
        return os.path.join(BASE_ID_MAP_DIR, f"{safe_user_id}.db")

    @staticmethod
    def _connect(user_id: str) -> sqlite3.Connection:
        conn = sqlite3.connect(IdMappingService._db_path(user_id))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS id_mappings (
                source_crm      TEXT NOT NULL,
                target_crm      TEXT NOT NULL,
                source_instance TEXT NOT NULL DEFAULT '',
                target_instance TEXT NOT NULL DEFAULT '',
                object_name     TEXT NOT NULL,
                source_id       TEXT NOT NULL,
                target_id       TEXT NOT NULL,
                updated_at      TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (source_crm, target_crm, source_instance, target_instance, object_name, source_id)
            )
        """)
        IdMappingService._migrate_schema(conn)
        return conn

    @staticmethod
    def _migrate_schema(conn: sqlite3.Connection) -> None:
        """
        CREATE TABLE IF NOT EXISTS only creates the table when it's entirely
        absent -- it does NOT touch a table that already exists under an
        older layout. Since each user's id_mappings table lives in its own
        on-disk SQLite file that persists indefinitely (that's the whole
        point of this module), any file created before
        source_instance/target_instance existed is stuck on the old layout
        forever unless we patch it here.

        This can't be a plain `ALTER TABLE ... ADD COLUMN`: the old table's
        PRIMARY KEY is (source_crm, target_crm, object_name, source_id) --
        4 columns -- while save_mappings()'s `INSERT ... ON CONFLICT(source_crm,
        target_crm, source_instance, target_instance, object_name, source_id)`
        names 6. SQLite requires an ON CONFLICT target to exactly match an
        existing PRIMARY KEY or UNIQUE constraint, and ALTER TABLE cannot
        redefine a PRIMARY KEY in place. Just adding the two columns would
        trade the "no such column" crash for an immediate "ON CONFLICT
        clause does not match any PRIMARY KEY or UNIQUE constraint" crash
        instead of actually fixing anything.

        So instead: build the new-shape table under a temp name, copy every
        existing row across (source_instance/target_instance backfill to ''
        -- the same default new rows already get, and the least-surprising
        reading for a mapping saved before instance-scoping existed: treat
        it as that CRM type's one unscoped/default org, per the tradeoff
        save_mappings() already documents for omitted instance args), then
        swap it in for the old table. Old rows survive; new rows get a real
        6-column PK that ON CONFLICT can actually target.

        Guarded by PRAGMA table_info() so this only runs once per file --
        once the table has both columns (and, in practice, the rebuilt PK
        that comes with them), later connects are a no-op.
        """
        cols = conn.execute("PRAGMA table_info(id_mappings)").fetchall()
        existing_cols = {row[1] for row in cols}
        if {"source_instance", "target_instance"} <= existing_cols:
            return  # already current -- nothing to migrate

        old_cols = [row[1] for row in cols]  # preserve actual on-disk column order
        conn.execute("ALTER TABLE id_mappings RENAME TO id_mappings_old")
        conn.execute("""
            CREATE TABLE id_mappings (
                source_crm      TEXT NOT NULL,
                target_crm      TEXT NOT NULL,
                source_instance TEXT NOT NULL DEFAULT '',
                target_instance TEXT NOT NULL DEFAULT '',
                object_name     TEXT NOT NULL,
                source_id       TEXT NOT NULL,
                target_id       TEXT NOT NULL,
                updated_at      TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (source_crm, target_crm, source_instance, target_instance, object_name, source_id)
            )
        """)
        select_cols = ", ".join(
            c if c in old_cols else ("'' " if c in ("source_instance", "target_instance") else "NULL")
            for c in ("source_crm", "target_crm", "source_instance", "target_instance",
                      "object_name", "source_id", "target_id", "updated_at")
        )
        conn.execute(f"""
            INSERT OR IGNORE INTO id_mappings
                (source_crm, target_crm, source_instance, target_instance, object_name, source_id, target_id, updated_at)
            SELECT {select_cols} FROM id_mappings_old
        """)
        conn.execute("DROP TABLE id_mappings_old")
        conn.commit()

    @staticmethod
    def _normalize_id(raw_id: Any) -> str:
        """Truncates a Salesforce-length Id to its first 15 characters so the
        case-sensitive 15-char form and the checksum-suffixed 18-char form
        of the same record always land on the same key. No-ops (returns the
        value unchanged, just stringified) for anything shorter -- every
        other CRM's Ids compare in full."""
        s = str(raw_id)
        return s[:_SF_ID_KEY_LENGTH] if len(s) >= _SF_ID_KEY_LENGTH else s

    @staticmethod
    def _instance_key(instance: Optional[str]) -> str:
        return (instance or "").strip().rstrip("/").lower()

    @staticmethod
    def save_mappings(
        user_id: str,
        source_crm: str,
        target_crm: str,
        object_name: str,
        pairs: List[Tuple[str, str]],
        source_instance: Optional[str] = None,
        target_instance: Optional[str] = None,
    ) -> int:
        """
        Upserts (source_id -> target_id) pairs for one object migrated
        between one specific source/target CRM+instance pair. ON CONFLICT
        ... DO UPDATE (last-write-wins) rather than erroring, so re-running
        an object's migration (e.g. after fixing validation errors, or a
        second incremental sync) keeps the map current instead of failing
        on the duplicate primary key.

        `source_instance`/`target_instance` should be whatever
        per-connection identifier the CRM exposes (Salesforce: instance_url;
        Zoho: api_domain; Zendesk: subdomain) -- this is what keeps a
        sandbox run and a production run from colliding under the same
        generic `crm_type` string. Omitting them is supported (defaults to
        ''), but means every connection of that CRM type for this user
        shares one map -- fine for a single-org setup, risky the moment a
        second org of the same CRM type enters the picture.

        Ids are normalized (see _normalize_id) before storage so a 15-char
        and an 18-char Salesforce Id for the same record land on the same
        key regardless of which form either run happened to produce.

        Returns the number of pairs actually written -- rows with a
        missing/empty source_id or target_id are silently dropped and not
        counted, same "fail the row, not the batch" posture used
        everywhere else in this pipeline (see payload_builder.py,
        field_access_utils.py).
        """
        clean_pairs = [
            (IdMappingService._normalize_id(sid), IdMappingService._normalize_id(tid))
            for sid, tid in pairs if sid not in (None, "") and tid not in (None, "")
        ]
        if not clean_pairs:
            return 0

        src_inst = IdMappingService._instance_key(source_instance)
        tgt_inst = IdMappingService._instance_key(target_instance)

        conn = IdMappingService._connect(user_id)
        try:
            conn.executemany(
                """
                INSERT INTO id_mappings
                    (source_crm, target_crm, source_instance, target_instance, object_name, source_id, target_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(source_crm, target_crm, source_instance, target_instance, object_name, source_id)
                DO UPDATE SET target_id = excluded.target_id, updated_at = excluded.updated_at
                """,
                [
                    (source_crm.lower(), target_crm.lower(), src_inst, tgt_inst, object_name, sid, tid)
                    for sid, tid in clean_pairs
                ]
            )
            conn.commit()
            return len(clean_pairs)
        finally:
            conn.close()

    @staticmethod
    def get_mapping(
        user_id: str,
        source_crm: str,
        target_crm: str,
        object_name: str,
        source_instance: Optional[str] = None,
        target_instance: Optional[str] = None,
    ) -> Dict[str, str]:
        """
        Returns {normalized_source_id: target_id} for every pair migrated so
        far for this object, between this specific CRM+instance pair.
        Loaded in one shot rather than per-lookup -- a single migration
        batch typically needs to resolve hundreds/thousands of reference
        values at once. Keys are normalized the same way save_mappings()
        stored them, so callers should normalize any value they look up
        with _normalize_id() too (remap_reference_fields() below does this
        automatically).
        """
        conn = IdMappingService._connect(user_id)
        try:
            cursor = conn.execute(
                """
                SELECT source_id, target_id FROM id_mappings
                WHERE source_crm = ? AND target_crm = ?
                  AND source_instance = ? AND target_instance = ?
                  AND object_name = ?
                """,
                (
                    source_crm.lower(), target_crm.lower(),
                    IdMappingService._instance_key(source_instance),
                    IdMappingService._instance_key(target_instance),
                    object_name,
                )
            )
            return {row[0]: row[1] for row in cursor.fetchall()}
        finally:
            conn.close()

    @staticmethod
    async def remap_reference_fields(
        source_records: List[dict],
        mappings: List[dict],
        user_id: str,
        source_crm: str,
        target_crm: str,
        source_instance: Optional[str] = None,
        target_instance: Optional[str] = None,
        send_log=None
    ) -> None:
        """
        Mutates source_records IN PLACE: for every reference-type mapping
        that ISN'T already using the shared-external-id path
        (relationalExtIdField unset, or literally "id" -- i.e. the mapping
        is carrying a raw record Id straight through, which is also
        API-mapping_component.ts's default for any reference field the
        user hasn't explicitly configured an external-id for), replace
        that raw SOURCE org Id with whatever this SQLite map has on file
        as the corresponding TARGET org Id -- keyed off whichever parent
        object(s) the field's `referenceTo`/`parentObjectName` points at.

        A source value with no entry in the map (parent record was never
        migrated through this tool, or hasn't been yet) is left completely
        untouched -- the raw source Id goes through as-is, and the target
        CRM's own "no such record"/"invalid reference" rejection surfaces
        it as a normal per-row error, exactly like any other bad value,
        rather than this function silently blanking it out or failing the
        whole batch over one unresolved row.

        Call this AFTER extraction, BEFORE PayloadBuilderService.build_payload().

        Fully dynamic: this makes no assumption about which two objects are
        involved or how many hops apart they are. Every reference-type
        mapping is resolved independently against whatever parent object(s)
        its own `referenceTo` metadata names, so Opportunity->Account,
        Opportunity->Contact, Contact->Account, or a five-object chain all
        go through the exact same per-mapping loop below. If ONE relation
        in that chain resolves and another doesn't, the difference is data
        (was that parent actually migrated? under the same CRM+instance
        pair? does this specific field's metadata actually carry a
        referenceTo?), not the mechanism -- which is exactly what the
        per-mapping diagnostics below are for: they log each field
        independently so a "works for Account, not for Contact" report
        tells you WHICH of those questions to check, instead of just a
        single opaque total count.

        Polymorphic fields (referenceTo names MORE than one object type,
        e.g. a "Related To" field that can point at either Contact or
        Lead) are handled per ROW, not per field: since different rows in
        the same batch can legitimately reference different object types,
        each row's value is checked against every candidate parent's map
        in turn, and the first match wins. Resolving only against
        referenceTo[0] for the whole batch -- the previous behavior --
        would silently miss every row that's actually the second type.
        """
        reference_mappings = [
            m for m in mappings
            if m.get("type") == "reference" and (m.get("relationalExtIdField") or "id").lower() == "id"
        ]
        if not reference_mappings:
            return

        def _candidate_parents(m: dict) -> List[str]:
            explicit = m.get("parentObjectName")
            ref_to = list(m.get("referenceTo") or [])
            if explicit and explicit not in ref_to:
                ref_to = [explicit] + ref_to
            elif explicit:
                ref_to = [explicit] + [p for p in ref_to if p != explicit]
            return ref_to


        maps_by_parent: Dict[str, Dict[str, str]] = {}
        for m in reference_mappings:
            for parent in _candidate_parents(m):
                if parent in maps_by_parent:
                    continue
                maps_by_parent[parent] = IdMappingService.get_mapping(
                    user_id, source_crm, target_crm, parent, source_instance, target_instance
                )

        remapped_count = 0
        for m in reference_mappings:
            field_label = m.get("targetField") or m.get("sfField") or "(unnamed field)"
            source_field = m.get("sourceField") or m.get("csvField")
            candidates = _candidate_parents(m)

            if not candidates:
                if send_log:
                    await send_log(
                        f"[Reference Remap] SKIPPED '{field_label}': no parent object name found "
                        f"(mapping has no referenceTo/parentObjectName metadata). This field's target "
                        f"describe() likely isn't returning a referenceTo for it -- check "
                        f"crm_metadata_service.py's field parsing for the target object, or that the "
                        f"target field is genuinely a lookup type."
                    )
                continue

            if not source_field:
                if send_log:
                    await send_log(f"[Reference Remap] SKIPPED '{field_label}' (candidates: {candidates}): mapping has no sourceField set.")
                continue

            candidate_maps = [(p, maps_by_parent.get(p) or {}) for p in candidates]
            if not any(cm for _, cm in candidate_maps):
                if send_log:
                    await send_log(
                        f"[Reference Remap] SKIPPED '{field_label}': no saved Id map found for any of "
                        f"{candidates} under {source_crm}->{target_crm} (instance {target_instance or 'default'}). "
                        f"Either none of these have been migrated through this tool yet for this CRM+org pair, "
                        f"or they were migrated under a different source/target connection than this run is using."
                    )
                continue

            field_remapped = 0
            field_seen = 0
            per_parent_hits = {p: 0 for p, _ in candidate_maps}
            sample_unmatched = None
            for row in source_records:
                old_val = row.get(source_field)
                if old_val is None:
                    continue
                field_seen += 1
                key = IdMappingService._normalize_id(old_val)
        
                for parent, id_map in candidate_maps:
                    if key in id_map:
                        row[source_field] = id_map[key]
                        field_remapped += 1
                        per_parent_hits[parent] += 1
                        break
                else:
                    if sample_unmatched is None:
                        sample_unmatched = key

            remapped_count += field_remapped
            if send_log:
                if len(candidates) > 1:
                    breakdown = ", ".join(f"{p}: {n}" for p, n in per_parent_hits.items())
                    await send_log(f"[Reference Remap] '{field_label}' (polymorphic, candidates: {candidates}): {field_remapped}/{field_seen} resolved [{breakdown}].")
                elif field_remapped == field_seen and field_seen > 0:
                    await send_log(f"[Reference Remap] '{field_label}' (parent: {candidates[0]}): {field_remapped}/{field_seen} resolved.")
                elif field_seen > 0:
                    await send_log(
                        f"[Reference Remap] '{field_label}' (parent: {candidates[0]}): only {field_remapped}/{field_seen} resolved -- "
                        f"{field_seen - field_remapped} source value(s) had no match in the saved map(s) for {candidates} "
                        f"(e.g. '{sample_unmatched}'). Those records point at rows that either weren't part of that "
                        f"object's migration batch, or weren't migrated through this tool at all."
                    )

        if send_log and remapped_count == 0 and reference_mappings:
            await send_log(
                "[Reference Remap] 0 total values resolved across all reference fields this pass -- "
                "see the per-field lines above for why."
            )