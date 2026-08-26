# SureShift

CRM-to-CRM (and CSV-to-CRM) data migration platform. Angular frontend, FastAPI backend, Supabase for auth/storage, a local Ollama model for AI field-mapping suggestions. Supports Salesforce, Zoho CRM, Zendesk, and HubSpot as source and/or target.

New here? Read in this order:
1. **This file** — get it running locally.
2. `GLOSSARY.md` — decode the domain jargon (external ID, self-reference, pass 1/2/3, etc.) before the other docs assume you already know it.
3. `ARCHITECTURE.md` — how the system is laid out, the core contracts (`Migrator`, `Validator`, `PayloadBuilderService`), and known risk areas.
4. `API.md` — every REST/WebSocket endpoint with request/response shapes.
5. `SureShift_Migration_Documentation.md` — the feature inventory, CRM limitations, and end-user migration manual.

---

## Prerequisites

- **Python 3.11+** (FastAPI backend)
- **Node.js + npm** (Angular frontend — check the frontend project's `package.json`/`.nvmrc` for the exact version this repo targets)
- **Ollama**, running locally with the `mxbai-embed-large` embedding model pulled — required for AI Auto-Map (`/api/metadata/ai-auto-map`). Without it, everything else works but auto-mapping falls back to name/token/fuzzy matching only, since the embedding call will fail.
- **A Supabase project** — used for auth (`supabase.auth`), storing CRM OAuth connections (`crm_connections` table), migration history (`migration_history` table), and audit report storage (a `migration_reports` storage bucket).
- **OAuth apps registered with each CRM you intend to connect** (Salesforce, Zoho, Zendesk, HubSpot) — each needs its own client ID/secret, and a redirect URI pointing back at this backend.

> This document covers configuration and environment, not exact package versions — check the repo's own `requirements.txt` (backend) and `package.json` (frontend) for pinned versions before assuming anything here is exhaustive.

---

## Environment variables

Set these for the **backend** process:

| Variable | Used by | Notes |
|---|---|---|
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | `crm_service.py` | Salesforce connected app. Token refresh also branches on `environment == "sandbox"` per-connection (stored, not an env var) to pick `test.salesforce.com` vs. `login.salesforce.com`. |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | `crm_service.py` | Zoho OAuth client. Per-connection `accounts_server` (stored) defaults to `https://accounts.zoho.com` — override per data-center region if needed. |
| `ZD_CLIENT_ID` / `ZD_CLIENT_SECRET` | `crm_service.py` | Zendesk OAuth client. |
| `HS_CLIENT_ID` / `HS_CLIENT_SECRET` | `crm_service.py` | HubSpot OAuth client. |
| `ANGULAR_FRONTEND_URL` | `auth_service.py` | Where password-reset emails redirect back to (`{url}/login`). Defaults to `http://localhost:4200` if unset. |
| `SUPABASE_URL` / `SUPABASE_KEY` | `audit_service.py` (and presumably `app/utils/config.py`, which isn't part of this review) | Used to create a **request-scoped** Supabase client per audit-report write, deliberately separate from the shared module-level `supabase` client used everywhere else, to avoid mutating a shared client's session under concurrent requests. |

Not environment-configured (hardcoded — change in source if you need a different value):

| Value | Where | Default |
|---|---|---|
| Ollama base URL | `ai_services.py::OLLAMA_BASE_URL` | `http://127.0.0.1:11434/api` |
| Embedding model | `ai_services.py::EMBEDDING_MODEL` | `mxbai-embed-large` |

The frontend has its own environment file (Angular `environment.ts`/`environment.prod.ts` convention) pointing at this backend's base URL — not covered here since it wasn't part of what's been reviewed; check the Angular project structure directly.

---

## Backend setup

```bash
# from the backend project root
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

# set the env vars from the table above, e.g. via a .env file + python-dotenv,
# or export them directly in your shell / deployment config

uvicorn app.main:app --reload --port 8000   # adjust module path to match the actual entrypoint
```

Known Python dependencies from the modules reviewed (confirm exact pins in `requirements.txt`): `fastapi`, `pydantic`, `httpx`, `pandas`, `numpy`, `openpyxl`, `supabase` (Python client), `fpdf`, `pycountry`.

## Frontend setup

```bash
# from the Angular project root
npm install
ng serve   # or `npm start`, depending on the configured script
```

Known frontend dependencies from the components reviewed: Angular (with the `@if`/`@for` control-flow syntax — Angular 17+), `xlsx` (SheetJS, for client-side workbook building in the CSV flow), `ngx-toastr`, `sweetalert2`, RxJS.

---

## Running it end-to-end locally

1. Start Ollama (`ollama serve`, with `mxbai-embed-large` pulled) if you want AI Auto-Map to work.
2. Start the FastAPI backend.
3. Start the Angular frontend.
4. Sign up / log in (Supabase auth — `auth_service.py`).
5. Under Connections, OAuth-connect a `source` and a `target` CRM (or skip straight to the CSV flow, which only needs a `target` connection).
6. Either:
   - **CRM → CRM**: use the API-mapping UI to pick source/target objects, map fields, and run.
   - **CSV → CRM**: upload a file, map + validate, queue it, and route it into the migration UI.

## Smoke-testing your setup

- `GET /api/metadata/{crm_id}/objects?role=target` for a connected CRM should return a real object list — confirms OAuth + token storage + metadata fetching all work.
- `POST /api/python/extract-headers` with a small CSV should return its headers instantly — confirms the file-upload path works independent of any CRM connection.
- `POST /api/metadata/ai-auto-map` with a couple of obviously-matching field pairs (e.g. `{"name": "Email"}` on both sides) should return a `confidence: 1.0` mapping — confirms Ollama is reachable. A `503` here means Ollama isn't running or the model isn't pulled.

## Where things live (quick map)

```
Backend routes:     metadata_routes.py, validation_routes.py, migration_routes.py, migration_history.py
Backend services:    crm_service.py, crm_metadata_service.py, crm_query_service.py,
                     payload_builder.py, validator_service.py, ai_services.py, audit_service.py, auth_service.py
Per-CRM migrators:  salesforce_migrator.py, salesforce_file_migrator.py, zoho_migrator.py,
                     zendesk_migrator.py, hubspot_migrator.py
Per-CRM validators: salesforce_validator.py, zoho_validator.py, zendesk_validator.py,
                     hubspot_validator.py, base_validator.py (fallback), validator_factory.py
Frontend:           API-mapping_component (CRM→CRM), data-validation_component (CSV upload/validate),
                     default_component (migration queue → /ws/migrate)
```

See `ARCHITECTURE.md` for how these actually connect.
