from fastapi import HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from app.utils.config import supabase

security = HTTPBearer()

def get_current_user(credentials: HTTPAuthorizationCredentials = Security(security)):
    token = credentials.credentials
    print("\n--- AUTH DEBUG ---")
    print(f"Token Received: {token[:15]}... (length: {len(token)})")
    
    try:
        # Explicitly pass the token as the 'jwt' argument
        user_response = supabase.auth.get_user(jwt=token)
        
        if not user_response or not user_response.user:
            print("ERROR: Supabase verified the token but returned no user.")
            raise HTTPException(status_code=401, detail="Invalid authentication token")
            
        print(f"SUCCESS: User {user_response.user.email} authenticated.")
        return user_response.user
        
    except Exception as e:
        # THIS will print the exact reason it failed to your terminal!
        print(f"SUPABASE REJECTION REASON: {str(e)}")
        raise HTTPException(status_code=401, detail=f"Session expired or invalid: {str(e)}")