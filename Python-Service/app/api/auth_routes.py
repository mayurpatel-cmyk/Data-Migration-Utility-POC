from fastapi import APIRouter, Depends
from pydantic import BaseModel
from app.services.auth_service import AuthService

router = APIRouter()

# 1. Separate Payloads for better validation
class LoginPayload(BaseModel):
    email: str
    password: str

class SignUpPayload(BaseModel):
    email: str
    password: str
    full_name: str  # Added Full Name requirement

class RefreshPayload(BaseModel):
    refresh_token: str

class ForgotPasswordPayload(BaseModel):
    email: str

@router.post("/signup")
def signup(payload: SignUpPayload):
    user = AuthService.sign_up(payload.email, payload.password, payload.full_name)
    return {"success": True, "message": "User created successfully", "user_id": user.id}

@router.post("/login")
def login(payload: LoginPayload):
    session = AuthService.login(payload.email, payload.password)
    return {
        "success": True,
        "token": session.access_token,
        "refresh_token": session.refresh_token, # Send refresh token to frontend
        "user": {
            "id": session.user.id,
            "email": session.user.email,
            "full_name": session.user.user_metadata.get("full_name", "")
        }
    }

@router.post("/refresh")
def refresh_session(payload: RefreshPayload):
    session = AuthService.refresh_token(payload.refresh_token)
    return {
        "success": True,
        "token": session.access_token,
        "refresh_token": session.refresh_token
    }

@router.post("/logout")
def logout_user():
    AuthService.sign_out()
    return {"success": True, "message": "Successfully logged out."}

@router.post("/forgot-password")
def forgot_password(payload: ForgotPasswordPayload):
    AuthService.reset_password(payload.email)
    return {
        "success": True, 
        "message": "If that email exists, a reset link has been sent."
    }