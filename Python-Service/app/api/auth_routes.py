from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from app.services.auth_service import AuthService
from app.api.dependencies.auth import get_current_user

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

class ProfileUpdatePayload(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    company: str | None = None
    contact: str | None = None
    other_info: str | None = None

@router.post("/signup")
def signup(payload: SignUpPayload):
    user = AuthService.sign_up(payload.email, payload.password, payload.full_name)
    return {"success": True, "message": "User created successfully", "user_id": user.id}

def extract_full_name(user):
    return getattr(user, 'full_name', None) or user.user_metadata.get('full_name', '')

@router.post("/login")
def login(payload: LoginPayload):
    session = AuthService.login(payload.email, payload.password)
    return {
        "success": True,
        "token": session.access_token,
        "refresh_token": session.refresh_token,
        "user": {
            "id": session.user.id,
            "email": session.user.email,
            "full_name": extract_full_name(session.user),
            "user_metadata": session.user.user_metadata or {}
        }
    }

@router.get("/profile")
def get_profile(current_user=Depends(get_current_user)):
    return {
        "success": True,
        "user": {
            "id": current_user.id,
            "email": current_user.email,
            "full_name": extract_full_name(current_user),
            "user_metadata": current_user.user_metadata or {}
        }
    }

@router.put("/profile")
def update_profile(payload: ProfileUpdatePayload, current_user=Depends(get_current_user)):
    attributes = {}
    if payload.full_name is not None:
        attributes["full_name"] = payload.full_name
    if payload.email is not None:
        attributes["email"] = payload.email

    user_metadata = {}
    if payload.company is not None:
        user_metadata["company"] = payload.company
    if payload.contact is not None:
        user_metadata["contact"] = payload.contact
    if payload.other_info is not None:
        user_metadata["other_info"] = payload.other_info
    if user_metadata:
        attributes["user_metadata"] = user_metadata

    if not attributes:
        raise HTTPException(status_code=400, detail="No profile data provided to update.")

    response = AuthService.update_profile(current_user.id, attributes)
    user = response.user
    return {
        "success": True,
        "user": {
            "id": user.id,
            "email": user.email,
            "full_name": extract_full_name(user),
            "user_metadata": user.user_metadata or {}
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