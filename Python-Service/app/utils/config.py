import os
import certifi
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SSL_VERIFY = os.getenv("SUPABASE_SSL_VERIFY", "true").lower() not in ("false", "0", "no")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase credentials not found in environment variables.")

if SSL_VERIFY:
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
else:
    if os.getenv("ENVIRONMENT", "development").lower() not in ("local", "development", "dev"):
        raise RuntimeError(
            "SUPABASE_SSL_VERIFY=false is set but ENVIRONMENT is not local/development. "
            "Refusing to disable TLS verification outside local dev."
        )
    os.environ["PYTHONHTTPSVERIFY"] = "0"
    os.environ["CURL_CA_BUNDLE"] = ""
    os.environ["SSL_CERT_FILE"] = ""

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)