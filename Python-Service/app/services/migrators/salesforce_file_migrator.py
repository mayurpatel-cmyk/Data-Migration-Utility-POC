import base64
import asyncio
import urllib.parse
from app.services.crm_service import CrmService


def chunk_list(data: list, size: int = 200):
    for i in range(0, len(data), size):
        yield data[i:i + size]


class SalesforceFileMigrator:
    """
    Handles extraction + migration of Salesforce record attachments between
    a source and target org (Salesforce -> Salesforce only, for now).

    Supports BOTH file models an org may be using:
      - Legacy `Attachment` (ParentId, Body)
      - Modern Files (`ContentVersion` + `ContentDocumentLink`, LinkedEntityId)

    Works purely off an old_id -> new_id map, so it's not tied to Case --
    any object that's already been migrated (and has Target_Id stamped on
    its success records) can be passed in here.
    """

    API_VERSION = "v60.0"
    MAX_INLINE_BYTES = 25 * 1024 * 1024

    # ==========================================
    # AUTH-AWARE REQUEST WRAPPER (silent refresh)
    # ==========================================
    async def _authed_request(self, client, method: str, url: str, creds: dict, user_id: str, role: str, send_log, **kwargs):
        token = creds.get("access_token")
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {token}"

        res = await client.request(method, url, headers=headers, **kwargs)

        if res.status_code == 401:
            await send_log(f"[Files] {role.capitalize()} session expired mid-transfer. Refreshing token...")
            new_token = await CrmService.refresh_crm_token(user_id, "salesforce", role)
            creds["access_token"] = new_token
            headers["Authorization"] = f"Bearer {new_token}"
            res = await client.request(method, url, headers=headers, **kwargs)

        return res

    # ==========================================
    # EXTRACTION (from source org)
    # ==========================================
    async def extract_attachments(self, client, creds, user_id, parent_ids: list, send_log):
        """Query legacy Attachment records for a batch of parent record Ids."""
        instance = creds.get("instance_url", "").rstrip('/')
        all_attachments = []

        for id_chunk in chunk_list(parent_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = f"SELECT Id, ParentId, Name, ContentType, BodyLength FROM Attachment WHERE ParentId IN ({id_list})"
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Attachments] Query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                all_attachments.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        await send_log(f"[Attachments] Found {len(all_attachments)} legacy attachments across {len(parent_ids)} records.")
        return all_attachments

    async def extract_files(self, client, creds, user_id, parent_ids: list, send_log):
        """Query modern Files (ContentDocumentLink + ContentVersion) for a batch of parent Ids."""
        instance = creds.get("instance_url", "").rstrip('/')

        links = []
        for id_chunk in chunk_list(parent_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = f"SELECT LinkedEntityId, ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId IN ({id_list})"
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Files] ContentDocumentLink query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                links.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        if not links:
            await send_log(f"[Files] No modern Files found across {len(parent_ids)} records.")
            return []

        doc_to_parents = {}
        for l in links:
            doc_to_parents.setdefault(l["ContentDocumentId"], []).append(l["LinkedEntityId"])

        doc_ids = list(doc_to_parents.keys())
        versions = []
        for id_chunk in chunk_list(doc_ids, 200):
            id_list = ",".join(f"'{i}'" for i in id_chunk)
            soql = (
                "SELECT Id, ContentDocumentId, Title, FileExtension, ContentSize "
                f"FROM ContentVersion WHERE ContentDocumentId IN ({id_list}) AND IsLatest = true"
            )
            url = f"{instance}/services/data/{self.API_VERSION}/query?q={urllib.parse.quote(soql)}"

            while url:
                res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
                if res.status_code != 200:
                    await send_log(f"[Files] ContentVersion query failed: {res.text}")
                    res.raise_for_status()
                data = res.json()
                versions.extend(data.get("records", []))
                url = f"{instance}{data.get('nextRecordsUrl')}" if not data.get("done") else None

        files = []
        for v in versions:
            for parent_id in doc_to_parents.get(v["ContentDocumentId"], []):
                title = v.get("Title") or "file"
                ext = v.get("FileExtension") or ""
                name = f"{title}.{ext}" if ext and not title.lower().endswith(f".{ext.lower()}") else title
                files.append({
                    "ParentId": parent_id,
                    "ContentVersionId": v["Id"],
                    "Name": name,
                    "ContentSize": v.get("ContentSize", 0)
                })

        await send_log(f"[Files] Found {len(files)} modern Files across {len(parent_ids)} records.")
        return files

    # ==========================================
    # DOWNLOAD (binary body, from source org)
    # ==========================================
    async def download_body(self, client, creds, user_id, record_id: str, kind: str, send_log) -> bytes:
        """kind is 'attachment' or 'file'."""
        instance = creds.get("instance_url", "").rstrip('/')
        if kind == "attachment":
            url = f"{instance}/services/data/{self.API_VERSION}/sobjects/Attachment/{record_id}/Body"
        else:
            url = f"{instance}/services/data/{self.API_VERSION}/sobjects/ContentVersion/{record_id}/VersionData"

        res = await self._authed_request(client, "GET", url, creds, user_id, "source", send_log)
        res.raise_for_status()
        return res.content

    # ==========================================
    # UPLOAD (to target org)
    # ==========================================
    async def upload_attachment(self, client, creds, user_id, new_parent_id: str, name: str, content_type: str, blob: bytes, send_log):
        instance = creds.get("instance_url", "").rstrip('/')

        if len(blob) > self.MAX_INLINE_BYTES:
            msg = f"'{name}' is {len(blob) / 1e6:.1f}MB, over the {self.MAX_INLINE_BYTES / 1e6:.0f}MB inline upload limit."
            await send_log(f"[Attachment SKIPPED] {msg}")
            return False, msg

        payload = {
            "ParentId": new_parent_id,
            "Name": name,
            "ContentType": content_type or "application/octet-stream",
            "Body": base64.b64encode(blob).decode("ascii")
        }
        url = f"{instance}/services/data/{self.API_VERSION}/sobjects/Attachment/"
        res = await self._authed_request(client, "POST", url, creds, user_id, "target", send_log, json=payload)

        if res.status_code == 201:
            return True, res.json().get("id")
        return False, res.text

    async def upload_file(self, client, creds, user_id, new_parent_id: str, name: str, blob: bytes, send_log):
        instance = creds.get("instance_url", "").rstrip('/')

        if len(blob) > self.MAX_INLINE_BYTES:
            msg = f"'{name}' is {len(blob) / 1e6:.1f}MB, over the {self.MAX_INLINE_BYTES / 1e6:.0f}MB inline upload limit."
            await send_log(f"[File SKIPPED] {msg}")
            return False, msg

        payload = {
            "Title": name,
            "PathOnClient": name,
            "VersionData": base64.b64encode(blob).decode("ascii"),
            "FirstPublishLocationId": new_parent_id
        }
        url = f"{instance}/services/data/{self.API_VERSION}/sobjects/ContentVersion/"
        res = await self._authed_request(client, "POST", url, creds, user_id, "target", send_log, json=payload)

        if res.status_code == 201:
            return True, res.json().get("id")
        return False, res.text

    async def migrate_files_for_batch(
        self, client, source_creds, target_creds, user_id: str, id_map: dict,
        migrate_attachments: bool, migrate_files: bool, send_log, concurrency: int = 4
    ):
        """
        id_map: { old_source_record_id: new_target_record_id }
        (this is exactly what you already have in `all_success_data` after
        the object migration pass, via each record's stamped `Target_Id`)

        Returns a results dict for reporting/audit purposes.
        """
        old_ids = list(id_map.keys())
        results = {
            "attachments": {"success": 0, "error": 0, "errors": []},
            "files": {"success": 0, "error": 0, "errors": []}
        }
        semaphore = asyncio.Semaphore(concurrency)

        if not old_ids:
            return results

        if migrate_attachments:
            attachments = await self.extract_attachments(client, source_creds, user_id, old_ids, send_log)

            async def move_attachment(att):
                async with semaphore:
                    new_parent = id_map.get(att["ParentId"])
                    if not new_parent:
                        return
                    try:
                        blob = await self.download_body(client, source_creds, user_id, att["Id"], "attachment", send_log)
                        ok, info = await self.upload_attachment(
                            client, target_creds, user_id, new_parent,
                            att.get("Name", "attachment"), att.get("ContentType"), blob, send_log
                        )
                        if ok:
                            results["attachments"]["success"] += 1
                        else:
                            results["attachments"]["error"] += 1
                            results["attachments"]["errors"].append({"name": att.get("Name"), "parentId": att["ParentId"], "error": info})
                    except Exception as e:
                        results["attachments"]["error"] += 1
                        results["attachments"]["errors"].append({"name": att.get("Name"), "parentId": att["ParentId"], "error": str(e)})

            if attachments:
                await send_log(f"[Attachments] Migrating {len(attachments)} legacy attachments...")
                await asyncio.gather(*[move_attachment(a) for a in attachments])
                await send_log(f"[Attachments] Done: {results['attachments']['success']} succeeded, {results['attachments']['error']} failed.")

        if migrate_files:
            files = await self.extract_files(client, source_creds, user_id, old_ids, send_log)

            async def move_file(f):
                async with semaphore:
                    new_parent = id_map.get(f["ParentId"])
                    if not new_parent:
                        return
                    try:
                        blob = await self.download_body(client, source_creds, user_id, f["ContentVersionId"], "file", send_log)
                        ok, info = await self.upload_file(
                            client, target_creds, user_id, new_parent, f.get("Name", "file"), blob, send_log
                        )
                        if ok:
                            results["files"]["success"] += 1
                        else:
                            results["files"]["error"] += 1
                            results["files"]["errors"].append({"name": f.get("Name"), "parentId": f["ParentId"], "error": info})
                    except Exception as e:
                        results["files"]["error"] += 1
                        results["files"]["errors"].append({"name": f.get("Name"), "parentId": f["ParentId"], "error": str(e)})

            if files:
                await send_log(f"[Files] Migrating {len(files)} modern Files...")
                await asyncio.gather(*[move_file(f) for f in files])
                await send_log(f"[Files] Done: {results['files']['success']} succeeded, {results['files']['error']} failed.")

        return results