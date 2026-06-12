import asyncio
import sys

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import your NEW modular routes
from app.api.validation_routes import router as validation_router
from app.api.migration_routes import router as migration_router
from app.api.auth_routes import router as auth_router
from app.api.crm_routes import router as crm_router
from app.api.metadata_routes import router as metadata_router 

app = FastAPI(title="Migration Engine")

# =========================================================
# CONFIGURE CORS MIDDLEWARE 
# =========================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200"], 
    allow_credentials=True,
    allow_methods=["*"], 
    allow_headers=["*"], 
)

# Register our API routes
app.include_router(metadata_router) 
app.include_router(migration_router)
app.include_router(auth_router, prefix="/api/auth", tags=["Auth"])
app.include_router(crm_router, prefix="/api/crm", tags=["CRM Connections"])
app.include_router(validation_router)