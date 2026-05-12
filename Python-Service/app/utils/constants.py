import re
import pandas as pd

# Standardizing State & Country codes
COUNTRY_MAP = {'united states': 'US', 'united states of america': 'US', 'canada': 'CA'}
STATE_MAP = {'california': 'CA', 'new york': 'NY', 'texas': 'TX'}

# Vectorized Email Regex
def is_valid_email(email):
    if pd.isna(email) or str(email).strip() == "": return True # Empty is valid unless marked 'required'
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", str(email)))