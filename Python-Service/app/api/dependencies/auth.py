from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase

# Tells FastAPI to automatically intercept the "Authorization: Bearer <token>" header
security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    
    print("\n--- 🛡️ SECURITY CHECK ---")
    print(f"Token Received (First 15 chars): {token[:15]}...")
    
    try:
        # Ask Supabase to verify the token
        user_response = supabase.auth.get_user(token)
        
        if not user_response or not user_response.user:
            print("❌ Auth Failed: Supabase returned no user.")
            raise HTTPException(status_code=401, detail="Invalid session.")
            
        print(f"✅ User Authenticated: {user_response.user.id}\n")
        return user_response.user
        
    except Exception as e:
        print(f"❌ Auth Exception from Supabase: {str(e)}\n")
        raise HTTPException(status_code=401, detail=f"Authentication failed: {str(e)}")