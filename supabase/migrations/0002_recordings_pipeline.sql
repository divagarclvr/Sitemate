-- Phase 2: background job queue + private audio storage.

-- ───────────────────────── job queue ─────────────────────────
-- A tiny queue inside Postgres (works through Supabase's pooler; no extra service).
create table jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  kind        text not null check (kind in ('process_recording','process_text','resummarise')),
  note_id     uuid not null references notes on delete cascade,
  status      text not null default 'queued' check (status in ('queued','running','done','failed')),
  run_after   timestamptz not null default now(),
  attempts    int not null default 0,
  last_error  text,
  locked_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index jobs_ready on jobs (run_after) where status = 'queued';
create index jobs_note on jobs (note_id);

alter table jobs enable row level security;
create policy owner_all on jobs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create trigger jobs_updated_at before update on jobs for each row execute function set_updated_at();

-- Segments produced by the AI clean-up keep a short English meaning for local-language phrases.
-- (column already exists as transcript_segments.gloss)

-- Notes remember which recording language was chosen and processing progress text.
alter table notes add column if not exists progress_text text;

-- ───────────────────────── storage ─────────────────────────
-- Private bucket for recordings and shared files. Only the server (secret key) reads/writes;
-- the phone uploads through short-lived signed upload URLs issued by the server.
insert into storage.buckets (id, name, public, file_size_limit)
values ('sitemate-private', 'sitemate-private', false, 104857600)  -- 100 MB per file
on conflict (id) do nothing;
