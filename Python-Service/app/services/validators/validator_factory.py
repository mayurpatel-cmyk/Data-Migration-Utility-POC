from app.services.validators.salesforce_validator import SalesforceValidator
from app.services.validators.zoho_validator import ZohoValidator
from app.services.validators.zendesk_validator import ZendeskValidator
from app.services.validators.base_validator import BaseValidator

class ValidatorFactory:
    @staticmethod
    def get_validator(target_crm: str):
        crm = target_crm.lower() if target_crm else "salesforce"
        
        if crm == "salesforce":
            return SalesforceValidator()
        elif crm == "zoho":
            return ZohoValidator()
        elif crm == "zendesk":
            return ZendeskValidator()
        else:
            return BaseValidator()