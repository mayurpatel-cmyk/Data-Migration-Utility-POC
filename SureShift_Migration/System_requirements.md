# Migration Tool — System & Storage Requirements

Scope: Salesforce/Zoho/Zendesk/HubSpot record migration + Salesforce↔Salesforce
attachment/file migration (`salesforce_migrator.py`, `salesforce_file_migrator.py`,
`migration_routes.py`, `file_migration_routes.py`).

These numbers are derived from the actual code paths, not generic guidance —
each section cites the mechanism that drives the requirement, and flags where
the current architecture is the limiting factor rather than the hardware.

---

## 1. Baseline (works today, no code changes)

| Resource | Minimum | Recommended |
|---       |---      |---          |
| CPU      | 2 vCPU  | 4 vCPU      |
| RAM      | 4 GB    | 8 GB        |
| Disk (app + logs) | 10 GB | 20 GB SSD |
| Disk (scratch/staging) | see §3 | see §3 |
| Python   | 3.10+   | 3.11        |
| Network  | outbound HTTPS to Salesforce/Zoho/Zendesk/HubSpot APIs | same, plus stable long-lived connections (no aggressive idle-kill) |

This tier is fine for **low-volume runs**: a few thousand records, files under
~25MB (the base64/inline path), one migration at a time. Past that, the
resource driver shifts to the mechanisms in §2–§5 below, not raw hardware.

---

## 2. Memory (RAM)

### 2.1 Record extraction/upload — the primary RAM driver

```python
# salesforce_migrator.py :: extract()
source_records = []
while url:
    ...
    source_records.append(flat_rec)   # entire object's record set, in memory
```

`extract()` accumulates **every record for the object being migrated** into
one Python list before validation or upload starts. `migration_routes.py`'s
validate-stream handler holds this full `raw_records` list for the duration
of the run.

- **RAM driver:** flat size of one object's full record set (not the whole
  migration — jobs run per-object, sequenced by `sort_jobs_by_dependency`).
- **Rule of thumb:** budget **2.5–3× the raw JSON size** of your largest
  single object's record set, to cover the extracted list, the
  validated/deduped copy, and the payload-builder's transformed copy
  co-existing briefly.
- **Concurrency multiplier:** `salesforce_migrator.py::upload()` uses
  `asyncio.gather()` with **no concurrency cap** on batch chunks (unlike file
  migration's `Semaphore(6)`), so every chunk's payload sits in memory
  simultaneously during upload.

| Object record count | Avg record size | Estimated peak RAM (extraction + upload) |
|---|---|---|
| 100,000 | 1 KB | ~0.5–1 GB |
| 1,000,000 | 1 KB | ~3–5 GB |
| 5,000,000 | 1 KB | ~15–25 GB *(not recommended without the fix in §6.1)* |

These are **per object**, not cumulative across a full migration — but if
your migration includes one object at this scale, size the box for it.

### 2.2 File migration — bounded by design (after the multipart change)

```python
semaphore = asyncio.Semaphore(concurrency)   # default 6, in migrate_files_for_batch
```

- **Small files (≤ `MAX_INLINE_BYTES`, 25MB):** read fully into memory and
  base64-encoded (`upload_attachment`/`upload_file`, unchanged). Peak:
  `concurrency × avg_file_size × 1.33` (base64 overhead).
- **Large files (> 25MB, up to `MAX_MULTIPART_BYTES`, 2GB):** streamed in
  1MB chunks on both download (`download_body_to_disk_streamed`) and upload
  (`upload_*_multipart`) — RAM cost per file is ~1MB regardless of file size.
  **This is the fix that makes big-file RAM usage flat, not the box size.**

| Scenario (concurrency = 6, default) | Peak RAM |
|---|---|
| 6 concurrent 10MB files (small-file path) | ~80 MB |
| 6 concurrent 500MB files (multipart path) | ~6 MB (chunked) |
| Mixed batch (small + large together) | dominated by the small-file batch's `concurrency × size × 1.33`, large files stay flat |

**Takeaway:** file migration RAM is already scale-safe post-multipart-fix.
Record migration RAM is **not** — it's the dominant sizing factor for
"millions of records," see §6.1.

---

## 3. Disk (scratch/staging space)

### 3.1 File staging — `tempfile.mkdtemp()` per batch call

```python
staging_dir = tempfile.mkdtemp(prefix=f"sf_file_migration_{user_id}_")
try:
    ...  # all downloads for this batch land here
finally:
    shutil.rmtree(staging_dir, ignore_errors=True)   # deleted only at end of the WHOLE batch
```

Every file downloaded during one `migrate_files_for_batch()` call — small or
multi-GB — stays on disk until **every** file in that call has finished
uploading (success or fail), not deleted per-file. See the follow-up item in
§6.2 if this matters for your deployment.

- **Peak scratch disk per concurrent batch:** `concurrency (default 6) × largest file size in flight`.
  With the new 2GB multipart ceiling: **up to ~12GB** per concurrently-running batch.
- **Cumulative for the batch:** sum of every file's size downloaded during
  that call (not just in-flight ones), since nothing is deleted until the end.
  For a batch containing 500 files averaging 50MB, that's ~25GB sitting on
  disk simultaneously by the time the last file uploads.
- **Multiple simultaneous migrations** (different users/sessions) each get
  their own `mkdtemp()` directory — scratch disk requirement is additive
  across concurrently-running migrations.

| Batch composition | Peak scratch disk |
|---|---|
| 1,000 files, avg 5MB | ~5 GB |
| 200 files, avg 200MB | ~40 GB |
| 50 files, avg 1.8GB (near multipart ceiling) | ~90 GB |

**Recommendation:** provision scratch disk = *(largest realistic single
batch's total file volume)* with headroom for 2–3 concurrent migrations if
multiple users run jobs at once. Use a dedicated volume, not the root disk —
`tempfile.mkdtemp()` defaults to `$TMPDIR`/`/tmp`, which on some container
base images is a small `tmpfs` (RAM-backed!) — **verify `/tmp` is disk-backed,
not RAM-backed**, or file staging silently eats into RAM instead of disk.

### 3.2 Record-validation staging — SQLite per session

```python
db_path = get_db_path(session_id)   # SureShift_staging_databases/<crm>/<object>/<session_id>.db
conn = sqlite3.connect(db_path)
```

- One `.db` file per validation session, holding every extracted record
  (valid + invalid) as JSON text in a SQLite table.
- **Not cleaned up automatically** except via the explicit
  `/api/admin/staging/cleanup` endpoint (`cleanup_stale_staging_databases`,
  default max age from `DEFAULT_MAX_AGE_HOURS`) — this needs to run on a
  schedule (cron/scheduled task) or these accumulate indefinitely.
- **Sizing:** roughly 1.2–1.5× the flat JSON size of the object's record set
  (SQLite row + JSON text + index overhead). For 1M records at ~1KB each,
  budget ~1.5GB per session, and that session's `.db` persists until cleanup
  runs.
- **Concurrency:** SQLite handles one writer at a time per file — concurrent
  *different* sessions are fine (separate `.db` files), but don't point
  multiple workers at the same session's `.db`.

**Recommendation:** schedule `/api/admin/staging/cleanup` to run at least
daily, and size disk for `(sessions per day) × (avg object size) × 1.5`
between cleanup runs.

---

## 4. CPU

Both extraction and file transfer are I/O-bound (async network calls), so
CPU is rarely the constraint. The measurable CPU costs:

- **Base64 encode/decode** for small-file uploads and record payloads —
  noticeable at high file/record counts but not a bottleneck below a few
  thousand concurrent operations.
- **ZIP building** for Bulk API batches (`_build_zip_batch`) — bounded by
  `MAX_BULK_BATCH_BYTES` (4.5MB) per batch, done sequentially in the batch
  submission loop, so this never spikes.
- **JSON parse/serialize** at record-migration volume (validation, payload
  building) — the main CPU line item at "millions of records" scale.

**Recommendation:** 4 vCPU is sufficient up to several million records; CPU
will not be your scaling wall before RAM/disk/architecture are.

---

## 5. Network

- **Outbound only** — HTTPS to each CRM's API domain(s). No inbound
  requirements beyond your own app's ingress (WebSocket for
  `/ws/validate-stream`, REST for the rest).
- **Connection pool:** `httpx.AsyncClient` is instantiated per-request
  (`file_migration_routes.py`, `migration_routes.py`) with **no explicit
  `httpx.Limits`** — defaults to httpx's built-in caps (100 max connections,
  20 keepalive). Combined with the uncapped `asyncio.gather()` in
  `salesforce_migrator.py::upload()` (§2.1, §6.1), a large record migration
  can attempt far more concurrent outbound connections than the default pool
  allows, causing queuing/latency rather than an outright failure — but it's
  a symptom of the same missing-semaphore issue.
- **Reverse proxy / load balancer timeout:** the entire migration executes
  inside one HTTP/WebSocket request-response lifecycle. Whatever sits in
  front (nginx, ALB, API gateway, Cloud Run, etc.) **must have an idle/request
  timeout longer than your longest expected migration run**, or the client
  gets disconnected mid-run with no server-side awareness that anything went
  wrong. Common defaults that will bite you: nginx 60s, ALB idle 60s, Cloud
  Run request timeout (configurable, but capped).
- **Salesforce daily API limits:** already handled in-code —
  `ApiLimitNearExhaustionError` halts and checkpoints before the hard daily
  ceiling (`api_usage_safety_threshold`, default 0.90). No extra
  infrastructure needed for this specifically; just be aware a large
  migration may legitimately span multiple 24h windows and resume.

---

## 6. Architectural limits hardware alone won't fix

These are the two items that determine whether "millions of records/files"
is even achievable, independent of instance size:

### 6.1 No background job/worker model
The whole migration runs inside a single live WebSocket connection in one
process. If that process restarts (deploy, OOM-kill, autoscaling event), the
in-flight record migration is lost — there's no resume primitive for records
the way `FileMigrationCheckpoint` provides for files. At scale, this needs to
move to a background worker (Celery/RQ/arq + a queue, or a DB-backed job
table + polling worker), decoupled from the request/WebSocket lifecycle.

### 6.2 Two missing concurrency/cleanup bounds
- `salesforce_migrator.py::upload()`'s `asyncio.gather()` has no semaphore —
  this is both the RAM driver in §2.1 and the network-pool pressure in §5.
- File staging cleanup happens at end-of-batch, not per-file — this is the
  disk driver in §3.1.

Both are scoped, mechanical fixes (add a `Semaphore`; delete each staged file
right after its own upload settles) — flag if you want these implemented
next; they're the highest-leverage changes before any queue/worker rework.

---

## 7. Sizing summary by migration scale

| Scale | RAM | Scratch disk | Notes |
|---|---|---|---|
| ≤100K records, files ≤25MB | 4–8 GB | 5–10 GB | Baseline tier handles this as-is |
| ≤1M records, mixed file sizes to 2GB | 8–16 GB | 20–50 GB | Multipart fix already covers large files; record-side RAM is the driver |
| 1M–5M+ records, and/or many concurrent migrations | 16–32 GB+ | 50–100 GB+ | Not recommended without §6.1/§6.2 fixes — hardware will paper over it briefly, then you hit the same wall at a higher record count |