import os
import tempfile
import csv
from collections import Counter
from fpdf import FPDF
from supabase import create_client
from app.utils.config import supabase, SUPABASE_URL, SUPABASE_KEY


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
        """Buckets a raw CRM/validation error string into a coarse category
        for the analytics dashboard. Falls back to 'Other API Error' when
        nothing recognizable matches -- that bucket is still surfaced in
        the summary so it's obvious how much error volume is
        uncategorized, rather than silently dropped."""
        msg = (error_message or "").lower()
        for category, keywords in ERROR_CATEGORIES:
            if any(kw in msg for kw in keywords):
                return category
        return "Other API Error"

    @staticmethod
    def build_error_summary(error_data: list, top_n: int = 8) -> list:
        """Turns a flat error list (each item shaped like
        {"record": {...}, "error": "<message>"}) into a small, storable
        summary: category + count + one representative sample message,
        sorted by count descending and capped at top_n categories. Extra
        volume beyond top_n is folded into a single 'Other' rollup so the
        JSON stays small enough to store inline on the migration_history /
        validation_history row -- the dashboard reads this column directly
        instead of re-parsing the full error CSV on every page load."""
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
    # SHARED CSV UPLOAD HELPER
    # ==========================================
    @staticmethod
    def _upload_csv(rows: list, fieldnames: list, storage_path: str, bucket: str = "migration_reports") -> str:
        """Writes rows to a temp CSV and uploads it to the given Supabase
        Storage bucket/path, returning its public URL. Shared by the
        migration and validation report paths so the upload/cleanup dance
        only lives in one place."""
        tmp_path = os.path.join(tempfile.gettempdir(), os.path.basename(storage_path))
        with open(tmp_path, 'w', newline='', encoding='utf-8') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

        with open(tmp_path, "rb") as f:
            supabase.storage.from_(bucket).upload(
                storage_path,
                f,
                file_options={"x-upsert": "true"}
            )
        url = supabase.storage.from_(bucket).get_public_url(storage_path)
        os.remove(tmp_path)
        return url

    # ==========================================
    # MIGRATION REPORTS
    # ==========================================
    @staticmethod
    def generate_and_save_reports(user_id: str, session_id: str, source_crm: str, target_crm: str, target_object: str, success_data: list, error_data: list, auth_token: str):
        success_count = len(success_data)
        error_count = len(error_data)
        total = success_count + error_count

        urls = {"pdf": None, "success_csv": None, "error_csv": None}
        error_summary = AuditService.build_error_summary(error_data)

        # ==========================================
        # 1. GENERATE & UPLOAD PDF SUMMARY
        # ==========================================
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Arial", size=16, style="B")
        pdf.cell(200, 10, txt="Migration Audit Report", ln=True, align='C')
        pdf.set_font("Arial", size=12)
        pdf.cell(200, 10, txt=f"Session ID: {session_id}", ln=True)
        pdf.cell(200, 10, txt=f"Source: {source_crm.capitalize()} -> Target: {target_crm.capitalize()}", ln=True)
        pdf.cell(200, 10, txt=f"Object: {target_object}", ln=True)
        pdf.cell(200, 10, txt=f"Successful Records: {success_count}", ln=True)
        pdf.cell(200, 10, txt=f"Failed Records: {error_count}", ln=True)

        if error_summary:
            pdf.ln(4)
            pdf.set_font("Arial", size=13, style="B")
            pdf.cell(200, 10, txt="Top Error Categories", ln=True)
            pdf.set_font("Arial", size=11)
            for item in error_summary:
                pdf.cell(200, 8, txt=f"- {item['category']}: {item['count']}", ln=True)

        temp_pdf = os.path.join(tempfile.gettempdir(), f"{session_id}.pdf")
        pdf.output(temp_pdf)

        with open(temp_pdf, "rb") as f:
            supabase.storage.from_("migration_reports").upload(
                f"{user_id}/{session_id}.pdf",
                f,
                file_options={"x-upsert": "true"}
            )
        urls["pdf"] = supabase.storage.from_("migration_reports").get_public_url(f"{user_id}/{session_id}.pdf")
        os.remove(temp_pdf)

        # ==========================================
        # 2. GENERATE & UPLOAD SUCCESS CSV
        # ==========================================
        if success_count > 0:
            fieldnames = list(success_data[0].keys())
            urls["success_csv"] = AuditService._upload_csv(
                success_data, fieldnames, f"{user_id}/{session_id}_success.csv"
            )

        # ==========================================
        # 3. GENERATE & UPLOAD ERROR CSV
        # ==========================================
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
        """Persists a validation run (initial or re-validation) so it shows
        up permanently in History & Analytics instead of only existing in
        the temporary staging SQLite DB, which gets cleaned up after a few
        hours. Writes the FULL invalid-record set (not just the 500-row UI
        preview) to a CSV in Supabase Storage, and upserts one row per
        session_id -- re-validating the same session overwrites its
        previous snapshot rather than creating a duplicate history entry.

        `invalid_records` is expected in the shape used elsewhere in this
        codebase: [{"originalRow": {...}, "errors": "<message>"}, ...]
        """
        invalid_csv_url = None
        error_like = [{"record": rec.get("originalRow", {}), "error": rec.get("errors", "")} for rec in invalid_records]
        error_summary = AuditService.build_error_summary(error_like)

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

        scoped_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        scoped_client.auth.set_session(access_token=auth_token, refresh_token="")

        scoped_client.table("validation_history").upsert({
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
            "error_summary": error_summary,
        }, on_conflict="session_id").execute()

        return {"invalid_csv_url": invalid_csv_url, "error_summary": error_summary}