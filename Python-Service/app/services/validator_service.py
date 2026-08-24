from app.services.validators.validator_factory import ValidatorFactory

def process_validation_batch(records: list, mappings: list, dedupe_key: str, target_rules: dict, date_format: str = "", target_crm: str = "salesforce") -> dict:
    """
    Acts as a gateway. Dynamically loads the specific Validation Strategy 
    for the requested Target CRM and executes the data check.
    """
    validator_engine = ValidatorFactory.get_validator(target_crm)
    
    return validator_engine.validate(
        records=records, 
        mappings=mappings, 
        dedupe_key=dedupe_key, 
        target_rules=target_rules, 
        date_format=date_format
    )