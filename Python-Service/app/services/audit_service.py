import os
import json
import tempfile
import csv
import logging
from datetime import datetime
from collections import Counter
from fpdf import FPDF
from supabase import create_client
from app.utils.config import supabase, SUPABASE_URL, SUPABASE_KEY

logger = logging.getLogger(__name__)


ERROR_CATEGORIES = [
    ("Duplicate Record", ["duplicate", "already exists", "duplicate_value"]),
    ("Required Field Missing", ["required", "cannot be blank", "is required", "required_field_missing"]),
    ("Invalid Reference / Lookup", ["invalid cross reference", "no matching", "foreign key", "invalid lookup", "reference to a record"]),
    ("Permission / Field-Level Security", ["insufficient access", "permission", "not authorized", "field_custom_validation", "fls", "unable to access"]),
    ("Validation Rule Failed", ["validation rule", "field_custom_validation_exception"]),
    ("Invalid Value / Format", ["invalid", "malformed", "picklist", "invalid_field", "bad format", "value provided"]),
    ("Rate Limit / API Budget", ["rate limit", "request_limit_exceeded", "too many requests", "api limit"]),
    ("Authentication / Session", ["invalid_session_id", "unauthorized", "expired token", "invalid token", "session expired"]),
]


class AuditService:

    # ==========================================
    # ERROR CATEGORIZATION
    # ==========================================
    @staticmethod
    def categorize_error(error_message: str) -> str:
        msg = (error_message or "").lower()
        for category, keywords in ERROR_CATEGORIES:
            if any(kw in msg for kw in keywords):
                return category
        return "Other API Error"

    @staticmethod
    def build_error_summary(error_data: list, top_n: int = 8) -> list:
        if not error_data:
            return []

        counts = Counter()
        samples = {}
        for err in error_data:
            message = err.get("error") if isinstance(err, dict) else str(err)
            category = AuditService.categorize_error(message)
            counts[category] += 1
            if category not in samples:
                samples[category] = message

        ranked = counts.most_common()
        top = ranked[:top_n]
        rest_count = sum(c for _, c in ranked[top_n:])

        summary = [
            {"category": cat, "count": count, "sample": samples[cat]}
            for cat, count in top
        ]
        if rest_count:
            summary.append({"category": "Other", "count": rest_count, "sample": None})
        return summary

    # ==========================================
    # PDF TEXT SANITIZATION
    # ==========================================
    @staticmethod
    def _sanitize_pdf_text(text) -> str:
        """FPDF's core fonts (Arial/Helvetica/Times/Courier) only support
        latin-1. Any character outside that range -- curly quotes, em/en
        dashes, non-Latin scripts in a CRM error message or a Zoho/HubSpot
        object label -- either raises inside fpdf2 or writes corrupt bytes
        on classic PyFPDF, producing a PDF the browser can't parse at all.
        Replacing common "smart" punctuation with ASCII equivalents first
        keeps normal error text readable; anything left outside latin-1
        after that gets replaced with '?' rather than crashing report
        generation entirely."""
        if text is None:
            return ""
        s = str(text)
        replacements = {
            "\u2018": "'", "\u2019": "'",   # ' '
            "\u201c": '"', "\u201d": '"',   # " "
            "\u2013": "-", "\u2014": "-",   # – —
            "\u2026": "...",                 # …
            "\u00a0": " ",                   # nbsp
        }
        for src, dst in replacements.items():
            s = s.replace(src, dst)
        return s.encode("latin-1", "replace").decode("latin-1")

    # ==========================================
    # EFFECTIVE QUERY RECONSTRUCTION (for audit/debug visibility)
    # ==========================================
    @staticmethod
    def _build_effective_query(source_crm: str, target_object: str, extraction_query: str, time_filter: dict = None) -> str:
        """Best-effort reconstruction of the *actual* query sent to the
        source CRM -- i.e. the user's raw extraction_query merged with the
        migrationTimeFilter date range, mirroring what CrmQueryService does
        at extraction time (see execute_salesforce_query / _salesforce_count
        etc.). This exists purely for audit/debug visibility in the report,
        so any failure here falls back to the raw query instead of blocking
        PDF generation -- it must never be the reason a report fails.

        Caveat: for a multi-job migration queue this is only ever called
        with the LAST job's extraction_query/time_filter (that's what the
        route currently threads through to generate_and_save_reports), so
        on multi-object migrations the "full query" line reflects the last
        object synced, not every job in the queue."""
        query = (extraction_query or "").strip()
        no_query_label = "(no query filter -- full object export)"

        if not time_filter:
            return query or no_query_label

        try:
            from app.services.time_filter_service import (
                build_salesforce_time_clause, build_zoho_time_clause,
                build_zendesk_time_clause, build_hubspot_time_filters,
                merge_time_clause,
            )

            crm = (source_crm or "").lower()

            if crm == "salesforce":
                time_clause = build_salesforce_time_clause(time_filter)
                if not time_clause:
                    return query or no_query_label
                if query.lower().startswith("select "):
                    return merge_time_clause(query, time_clause, where_kw="WHERE", and_kw="AND")
                where_parts = [p for p in [f"({query})" if query else None, time_clause] if p]
                return f"SELECT * FROM {target_object} WHERE {' AND '.join(where_parts)}"

            elif crm == "zoho":
                time_clause = build_zoho_time_clause(time_filter)
                if not time_clause:
                    return query or no_query_label
                if query.lower().startswith("select "):
                    return merge_time_clause(query, time_clause, where_kw="where", and_kw="and")
                where_parts = [p for p in [f"({query})" if query else None, time_clause] if p]
                return f"select * from {target_object} where {' and '.join(where_parts)}"

            elif crm == "zendesk":
                time_clause = build_zendesk_time_clause(time_filter)
                parts = [p for p in [query, time_clause] if p]
                return " ".join(parts) if parts else no_query_label

            elif crm == "hubspot":
                time_filters = build_hubspot_time_filters(time_filter)
                base = query or "{}"
                return f"{base}  |  time filters: {json.dumps(time_filters)}" if time_filters else base

            else:
                return query or no_query_label

        except Exception:
            logger.warning(
                "[AUDIT] Could not reconstruct effective query for source_crm=%s -- "
                "falling back to raw extraction_query.", source_crm, exc_info=True
            )
            return query or no_query_label

    # ==========================================
    # SHARED STORAGE UPLOAD HELPER
    # ==========================================
    @staticmethod
    def _upload_file(local_path: str, storage_path: str, content_type: str, disposition: str, bucket: str = "migration_reports") -> str:
        """Single upload path for both PDF and CSV so the
        content-type/content-disposition logic can't drift out of sync
        between the two again. `disposition` is either 'inline' (render in
        browser -- PDFs) or 'attachment' (force download -- CSVs)."""
        filename = os.path.basename(storage_path)
        with open(local_path, "rb") as f:
            supabase.storage.from_(bucket).upload(
                storage_path,
                f,
                file_options={
                    "x-upsert": "true",
                    "content-type": content_type,
                    "content-disposition": f'{disposition}; filename="{filename}"',
                }
            )
        return supabase.storage.from_(bucket).get_public_url(storage_path)

    @staticmethod
    def _upload_csv(rows: list, fieldnames: list, storage_path: str, bucket: str = "migration_reports") -> str:
        """'utf-8-sig' writes a UTF-8 BOM, which is what makes Excel
        auto-detect the encoding and render special characters correctly
        instead of showing mojibake or dumping everything into column A."""
        filename = os.path.basename(storage_path)
        tmp_path = os.path.join(tempfile.gettempdir(), filename)

        with open(tmp_path, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
            writer.writeheader()
            writer.writerows(rows)

        url = AuditService._upload_file(
            tmp_path, storage_path,
            content_type="text/csv; charset=utf-8",
            disposition="attachment",   # CSVs always download straight to Excel
            bucket=bucket,
        )
        os.remove(tmp_path)
        return url

    # ==========================================
    # MIGRATION REPORTS
    # ==========================================
    @staticmethod
    def generate_and_save_reports(user_id: str, session_id: str, source_crm: str, target_crm: str, target_object: str, success_data: list, error_data: list, auth_token: str, extraction_query: str = "", time_filter: dict = None, op_mode: str = "", user_email: str = None, source_mode: str = None, actual_query_used: str = None):
        success_count = len(success_data)
        error_count = len(error_data)
        total = success_count + error_count

        urls = {"pdf": None, "success_csv": None, "error_csv": None}
        error_summary = AuditService.build_error_summary(error_data)

        run_timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        extraction_mode = source_mode or ("CSV Upload" if (source_crm or "").lower() == "csv" else "Direct API Sync")

        effective_query = actual_query_used or AuditService._build_effective_query(source_crm, target_object, extraction_query, time_filter)

        # ==========================================
        # 1. GENERATE & UPLOAD PDF SUMMARY
        # ==========================================
        try:
            s = AuditService._sanitize_pdf_text

            pdf = FPDF()
            pdf.add_page()
            pdf.set_font("Arial", size=16, style="B")
            pdf.cell(200, 10, txt=s("Migration Audit Report"), ln=True, align="C")
            pdf.set_font("Arial", size=12)
            pdf.cell(200, 10, txt=s(f"Session ID: {session_id}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Run By: {user_email or user_id}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Generated At: {run_timestamp}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Source: {source_crm.capitalize()} -> Target: {target_crm.capitalize()}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Object: {target_object}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Extraction Mode: {extraction_mode}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Operation Mode: {op_mode}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Successful Records: {success_count}"), ln=True)
            pdf.cell(200, 10, txt=s(f"Failed Records: {error_count}"), ln=True)


            pdf.ln(2)
            pdf.set_font("Arial", size=11, style="B")
            pdf.cell(200, 8, txt=s("Full Query Used (incl. filters):"), ln=True)
            pdf.set_font("Arial", size=10)
            pdf.multi_cell(190, 6, txt=s(effective_query))
            pdf.set_font("Arial", size=12)

            if error_summary:
                pdf.ln(4)
                pdf.set_font("Arial", size=13, style="B")
                pdf.cell(200, 10, txt=s("Top Error Categories"), ln=True)
                pdf.set_font("Arial", size=11)
                for item in error_summary:
                    pdf.cell(200, 8, txt=s(f"- {item['category']}: {item['count']}"), ln=True)

            temp_pdf = os.path.join(tempfile.gettempdir(), f"{session_id}.pdf")
            pdf.output(temp_pdf)

            pdf_filename = f"{session_id}.pdf"
            urls["pdf"] = AuditService._upload_file(
                temp_pdf, f"{user_id}/{pdf_filename}",
                content_type="application/pdf",
                disposition="inline",
            )
            os.remove(temp_pdf)
        except Exception:
            logger.exception(
                "[AUDIT] PDF summary generation/upload failed for session %s -- "
                "continuing without it so the history row still gets saved.", session_id
            )

        # ==========================================
        # 2. GENERATE & UPLOAD SUCCESS CSV
        # ==========================================
        try:
            if success_count > 0:
                fieldnames = list(success_data[0].keys())
                urls["success_csv"] = AuditService._upload_csv(
                    success_data, fieldnames, f"{user_id}/{session_id}_success.csv"
                )
        except Exception:
            logger.exception(
                "[AUDIT] Success CSV generation/upload failed for session %s -- "
                "continuing without it so the history row still gets saved.", session_id
            )

        # ==========================================
        # 3. GENERATE & UPLOAD ERROR CSV
        # ==========================================
        try:
            if error_count > 0:
                flat_errors = []
                for err in error_data:
                    flat_rec = dict(err.get("record", {}))
                    flat_rec["Migration_Error_Message"] = err.get("error", "Unknown Error")
                    flat_errors.append(flat_rec)

                fieldnames = ["Migration_Error_Message"] + [k for k in flat_errors[0].keys() if k != "Migration_Error_Message"]
                urls["error_csv"] = AuditService._upload_csv(
                    flat_errors, fieldnames, f"{user_id}/{session_id}_error.csv"
                )
        except Exception:
            logger.exception(
                "[AUDIT] Error CSV generation/upload failed for session %s -- "
                "continuing without it so the history row still gets saved.", session_id
            )

        # ==========================================
        # 4. SAVE TO DATABASE
        # ==========================================
        scoped_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        scoped_client.auth.set_session(access_token=auth_token, refresh_token="")

        scoped_client.table("migration_history").insert({
            "user_id": user_id,
            "session_id": session_id,
            "source_crm": source_crm,
            "target_crm": target_crm,
            "target_object": target_object,
            "total_records": total,
            "success_count": success_count,
            "error_count": error_count,
            "pdf_url": urls["pdf"],
            "success_csv_url": urls["success_csv"],
            "error_csv_url": urls["error_csv"],
            "error_summary": error_summary,
        }).execute()

        return urls

    # ==========================================
    # VALIDATION REPORTS
    # ==========================================
    @staticmethod
    def generate_and_save_validation_report(
        user_id: str,
        session_id: str,
        source_crm: str,
        target_crm: str,
        target_object: str,
        stats: dict,
        invalid_records: list,
        auth_token: str,
    ):
        invalid_csv_url = None
        valid_csv_url = None
        error_like = [{"record": rec.get("originalRow", {}), "error": rec.get("errors", "")} for rec in invalid_records]
        error_summary = AuditService.build_error_summary(error_like)

        try:
            if invalid_records:
                flat_rows = []
                for rec in invalid_records:
                    flat_rec = dict(rec.get("originalRow", {}))
                    flat_rec.pop("_db_id", None)
                    flat_rec["Validation_Errors"] = rec.get("errors", "")
                    flat_rows.append(flat_rec)

                fieldnames = ["Validation_Errors"] + [k for k in flat_rows[0].keys() if k != "Validation_Errors"]
                invalid_csv_url = AuditService._upload_csv(
                    flat_rows, fieldnames, f"{user_id}/{session_id}_validation_invalid.csv",
                    bucket="migration_reports",
                )
        except Exception:
            logger.exception(
                "[AUDIT] Invalid-records CSV generation/upload failed for session %s -- "
                "continuing without it so the history row still gets saved.", session_id
            )

        scoped_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        scoped_client.auth.set_session(access_token=auth_token, refresh_token="")

        row = {
            "user_id": user_id,
            "session_id": session_id,
            "source_crm": source_crm,
            "target_crm": target_crm,
            "target_object": target_object,
            "total_records": stats.get("total", 0),
            "valid_count": stats.get("valid", 0),
            "invalid_count": stats.get("invalid", 0),
            "duplicate_count": stats.get("duplicates", 0),
            "invalid_csv_url": invalid_csv_url,
            "valid_csv_url": valid_csv_url,
            "error_summary": error_summary,
        }

        AuditService._save_validation_row(scoped_client, session_id, row)

        return {"invalid_csv_url": invalid_csv_url,"valid_csv_url": valid_csv_url, "error_summary": error_summary}

    @staticmethod
    def _save_validation_row(scoped_client, session_id: str, row: dict) -> None:
        """Writes one row to validation_history, keyed by session_id (a
        re-validation pass overwrites the row from the initial pass rather
        than adding a second one).

        `.upsert(..., on_conflict="session_id")` only works if `session_id`
        has a UNIQUE constraint in Postgres -- without it Postgrest raises
        42P10 ("no unique or exclusion constraint matching the ON CONFLICT
        specification") and the *entire* insert is rejected. That failure
        was previously only caught by a bare `except Exception` at the
        call site in migration_routes.py and printed to the server log, so
        every validation run silently failed to persist and the
        Validations tab in the history UI stayed empty forever with no
        visible error anywhere.

        This tries the fast upsert path first (works once the unique
        constraint is added -- see the migration note in this file's
        module docstring/README), and falls back to an explicit
        select-then-update-or-insert if the DB doesn't have that
        constraint, so a validation run is never silently lost either way.
        """
        try:
            scoped_client.table("validation_history").upsert(row, on_conflict="session_id").execute()
            return
        except Exception as e:

            error_code = getattr(e, "code", None)
            if error_code != "42P10":
                logger.exception(
                    "[AUDIT] validation_history upsert failed for session %s: %s", session_id, e
                )
                raise
            logger.warning(
                "[AUDIT] validation_history.session_id has no UNIQUE constraint (Postgrest 42P10) -- "
                "falling back to manual select+insert/update for session %s. Add "
                "`ALTER TABLE validation_history ADD CONSTRAINT validation_history_session_id_key "
                "UNIQUE (session_id);` to restore the fast upsert path.",
                session_id,
            )

        existing = (
            scoped_client.table("validation_history")
            .select("id")
            .eq("session_id", session_id)
            .limit(1)
            .execute()
        )
        if existing.data:
            scoped_client.table("validation_history").update(row).eq("session_id", session_id).execute()
        else:
            scoped_client.table("validation_history").insert(row).execute()