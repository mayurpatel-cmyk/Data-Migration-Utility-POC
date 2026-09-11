import logging
from typing import List, Optional, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.dependencies.auth import get_current_user
from app.services.crm_service import CrmService
from app.services.file_migration_estimator import FileMigrationEstimator
from app.services.salesforce_file_migrator import (
    SalesforceFileMigrator, FileMigrationStrategy, FileMigrationCheckpoint,
)

logger = logging.getLogger(__name__)
router = APIRouter()
estimator = FileMigrationEstimator()


class FileMigrationEstimateRequest(BaseModel):
    parentIds: List[str]
    migrateAttachments: bool = True
    migrateFiles: bool = True
    safetyThreshold: float = 0.90
    sourceOtherReservedCalls: int = 0
    targetOtherReservedCalls: int = 0


class FileMigrationEstimateResponse(BaseModel):
    sourceDailyLimit: int
    sourceUsed: int
    sourceAvailable: int
    targetDailyLimit: int
    targetUsed: int
    targetAvailable: int
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
    source_creds = CrmService.get_active_crm_credentials(current_user.id, "salesforce", "source")
    target_creds = CrmService.get_active_crm_credentials(current_user.id, "salesforce", "target")

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
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("File migration estimate failed")
            raise HTTPException(status_code=500, detail=f"Could not calculate API budget: {e}")

    return FileMigrationEstimateResponse(
        sourceDailyLimit=result.source_budget.daily_limit, sourceUsed=result.source_budget.used,
        sourceAvailable=result.source_budget.available_calls,
        targetDailyLimit=result.target_budget.daily_limit, targetUsed=result.target_budget.used,
        targetAvailable=result.target_budget.available_calls,
        estimatedDownloadCalls=result.estimated_download_calls,
        estimatedUploadCalls=result.estimated_upload_calls,
        estimatedTotalCalls=result.estimated_total_calls,
        fitsInBudget=result.fits_in_budget, bindingOrg=result.binding_org,
        totalRecordCount=result.total_record_count, safeRecordCount=result.safe_record_count,
        totalFileCount=result.total_file_count, safeFileCount=result.safe_file_count,
        requiresAcknowledgment=result.requires_acknowledgment,
        message=result.message,
        attachmentFileCount=result.attachments.file_count, attachmentBytesEstimated=result.attachments.sampled,
        contentFileCount=result.files.file_count, contentBytesEstimated=result.files.sampled,
    )


class RunFileMigrationRequest(BaseModel):
    idMap: dict
    migrateAttachments: bool = True
    migrateFiles: bool = True
    scope: Literal["full", "limited", "cancel"]
    safeRecordCount: Optional[int] = None
    strategy: Literal["rest", "bulk_zip"] = "bulk_zip"
    previouslyMigratedAttachmentIds: List[str] = []
    previouslyMigratedContentVersionIds: List[str] = []


@router.post("/api/migration/files/run")
async def run_file_migration(payload: RunFileMigrationRequest, current_user=Depends(get_current_user)):
    if payload.scope == "cancel":
        return {"status": "cancelled"}

    if payload.scope == "limited" and not payload.safeRecordCount:
        raise HTTPException(status_code=400, detail="safeRecordCount is required when scope is 'limited'.")

    all_old_ids = list(payload.idMap.keys())

    if payload.scope == "limited":
        included_ids, excluded_ids = estimator.select_batch_within_budget(all_old_ids, payload.safeRecordCount)
        id_map = {oid: payload.idMap[oid] for oid in included_ids}
    else:
        id_map = payload.idMap
        excluded_ids = []

    source_creds = CrmService.get_active_crm_credentials(current_user.id, "salesforce", "source")
    target_creds = CrmService.get_active_crm_credentials(current_user.id, "salesforce", "target")

    logs = []

    async def send_log(msg: str):
        logs.append(msg)
        logger.info(msg)

    checkpoint = FileMigrationCheckpoint(
        migrated_attachment_ids=set(payload.previouslyMigratedAttachmentIds),
        migrated_content_version_ids=set(payload.previouslyMigratedContentVersionIds),
    )

    migrator = SalesforceFileMigrator()
    strategy = FileMigrationStrategy.BULK_ZIP if payload.strategy == "bulk_zip" else FileMigrationStrategy.REST

    async with httpx.AsyncClient(timeout=300) as client:
        results = await migrator.migrate_files_for_batch(
            client, source_creds, target_creds, str(current_user.id), id_map,
            payload.migrateAttachments, payload.migrateFiles, send_log,
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