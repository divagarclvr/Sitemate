-- Phase 3: shared/uploaded files (PDF, Office, images, audio, WhatsApp chats).

-- Jobs can now process files.
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check
  check (kind in ('process_recording','process_text','resummarise','process_file'));

-- A file note can be linked to a meeting ("attach this BOQ to Monday's vendor meeting").
alter table notes add column if not exists related_note_id uuid references notes on delete set null;
create index if not exists notes_related on notes (related_note_id);

-- Upload tracking for files (same idea as recordings).
alter table files add column if not exists local_id text;
alter table files add column if not exists upload_status text not null default 'pending'
  check (upload_status in ('pending','uploaded','failed'));
alter table files add column if not exists file_kind text;   -- pdf, word, excel, powerpoint, image, audio, text, whatsapp, other
alter table files add column if not exists deleted_at timestamptz;
create unique index if not exists files_local_uq on files (user_id, local_id) where local_id is not null;
create index if not exists files_note on files (note_id);
