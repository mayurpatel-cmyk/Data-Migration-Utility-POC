# SureShift — CRM Migration Documentation & User Manual

**Scope:** Salesforce ⇄ Zoho ⇄ Zendesk ⇄ HubSpot data migration, powered by the SureShift platform (Angular frontend + FastAPI backend).

---

## 1. Feature & Component Inventory

### 1.1 Extracted Features

| Feature | Description | Where it lives |
|---|---|---|
| Multi-CRM OAuth Connect | PKCE-based OAuth2 for Salesforce; standard OAuth2 for Zoho, Zendesk, HubSpot. Each user holds one `source` and one `target` connection slot per CRM. | `crm_routes.py` |
| Silent Token Refresh | Every metadata/query/migration call transparently retries once on `401` after exchanging the stored `refresh_token`. | `crm_service.py::refresh_crm_token` |
| Dynamic Object & Field Discovery | Pulls live object/field schemas from the connected CRM instead of a static schema file. | `metadata_routes.py`, `crm_metadata_service.py` |
| Hybrid AI Field Auto-Mapping | 3-pass pipeline: (1) normalized-name exact match, (2) token-overlap heuristic, (3) `difflib` fuzzy match. Anything left over is batched to a local embedding model (Ollama) for cosine-similarity matching. | `metadata_routes.py::ai_auto_map_fields`, `ai_services.py` |
| Preview / Query Filter | Lets a user run a scoped query (SOQL, COQL, Zendesk search syntax, or a HubSpot filter JSON) against the source CRM before committing to a full migration. | `crm_query_service.py` |
| Chunked, Streaming Validation | Uploads (CSV/XLSX) are validated in 10k-row chunks against target-CRM-specific rules, staged into a per-session SQLite file so the UI can resume/re-validate without re-uploading. | `validation_routes.py`, `migration_routes.py` (`/ws/validate-stream`) |
| Payload Builder | Normalizes mapped records into the exact wire format each target CRM expects (Salesforce relationship lookups, Zoho external-ID wrapping, Zendesk custom object/field split, HubSpot property flattening). | `payload_builder.py` |
| Dedupe Guard | Before an upsert/update batch goes out, collapses duplicate unique-key rows within the same batch (last-row-wins) so bulk APIs don't behave non-deterministically. | `payload_builder.py::dedupe_by_unique_key` |
| Dependency-Ordered Multi-Object Migration | Topologically sorts a queue of object migration jobs by lookup/reference dependencies, with a deferred "pass 3" patch for circular references. | `migration_routes.py::sort_jobs_by_dependency` |
| Update-Mode Auto-Revert | If "Update" mode causes a target CRM to auto-create a record (no match found), that record is automatically archived/deleted after the fact so Update never silently behaves like Insert. | `salesforce_migrator.py`, `zoho_migrator.py`, `hubspot_migrator.py` (`_delete_records` / `_archive_records`) |
| File & Attachment Migration | Salesforce → Salesforce only (for now): migrates both legacy `Attachment` and modern `ContentVersion`/`ContentDocumentLink` files, keyed off the object migration's `Target_Id` map. | `salesforce_file_migrator.py` |
| Audit Reporting | Per-session PDF summary + success/error CSVs, uploaded to Supabase Storage and linked from `migration_history`. | `audit_service.py` |
| Migration History | Per-user list of past migration sessions with links to generated reports. | `migration_history.py` |

### 1.2 Component Mapping

| SureShift Concept | Salesforce | Zoho CRM | Zendesk | HubSpot |
|---|---|---|---|---|
| Record container | sObject (`Account`, custom `__c` objects) | Module (`Leads`, `Deals`) | Standard resource (`tickets`, `users`) or Custom Object | Object (`contacts`, `deals`, custom objects) |
| Unique/External ID field | External ID field (must be marked as such in Setup) | Any field + `duplicate_check_fields` | `external_id` | `idProperty` on upsert |
| Relationship/Lookup | Reference field (`AccountId`) + optional relationship name (`Account__r`) | Lookup field wrapped as `{ "field": "extId" }` | `custom_object_fields` for lookups | Association API (not auto-mapped — see §2.2) |
| Bulk write mechanism | Bulk API 2.0-style async job (`/services/async/60.0/job`) | REST batch upsert (100 rows/call) | `create_or_update_many` / custom object batch | `batch/upsert`, `batch/create` (100 rows/call) |
| Query language | SOQL | COQL | Search API query string / custom object filter | Search API `filterGroups` JSON |

---

## 2. CRM Limitations & System Constraints

### 2.1 Known Technical Limitations

| CRM | Limit | Enforced where |
|---|---|---|
| Zoho | COQL queries capped at 200 records/request | `crm_query_service.py`, `zoho_migrator.py` clamp `limit` to 200 |
| Zoho | Bulk upsert batch size: 100 records | `zoho_migrator.py::chunk_dataset(..., 100)` |
| HubSpot | Batch upsert/create: 100 records/call | `hubspot_migrator.py::chunk_dataset(..., 100)` |
| HubSpot | Property list capped at 100 in search payloads | `hubspot_migrator.py` (`properties[:100]`) |
| Zendesk | Rate-limited; `429` responses carry `Retry-After` | Handled via silent-retry loop in `hubspot_migrator.py`/analogous Zendesk logic |
| Salesforce | REST inline file upload ceiling: ~25MB raw / ~35MB base64 | `salesforce_file_migrator.py::MAX_INLINE_BYTES` — larger files are skipped and reported, not silently dropped |
| Salesforce | Bulk API job batches default to 5,000 records | `salesforce_migrator.py::chunk_dataset` |
| All CRMs | AI auto-mapping excludes `id`/`reference`-typed fields and known system fields (`createddate`, `hs_object_id`, `$state`, etc.) from consideration | `metadata_routes.py::restricted_targets` |

### 2.2 Functional Gaps (require manual/custom handling)

- **HubSpot associations are not migrated automatically.** The payload builder explicitly skips `reference`-type fields for HubSpot (`payload_builder.py`, `target_crm == "hubspot"` branch does `pass` on references) because HubSpot associations are a separate API call, not a property on the object payload. Cross-object relationships into HubSpot need a follow-up association pass — not currently implemented.
- **Salesforce/Zoho/Zendesk record file attachments only migrate Salesforce → Salesforce.** Moving attachments into/out of Zoho, Zendesk, or HubSpot is unimplemented.
- **Zendesk custom object relationships** are flattened into `custom_object_fields` rather than resolved as true lookups — no external-ID-style relationship resolution exists for Zendesk targets today.
- **No bidirectional sync** — SureShift performs one-directional, one-time (or repeatable-on-demand) migrations, not continuous sync.

### 2.3 Data Constraints

- **External ID / dedupe key is mandatory for Update and Upsert modes** on every target CRM. If `targetExtIdField` isn't set, the migrator short-circuits the entire batch and reports every row as skipped rather than guessing (`salesforce_migrator.py`, `zoho_migrator.py`, `hubspot_migrator.py` all check this before doing any network I/O).
- **Duplicate keys within one upload are deduped pre-flight** (`payload_builder.py::dedupe_by_unique_key`) — only the last occurrence per key value is sent; earlier ones are reported with `Target_SkipReason`, not silently dropped.
- **Type coercion is opinionated, not configurable per-run:** empty-ish strings (`"nan"`, `"null"`, `"none"`, `"nat"`, `"<na>"`, `"undefined"`, `""`) are normalized to `None`; trailing `.0` on numeric-looking strings is stripped; dates are parsed via `pandas.to_datetime` with `errors='coerce'`.

---

## 3. Step-by-Step CRM Migration Manual

### 3.1 Pre-Migration Prerequisites

1. **Connect both CRM slots.** Under *Connections*, authorize a `source` and a `target` CRM. Salesforce connections additionally require choosing Production vs. Sandbox before the OAuth redirect.
2. **Mark your External ID field** in the target CRM's setup if you intend to run Update or Upsert (Salesforce: mark the custom field as "External ID"; Zoho/HubSpot/Zendesk: any indexable unique field works).
3. **Clean source data** — the validator will catch type mismatches and missing required fields, but it won't fix them for you. Run a dry validation pass first.
4. **Confirm object dependency order** for multi-object migrations (e.g., migrate `Account` before `Contact` if `Contact.AccountId` is mapped) — the dependency sorter (§1.1) handles this automatically from your field mappings, but it's worth sanity-checking the generated execution order in the job queue before running.

### 3.2 Step-by-Step Migration Process

**Step 1 — Data Extraction & Transformation**
- CRM → CRM: SureShift extracts directly via each CRM's query API (SOQL/COQL/Search/filter JSON) — no manual export step needed.
- File → CRM: Upload CSV/XLSX. Headers are extracted instantly (`POST /api/python/extract-headers`) so you can build field mappings before committing to a full validation pass.

**Step 2 — Data Import & Mapping**
1. Select source and target objects.
2. Run **AI Auto-Map** (`POST /api/metadata/ai-auto-map`) to get an initial field-mapping suggestion — review and adjust confidence-flagged fields manually; anything under the heuristic thresholds is routed to the local embedding model and returned with a similarity-based confidence score.
3. For reference/lookup fields, set the **relational external ID field** (which field on the *related* object should be used to resolve the lookup) — this is required for relationship mapping to work on Salesforce and Zoho.
4. Standard objects before custom objects, and parent objects before objects that reference them — enforced automatically by the dependency sort, but confirm the generated pass order matches your expectations.

**Step 3 — Validation & Verification**
- Run validation (`POST /api/python/validate` for file uploads, or the `/ws/validate-stream` websocket for CRM-to-CRM). Records are split into `validRecords` / `invalidRecords` with per-row error messages and staged to a session-scoped SQLite file.
- Fix flagged rows in the UI and **re-validate** (`isRevalidation: true` over the same websocket, same `sessionId`) rather than re-uploading the whole file.
- Before cutover, spot-check record counts: `total = valid + invalid`, and cross-reference `duplicates` reported by the dedupe pass.

### 3.3 Cutover Strategy

1. **Freeze source-side writes** if possible for the duration of the run — SureShift does not currently track incremental changes made during migration.
2. Run the full migration queue in **Insert** mode for a first-time load, or **Upsert** for iterative syncs.
3. Review the generated **audit report** (PDF summary + success/error CSVs, linked from Migration History) before declaring cutover complete.
4. For any rows in the error CSV, decide: re-run just those rows after a fix, or accept the gap and document it.
5. Only after error-rate is acceptable, cut users over to the target CRM.

---

## 4. Component Updates & Code Refactoring Instructions

### 4.1 Components Needing Attention Before Adding a New CRM

Adding a 5th CRM touches exactly these files — anything missed here is where the next integration will silently misbehave:

| File | What to add |
|---|---|
| `crm_routes.py` | OAuth login/callback pair, following the existing `SF_CLIENT_ID`/`ZOHO_CLIENT_ID` env var pattern |
| `crm_service.py::refresh_crm_token` | New `elif crm == "newcrm":` branch |
| `crm_metadata_service.py` | `fetch_<newcrm>_objects` / `fetch_<newcrm>_fields` |
| `crm_query_service.py` | `execute_<newcrm>_query` |
| `payload_builder.py` | New `elif target_crm == "newcrm":` formatting branch |
| `migrators/<newcrm>_migrator.py` | New migrator class implementing `extract()` / `upload()` |
| `migration_routes.py::MIGRATORS` | Register the new migrator instance |
| `metadata_routes.py::restricted_targets` | Add the new CRM's system-field names |
| Angular `connection.component` | New "Connect" card + OAuth redirect handling |

### 4.2 Known Refactor Targets (carried over from architecture review)

```python
# crm_service.py, crm_metadata_service.py, crm_query_service.py, migration_routes.py
# BEFORE — disables TLS certificate validation on every outbound call:
async with httpx.AsyncClient(verify=False, timeout=30.0) as client:
    ...

# AFTER:
async with httpx.AsyncClient(timeout=30.0) as client:
    ...
```

```python
# audit_service.py
# BEFORE — mutates the shared, module-level Supabase client's session:
supabase.auth.set_session(access_token=auth_token, refresh_token="")
supabase.table("migration_history").insert({...}).execute()

# AFTER — request-scoped client, safe under concurrency:
scoped_client = create_client(SUPABASE_URL, SUPABASE_KEY)
scoped_client.auth.set_session(access_token=auth_token, refresh_token="")
scoped_client.table("migration_history").insert({...}).execute()
```

```python
# migration_routes.py::get_db_path
# BEFORE — session_id from the client goes straight into a filesystem path:
def get_db_path(session_id: str):
    parts = session_id.split('_')
    ...

# AFTER — reject anything that isn't the exact charset we generate ourselves:
_SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]+$')
def get_db_path(session_id: str):
    if not session_id or not _SESSION_ID_RE.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session ID.")
    ...
```

```typescript
// auth.interceptor.ts
// BEFORE — attaches the bearer token to every outgoing HttpClient request,
// including third-party/external calls:
authReq = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });

// AFTER — scope to your own API only:
if (!req.url.startsWith(environment.apiUrl)) { return next(req); }
```

---

## 5. Troubleshooting & Rollback Plan

### 5.1 Common Errors

| Error | Cause | Resolution |
|---|---|---|
| `401` from CRM mid-migration, migration continues | Expected — silent refresh kicked in | No action; check logs only if it recurs more than once per session |
| `"[<field>] is not marked as an External ID..."` (Salesforce) | Chosen `targetExtIdField` isn't flagged as External ID / indexed in Salesforce Setup | Mark the field as External ID in Salesforce Object Manager, or pick a different field |
| `"No unique/external ID field configured -- cannot match existing records for UPDATE."` | Update/Upsert mode selected with no dedupe key set | Set `targetExtIdField` in the mapping UI before running |
| Zoho `429` during upload | Zoho API rate limit | Handled automatically (30s backoff + retry); if persistent, reduce `batchSize` |
| `"Skipped: missing required '<field>' value"` (HubSpot) | Row missing the configured dedupe key | Backfill the key in source data, or switch to Insert mode if these should be new records |
| `"Staging session expired."` on re-validation | SQLite staging file for that `sessionId` no longer exists | Re-upload and re-validate from scratch — staging files aren't retained indefinitely |
| `Invalid session ID.` (`400`) on audit download | Malformed/tampered `session_id` | Use the session ID exactly as returned by the validation step; don't hand-construct it |

### 5.2 Rollback Procedure

SureShift's **Update-mode auto-revert** (§1.1) already handles the most common accidental-create case automatically — no manual action needed there.

For everything else:

1. **Stop the migration** — close the `/ws/migrate` connection; in-flight batches complete, queued batches do not start.
2. **Identify affected records** from the audit report's success CSV — every successful row carries the target CRM's `Target_Id`.
3. **Bulk-delete via the target CRM's own bulk API**, using the `Target_Id` list from the success CSV (Salesforce Bulk API delete job, Zoho bulk delete, HubSpot batch archive, Zendesk bulk delete — same APIs SureShift itself uses internally for revert, see `_delete_records`/`_archive_records` in each migrator).
4. **Re-open the source system** for writes if it was frozen for cutover.
5. **Re-run validation** on the corrected data before attempting the migration again.
6. **Do not re-run in Insert mode** against a partially-migrated target without switching to Upsert first — Insert has no duplicate protection beyond what the target CRM itself enforces.

---
