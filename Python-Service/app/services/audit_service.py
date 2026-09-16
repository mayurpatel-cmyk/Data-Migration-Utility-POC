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
    def generate_and_save_reports(user_id: str, session_id: str, source_crm: str, target_crm: str, target_object: str, success_data: list, error_data: list, auth_token: str):
        success_count = len(success_data)
        error_count = len(error_data)
        total = success_count + error_count

        urls = {"pdf": None, "success_csv": None, "error_csv": None}
        error_summary = AuditService.build_error_summary(error_data)

        # ==========================================
        # 1. GENERATE & UPLOAD PDF SUMMARY
        # ==========================================
        s = AuditService._sanitize_pdf_text

        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Arial", size=16, style="B")
        pdf.cell(200, 10, txt=s("Migration Audit Report"), ln=True, align="C")
        pdf.set_font("Arial", size=12)
        pdf.cell(200, 10, txt=s(f"Session ID: {session_id}"), ln=True)
        pdf.cell(200, 10, txt=s(f"Source: {source_crm.capitalize()} -> Target: {target_crm.capitalize()}"), ln=True)
        pdf.cell(200, 10, txt=s(f"Object: {target_object}"), ln=True)
        pdf.cell(200, 10, txt=s(f"Successful Records: {success_count}"), ln=True)
        pdf.cell(200, 10, txt=s(f"Failed Records: {error_count}"), ln=True)

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