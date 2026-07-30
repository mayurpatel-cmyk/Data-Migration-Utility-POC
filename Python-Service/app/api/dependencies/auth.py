from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase

# Tells FastAPI to automatically intercept the "Authorization: Bearer <token>" header
security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    
    try:
        # Ask Supabase to verify the token
        user_response = supabase.auth.get_user(token)
        
        if not user_response or not user_response.user:
            
            raise HTTPException(status_code=401, detail="Invalid session.")
            
        return user_response.user
        
    except Exception as e:
        
        raise HTTPException(status_code=401, detail=f"Authentication failed: {str(e)}")