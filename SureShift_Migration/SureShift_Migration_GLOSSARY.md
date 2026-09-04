# SureShift — Glossary

Terms as used *in this codebase*, not general CRM-industry definitions where the two differ. Organized by topic. See `ARCHITECTURE.md` for how these fit together and `API.md` for where each shows up in a request/response.

---

## Migration modes

**`op_mode`**
The mode the user picked in the UI: `insert`, `update`, `upsert`, or `delete`. This is what every migrator function receives as its `op_mode` parameter.

**`wire_op_mode`**
What actually gets sent to the target CRM's API. Every migrator does `wire_op_mode = "upsert" if op_mode == "update" else op_mode` — **there is no such thing as a pure "update" call to any target CRM in this system.** `update` is implemented as an upsert, followed by auto-revert (below) of anything the CRM created instead of matched.

**Update-mode auto-revert**
The mechanism that makes `update` mode actually mean "only touch existing records." Since `update` is wired as `upsert`, a row with no matching external ID gets created by the CRM. Every migrator tracks the IDs of such rows (`ids_to_revert`) and deletes/archives them after the batch completes, so the record shows up in the audit report as **skipped**, not as a phantom success.

**Insert / Update / Upsert / Delete** (as concepts, not just modes)
- **Insert**: always creates. No existing-record matching happens.
- **Update**: only touches records that already exist (matched by external ID); anything unmatched is skipped, not created (see auto-revert above).
- **Upsert**: creates or updates, whichever matches. This is the mode multi-pass reference resolution (below) always uses internally, regardless of what the user picked for the main pass.
- **Delete**: payload is trimmed down to just the `Id`/`id` field before sending — see `PayloadBuilderService.build_payload`'s delete-mode branch.

---

## Reference / relationship fields

**External ID / dedupe key**
The field used to match an incoming row against an existing target-CRM record for `update`/`upsert`. Called `targetExtIdField` or `dedupeKey` depending on which part of the codebase you're in (same concept, two names — see "Two mapping key conventions" in `API.md`). **Mandatory** for update/upsert — every migrator short-circuits the whole batch with zero network calls if it's missing, rather than guessing.

**`referenceTo`**
On a target field's metadata: which object(s) a lookup/reference field points to (e.g. `Contact.AccountId.referenceTo == ["Account"]`). This is what `sort_jobs_by_dependency()` reads to figure out migration order — a mapping with no `referenceTo` is invisible to the dependency sorter even if it's genuinely a lookup field.

**`relationshipName`**
Salesforce-specific: the relationship name used to traverse a lookup in a nested-object payload (e.g. `AccountId` ↔ `Account__r`). Only used when building a payload that resolves a lookup by *external ID* rather than by CRM record ID — see `relationalExtIdField` below. **Not currently populated by `crm_metadata_service.py` for any CRM** — `payload_builder.py` falls back to deriving it from the field name (`Id` suffix stripped, `__c` → `__r`), which only works for conventionally-named fields.

**`relationalExtIdField`**
Per-mapping: which field on the *related* object should be used to resolve a lookup, when you don't have the related record's CRM-native ID (e.g. linking a Contact to an Account by the Account's own external ID, not its Salesforce Id). If this is unset, the field is sent as a plain value instead of a relationship lookup — a very easy way to silently break reference-field migrations if this gets dropped anywhere in the pipeline (see `ARCHITECTURE.md` §6.1 for a case where it was).

**`parentObjectName`**
Which object `relationalExtIdField` is a field *on* — i.e. the resolved value of `referenceTo[0]` for a given mapping, cached once so the UI can fetch that object's fields for the "pick a relational ext ID field" dropdown.

**Self-reference**
A lookup field where `referenceTo` includes the *same* object currently being migrated (e.g. `Account.ParentId → Account`). Requires two passes (see below) because you can't set a record's parent to another record that doesn't have an ID yet.

**Cross-reference / circular reference**
Two different objects in the same migration queue that reference each other (A→B and B→A). Handled with a deferred third pass (see Pass 1/2/3 below) since neither object can be fully inserted first.

**Pass 1 / Pass 2 / Pass 3**
The multi-pass execution shapes `migration_routes.py` builds for reference-heavy jobs:
- **Pass 1**: insert/update/upsert with the self-referencing field *omitted* (`skipSelfReferencing=True`).
- **Pass 2**: re-upsert the same records with *only* the self-referencing field populated (`onlySelfReferencing=True`), now that every row has an ID from Pass 1.
- **Pass 3** (`isPass3Patch`): a synthetic job appended after every other job in the queue, upserting only the fields that reference an object involved in a circular dependency (`onlyReferencesTo`).

---

## Data pipeline

**Mapping** / **mapping row**
One `{source field} → {target field}` pairing, plus its metadata (type, reference info, validation rules). Two different shapes exist for historical reasons — see "Two mapping key conventions" in `API.md`.

**`cleanMappings`** (CSV flow, `data-validation_component.ts`)
The mapping array as it's packaged into a `validationQueue` job — stripped down to just what the validator needs, with reference metadata (`referenceTo`/`relationshipName`/`relationalExtIdField`) re-attached from live field metadata rather than trusted from the in-progress UI state.

**`enhancedMappings`** (both flows)
The mapping array as it's packaged into a `migrationQueue`/`queue` job right before hitting `/ws/migrate` — this is the shape `PayloadBuilderService` and `sort_jobs_by_dependency()` actually consume. If reference metadata didn't survive into `enhancedMappings`, the migration engine effectively can't see it, regardless of what the UI showed.

**Validation queue** vs. **Migration queue**
Two different in-memory lists in two different components. `data-validation_component`'s `validationQueue` holds jobs that have been mapped and validated but not yet migrated. `default_component`'s `migrationQueue` holds jobs that are about to be sent over `/ws/migrate`. `DataTransferService` is the one-shot handoff between them (CSV flow only — the CRM→CRM flow builds `migrationQueue` directly).

**Staging session** / **session ID**
A per-validation-run SQLite file (`SureShift_staging_databases/{crm}/{object}/{session_id}.db`) holding every record from a live-CRM validation pass, split into valid/invalid. Lets the UI re-validate just the rows the user fixed (`/ws/validate-stream` with `isRevalidation: true`) without re-extracting from the source CRM. CSV-uploaded validation (`/api/python/validate`) does **not** create a staging session — it's stateless, single-shot.

**Chunk** / **batch**
A slice of records processed together against a rate-limited or size-limited API. Chunk size is CRM-specific and hardcoded per migrator (Salesforce: `batchSize`, default 5000, via Bulk API; Zoho/HubSpot/Zendesk: 100). Not the same as a *validation* chunk (`validation_routes.py`/`migration_routes.py` chunk at 10,000/1,000 rows respectively — a much larger unit, since validation is local CPU work, not a rate-limited API call).

**`payload`** / **`targetRecord`** / **`originalIndex`**
The output of `PayloadBuilderService.build_payload()`: a list of `{"originalIndex": idx, "targetRecord": {...}}`. `targetRecord` is the fully-shaped, CRM-ready record; `originalIndex` is how a migrator maps a CRM API response back to the original source row for success/error/skip reporting.

**`Target_Id`** / **`Target_Error`** / **`Target_SkipReason`**
Fields every migrator stamps onto the *original* source record (not the payload) before adding it to the success/error/skipped lists — this is what ends up in the audit CSVs. `Target_Id` is the new record's ID in the target CRM; `Target_Error` is the failure reason; `Target_SkipReason` explains why a row was intentionally not written (e.g. update-mode auto-revert, duplicate key within a batch).

---

## CRM / auth

**Source** / **target** (as a `role`)
Every CRM connection is stored per-user, per-CRM, per-role. A user can have a Salesforce connection as `source` and a different Salesforce connection as `target` simultaneously (e.g. sandbox → production). Almost every backend function that touches a CRM takes a `role` parameter for exactly this reason.

**Silent token refresh**
The pattern every CRM-calling function follows: try the stored `access_token`, and on a `401`, call `CrmService.refresh_crm_token()` once and retry, all without surfacing anything to the frontend unless the refresh itself also fails.

**SOQL** / **COQL**
Salesforce's and Zoho's respective SQL-like query languages, used for the `extract()` step and for preview/count queries. Zendesk and HubSpot don't have a SQL-like language — Zendesk uses its Search API query syntax, HubSpot uses a `filterGroups` JSON structure.

**Bulk API job** (Salesforce)
Salesforce's async bulk-write mechanism (`/services/async/60.0/job`) — you open a job, submit batches against it, close it, then poll for completion. This is why Salesforce uploads look structurally different from every other migrator (open job → submit → close → poll → fetch per-batch results), instead of a single synchronous bulk-write call.

**`idProperty`** (HubSpot) / **`duplicate_check_fields`** (Zoho) / **`external_id`** (Zendesk)
Each CRM's own name for "the field to match existing records on" during a native upsert call. This is the value of `targetExtIdField`/`dedupeKey`, just passed under a different key per CRM's API contract.

**`show_many` vs. Search API** (Zendesk)
Two different ways to look up an existing Zendesk record by external ID. `show_many.json?external_ids=...` reads the primary table directly (strongly consistent, no lag). `/api/v2/search.json` reads an asynchronous search index that can lag writes by seconds to minutes. Organizations use `show_many`; anything without an equivalent endpoint (tickets, custom objects) falls back to Search and inherits its consistency risk — see `ARCHITECTURE.md` §6.2.

**Manual upsert split** (Zendesk)
What happens when a Zendesk object type has no native bulk-upsert-by-external-id endpoint: the migrator looks up existing records itself, then manually splits the chunk into a `update_many` call and a `create_many` call. This is the one place in the system where existing-record matching is client-resolved instead of delegated to the target CRM's own atomic upsert.

---

## AI mapping

**AI Auto-Map**
The `/api/metadata/ai-auto-map` pipeline: exact normalized-name match → token-overlap heuristic → `difflib` fuzzy match → (for anything still unmatched) cosine-similarity match against local Ollama embeddings (`mxbai-embed-large`). Confidence scores from each stage are comparable but computed differently — treat `1.0` (exact match) as categorically more trustworthy than a `0.83`+ embedding-similarity score.

**Confidence**
A `0–1` score attached to an AI-suggested mapping. `1.0` = exact normalized-name match. `0.85` = token-overlap heuristic. `0.75` = fuzzy string match. Embedding-based matches use raw cosine similarity (with small type-match/exact-text-match bonuses added), thresholded at `> 0.83` to even be offered.

**Taxonomy expansion** (`ai_services.py::CRM_FIELD_CONTEXT`)
A hand-maintained synonym table (`"fname"` → `"first given name"`, etc.) used to enrich a field's name/label before embedding, so semantically-equivalent fields with unrelated literal names still match. If a new synonym pair is needed for a new CRM, this is where it goes.
