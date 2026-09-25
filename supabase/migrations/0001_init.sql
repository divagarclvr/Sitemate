-- SiteMate initial schema. Run once in Supabase → SQL Editor (see README, Phase 1).
-- Every table belongs to one user and is protected by Row Level Security.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ───────────────────────── helpers ─────────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ───────────────────────── settings ─────────────────────────
create table user_settings (
  user_id               uuid primary key references auth.users on delete cascade,
  timezone              text not null default 'Asia/Kolkata',
  default_language      text not null default 'auto'
                        check (default_language in ('auto','en','ta','kn','te','ml','hi')),
  transcript_script     text not null default 'original' check (transcript_script in ('original','romanised')),
  morning_plan_time     time not null default '07:30',
  evening_recap_time    time not null default '19:00',
  evening_recap_enabled boolean not null default true,
  reminder_minutes      int  not null default 15,
  audio_retention_days  int  default 30,
  theme                 text not null default 'system' check (theme in ('system','light','dark','sunlight')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ───────────────────────── projects & contacts ─────────────────────────
create table projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  code        text,
  client      text,
  location    text,
  status      text not null default 'active' check (status in ('active','closed')),
  color       text,
  wbs_prefix  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table contacts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  name               text not null,
  company            text,
  role               text,
  phones             text[] not null default '{}',
  email              text,
  notes              text,
  source             text not null default 'manual' check (source in ('phone','manual')),
  device_contact_id  text,
  name_aliases       text[] not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index contacts_device_uq on contacts (user_id, device_contact_id) where device_contact_id is not null;
create index contacts_name_trgm on contacts using gin (name gin_trgm_ops);

create table contact_projects (
  user_id     uuid not null references auth.users on delete cascade,
  contact_id  uuid not null references contacts on delete cascade,
  project_id  uuid not null references projects on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (contact_id, project_id)
);

-- ───────────────────────── notes (meetings, memos, calls, files) ─────────────────────────
create table notes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  kind              text not null check (kind in ('meeting','memo','call','file','chat_export')),
  title             text,
  status            text not null default 'queued' check (status in
                    ('queued','uploading','transcribing','extracting','summarising','embedding',
                     'waiting_quota','done','failed')),
  error_message     text,
  error_hint        text,
  language_hint     text not null default 'auto',
  languages_detected text[] not null default '{}',
  started_at        timestamptz,
  duration_sec      int,
  location          text,
  project_id        uuid references projects on delete set null,
  contact_id        uuid references contacts on delete set null,
  structured        jsonb,
  summary           text,
  transcript_text   text,
  user_edited       boolean not null default false,
  prompt_version    text,
  ai_model          text,
  local_id          text,
  deleted_at        timestamptz,
  search_tsv        tsvector generated always as (
                      setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                      setweight(to_tsvector('simple', coalesce(summary,'')), 'B') ||
                      setweight(to_tsvector('simple', coalesce(transcript_text,'')), 'C')
                    ) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index notes_local_uq on notes (user_id, local_id) where local_id is not null;
create index notes_user_started on notes (user_id, started_at desc);
create index notes_project on notes (project_id);
create index notes_search on notes using gin (search_tsv);

create table recordings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  note_id       uuid not null references notes on delete cascade,
  storage_path  text,
  mime          text,
  size_bytes    bigint,
  duration_sec  int,
  sha256        text,
  local_id      text,
  upload_status text not null default 'pending' check (upload_status in ('pending','uploaded','failed')),
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index recordings_note on recordings (note_id);

create table files (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users on delete cascade,
  note_id         uuid references notes on delete set null,
  project_id      uuid references projects on delete set null,
  original_name   text not null,
  mime            text,
  size_bytes      bigint,
  storage_path    text,
  sha256          text,
  source          text not null default 'upload' check (source in ('share','upload')),
  extracted_text  text,
  page_count      int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index files_sha_uq on files (user_id, sha256) where sha256 is not null;
create index files_text_trgm on files using gin (extracted_text gin_trgm_ops);

create table transcript_segments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  note_id             uuid not null references notes on delete cascade,
  idx                 int not null,
  speaker_label       text,
  speaker_contact_id  uuid references contacts on delete set null,
  start_ms            int,
  end_ms              int,
  text                text not null,
  gloss               text,
  edited              boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (note_id, idx)
);
create index segments_text_trgm on transcript_segments using gin (text gin_trgm_ops);

create table note_contacts (
  user_id          uuid not null references auth.users on delete cascade,
  note_id          uuid not null references notes on delete cascade,
  contact_id       uuid not null references contacts on delete cascade,
  speaker_label    text,
  role_in_meeting  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (note_id, contact_id)
);

-- ───────────────────────── tasks, figures, follow-ups ─────────────────────────
create table tasks (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  note_id            uuid references notes on delete set null,
  project_id         uuid references projects on delete set null,
  owner_contact_id   uuid references contacts on delete set null,
  owner_text         text,
  title              text not null,
  due_date           date,
  priority           text not null default 'medium' check (priority in ('high','medium','low')),
  status             text not null default 'open' check (status in ('open','done','cancelled')),
  completed_at       timestamptz,
  external_provider  text,   -- e.g. 'ticktick' (later)
  external_id        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index tasks_due on tasks (user_id, status, due_date);

create table figures (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  note_id       uuid not null references notes on delete cascade,
  project_id    uuid references projects on delete set null,
  kind          text not null,
  value         numeric(18,4),
  unit          text,
  currency      text,
  item          text,
  vendor_text   text,
  reference_no  text,
  raw_text      text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index figures_note on figures (note_id);

create table follow_up_suggestions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  note_id            uuid not null references notes on delete cascade,
  type               text not null check (type in ('meeting','call','deadline','reminder')),
  description        text not null,
  suggested_start    timestamptz,
  status             text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  calendar_event_id  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table pending_actions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  kind        text not null check (kind in ('call','calendar_event','task','reminder')),
  payload     jsonb not null,
  status      text not null default 'pending' check (status in ('pending','confirmed','rejected','expired')),
  origin      text not null check (origin in ('chat','note','voice_command')),
  expires_at  timestamptz not null default now() + interval '1 day',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────── calendar & planner ─────────────────────────
create table calendar_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  provider           text not null check (provider in ('microsoft','google')),
  account_email      text,
  access_token_enc   text,
  refresh_token_enc  text,
  expires_at         timestamptz,
  scopes             text,
  calendar_id        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table calendar_events_cache (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  account_id        uuid not null references calendar_accounts on delete cascade,
  external_id       text not null,
  title             text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  location          text,
  attendees         jsonb,
  project_id        uuid references projects on delete set null,
  note_id           uuid references notes on delete set null,
  reminder_sent_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (account_id, external_id)
);
create index events_start on calendar_events_cache (user_id, starts_at);

create table day_plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  plan_date   date not null,
  kind        text not null check (kind in ('morning','evening')),
  content     jsonb not null,
  pushed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, plan_date, kind)
);

create table push_tokens (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users on delete cascade,
  expo_push_token  text not null unique,
  device_name      text,
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ───────────────────────── chat & search ─────────────────────────
create table chat_threads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  thread_id   uuid not null references chat_threads on delete cascade,
  role        text not null check (role in ('user','assistant','tool')),
  content     jsonb not null,
  tokens      int,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index chat_messages_thread on chat_messages (thread_id, created_at);

create table message_sources (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  message_id  uuid not null references chat_messages on delete cascade,
  note_id     uuid references notes on delete cascade,
  file_id     uuid references files on delete cascade,
  segment_id  uuid references transcript_segments on delete set null,
  snippet     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table search_chunks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  note_id      uuid references notes on delete cascade,
  file_id      uuid references files on delete cascade,
  chunk_idx    int not null,
  text         text not null,
  embedding    vector(384),
  project_id   uuid references projects on delete set null,
  occurred_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index search_chunks_embedding on search_chunks using hnsw (embedding vector_cosine_ops);

-- ───────────────────────── usage & audit ─────────────────────────
create table usage_events (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  service            text not null check (service in ('llm','stt')),
  provider           text not null,
  model              text not null,
  purpose            text not null,
  input_tokens       int,
  output_tokens      int,
  audio_seconds      int,
  cost_usd           numeric(10,5) not null default 0,
  note_id            uuid references notes on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index usage_month on usage_events (user_id, created_at);

create table audit_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  action      text not null,
  entity      text,
  entity_id   uuid,
  meta        jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────── RLS + updated_at on every table ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'user_settings','projects','contacts','contact_projects','notes','recordings','files',
    'transcript_segments','note_contacts','tasks','figures','follow_up_suggestions','pending_actions',
    'calendar_accounts','calendar_events_cache','day_plans','push_tokens','chat_threads','chat_messages',
    'message_sources','search_chunks','usage_events','audit_log'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy owner_all on %I for all to authenticated
         using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
    execute format(
      'create trigger %I before update on %I for each row execute function set_updated_at()',
      t || '_updated_at', t);
  end loop;
end $$;

-- OAuth tokens must never be readable from the app, even by the owner.
revoke all on calendar_accounts from anon, authenticated;
