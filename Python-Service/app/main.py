from fastapi import FastAPI
from app.api.routes import router
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Migartion Engine")


# =========================================================
# CONFIGURE CORS MIDDLEWARE 
# =========================================================
app.add_middleware(
    CORSMiddleware,
    # Allow requests coming from your Angular frontend
    allow_origins=["http://localhost:4200"], 
    allow_credentials=True,
    # Allows GET, POST, PUT, and crucially, OPTIONS preflight requests
    allow_methods=["*"], 
    # CRITICAL: This allows your custom metadata headers like sf-token, zd-token, etc.
    allow_headers=["*"], 
)

# Register our API routes
app.include_router(router)