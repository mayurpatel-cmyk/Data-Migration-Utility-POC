# SureShift — Architecture

**Stack:** Angular frontend (chat-style guided migration UI) + FastAPI backend + Supabase (auth, connection storage, report storage) + local Ollama embedding model (AI field mapping).

This document describes *how the system is built* — layering, contracts, data flow, and concurrency model. For feature inventory, CRM limitations, and the operational runbook, see `SureShift_Migration_Documentation.md`.

---

## 1. System Layers

```
┌─────────────────────────────────────────────────────────────────┐
│ Angular Frontend                                                 │
│  API-mapping_component   — CRM → CRM field mapping UI            │
│  data-validation_component — CSV upload → validation queue UI    │
│  default_component       — migration queue → /ws/migrate driver  │
│  DataTransferService      — in-memory handoff between the two    │
└───────────────────────────────┬───────────────────────────────────┘
                                 │ REST + WebSocket
┌────────────────────────────────▼───────────────────────────────────┐
│ FastAPI Routes                                                     │
│  metadata_routes.py    — object/field discovery, AI auto-map       │
│  validation_routes.py  — file upload, chunked validate (REST)      │
│  migration_routes.py   — /ws/migrate, /ws/validate-stream, audit   │
│  migration_history.py  — past-session listing                     │
└──────┬──────────────────┬───────────────────┬──────────────────────┘
       │                  │                   │
┌──────▼──────┐   ┌───────▼────────┐   ┌──────▼───────────────┐
│ crm_service │   │ payload_builder │   │ validator_service     │
│ crm_metadata│   │  .py            │   │  → ValidatorFactory   │
│ crm_query   │   │ (CRM-agnostic   │   │  → {crm}_validator.py │
│  .py        │   │  record shaper) │   │  (pandas, per-CRM     │
│ (auth +     │   └────────┬────────┘   │  type/rule engine)    │
│  metadata + │            │            └───────────────────────┘
│  preview)   │            │
└──────┬──────┘            │
       │           ┌───────▼────────────────────────┐
       │           │ {crm}_migrator.py (per CRM)     │
       │           │  salesforce_migrator.py         │
       │           │  zoho_migrator.py                │
       │           │  zendesk_migrator.py              │
       │           │  hubspot_migrator.py               │
       │           │  salesforce_file_migrator.py        │
       │           │  (extract() / upload() contract)     │
       │           └───────┬────────────────────────────┘
       │                   │ httpx (async)
┌──────▼───────────────────▼─────────────────────────────────┐
│ External CRMs: Salesforce · Zoho · Zendesk · HubSpot          │
└─────────────────────────────────────────────────────────────┘

Supabase: crm_connections (OAuth creds), migration_history, Storage (PDF/CSV reports)
Ollama (local): mxbai-embed-large — ai_services.py cosine-similarity field matching
```

---

## 2. Core Abstractions

### 2.1 Migrator contract (`{crm}_migrator.py`)

Every migrator implements the same two-method shape, called uniformly from `migration_routes.py` regardless of target CRM:

```python
async def extract(client, creds, obj_name, query, mappings, send_log) -> list[dict]
async def upload(client, payload, op_mode, pass_name, options, send_log) -> tuple[
    total_success, total_error, total_skipped,
    all_success_data, all_error_data, all_skipped_data
]
```

- `extract()` pulls source records via the CRM's own query language (SOQL, COQL, Zendesk Search, HubSpot `filterGroups`) and flattens nested/list values to strings so the validator and payload builder can treat every record as a flat dict.
- `upload()` receives an already-built `payload` (see §2.3), chunks it per the target CRM's bulk-write limits, and — for `update`/`upsert` — resolves existing records before deciding create vs. update. This resolution step is CRM-specific and is the single biggest source of correctness bugs in the system (see §6.2).
- Every migrator implements the same **Update-mode auto-revert** invariant: if `update` mode causes the CRM to auto-create a record (no match found), that record is deleted/archived after the fact (`_delete_records` / `_archive_records`), so `update` never silently degrades into `insert`.

CSV-sourced jobs skip `extract()` entirely — `migration_routes.py` reads `job["sourceRecords"]` directly instead of calling a migrator.

### 2.2 Validator contract (`{crm}_validator.py` via `ValidatorFactory`)

```python
def validate(records, mappings, dedupe_key, target_rules, date_format="") -> {
    "stats": {"total", "valid", "invalid", "duplicates"},
    "validRecords": [...],
    "invalidRecords": [{"originalRow", "errors", "rowNumber"}]
}
```

`validator_service.py::process_validation_batch` is a thin gateway that resolves `target_crm` → `ValidatorFactory.get_validator()` → one of `SalesforceValidator` / `ZohoValidator` / `ZendeskValidator` / `HubspotValidator` / `BaseValidator` (fallback). Each is a pandas-vectorized rule engine keyed off the target CRM's field-type taxonomy (picklist, multiselect, currency/precision, date, boolean, email/URL, lookup-ID format, etc.), reading required/unique/length/picklist rules out of `target_rules[field]` (live CRM metadata) with `mapping.get(...)` as a fallback when metadata is thin.

Two historical mapping key conventions coexist throughout the validators and payload builder — `csvField`/`sfField` (CSV path) and `sourceField`/`targetField` (API-mapping path) — every consumer reads both (`mapping.get("targetField") or mapping.get("sfField")`, etc.) rather than normalizing at the boundary. This is a deliberate compatibility shim, not an oversight, but it means **any new mapping consumer must remember to check both key names** or it will silently see zero fields for one of the two migration paths.

### 2.3 PayloadBuilderService — the CRM-agnostic shaping layer

`payload_builder.py::build_payload(raw_records, mappings, options, target_crm)` is the single chokepoint every record passes through before hitting a migrator's `upload()`. Per mapping, per record, it:

1. Resolves the source value (`sourceField`/`csvField`, falling back to an already-transformed value under `targetField` if the validator renamed columns).
2. Sanitizes it — NaN → `None`, string-null tokens (`"nan"`/`"null"`/`"none"`/`"nat"`/`"<na>"`/`"undefined"`/`""`) → `None`, strips trailing `.0` on numeric-looking strings.
3. Coerces to the exact JSON type the target field expects (string/number/boolean/date), with CRM-specific quirks (Zoho wants strict int vs. float; Salesforce/Zoho dates as `YYYY-MM-DD` / ISO datetime).
4. Applies self-reference / cross-reference filtering (`skipSelfReferencing`, `onlySelfReferencing`, `excludeReferencesTo`, `onlyReferencesTo`) — this is what makes the two/three-pass dependency-safe migration in §4 possible.
5. Shapes the field into the target CRM's relationship format — Salesforce `{ "Account__r": {"External_Id__c": val} }`, Zoho `{ "field": {"extId": val} }`, Zendesk `custom_object_fields`/`custom_fields` split, HubSpot (references intentionally dropped — see §5).

`_dedupe_target_fields()` and `dedupe_by_unique_key()` are defensive backstops: the first collapses two mapping rows that both target the same field (last-one-wins, matching how the per-record loop would behave anyway) so silent data loss at least gets logged; the second collapses duplicate key *values* within one batch before it reaches a bulk upsert endpoint, since Salesforce/HubSpot/Zoho/Zendesk bulk APIs don't guarantee deterministic behavior when two rows in the same call share a key.

---

## 3. Request/Data Flow

### 3.1 CRM → CRM (direct)

```
API-mapping_component.ts
  → GET /api/metadata/{crm}/objects, /fields/{object}   (crm_metadata_service.py)
  → POST /api/metadata/preview-filter                    (crm_query_service.py)
  → POST /api/metadata/ai-auto-map                        (ai_services.py, local embeddings)
  → user reviews/adjusts mapping, sets relationalExtIdField per lookup field
  → WS /ws/migrate  { queue: [ {sourceObject, targetObject, mappings: enhancedMappings, ...} ] }
      enhancedMappings carries: sourceField, targetField, type, referenceTo,
      relationshipName, relationalExtIdField, parentObjectName
  → migration_routes.py: sort_jobs_by_dependency() → per job:
       source_migrator.extract() → PayloadBuilderService.build_payload() → target_migrator.upload()
  → audit_service.py generates PDF + CSVs, migration_history row inserted
```

### 3.2 CSV → CRM

```
data-validation_component.ts
  → POST /api/python/extract-headers                     (validation_routes.py)
  → POST /api/python/validate  (chunked, 10k rows)        (validator_service.py)
  → addToQueue(): builds validationQueue[].mappings = cleanMappings
      (csvField, sfField, type, relationalExtIdField, referenceTo,
       relationshipName, parentObjectName — see §6.1 for what this used to drop)
  → routeToMigration(): DataTransferService.setValidatedData(validJobs)
  → Angular router → /data-import → default_component.ts

default_component.ts
  → DataTransferService.getValidatedData() on init
  → rebuilds migrationQueue[].mappings from the incoming job.mappings
      (must carry referenceTo/relationshipName/relationalExtIdField through —
       see §6.1; this hop is the second place that data used to get dropped)
  → user can add more objects via queueAnotherObject() / goToReview()
      (these two paths spread ...mapping + attach type/referenceTo/relationshipName
       from live field metadata — this is the reference implementation the
       DataTransferService ingestion path should mirror)
  → WS /ws/migrate  { queue: migrationQueue, sourceCrmId: "csv", sourceRecords: [...] }
  → migration_routes.py: source_crm == "csv" branch reads job["sourceRecords"]
       directly instead of calling a migrator's extract()
```

The CSV path re-derives `type`/`referenceTo`/`relationshipName` from live target-CRM field metadata at *each* hop (`addToQueue`, `queueAnotherObject`, `goToReview`) rather than trusting a previously-attached value, because the mapping object is mutated in place through several UI states (`onSfFieldChange`, `selectParentField`, `clearMapping`) and metadata is the only source of truth that's always current.

---

## 4. Dependency-Ordered Multi-Object Migration

`migration_routes.py::sort_jobs_by_dependency()` performs a DFS topological sort over the job queue, using each job's `mappings[].referenceTo` to build an edge list (`m.get("type") == "reference" and m.get("referenceTo")`). Three execution shapes fall out of this:

- **No self/cross reference on this object** → single pass, straight insert/update/upsert.
- **Self-reference** (e.g. `Account.ParentId → Account`) → two passes per job: Pass 1 inserts with `skipSelfReferencing=True` (self-ref field omitted), Pass 2 re-upserts the same records with `onlySelfReferencing=True` to backfill the self-referencing field now that every row has an ID.
- **Circular cross-object reference** (A references B, B references A) → the DFS detects the back-edge, marks it `deferReferencesTo`, and appends a synthetic `isPass3Patch` job that runs *after* every other job, upserting only the deferred reference field via `onlyReferencesTo`.

This entire mechanism is inert unless `referenceTo` survives on every mapping that reaches `migration_routes.py` — it is populated correctly for the API-mapping path (metadata is attached at mapping-build time) but was, until recently, silently empty for CSV-sourced jobs (see §6.1).

---

## 5. Per-CRM Concurrency & Matching Model

| CRM | Chunk size | Concurrency | Update/Upsert existing-record match |
|---|---|---|---|
| Salesforce | `batchSize` (default 5000), Bulk API async job | `asyncio.Semaphore(6)` batch submission, polled to completion | Native Bulk API `upsert` operation with `externalIdFieldName` — server-side matching |
| Zoho | 100/call | Sequential per-chunk (no semaphore) | Native `/upsert` endpoint with `duplicate_check_fields` — server-side matching |
| HubSpot | 100/call | `asyncio.Semaphore(10)` | Native `batch/upsert` with `idProperty` — server-side matching |
| Zendesk | 100/call | 5 chunks concurrently via `asyncio.gather`, batched in groups of 5 | **Client-resolved** for `organizations`/`tickets` (no native bulk-upsert-by-external-id endpoint) — the migrator searches for existing records itself, then manually splits the chunk into `update_many`/`create_many` calls. Users and standard bulk-write objects with a native `create_or_update_many` bypass this. |

Zendesk is the odd one out architecturally: every other migrator delegates existing-record resolution to the target CRM's own upsert endpoint, which is atomic and strongly consistent by construction. Zendesk's manual-split path is where client-side matching bugs live — see §6.2.

---

## 6. Known Architectural Risk Areas (and what's been fixed)

### 6.1 Mapping metadata attrition across the CSV pipeline (fixed)

The CSV path passes mapping objects through three components (`data-validation_component` → `DataTransferService` → `default_component`) before they reach `migration_routes.py`. Two of those hops previously rebuilt the mapping object from a narrower field list, dropping `relationalExtIdField`, `referenceTo`, `relationshipName`, and `parentObjectName` — which silently broke:
- `PayloadBuilderService.build_payload()`'s relationship-wrapping (records got sent as raw values instead of `{relationshipName: {relationalExtIdField: value}}`)
- `sort_jobs_by_dependency()`'s self/cross-reference detection (§4), since it keys off `referenceTo`

Both hops now carry the full mapping shape through, matching what `queueAnotherObject()`/`goToReview()` already did correctly in `default_component.ts`.

### 6.2 Zendesk manual-upsert used an eventually-consistent lookup (fixed for organizations)

`process_manual_upsert_chunk()` matched existing organizations by `external_id` via `/api/v2/search.json`, which is backed by Zendesk's asynchronous search index (documented indexing lag of seconds to minutes under load). Because chunks run concurrently, an org created in an earlier chunk of the *same* run frequently wasn't searchable yet when a later chunk looked it up — the match failed, the record fell into `create_records` instead of `update_records`, and Zendesk created a duplicate org with the same `external_id`.

Fixed by switching organizations to `GET /api/v2/organizations/show_many.json?external_ids=...`, which reads the primary table via its unique `external_id` index — no propagation lag. Tickets and other manually-split object types still use the Search API fallback, since Zendesk doesn't expose an equivalent `show_many` for them; this remains a latent risk for any standard object other than organizations/users that ever needs `needs_manual_upsert_split`.

### 6.3 Remaining known gaps (not yet addressed)

- **`crm_metadata_service.py` never populates `relationshipName`** for any CRM (always `None`/absent). `payload_builder.py` falls back to deriving it from field-name convention (`Id` suffix stripped, `__c` → `__r`), which is Salesforce-specific and silently wrong for non-conventionally-named relationship fields on Salesforce, and a no-op for Zoho (which doesn't need `relationshipName` — it wraps by field name directly).
- **`crm_metadata_service.py` hardcodes `referenceTo: None` for every Zendesk field.** Combined with §4, this means Zendesk targets never get dependency-ordered multi-object migration or self-reference two-pass handling, even after the §6.1 fix — there's simply no reference metadata to propagate. A Zendesk-side fix would need to source `referenceTo` from Zendesk's lookup-field relationship target, which the current extraction code doesn't request.
- **HubSpot associations are not migrated.** `payload_builder.py`'s HubSpot branch explicitly `pass`es on `type == "reference"` fields — cross-object relationships into HubSpot need a separate Associations API call per record, unimplemented.
- **Two mapping key conventions (`csvField`/`sfField` vs. `sourceField`/`targetField`) are read defensively everywhere** rather than normalized once at ingestion. Functionally safe today because every consumer checks both, but it's an easy trap for new code that only checks one.

---

## 7. Auth & Token Refresh Pattern

Every outbound CRM call follows the same shape: try the stored `access_token`; on `401`, call `CrmService.refresh_crm_token(user_id, crm_type, role)` once (source and target connections refresh independently — a migration can be mid-flight refreshing target while source stays valid), retry once, then propagate the error if the retry also fails. This pattern is duplicated per-migrator/per-metadata-service rather than centralized in an HTTP client wrapper (`salesforce_file_migrator.py::_authed_request` is the one exception that factors it into a helper) — a candidate refactor if a 5th CRM is added.

---

## 8. Extending the System (adding a 5th CRM)

Touches exactly these files:

| File | What to add |
|---|---|
| `crm_service.py::refresh_crm_token` | New `elif crm == "newcrm":` branch |
| `crm_metadata_service.py` | `fetch_<newcrm>_objects` / `fetch_<newcrm>_fields` — **populate `referenceTo`/`relationshipName` here**, don't repeat the Zendesk gap (§6.3) |
| `crm_query_service.py` | `execute_<newcrm>_query` |
| `payload_builder.py` | New `elif target_crm == "newcrm":` formatting branch |
| `migrators/<newcrm>_migrator.py` | New class implementing the `extract()`/`upload()` contract (§2.1) — prefer the target CRM's native upsert-by-external-id endpoint over client-side search-based matching (§6.2) |
| `validators/<newcrm>_validator.py` | New class implementing the `validate()` contract (§2.2), registered in `validator_factory.py` |
| `migration_routes.py::MIGRATORS` | Register the new migrator instance |
| `metadata_routes.py::restricted_targets` | Add the new CRM's system-field names so AI auto-map doesn't offer them |
| Angular connection component | New "Connect" card + OAuth redirect handling |