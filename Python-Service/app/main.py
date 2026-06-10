from fastapi import FastAPI
from app.api.routes import router
from fastapi.middleware.cors import CORSMiddleware
# 1. Import your core routes
from app.api.routes import router as core_router
from app.api.routes import router as auth_router

# 2. Import your NEW migration routes
from app.api.migration_routes import router as migration_router
from app.api.auth_routes import router as auth_router
from app.api.crm_routes import router as crm_router

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
app.include_router(core_router)
app.include_router(migration_router)
app.include_router(auth_router, prefix="/api/auth", tags=["Auth"])
app.include_router(crm_router, prefix="/api/crm", tags=["CRM Connections"])