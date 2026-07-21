from app.utils.config import supabase
from fastapi import HTTPException

class AuthService:
    @staticmethod
    def sign_up(email: str, password: str, full_name: str):
        try:
            # Pass the full_name into Supabase's user metadata
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
            # Exchange the old refresh token for a new access/refresh token pair
            response = supabase.auth.refresh_session(refresh_token)
            return response.session
        except Exception as e:
            raise HTTPException(status_code=401, detail="Session expired. Please log in again.")

    @staticmethod
    def sign_out():
        try:
            # Tells Supabase to invalidate the current session on the server
            supabase.auth.sign_out()
            return True
        except Exception as e:
            # We don't want to throw a hard error on logout, just fail gracefully
            return False

    @staticmethod
    def reset_password(email: str):
        try:
            # Sends a secure reset link to the user's email
            # You can change the redirect_to URL to point to a specific page in your Angular app
            supabase.auth.reset_password_email(
                email, 
                options={"redirect_to": "http://localhost:4200/login"}
            )
            return True
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))

    @staticmethod
    def update_email(new_email: str):
        try:
            # Supabase requires the user to verify the new email. 
            # It will send a confirmation link to the NEW email address.
            response = supabase.auth.update_user({
                "email": new_email
            })
            return response.user
        except Exception as e:
            raise HTTPException(status_code=400, detail=str(e))