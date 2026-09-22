import os
import httpx
from dotenv import load_dotenv
from supabase import create_client, Client, ClientOptions

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase credentials not found in environment variables.")

SSL_VERIFY = os.getenv("SUPABASE_SSL_VERIFY", "true").lower() not in ("false", "0", "no")

if not SSL_VERIFY and os.getenv("ENVIRONMENT", "development").lower() not in ("local", "development", "dev"):
    raise RuntimeError(
        "SUPABASE_SSL_VERIFY=false is set but ENVIRONMENT is not local/development. "
        "Refusing to disable TLS verification outside local dev."
    )

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_KEY,
    options=ClientOptions(httpx_client=httpx.Client(verify=SSL_VERIFY)),
)