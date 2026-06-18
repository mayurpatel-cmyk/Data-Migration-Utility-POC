import os
from dotenv import load_dotenv
from supabase import create_client, Client
import httpx
load_dotenv()


SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# 1. Create a custom httpx client that ignores SSL
custom_client = httpx.Client(verify=False)

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase credentials not found in environment variables.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)