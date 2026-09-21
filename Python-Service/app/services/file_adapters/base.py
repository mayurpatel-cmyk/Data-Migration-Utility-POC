"""
CRM-agnostic contracts for file/attachment migration.

Each CRM implements ONE adapter that can act as a source (list + download
files) and as a target (upload a file to a parent record). The orchestrator
(cross_crm_file_migrator.py) and estimator (file_migration_estimator.py) only
talk to this interface, so adding HubSpot / Zendesk later means writing one
adapter class and registering it -- nothing else changes.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional, Tuple


@dataclass
class SourceFile:
    source_id: str
    parent_id: str                      # id of the SOURCE record this file hangs off
    name: str
    size: int
    kind: str                           # "attachment" | "file" (checkpoint bucket)
    content_type: Optional[str] = None
    skip_reason: Optional[str] = None   # set when the file can't be transferred (e.g. link-only)
    meta: dict = field(default_factory=dict)


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
    verified: bool = True  # False when the CRM doesn't expose its daily quota via API


class FileAdapter(ABC):
    crm: str = ""
    sample_size: int = 2000        # records sampled by the estimator before extrapolating
    max_concurrency: int = 6
    files_are_attachments: bool = False  # True if the CRM has one file type (UI "Files" == "Attachments")

    # ---------- source side ----------
    @abstractmethod
    async def fetch_record_ids(self, client, creds, user_id, obj_name, query, time_filter, send_log) -> List[str]: ...

    @abstractmethod
    async def count_files(self, client, creds, user_id, parent_ids, source_object, kind, send_log) -> FileTypeEstimate:
        """kind: 'attachments' | 'files'"""

    @abstractmethod
    async def list_files(
        self, client, creds, user_id, parent_ids, source_object,
        migrate_attachments: bool, migrate_files: bool, send_log,
    ) -> List[SourceFile]: ...

    @abstractmethod
    async def download_to_disk(self, client, creds, user_id, f: SourceFile, staging_dir: str, send_log) -> Tuple[str, int]:
        """Returns (path, size_bytes)."""

    # ---------- target side ----------
    @abstractmethod
    async def upload(
        self, client, creds, user_id, target_object: str, new_parent_id: str,
        f: SourceFile, path: str, send_log,
    ) -> Tuple[bool, str]:
        """Returns (ok, new_id_or_error_message)."""

    # ---------- budget ----------
    @abstractmethod
    async def get_budget(self, client, creds, user_id, role, send_log, safety_threshold: float, other_reserved: int) -> OrgBudget: ...

    @abstractmethod
    def source_calls(self, total_records: int, total_files: int) -> int:
        """API calls this CRM spends when it is the SOURCE (listing + downloads)."""

    @abstractmethod
    def target_calls(self, total_files: int, total_bytes: int, strategy: str) -> int:
        """API calls this CRM spends when it is the TARGET."""