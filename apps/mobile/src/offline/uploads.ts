import type { CreateRecordingNoteResponse, LanguageHint } from "@sitemate/shared";
import { Directory, File, Paths } from "expo-file-system";
import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
import { AppState } from "react-native";
import { api, ApiRequestError } from "@/lib/api";
import { localDb } from "./db";

/**
 * Recordings are saved on the phone first, then uploaded by this queue — so a bad network
 * never loses a meeting. Each item keeps its local_id; the server treats a repeated local_id
 * as the same note, so retries never create duplicates.
 */

export interface PendingUpload {
  local_id: string;
  kind: "meeting" | "memo" | "call";
  file_uri: string;
  language_hint: LanguageHint;
  project_id: string | null;
  started_at: string;
  duration_sec: number | null;
  size_bytes: number;
  note_id: string | null;
  status: "pending" | "uploading" | "failed";
  attempts: number;
  last_error: string | null;
}

const recordingsDir = () => {
  const dir = new Directory(Paths.document, "recordings");
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
};

// ─────────── tiny store so screens can show the queue ───────────
let snapshot: PendingUpload[] = [];
const listeners = new Set<() => void>();
async function refresh() {
  snapshot = await localDb.getAllAsync<PendingUpload>("select * from pending_uploads order by created_at");
  listeners.forEach((l) => l());
}
export const uploadQueue = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  get: () => snapshot,
};

/** Moves a finished recording into permanent storage and queues it for upload. */
export async function queueRecording(input: {
  localId: string;
  tempUri: string;
  kind: PendingUpload["kind"];
  languageHint: LanguageHint;
  projectId: string | null;
  startedAt: Date;
  durationSec: number;
}) {
  const src = new File(input.tempUri);
  const dest = new File(recordingsDir(), `${input.localId}.m4a`);
  src.move(dest); // out of the cache folder, which Android may clear
  await localDb.runAsync(
    `insert or replace into pending_uploads (local_id, kind, file_uri, language_hint, project_id, started_at, duration_sec, size_bytes)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.localId,
    input.kind,
    dest.uri,
    input.languageHint,
    input.projectId,
    input.startedAt.toISOString(),
    input.durationSec,
    dest.size ?? 0,
  );
  await refresh();
  void processUploads();
}

let running = false;
let onUploaded: (() => void) | null = null;
/** Called after each successful upload (the notes list refreshes itself). */
export function setOnUploaded(fn: () => void) {
  onUploaded = fn;
}

/** Uploads everything waiting, one at a time. Safe to call often. */
export async function processUploads() {
  if (running) return;
  running = true;
  try {
    const net = await getNetworkStateAsync();
    if (net.isInternetReachable === false || net.isConnected === false) return;

    // Only one upload loop runs at a time, so anything still marked 'uploading' was
    // interrupted (app closed mid-upload) and is retried too.
    const items = await localDb.getAllAsync<PendingUpload>("select * from pending_uploads order by created_at");
    for (const item of items) {
      try {
        await uploadOne(item);
        onUploaded?.();
      } catch (err) {
        const message = err instanceof ApiRequestError ? err.message : String(err);
        await localDb.runAsync(
          "update pending_uploads set status = 'failed', attempts = attempts + 1, last_error = ? where local_id = ?",
          message,
          item.local_id,
        );
        // Server unreachable → stop for now; the next trigger will retry.
        if (!(err instanceof ApiRequestError) || err.status === undefined) break;
      } finally {
        await refresh();
      }
    }
  } finally {
    running = false;
  }
}

async function uploadOne(item: PendingUpload) {
  const file = new File(item.file_uri);
  if (!file.exists) {
    await localDb.runAsync("delete from pending_uploads where local_id = ?", item.local_id);
    return;
  }
  await localDb.runAsync("update pending_uploads set status = 'uploading' where local_id = ?", item.local_id);
  await refresh();

  const created = await api<CreateRecordingNoteResponse>("/v1/notes", {
    method: "POST",
    body: JSON.stringify({
      kind: item.kind,
      local_id: item.local_id,
      language_hint: item.language_hint,
      project_id: item.project_id,
      started_at: item.started_at,
      duration_sec: item.duration_sec,
      mime: "audio/mp4",
      size_bytes: file.size ?? item.size_bytes,
      extension: ".m4a",
    }),
  });
  await localDb.runAsync("update pending_uploads set note_id = ? where local_id = ?", created.note_id, item.local_id);

  if (created.upload) {
    // Streams the file from disk to storage (no need to load it into memory).
    const res = await file
      .createUploadTask(created.upload.url, {
        httpMethod: "PUT",
        headers: { "content-type": created.upload.content_type },
      })
      .uploadAsync();
    if (res.status < 200 || res.status >= 300) {
      throw new ApiRequestError(`Upload failed (HTTP ${res.status})`, "Will retry automatically.", res.status);
    }
  }

  await api(`/v1/notes/${created.note_id}/recording-uploaded`, { method: "POST", body: "{}" });

  // Safely on the server now — free the phone's storage.
  file.delete();
  await localDb.runAsync("delete from pending_uploads where local_id = ?", item.local_id);
}

/** Starts automatic retries: when the app opens, comes back to the screen, or the network returns. */
export function startUploadTriggers() {
  void refresh().then(processUploads);
  const net = addNetworkStateListener((s) => {
    if (s.isConnected) void processUploads();
  });
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void processUploads();
  });
  const timer = setInterval(() => {
    if (snapshot.length) void processUploads();
  }, 60_000);
  return () => {
    net.remove();
    app.remove();
    clearInterval(timer);
  };
}

/** Removes a queued recording the user no longer wants (also deletes the audio file). */
export async function discardUpload(localId: string) {
  const row = await localDb.getFirstAsync<PendingUpload>("select * from pending_uploads where local_id = ?", localId);
  if (row) {
    const f = new File(row.file_uri);
    if (f.exists) f.delete();
  }
  await localDb.runAsync("delete from pending_uploads where local_id = ?", localId);
  await refresh();
}
