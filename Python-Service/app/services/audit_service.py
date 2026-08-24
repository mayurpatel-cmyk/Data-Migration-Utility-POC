import os
import tempfile
import csv
from fpdf import FPDF
from supabase import create_client
from app.utils.config import supabase, SUPABASE_URL, SUPABASE_KEY  
class AuditService:
    @staticmethod
    def generate_and_save_reports(user_id: str, session_id: str, source_crm: str, target_crm: str, target_object: str, success_data: list, error_data: list, auth_token: str):
        success_count = len(success_data)
        error_count = len(error_data)
        total = success_count + error_count
        
        urls = {"pdf": None, "success_csv": None, "error_csv": None}

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
            temp_success = os.path.join(tempfile.gettempdir(), f"{session_id}_success.csv")
            with open(temp_success, 'w', newline='', encoding='utf-8') as f:
                fieldnames = list(success_data[0].keys())
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(success_data)
                
            with open(temp_success, "rb") as f:
                supabase.storage.from_("migration_reports").upload(
                    f"{user_id}/{session_id}_success.csv", 
                    f,
                    file_options={"x-upsert": "true"}
                )
            urls["success_csv"] = supabase.storage.from_("migration_reports").get_public_url(f"{user_id}/{session_id}_success.csv")
            os.remove(temp_success)

        # ==========================================
        # 3. GENERATE & UPLOAD ERROR CSV
        # ==========================================
        if error_count > 0:
            flat_errors = []
            for err in error_data:
                flat_rec = err.get("record", {})
                flat_rec["Migration_Error_Message"] = err.get("error", "Unknown Error")
                flat_errors.append(flat_rec)

            temp_error = os.path.join(tempfile.gettempdir(), f"{session_id}_error.csv")
            with open(temp_error, 'w', newline='', encoding='utf-8') as f:
                # Put the error message as the first column for easy reading
                fieldnames = ["Migration_Error_Message"] + [k for k in flat_errors[0].keys() if k != "Migration_Error_Message"]
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(flat_errors)

            with open(temp_error, "rb") as f:
                supabase.storage.from_("migration_reports").upload(
                    f"{user_id}/{session_id}_error.csv", 
                    f,
                    file_options={"x-upsert": "true"}
                )
            urls["error_csv"] = supabase.storage.from_("migration_reports").get_public_url(f"{user_id}/{session_id}_error.csv")
            os.remove(temp_error)

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
            "error_csv_url": urls["error_csv"]
        }).execute()

        return urls