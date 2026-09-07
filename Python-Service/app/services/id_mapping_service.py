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
"""
import os
import sqlite3
from typing import Dict, List, Tuple

BASE_ID_MAP_DIR = os.path.join(os.getcwd(), "SureShift_id_maps")


class IdMappingService:

    @staticmethod
    def _db_path(user_id: str) -> str:
        # user_id comes from Supabase auth (a UUID) but sanitize anyway
        # before it touches a filesystem path.
        safe_user_id = "".join(c for c in (user_id or "") if c.isalnum() or c in ("-", "_")) or "unknown_user"
        os.makedirs(BASE_ID_MAP_DIR, exist_ok=True)
        return os.path.join(BASE_ID_MAP_DIR, f"{safe_user_id}.db")

    @staticmethod
    def _connect(user_id: str) -> sqlite3.Connection:
        conn = sqlite3.connect(IdMappingService._db_path(user_id))
        conn.execute("""
            CREATE TABLE IF NOT EXISTS id_mappings (
                source_crm  TEXT NOT NULL,
                target_crm  TEXT NOT NULL,
                object_name TEXT NOT NULL,
                source_id   TEXT NOT NULL,
                target_id   TEXT NOT NULL,
                updated_at  TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (source_crm, target_crm, object_name, source_id)
            )
        """)
        return conn

    @staticmethod
    def save_mappings(
        user_id: str,
        source_crm: str,
        target_crm: str,
        object_name: str,
        pairs: List[Tuple[str, str]]
    ) -> int:
        """
        Upserts (source_id -> target_id) pairs for one object migrated
        between one specific source/target CRM pair. ON CONFLICT ... DO
        UPDATE (last-write-wins) rather than erroring, so re-running an
        object's migration (e.g. after fixing validation errors, or a
        second incremental sync) keeps the map current instead of failing
        on the duplicate primary key.

        Returns the number of pairs actually written -- rows with a
        missing/empty source_id or target_id are silently dropped and not
        counted, same "fail the row, not the batch" posture used
        everywhere else in this pipeline (see payload_builder.py,
        field_access_utils.py).
        """
        clean_pairs = [
            (str(sid), str(tid)) for sid, tid in pairs if sid not in (None, "") and tid not in (None, "")
        ]
        if not clean_pairs:
            return 0

        conn = IdMappingService._connect(user_id)
        try:
            conn.executemany(
                """
                INSERT INTO id_mappings (source_crm, target_crm, object_name, source_id, target_id, updated_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(source_crm, target_crm, object_name, source_id)
                DO UPDATE SET target_id = excluded.target_id, updated_at = excluded.updated_at
                """,
                [(source_crm.lower(), target_crm.lower(), object_name, sid, tid) for sid, tid in clean_pairs]
            )
            conn.commit()
            return len(clean_pairs)
        finally:
            conn.close()

    @staticmethod
    def get_mapping(user_id: str, source_crm: str, target_crm: str, object_name: str) -> Dict[str, str]:
        """
        Returns {source_id: target_id} for every pair migrated so far for
        this object between this specific CRM pair. Loaded in one shot
        rather than per-lookup -- a single migration batch typically needs
        to resolve hundreds/thousands of reference values at once.
        """
        conn = IdMappingService._connect(user_id)
        try:
            cursor = conn.execute(
                "SELECT source_id, target_id FROM id_mappings WHERE source_crm = ? AND target_crm = ? AND object_name = ?",
                (source_crm.lower(), target_crm.lower(), object_name)
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
        object the field's `referenceTo`/`parentObjectName` points at.

        A source value with no entry in the map (parent record was never
        migrated through this tool, or hasn't been yet) is left completely
        untouched -- the raw source Id goes through as-is, and the target
        CRM's own "no such record"/"invalid reference" rejection surfaces
        it as a normal per-row error, exactly like any other bad value,
        rather than this function silently blanking it out or failing the
        whole batch over one unresolved row.

        Call this AFTER extraction, BEFORE PayloadBuilderService.build_payload().
        """
        reference_mappings = [
            m for m in mappings
            if m.get("type") == "reference" and (m.get("relationalExtIdField") or "id").lower() == "id"
        ]
        if not reference_mappings:
            return

        maps_by_parent: Dict[str, Dict[str, str]] = {}
        for m in reference_mappings:
            parent = m.get("parentObjectName") or next(iter(m.get("referenceTo") or []), None)
            if not parent or parent in maps_by_parent:
                continue
            maps_by_parent[parent] = IdMappingService.get_mapping(user_id, source_crm, target_crm, parent)

        remapped_count = 0
        for m in reference_mappings:
            parent = m.get("parentObjectName") or next(iter(m.get("referenceTo") or []), None)
            id_map = maps_by_parent.get(parent) or {}
            if not id_map:
                continue
            source_field = m.get("sourceField") or m.get("csvField")
            if not source_field:
                continue
            for row in source_records:
                old_val = row.get(source_field)
                if old_val is not None and str(old_val) in id_map:
                    row[source_field] = id_map[str(old_val)]
                    remapped_count += 1

        if send_log and remapped_count:
            await send_log(
                f"[Reference Remap] Translated {remapped_count} reference value(s) to their "
                f"previously-migrated target Ids using the saved Id map."
            )