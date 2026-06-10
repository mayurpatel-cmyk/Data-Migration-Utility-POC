from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase

security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    """
    Extracts the Bearer token from the incoming request and verifies it with Supabase.
    Returns the user object if valid, throws a 401 Unauthorized if not.
    """
    token = credentials.credentials
    try:
        # Verify the JWT token with Supabase and get the user details
        user_response = supabase.auth.get_user(token)
        
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid authentication token")
            
        return user_response.user
    except Exception as e:
        raise HTTPException(status_code=401, detail="Session expired or invalid token")