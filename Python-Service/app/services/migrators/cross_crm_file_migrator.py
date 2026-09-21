import asyncio
import os
import shutil
import tempfile
from typing import Optional

from app.services.file_adapters.base import SourceFile
from app.services.file_adapters.registry import get_adapter
from app.services.migrators.salesforce_file_migrator import (
    ApiLimitNearExhaustionError,
    FileMigrationCheckpoint,
    FileMigrationStrategy,
    SalesforceFileMigrator,
)


class CrossCrmFileMigrator:
    """
    Single entry point for file migration between any supported CRM pair.

    Salesforce -> Salesforce is delegated unchanged to SalesforceFileMigrator
    (keeps the Bulk-ZIP fast path). Every other pair (Zoho -> Zoho,
    Zoho -> Salesforce, Salesforce -> Zoho, ...) runs the generic pipeline
    below, which streams each file source -> disk -> target one at a time so
    disk usage stays bounded and a mid-run stop loses at most the in-flight files.
    """

    async def migrate_files_for_batch(
        self, client, source_creds, target_creds, user_id: str, id_map: dict,
        migrate_attachments: bool, migrate_files: bool, send_log, *,
        source_crm: str = "salesforce", target_crm: str = "salesforce",
        source_object: str = "", target_object: str = "",
        concurrency: int = 6, strategy: str = "bulk_zip",
        checkpoint: Optional[FileMigrationCheckpoint] = None,
    ):
        checkpoint = checkpoint or FileMigrationCheckpoint()
        source_crm, target_crm = source_crm.lower(), target_crm.lower()

        if source_crm == "salesforce" and target_crm == "salesforce":
            return await SalesforceFileMigrator().migrate_files_for_batch(
                client, source_creds, target_creds, user_id, id_map,
                migrate_attachments, migrate_files, send_log,
                concurrency=concurrency, strategy=FileMigrationStrategy(strategy), checkpoint=checkpoint,
            )

        source, target = get_adapter(source_crm), get_adapter(target_crm)
        results = {
            "attachments": {"success": 0, "error": 0, "skipped": 0, "errors": []},
            "files": {"success": 0, "error": 0, "skipped": 0, "errors": []},
            "apiLimitReached": False,
        }
        old_ids = list(id_map.keys())
        if not old_ids:
            return results

        semaphore = asyncio.Semaphore(min(concurrency, source.max_concurrency, target.max_concurrency))
        staging_dir = tempfile.mkdtemp(prefix=f"file_migration_{user_id}_")
        limit_error: Optional[Exception] = None

        try:
            try:
                files = await source.list_files(
                    client, source_creds, user_id, old_ids, source_object,
                    migrate_attachments, migrate_files, send_log,
                )
            except ApiLimitNearExhaustionError as e:
                results["apiLimitReached"] = True
                await send_log(f"[Files] Stopping while listing files: {e}")
                return results

            def already_done(f: SourceFile) -> bool:
                done = (checkpoint.migrated_attachment_ids if f.kind == "attachment"
                        else checkpoint.migrated_content_version_ids)
                return f.source_id in done

            files = [f for f in files if not already_done(f)]
            await send_log(f"[Files] {len(files)} file(s) to migrate "
                           f"({source_crm} -> {target_crm}, strategy=rest).")
            processed = 0

            async def process(f: SourceFile):
                nonlocal limit_error, processed
                bucket = results["attachments" if f.kind == "attachment" else "files"]

                async with semaphore:
                    if limit_error:  # rate limit already hit; leave un-checkpointed so a re-run resumes here
                        return

                    new_parent = id_map.get(f.parent_id)
                    if not new_parent:
                        bucket["skipped"] += 1
                        await send_log(f"[Files] Skipped '{f.name}' ({f.source_id}): source record "
                                       f"{f.parent_id} is outside this migration batch.")
                        return
                    if f.skip_reason:
                        bucket["skipped"] += 1
                        await send_log(f"[Files] Skipped '{f.name}' ({f.source_id}): {f.skip_reason}.")
                        return

                    path, ok, info = None, False, ""
                    try:
                        path, size = await source.download_to_disk(client, source_creds, user_id, f, staging_dir, send_log)
                        f.size = size
                        ok, info = await target.upload(client, target_creds, user_id, target_object,
                                                       new_parent, f, path, send_log)
                    except ApiLimitNearExhaustionError as e:
                        limit_error = e
                        return
                    except Exception as e:
                        ok, info = False, str(e)
                    finally:
                        if path and os.path.exists(path):
                            try:
                                os.remove(path)
                            except OSError:
                                pass

                    if ok:
                        bucket["success"] += 1
                        await checkpoint.mark(f.kind, f.source_id)
                    else:
                        bucket["error"] += 1
                        bucket["errors"].append({"name": f.name, "parentId": f.parent_id, "error": info})

                    processed += 1
                    if processed % 25 == 0:
                        await send_log(f"[Files] Processed {processed}/{len(files)}...")

            await asyncio.gather(*[process(f) for f in files])

            if limit_error:
                results["apiLimitReached"] = True
                await send_log(
                    f"[Files] Stopping: {limit_error}. Progress so far is checkpointed -- re-run later "
                    f"to resume the remaining files."
                )
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)

        for name in ("attachments", "files"):
            r = results[name]
            if r["success"] or r["error"] or r["skipped"]:
                await send_log(f"[{name.capitalize()}] Done: {r['success']} succeeded, "
                               f"{r['error']} failed, {r['skipped']} skipped.")
        return results