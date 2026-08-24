from app.utils.config import supabase
from fastapi import HTTPException
import os

ANGULAR_FRONTEND_URL = os.getenv("ANGULAR_FRONTEND_URL", "http://localhost:4200").rstrip("/")

class AuthService:
    @staticmethod
    def sign_up(email: str, password: str, full_name: str):
        try:
            response = supabase.auth.sign_up({
                "email": email,
                "password": password,
                "options": {
                    "data": {
                        "full_name": full_name
                    }
                }
            })
            return response.user
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @staticmethod
    def login(email: str, password: str):
        try:
            response = supabase.auth.sign_in_with_password({
                "email": email,
                "password": password
            })
            return response.session
        except Exception as e:
            raise HTTPException(status_code=401, detail="Invalid email or password")

    @staticmethod
    def refresh_token(refresh_token: str):
        try:
            response = supabase.auth.refresh_session(refresh_token)
            return response.session
        except Exception as e:
            raise HTTPException(status_code=401, detail="Session expired. Please log in again.")

    @staticmethod
    def sign_out():
        try:
            supabase.auth.sign_out()
            return True
        except Exception as e:
            return False

    @staticmethod
    def reset_password(email: str):
        try:
            supabase.auth.reset_password_email(
                email, 
                options={"redirect_to": f"{ANGULAR_FRONTEND_URL}/login"}
            )
            return True
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @staticmethod
    def update_email(new_email: str):
        try:
            response = supabase.auth.update_user({
                "email": new_email
            })
            return response.user
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))