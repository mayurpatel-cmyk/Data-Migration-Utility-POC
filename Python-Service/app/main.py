from fastapi import FastAPI
from app.api.routes import router

app = FastAPI(title="Salesforce Validation Engine")

# Register our API routes
app.include_router(router)