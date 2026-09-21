from fastapi import HTTPException

from app.services.file_adapters.base import FileAdapter
from app.services.file_adapters.salesforce_adapter import SalesforceFileAdapter
from app.services.file_adapters.zoho_adapter import ZohoFileAdapter

_ADAPTERS = {
    "salesforce": SalesforceFileAdapter,
    "zoho": ZohoFileAdapter,
    # "hubspot": HubspotFileAdapter,   # add one adapter class per CRM, nothing else changes
    # "zendesk": ZendeskFileAdapter,
}


def get_adapter(crm: str) -> FileAdapter:
    cls = _ADAPTERS.get((crm or "").strip().lower())
    if not cls:
        raise HTTPException(
            status_code=400,
            detail=f"File migration is not supported for '{crm}'. Supported: {', '.join(sorted(_ADAPTERS))}.",
        )
    return cls()


def effective_strategy(source_crm: str, target_crm: str, requested: str) -> str:
    """Bulk-ZIP (Bulk API 1.0 binary batches) only exists for Salesforce -> Salesforce."""
    if (source_crm or "").lower() == "salesforce" and (target_crm or "").lower() == "salesforce":
        return requested
    return "rest"