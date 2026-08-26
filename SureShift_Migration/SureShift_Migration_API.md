# SureShift — API Reference

REST + WebSocket endpoints, grouped by route file. All routes require an authenticated user; REST routes use `current_user = Depends(get_current_user)`, WebSocket routes take an `authToken` in the first message payload and validate it manually against Supabase.

For domain terms used below (dedupe key, self/cross-reference, staging session, etc.), see `GLOSSARY.md`. For the system this API sits in front of, see `ARCHITECTURE.md`.

---

## metadata_routes.py

### `GET /api/metadata/{crm_id}/objects`

List the available objects for a connected CRM.

| Param | In | Notes |
|---|---|---|
| `crm_id` | path | `salesforce` \| `zoho` \| `zendesk` \| `hubspot` |
| `role` | query, default `source` | `source` or `target` — which connection slot to use |

Silently refreshes the CRM token and retries once on a `401` from the CRM. Returns `400` for an unsupported `crm_id`.

**Response:** shape is whatever `CrmMetadataService.fetch_<crm>_objects` returns — treat as CRM-specific; the frontend normalizes it.

---

### `GET /api/metadata/{crm_id}/fields/{object_name}`

List fields (with type/picklist/required/reference metadata) for one object.

| Param | In | Notes |
|---|---|---|
| `crm_id` | path | Same as above |
| `object_name` | path | CRM object API name |
| `role` | query, default `source` | |

Same silent-refresh behavior as the objects endpoint. This is the source of the `type`, `referenceTo`, `isRequired`, `picklistValues`, `length` etc. that the frontend attaches to each mapping row and that the validators read via `target_rules[field]`.

---

### `POST /api/metadata/preview-filter`

Run a scoped preview query against a CRM object before committing to a full extraction.

**Body** (`PreviewFilterPayload`):
```json
{
  "crmId": "salesforce",
  "objectName": "Account",
  "query": "",
  "headers": ["Name", "Industry"],
  "limit": 5,
  "role": "source"
}
```
`query` is CRM-native: SOQL fragment for Salesforce, COQL for Zoho, Zendesk search syntax, HubSpot filter JSON. `400` if `objectName` is missing.

**Response:** preview rows from `CrmQueryService.execute_<crm>_query`.

---

### `POST /api/metadata/ai-auto-map`

Hybrid field-mapping pipeline: normalized-name exact match → token-overlap heuristic → `difflib` fuzzy match, with anything unresolved batched to the local Ollama embedding model.

**Body** (`AiAutoMapPayload`):
```json
{
  "sourceFields": [{"name": "Company", "type": "string"}],
  "targetFields": [{"name": "Name", "type": "string"}]
}
```

**Response:**
```json
{
  "mappings": [
    {"sourceField": "Company", "targetField": "Name", "confidence": 1.0}
  ]
}
```
`400` if either field array is empty. System fields (`id`, `createddate`, `hs_object_id`, `$state`, etc. — see `metadata_routes.py::restricted_targets`) and `reference`/`id`-typed fields are excluded from consideration before matching starts.

---

## validation_routes.py

### `POST /api/python/extract-headers`

`multipart/form-data`, field `file` — a `.csv`/`.xlsx`/`.xls` upload. No auth dependency on this one (unlike the others in this file).

**Response:**
```json
{
  "sheets": ["Sheet1"],
  "headersMap": { "Sheet1": ["Name", "Email", "Amount"] }
}
```
For Excel, every sheet's header row is returned so the UI can prompt for a sheet choice when there's more than one.

---

### `POST /api/python/validate`

`multipart/form-data`: `file` (upload) + `config` (JSON string, form field).

**`config` shape:**
```json
{
  "mappings": [{"csvField": "Email", "sfField": "Email", "type": "email"}],
  "dedupeKey": "External_Id__c",
  "sheetName": "Sheet1",
  "sfRules": { "Email": {"required": true, "type": "email"} },
  "dateFormat": "",
  "targetCrmId": "salesforce"
}
```
Processes the file in 10,000-row chunks through `process_validation_batch`, aggregating stats across chunks. This is a one-shot REST call (no staging DB, no session) — the person is meant to iterate on their mapping and re-call this until it looks right before using `/ws/validate-stream` for the staged, resumable version.

**Response:**
```json
{
  "stats": {"total": 500, "valid": 480, "invalid": 20, "duplicates": 3},
  "invalidRecords": [{"originalRow": {...}, "errors": "[Email: Invalid Email format.] "}],
  "validRecords": [{...}]
}
```

---

### `POST /api/python/revalidate`

JSON body, no file — re-runs validation over records already in memory client-side.

```json
{
  "records": [{...}],
  "mappings": [...],
  "dedupeKey": "",
  "sfRules": {...},
  "dateFormat": "",
  "targetCrmId": "salesforce"
}
```

**Response:** same shape as `/api/python/validate`'s response (single-chunk `process_validation_batch` result, not aggregated).

---

### `GET /api/validation/sessions`

Lists up to 10 recoverable staging sessions (SQLite files under `SureShift_staging_databases/{crm}/{object}/{session_id}.db`), most recent first.

**Response:**
```json
{
  "sessions": [
    {"sessionId": "salesforce_account_20260810_143000_a1b2c3d4", "crm": "Salesforce", "object": "Account", "date": "2026-08-10 14:30", "sizeMb": 2.1, "timestamp": 1754837400.0}
  ]
}
```
⚠️ Known gap (documented in the route's own docstring): this only requires *a* valid login, not that the session belongs to the caller — the staging path has no `user_id` in it. See `ARCHITECTURE.md` §6 / the route's docstring for the schema addition needed to close this.

---

## migration_routes.py

### `WS /ws/migrate`

The core migration driver. First message from the client is the full job payload:

```json
{
  "authToken": "...",
  "sourceCrmId": "salesforce",
  "targetCrmId": "zoho",
  "queue": [
    {
      "targetObject": "Contacts",
      "sourceObject": "Contact",
      "extractionQuery": "",
      "mappings": [
        {
          "sourceField": "Email", "targetField": "Email", "type": "string",
          "referenceTo": null, "relationshipName": null, "relationalExtIdField": null
        }
      ],
      "operationMode": "upsert",
      "batchSize": 5000,
      "externalIdField": "External_Id__c",
      "migrateAttachments": false,
      "migrateFiles": false
    }
  ]
}
```

For a CSV-sourced job, set `sourceCrmId: "csv"` and include `sourceRecords: [...]` directly on the job instead of `sourceObject`/`extractionQuery` — `extract()` is skipped entirely for those.

Jobs are topologically sorted by reference dependency (`sort_jobs_by_dependency`, see `ARCHITECTURE.md` §4) before execution, which can inject synthetic `isPass3Patch` jobs for circular references. The server streams progress messages for the duration of the connection and closes it when the queue completes:

```json
{"log": "[Contacts] Standard Sync: Injecting data stream into Zoho CRM...", "status": "Running"}
```

No single final "done" response — the client tracks completion by connection close plus the accumulated log stream. Salesforce → Salesforce jobs with `migrateAttachments`/`migrateFiles: true` trigger a follow-on `SalesforceFileMigrator` pass after the object records succeed, keyed off each success record's `Target_Id`.

---

### `WS /ws/validate-stream`

Two message shapes over the same endpoint, distinguished by `isRevalidation`:

**Initial validation** (`isRevalidation` absent/false) — extracts live from a source CRM and stages results to a new SQLite session:
```json
{
  "authToken": "...",
  "crmId": "salesforce",
  "targetCrmId": "zoho",
  "objectName": "Contact",
  "query": "",
  "mappings": [...],
  "dedupeKey": "",
  "sfRules": {...}
}
```
Streams progress every 1,000-row chunk (`"Validated N records so far..."`) and a final message with `sessionId` for use in re-validation or the audit download endpoint.

**Re-validation** (`isRevalidation: true`) — re-checks specific records the person fixed in the UI, against an existing staging session:
```json
{
  "authToken": "...",
  "isRevalidation": true,
  "sessionId": "salesforce_contact_20260810_143000_a1b2c3d4",
  "fixedRecords": [{"_db_id": 42, "Email": "corrected@example.com"}],
  "mappings": [...],
  "dedupeKey": "",
  "sfRules": {...},
  "targetCrmId": "salesforce"
}
```
`_db_id` on each fixed record identifies the staging row to replace; rows without it are treated as new inserts into the staging DB. Returns `"Error: Staging session expired."` and closes if `sessionId` no longer has a staging file on disk.

**Final response (both modes):**
```json
{
  "log": "Stream Validation Complete: 500 total records.",
  "status": "Validation Passed",
  "stats": {"total": 500, "valid": 480, "invalid": 20, "duplicates": 3},
  "invalidRecords": [{"originalRow": {..., "_db_id": 7}, "errors": "..."}],
  "sessionId": "..."
}
```
`invalidRecords` is capped at 500 rows per response even if more failed — the staging DB holds the full set.

---

### `GET /api/audit/download/{session_id}`

Downloads records from a staging session as CSV.

| Param | In | Notes |
|---|---|---|
| `session_id` | path | From a validate-stream response |
| `type` | query, default `valid` | `valid` or (presumably) `invalid` — check `download_validation_audit` for the exact set of accepted values before relying on this |

Rejects malformed/non-generated `session_id` values (`get_db_path`'s charset check — see `ARCHITECTURE.md` §4.2 refactor note in the migration doc for the hardening applied here).

---

### `GET /api/metadata/{crm_id}/count/{object_name}`

Cheap record-count check (e.g. to warn "you're about to migrate 40,000 records" before a full extraction).

| Param | In | Notes |
|---|---|---|
| `crm_id` | path | |
| `object_name` | path | |
| `role` | query, default `source` | |
| `query` | query, default `""` | Same CRM-native filter syntax as `preview-filter` |

Silent token refresh on `401`, same pattern as every other metadata route.

**Response:** `{"count": 1234}`

---

## migration_history.py

### `GET /api/migration-history`

Lists the calling user's past migration sessions (one row per completed `/ws/migrate` run, written by `audit_service.py`), most recent first.

**Response:**
```json
{
  "success": true,
  "history": [
    {
      "id": "...", "user_id": "...", "session_id": "...",
      "source_crm": "salesforce", "target_crm": "zoho", "target_object": "Contact",
      "total_records": 500, "success_count": 480, "error_count": 20,
      "pdf_url": "https://.../reports.pdf",
      "success_csv_url": "https://.../success.csv",
      "error_csv_url": "https://.../error.csv"
    }
  ]
}
```

---

## Conventions across every endpoint

- **Silent token refresh**: every route that calls out to a connected CRM tries the stored `access_token` first, and on a `401` calls `CrmService.refresh_crm_token(user_id, crm_type, role)` once before retrying. This is invisible to the frontend — it never sees a `401` from a CRM call unless the refresh token itself is also expired (in which case you get a `401` asking the user to reconnect).
- **`role` is always `source` or `target`**, never inferred — a user can have one connection per CRM per role, so every metadata/extraction call needs to say which slot it means.
- **Two mapping key conventions** appear in request bodies throughout: `csvField`/`sfField` (CSV-sourced flow) and `sourceField`/`targetField` (CRM→CRM flow). Every backend consumer reads both; when building a new request body, prefer `sourceField`/`targetField` unless you're specifically feeding the CSV validation endpoints, which use `csvField`/`sfField` by convention.
