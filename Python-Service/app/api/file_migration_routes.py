import logging
from typing import List, Optional, Literal, Dict, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.file_adapters.registry import get_adapter, effective_strategy
from app.services.file_migration_estimator import FileMigrationEstimator
from app.services.migrators.cross_crm_file_migrator import CrossCrmFileMigrator
from app.services.migrators.salesforce_file_migrator import FileMigrationCheckpoint

logger = logging.getLogger(__name__)
router = APIRouter()
estimator = FileMigrationEstimator()


def _load_creds(user_id, source_crm: str, target_crm: str):
    get_adapter(source_crm)  # 400 on unsupported CRM
    get_adapter(target_crm)
    return (
        CrmService.get_active_crm_credentials(user_id, source_crm.lower(), "source"),
        CrmService.get_active_crm_credentials(user_id, target_crm.lower(), "target"),
    )


class FileMigrationEstimateRequest(BaseModel):
    parentIds: List[str]
    migrateAttachments: bool = True
    migrateFiles: bool = True
    safetyThreshold: float = 0.90
    sourceOtherReservedCalls: int = 0
    targetOtherReservedCalls: int = 0
    sourceCrm: str = "salesforce"
    targetCrm: str = "salesforce"
    sourceObject: str = ""        # required when the source is Zoho (attachments are per-module)
    strategy: Literal["rest", "bulk_zip"] = "bulk_zip"


class FileMigrationEstimateResponse(BaseModel):
    sourceDailyLimit: int
    sourceUsed: int
    sourceAvailable: int
    sourceBudgetVerified: bool = True
    targetDailyLimit: int
    targetUsed: int
    targetAvailable: int
    targetBudgetVerified: bool = True
    estimatedDownloadCalls: int
    estimatedUploadCalls: int
    estimatedTotalCalls: int
    fitsInBudget: bool
    bindingOrg: str
    totalRecordCount: int
    safeRecordCount: int
    totalFileCount: int
    safeFileCount: int
    requiresAcknowledgment: bool
    message: str
    attachmentFileCount: int
    attachmentBytesEstimated: bool
    contentFileCount: int
    contentBytesEstimated: bool


@router.post("/api/migration/files/estimate", response_model=FileMigrationEstimateResponse)
async def estimate_file_migration(payload: FileMigrationEstimateRequest, current_user=Depends(get_current_user)):
    if payload.sourceCrm.lower() == "zoho" and not payload.sourceObject:
        raise HTTPException(status_code=400, detail="sourceObject is required when the source CRM is Zoho.")

    source_creds, target_creds = _load_creds(current_user.id, payload.sourceCrm, payload.targetCrm)

    async def send_log(msg: str):
        logger.info(msg)

    async with httpx.AsyncClient(timeout=120) as client:
        try:
            result = await estimator.estimate(
                client, source_creds, target_creds, str(current_user.id), payload.parentIds,
                payload.migrateAttachments, payload.migrateFiles, send_log,
                safety_threshold=payload.safetyThreshold,
                source_other_reserved_calls=payload.sourceOtherReservedCalls,
                target_other_reserved_calls=payload.targetOtherReservedCalls,
                source_crm=payload.sourceCrm, target_crm=payload.targetCrm,
                source_object=payload.sourceObject, strategy=payload.strategy,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("File migration estimate failed")
            raise HTTPException(status_code=500, detail=f"Could not calculate API budget: {e}")

    return _estimate_response(result)


def _estimate_response(result) -> FileMigrationEstimateResponse:
    return FileMigrationEstimateResponse(
        sourceDailyLimit=result.source_budget.daily_limit, sourceUsed=result.source_budget.used,
        sourceAvailable=result.source_budget.available_calls, sourceBudgetVerified=result.source_budget.verified,
        targetDailyLimit=result.target_budget.daily_limit, targetUsed=result.target_budget.used,
        targetAvailable=result.target_budget.available_calls, targetBudgetVerified=result.target_budget.verified,
        estimatedDownloadCalls=result.estimated_download_calls,
        estimatedUploadCalls=result.estimated_upload_calls,
        estimatedTotalCalls=result.estimated_total_calls,
        fitsInBudget=result.fits_in_budget, bindingOrg=result.binding_org,
        totalRecordCount=result.total_record_count, safeRecordCount=result.safe_record_count,
        totalFileCount=result.total_file_count, safeFileCount=result.safe_file_count,
        requiresAcknowledgment=result.requires_acknowledgment, message=result.message,
        attachmentFileCount=result.attachments.file_count, attachmentBytesEstimated=result.attachments.sampled,
        contentFileCount=result.files.file_count, contentBytesEstimated=result.files.sampled,
    )


# =========================================================
# PRE-FLIGHT PREVIEW
# =========================================================
class FileMigrationPrecheckRequest(BaseModel):
    sourceObject: str
    query: str = ""
    migrationTimeFilter: Optional[Dict[str, Any]] = None
    migrateAttachments: bool = True
    migrateFiles: bool = True
    safetyThreshold: float = 0.90
    sourceCrm: str = "salesforce"
    targetCrm: str = "salesforce"
    strategy: Literal["rest", "bulk_zip"] = "bulk_zip"


class FileMigrationPrecheckResponse(BaseModel):
    fitsInBudget: bool
    bindingOrg: str
    sourceAvailable: int
    targetAvailable: int
    sourceBudgetVerified: bool = True
    targetBudgetVerified: bool = True
    estimatedDownloadCalls: int
    estimatedUploadCalls: int
    estimatedTotalCalls: int
    totalRecordCount: int
    safeRecordCount: int
    totalFileCount: int
    safeFileCount: int
    message: str
    attachmentFileCount: int
    contentFileCount: int


@router.post("/api/migration/files/precheck", response_model=FileMigrationPrecheckResponse)
async def precheck_file_migration(payload: FileMigrationPrecheckRequest, current_user=Depends(get_current_user)):
    source_creds, target_creds = _load_creds(current_user.id, payload.sourceCrm, payload.targetCrm)

    async def send_log(msg: str):
        logger.info(msg)

    async with httpx.AsyncClient(timeout=120) as client:
        try:
            result = await estimator.estimate_for_object(
                client, source_creds, target_creds, str(current_user.id),
                payload.sourceObject, payload.query, payload.migrationTimeFilter,
                payload.migrateAttachments, payload.migrateFiles, send_log,
                safety_threshold=payload.safetyThreshold,
                source_crm=payload.sourceCrm, target_crm=payload.targetCrm, strategy=payload.strategy,
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("File migration pre-check failed")
            raise HTTPException(status_code=500, detail=f"Could not pre-check API budget: {e}")

    return FileMigrationPrecheckResponse(
        fitsInBudget=result.fits_in_budget, bindingOrg=result.binding_org,
        sourceAvailable=result.source_budget.available_calls, targetAvailable=result.target_budget.available_calls,
        sourceBudgetVerified=result.source_budget.verified, targetBudgetVerified=result.target_budget.verified,
        estimatedDownloadCalls=result.estimated_download_calls,
        estimatedUploadCalls=result.estimated_upload_calls,
        estimatedTotalCalls=result.estimated_total_calls,
        totalRecordCount=result.total_record_count, safeRecordCount=result.safe_record_count,
        totalFileCount=result.total_file_count, safeFileCount=result.safe_file_count,
        message=result.message,
        attachmentFileCount=result.attachments.file_count, contentFileCount=result.files.file_count,
    )


# =========================================================
# RUN
# =========================================================
class RunFileMigrationRequest(BaseModel):
    idMap: dict                    # {source_record_id: target_record_id}
    migrateAttachments: bool = True
    migrateFiles: bool = True
    scope: Literal["full", "limited", "cancel"]
    safeRecordCount: Optional[int] = None
    strategy: Literal["rest", "bulk_zip"] = "bulk_zip"
    previouslyMigratedAttachmentIds: List[str] = []
    previouslyMigratedContentVersionIds: List[str] = []
    sourceCrm: str = "salesforce"
    targetCrm: str = "salesforce"
    sourceObject: str = ""         # Zoho source: module API name (e.g. "Contacts")
    targetObject: str = ""         # Zoho target: module API name


@router.post("/api/migration/files/run")
async def run_file_migration(payload: RunFileMigrationRequest, current_user=Depends(get_current_user)):
    if payload.scope == "cancel":
        return {"status": "cancelled"}

    if payload.scope == "limited" and not payload.safeRecordCount:
        raise HTTPException(status_code=400, detail="safeRecordCount is required when scope is 'limited'.")
    if payload.sourceCrm.lower() == "zoho" and not payload.sourceObject:
        raise HTTPException(status_code=400, detail="sourceObject is required when the source CRM is Zoho.")
    if payload.targetCrm.lower() == "zoho" and not payload.targetObject:
        raise HTTPException(status_code=400, detail="targetObject is required when the target CRM is Zoho.")

    all_old_ids = list(payload.idMap.keys())
    if payload.scope == "limited":
        included_ids, excluded_ids = estimator.select_batch_within_budget(all_old_ids, payload.safeRecordCount)
        id_map = {oid: payload.idMap[oid] for oid in included_ids}
    else:
        id_map, excluded_ids = payload.idMap, []

    source_creds, target_creds = _load_creds(current_user.id, payload.sourceCrm, payload.targetCrm)

    logs: List[str] = []

    async def send_log(msg: str):
        logs.append(msg)
        logger.info(msg)

    checkpoint = FileMigrationCheckpoint(
        migrated_attachment_ids=set(payload.previouslyMigratedAttachmentIds),
        migrated_content_version_ids=set(payload.previouslyMigratedContentVersionIds),
    )
    strategy = effective_strategy(payload.sourceCrm, payload.targetCrm, payload.strategy)

    async with httpx.AsyncClient(timeout=300) as client:
        results = await CrossCrmFileMigrator().migrate_files_for_batch(
            client, source_creds, target_creds, str(current_user.id), id_map,
            payload.migrateAttachments, payload.migrateFiles, send_log,
            source_crm=payload.sourceCrm, target_crm=payload.targetCrm,
            source_object=payload.sourceObject, target_object=payload.targetObject,
            strategy=strategy, checkpoint=checkpoint,
        )

    return {
        "status": "apiLimitReached" if results.get("apiLimitReached") else "completed",
        "results": results,
        "deferredRecordIds": excluded_ids,
        "migratedAttachmentIds": list(checkpoint.migrated_attachment_ids),
        "migratedContentVersionIds": list(checkpoint.migrated_content_version_ids),
        "logs": logs,
    }