import { openDatabaseSync } from "expo-sqlite";

/** On-device database: the upload queue (and later, cached notes for offline viewing). */
export const localDb = openDatabaseSync("sitemate.db");

localDb.execSync(`
  create table if not exists pending_uploads (
    local_id      text primary key,
    kind          text not null,
    file_uri      text not null,
    language_hint text not null,
    project_id    text,
    started_at    text not null,
    duration_sec  integer,
    size_bytes    integer not null,
    note_id       text,
    status        text not null default 'pending',  -- pending | uploading | failed
    attempts      integer not null default 0,
    last_error    text,
    created_at    text not null default (datetime('now'))
  );
`);

// Phase 3: the same queue also carries shared/uploaded files.
for (const col of [
  "upload_type text not null default 'recording'", // recording | file
  "file_name text",
  "mime text",
  "related_note_id text",
  "contact_id text",
]) {
  try {
    localDb.execSync(`alter table pending_uploads add column ${col}`);
  } catch {
    // column already exists
  }
}
