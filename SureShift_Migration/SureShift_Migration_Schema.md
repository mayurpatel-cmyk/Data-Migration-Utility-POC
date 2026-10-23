create table public.crm_connections (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  crm_type text not null,
  connection_role text not null,
  access_token text not null,
  refresh_token text null,
  instance_url text null,
  subdomain text null,
  api_domain text null,
  accounts_server text null,
  region text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  environment text null,
  org_id text null,
  constraint crm_connections_pkey primary key (id),
  constraint crm_connections_same_org_allow_key unique (user_id, crm_type, connection_role),
  constraint crm_connections_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE
) TABLESPACE pg_default;

...........................................................................................

create table public.migration_history (
  id uuid not null default extensions.uuid_generate_v4 (),
  user_id uuid null,
  session_id text null,
  source_crm text null,
  target_crm text null,
  target_object text null,
  total_records integer null,
  success_count integer null,
  error_count integer null,
  pdf_url text null,
  created_at timestamp with time zone null default now(),
  success_csv_url text null,
  error_csv_url text null,
  started_at timestamp with time zone null,
  duration_seconds integer null,
  skipped_count integer null default 0,
  operation_mode text null,
  skipped_csv_url text null,
  error_summary jsonb null,
  query_used text null,
  time_filter_used jsonb null,
  migration_mode text null,
  source_mode text null,
  run_type text null,
  retry_round integer null,
  run_id text null,
  parent_run_id text null,
  constraint migration_history_pkey primary key (id),
  constraint migration_history_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE
) TABLESPACE pg_default;

create index IF not exists idx_migration_history_user_created on public.migration_history using btree (user_id, created_at desc) TABLESPACE pg_default;


...........................................................................................
create table public.users (
  id uuid not null,
  email text null,
  full_name text null,
  constraint users_pkey primary key (id),
  constraint users_id_fkey foreign KEY (id) references auth.users (id)
) TABLESPACE pg_default;


........................................................................................

create table public.validation_history (
  id uuid not null default gen_random_uuid (),
  user_id uuid not null,
  session_id text not null,
  source_crm text not null,
  target_crm text null,
  target_object text not null,
  total_records integer not null default 0,
  valid_count integer not null default 0,
  invalid_count integer not null default 0,
  duplicate_count integer not null default 0,
  invalid_csv_url text null,
  error_summary jsonb null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  query_used text null,
  time_filter_used jsonb null,
  valid_csv_url text null,
  pdf_url text null,
  constraint validation_history_pkey primary key (id),
  constraint validation_history_user_id_fkey foreign KEY (user_id) references auth.users (id) on delete CASCADE
) TABLESPACE pg_default;

create unique INDEX IF not exists validation_history_session_id_key on public.validation_history using btree (session_id) TABLESPACE pg_default;

create index IF not exists validation_history_user_id_idx on public.validation_history using btree (user_id) TABLESPACE pg_default;

create index IF not exists validation_history_created_at_idx on public.validation_history using btree (created_at desc) TABLESPACE pg_default;

create trigger trg_validation_history_updated_at BEFORE
update on validation_history for EACH row
execute FUNCTION set_validation_history_updated_at ();