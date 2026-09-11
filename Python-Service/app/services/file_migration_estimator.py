"""
Pre-flight API budget calculator for file/attachment migrations.

Salesforce daily REST allocation is per-org and rolling-24h. A migration burns
budget on BOTH ends independently: downloads consume the SOURCE org's daily
allocation, uploads consume the TARGET org's. This estimator checks both and
the binding constraint is whichever org runs out first.
"""
import math
import random
import urllib.parse
from dataclasses import dataclass
from typing import List, Literal

from app.services.crm_service import CrmService
from app.services.migrators.salesforce_file_migrator import SalesforceFileMigrator

API_VERSION = "v60.0"
CHUNK_SIZE = 200
SAMPLE_SIZE = 2000
BULK_BATCH_OVERHEAD_CALLS = 5


@dataclass
class FileTypeEstimate:
    file_count: int = 0
    total_bytes: int = 0
    avg_bytes: float = 0.0
    sampled: bool = False
    sample_size: int = 0
    extrapolated_from_records: int = 0


@dataclass
class OrgBudget:
    role: str  # 'source' or 'target'
    daily_limit: int
    used: int
    remaining: int
    available_calls: int


@dataclass
class ApiBudgetEstimate:
    source_budget: OrgBudget
    target_budget: OrgBudget

    attachments: FileTypeEstimate
    files: FileTypeEstimate

    estimated_download_calls: int   # against source_budget
    estimated_upload_calls: int     # against target_budget
    estimated_total_calls: int

    fits_in_budget: bool
    binding_org: str  # 'source', 'target', or 'none'
    safe_record_count: int
    total_record_count: int
    safe_file_count: int
    total_file_count: int

    requires_acknowledgment: bool
    message: str


class FileMigrationEstimator:

    async def _authed_get(self, client, url, creds, user_id, role, send_log):
        headers = {"Authorization": f"Bearer {creds.get('access_token')}"}
        res = await client.get(url, headers=headers)
        if res.status_code == 401:
            await send_log(f"[Estimator] {role.capitalize()} session expired. Refreshing token...")
            new_token = await CrmService.refresh_crm_token(user_id, "salesforce", role)
            creds["access_token"] = new_token
            headers["Authorization"] = f"Bearer {new_token}"
            res = await client.get(url, headers=headers)
        res.raise_for_status()
        return res.json()

    # ==========================================
    # ORG API USAGE (checked independently, per org)
    # ==========================================
    async def get_org_budget(self, client, creds, user_id, role, send_log, safety_threshold: float, other_reserved_calls: int) -> OrgBudget:
        instance = creds.get("instance_url", "").rstrip('/')
        url = f"{instance}/services/data/{API_VERSION}/limits"
        data = await self._authed_get(client, url, creds, user_id, role, send_log)
        daily = data.get("DailyApiRequests", {})
        used, limit = daily.get("Used", 0), daily.get("Max", 0)
        remaining = max(limit - used, 0)
        available = max(int(remaining * safety_threshold) - other_reserved_calls, 0)
        return OrgBudget(role=role, daily_limit=limit, used=used, remaining=remaining, available_calls=available)

    # ==========================================
    # FILE/ATTACHMENT VOLUME ESTIMATION 
    # ==========================================
    async def _aggregate_attachments(self, client, creds, user_id, parent_ids, send_log) -> FileTypeEstimate:
        total_count, total_bytes = 0, 0
        instance = creds.get("instance_url", "").rstrip('/')
        for i in range(0, len(parent_ids), CHUNK_SIZE):
            id_chunk = parent_ids[i:i + CHUNK_SIZE]
            id_list = ",".join(f"'{pid}'" for pid in id_chunk)
            soql = f"SELECT COUNT(Id) cnt, SUM(BodyLength) totalBytes FROM Attachment WHERE ParentId IN ({id_list})"
            url = f"{instance}/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}"
            data = await self._authed_get(client, url, creds, user_id, "source", send_log)
            rec = (data.get("records") or [{}])[0]
            total_count += rec.get("cnt", 0) or 0
            total_bytes += rec.get("totalBytes", 0) or 0

        return FileTypeEstimate(
            file_count=total_count, total_bytes=total_bytes,
            avg_bytes=(total_bytes / total_count) if total_count else 0.0,
        )

    async def _aggregate_files(self, client, creds, user_id, parent_ids, send_log) -> FileTypeEstimate:
        instance = creds.get("instance_url", "").rstrip('/')
        doc_ids = []

        for i in range(0, len(parent_ids), CHUNK_SIZE):
            id_chunk = parent_ids[i:i + CHUNK_SIZE]
            id_list = ",".join(f"'{pid}'" for pid in id_chunk)
            soql = f"SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN ({id_list})"
            url = f"{instance}/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}"
            data = await self._authed_get(client, url, creds, user_id, "source", send_log)
            doc_ids.extend(r["ContentDocumentId"] for r in data.get("records", []))
            next_url = data.get("nextRecordsUrl")
            while next_url and not data.get("done"):
                data = await self._authed_get(client, f"{instance}{next_url}", creds, user_id, "source", send_log)
                doc_ids.extend(r["ContentDocumentId"] for r in data.get("records", []))
                next_url = data.get("nextRecordsUrl")

        if not doc_ids:
            return FileTypeEstimate()

        total_count, total_bytes = 0, 0
        for i in range(0, len(doc_ids), CHUNK_SIZE):
            id_chunk = doc_ids[i:i + CHUNK_SIZE]
            id_list = ",".join(f"'{did}'" for did in id_chunk)
            soql = (
                "SELECT COUNT(Id) cnt, SUM(ContentSize) totalBytes FROM ContentVersion "
                f"WHERE ContentDocumentId IN ({id_list}) AND IsLatest = true"
            )
            url = f"{instance}/services/data/{API_VERSION}/query?q={urllib.parse.quote(soql)}"
            data = await self._authed_get(client, url, creds, user_id, "source", send_log)
            rec = (data.get("records") or [{}])[0]
            total_count += rec.get("cnt", 0) or 0
            total_bytes += rec.get("totalBytes", 0) or 0

        return FileTypeEstimate(
            file_count=total_count, total_bytes=total_bytes,
            avg_bytes=(total_bytes / total_count) if total_count else 0.0,
        )

    async def _estimate_one_kind(self, client, creds, user_id, parent_ids, kind, send_log) -> FileTypeEstimate:
        total_records = len(parent_ids)
        estimator = self._aggregate_attachments if kind == "attachments" else self._aggregate_files

        if total_records <= SAMPLE_SIZE:
            return await estimator(client, creds, user_id, parent_ids, send_log)

        sample_ids = random.sample(parent_ids, SAMPLE_SIZE)
        sample_result = await estimator(client, creds, user_id, sample_ids, send_log)
        scale = total_records / SAMPLE_SIZE
        return FileTypeEstimate(
            file_count=round(sample_result.file_count * scale),
            total_bytes=round(sample_result.total_bytes * scale),
            avg_bytes=sample_result.avg_bytes,
            sampled=True, sample_size=SAMPLE_SIZE, extrapolated_from_records=total_records,
        )

    # ==========================================
    # FULL BUDGET ESTIMATE -- checks BOTH orgs
    # ==========================================
    async def estimate(
        self, client, source_creds: dict, target_creds: dict, user_id: str, parent_ids: List[str],
        migrate_attachments: bool, migrate_files: bool, send_log,
        safety_threshold: float = 0.90,
        source_other_reserved_calls: int = 0, target_other_reserved_calls: int = 0,
    ) -> ApiBudgetEstimate:
        source_budget = await self.get_org_budget(
            client, source_creds, user_id, "source", send_log, safety_threshold, source_other_reserved_calls
        )
        target_budget = await self.get_org_budget(
            client, target_creds, user_id, "target", send_log, safety_threshold, target_other_reserved_calls
        )

        attachments_est = FileTypeEstimate()
        files_est = FileTypeEstimate()

        if migrate_attachments and parent_ids:
            attachments_est = await self._estimate_one_kind(client, source_creds, user_id, parent_ids, "attachments", send_log)
        if migrate_files and parent_ids:
            files_est = await self._estimate_one_kind(client, source_creds, user_id, parent_ids, "files", send_log)

        total_file_count = attachments_est.file_count + files_est.file_count
        total_bytes = attachments_est.total_bytes + files_est.total_bytes

        # Download: 1 REST call per file (source org) -- no bulk/batch binary-download endpoint exists.
        estimated_download_calls = total_file_count

        # Upload: Bulk ZIP batches (target org), bounded by the migrator's byte/row caps.
        migrator_bytes_cap = SalesforceFileMigrator.MAX_BULK_BATCH_BYTES
        migrator_rows_cap = SalesforceFileMigrator.MAX_BULK_BATCH_ROWS
        batches_by_bytes = math.ceil(total_bytes / migrator_bytes_cap) if total_bytes else 0
        batches_by_rows = math.ceil(total_file_count / migrator_rows_cap) if total_file_count else 0
        estimated_batches = max(batches_by_bytes, batches_by_rows, (1 if total_file_count else 0))
        estimated_upload_calls = estimated_batches * BULK_BATCH_OVERHEAD_CALLS

        estimated_total_calls = estimated_download_calls + estimated_upload_calls
        total_records = len(parent_ids)

        source_fits = estimated_download_calls <= source_budget.available_calls
        target_fits = estimated_upload_calls <= target_budget.available_calls
        fits = source_fits and target_fits

        if fits:
            binding_org = "none"
            safe_record_count = total_records
            safe_file_count = total_file_count
            message = (
                f"Estimated {estimated_total_calls:,} API calls "
                f"({estimated_download_calls:,} download on source, {estimated_upload_calls:,} upload on target) "
                f"fits within both orgs' available budgets. Safe to run the full migration."
            )
        else:
            avg_files_per_record = (total_file_count / total_records) if total_records else 0
            avg_bytes_per_file = (total_bytes / total_file_count) if total_file_count else 0


            source_safe_records = int(source_budget.available_calls / avg_files_per_record) if avg_files_per_record else total_records
            files_per_batch_row = 1
            target_safe_files = target_budget.available_calls * migrator_rows_cap / BULK_BATCH_OVERHEAD_CALLS if target_budget.available_calls else 0
            target_safe_records = int(target_safe_files / avg_files_per_record) if avg_files_per_record else total_records

            safe_record_count = max(min(source_safe_records, target_safe_records, total_records), 0)
            safe_file_count = round(safe_record_count * avg_files_per_record)
            binding_org = "source" if source_safe_records <= target_safe_records else "target"

            message = (
                f"Estimated {estimated_total_calls:,} API calls needed "
                f"({estimated_download_calls:,} download / {estimated_upload_calls:,} upload), but the "
                f"{binding_org} org only has room for it at reduced scope "
                f"(source available: {source_budget.available_calls:,}, target available: {target_budget.available_calls:,}). "
                f"Approximately {safe_record_count:,} of {total_records:,} records "
                f"(~{safe_file_count:,} files) can be safely migrated now; the remainder needs a "
                f"subsequent run once the {binding_org} org's daily allocation resets."
            )

        return ApiBudgetEstimate(
            source_budget=source_budget, target_budget=target_budget,
            attachments=attachments_est, files=files_est,
            estimated_download_calls=estimated_download_calls,
            estimated_upload_calls=estimated_upload_calls,
            estimated_total_calls=estimated_total_calls,
            fits_in_budget=fits, binding_org=binding_org,
            safe_record_count=safe_record_count, total_record_count=total_records,
            safe_file_count=safe_file_count, total_file_count=total_file_count,
            requires_acknowledgment=not fits,
            message=message,
        )

    def select_batch_within_budget(
        self, parent_ids: List[str], safe_record_count: int,
        order: Literal["as_given", "shuffled"] = "as_given",
    ) -> tuple:
        ids = list(parent_ids)
        if order == "shuffled":
            random.shuffle(ids)
        return ids[:safe_record_count], ids[safe_record_count:]