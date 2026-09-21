"""
Pre-flight API budget calculator for file/attachment migrations between any
supported CRM pair.

A migration burns budget on BOTH ends independently: the SOURCE CRM pays for
listing + downloads, the TARGET CRM pays for uploads. The binding constraint is
whichever side runs out first. All CRM-specific behaviour lives in the adapters
(app/services/file_adapters/*); this class only does the arithmetic.
"""
import random
from dataclasses import dataclass
from typing import List, Literal

from app.services.file_adapters.base import FileTypeEstimate, OrgBudget
from app.services.file_adapters.registry import get_adapter, effective_strategy

__all__ = ["FileTypeEstimate", "OrgBudget", "ApiBudgetEstimate", "FileMigrationEstimator"]


@dataclass
class ApiBudgetEstimate:
    source_budget: OrgBudget
    target_budget: OrgBudget

    attachments: FileTypeEstimate
    files: FileTypeEstimate

    estimated_download_calls: int   # against source_budget (listing + downloads)
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

    async def _estimate_one_kind(self, adapter, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        total = len(parent_ids)
        if total <= adapter.sample_size:
            return await adapter.count_files(client, creds, user_id, parent_ids, source_object, kind, send_log)

        sample = random.sample(parent_ids, adapter.sample_size)
        s = await adapter.count_files(client, creds, user_id, sample, source_object, kind, send_log)
        scale = total / adapter.sample_size
        return FileTypeEstimate(
            file_count=round(s.file_count * scale), total_bytes=round(s.total_bytes * scale),
            avg_bytes=s.avg_bytes, sampled=True, sample_size=adapter.sample_size,
            extrapolated_from_records=total,
        )

    async def estimate(
        self, client, source_creds: dict, target_creds: dict, user_id: str, parent_ids: List[str],
        migrate_attachments: bool, migrate_files: bool, send_log,
        safety_threshold: float = 0.90,
        source_other_reserved_calls: int = 0, target_other_reserved_calls: int = 0,
        *, source_crm: str = "salesforce", target_crm: str = "salesforce",
        source_object: str = "", strategy: str = "bulk_zip",
    ) -> ApiBudgetEstimate:
        source, target = get_adapter(source_crm), get_adapter(target_crm)
        strategy = effective_strategy(source_crm, target_crm, strategy)

        source_budget = await source.get_budget(client, source_creds, user_id, "source", send_log,
                                                safety_threshold, source_other_reserved_calls)
        target_budget = await target.get_budget(client, target_creds, user_id, "target", send_log,
                                                safety_threshold, target_other_reserved_calls)

        # CRMs with a single file type (Zoho) treat the "Files" toggle as "Attachments".
        want_attachments = migrate_attachments or (migrate_files and source.files_are_attachments)

        attachments_est, files_est = FileTypeEstimate(), FileTypeEstimate()
        if want_attachments and parent_ids:
            attachments_est = await self._estimate_one_kind(source, client, source_creds, user_id, parent_ids,
                                                            source_object, "attachments", send_log)
        if migrate_files and parent_ids and not source.files_are_attachments:
            files_est = await self._estimate_one_kind(source, client, source_creds, user_id, parent_ids,
                                                      source_object, "files", send_log)

        total_files = attachments_est.file_count + files_est.file_count
        total_bytes = attachments_est.total_bytes + files_est.total_bytes
        total_records = len(parent_ids)

        src_calls = source.source_calls(total_records, total_files)
        tgt_calls = target.target_calls(total_files, total_bytes, strategy)
        total_calls = src_calls + tgt_calls

        fits = src_calls <= source_budget.available_calls and tgt_calls <= target_budget.available_calls
        unverified = [b.role for b in (source_budget, target_budget) if not b.verified]
        crm_by_role = {"source": source_crm, "target": target_crm}
        caveat = ""
        if unverified:
            names = " and ".join(f"{crm_by_role[r]} {r}" for r in unverified)
            caveat = (f" Note: the daily API quota for {names} can't be read via API, so that side's budget is "
                      f"unverified; the run backs off on rate limits and can be resumed from its checkpoint.")

        if fits:
            binding_org, safe_records, safe_files = "none", total_records, total_files
            message = (
                f"Estimated {total_calls:,} API calls ({src_calls:,} on source, {tgt_calls:,} on target) "
                f"fits within both budgets. Safe to run the full migration.{caveat}"
            )
        else:
            src_per_rec = (src_calls / total_records) if total_records else 0
            tgt_per_rec = (tgt_calls / total_records) if total_records else 0
            src_safe = int(source_budget.available_calls / src_per_rec) if src_per_rec else total_records
            tgt_safe = int(target_budget.available_calls / tgt_per_rec) if tgt_per_rec else total_records

            safe_records = max(min(src_safe, tgt_safe, total_records), 0)
            safe_files = round(safe_records * (total_files / total_records)) if total_records else 0
            binding_org = "source" if src_safe <= tgt_safe else "target"
            message = (
                f"Estimated {total_calls:,} API calls needed ({src_calls:,} source / {tgt_calls:,} target), but the "
                f"{binding_org} side only has room at reduced scope (source available: "
                f"{source_budget.available_calls:,}, target available: {target_budget.available_calls:,}). "
                f"Approximately {safe_records:,} of {total_records:,} records (~{safe_files:,} files) can be "
                f"safely migrated now; the remainder needs a later run once the {binding_org} allocation resets.{caveat}"
            )

        return ApiBudgetEstimate(
            source_budget=source_budget, target_budget=target_budget,
            attachments=attachments_est, files=files_est,
            estimated_download_calls=src_calls, estimated_upload_calls=tgt_calls,
            estimated_total_calls=total_calls,
            fits_in_budget=fits, binding_org=binding_org,
            safe_record_count=safe_records, total_record_count=total_records,
            safe_file_count=safe_files, total_file_count=total_files,
            requires_acknowledgment=not fits, message=message,
        )

    def select_batch_within_budget(
        self, parent_ids: List[str], safe_record_count: int,
        order: Literal["as_given", "shuffled"] = "as_given",
    ) -> tuple:
        ids = list(parent_ids)
        if order == "shuffled":
            random.shuffle(ids)
        return ids[:safe_record_count], ids[safe_record_count:]

    async def estimate_for_object(
        self, client, source_creds: dict, target_creds: dict, user_id: str,
        obj_name: str, query: str, time_filter, migrate_attachments: bool, migrate_files: bool,
        send_log, safety_threshold: float = 0.90,
        *, source_crm: str = "salesforce", target_crm: str = "salesforce", strategy: str = "bulk_zip",
    ) -> ApiBudgetEstimate:
        """Pre-flight preview: fetch just the record Ids matching the current
        query/filter, then reuse estimate() exactly as the mid-run guard does."""
        parent_ids = await get_adapter(source_crm).fetch_record_ids(
            client, source_creds, user_id, obj_name, query, time_filter, send_log
        )
        return await self.estimate(
            client, source_creds, target_creds, user_id, parent_ids,
            migrate_attachments, migrate_files, send_log, safety_threshold=safety_threshold,
            source_crm=source_crm, target_crm=target_crm, source_object=obj_name, strategy=strategy,
        )