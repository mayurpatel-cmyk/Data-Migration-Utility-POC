import sys
import os
from fastapi import FastAPI
from app.api.routes import router
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

app = FastAPI(title="Salesforce Validation Engine")

# Register our API routes
app.include_router(router)