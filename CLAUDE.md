# SiteMate — Personal AI Assistant for a Construction Estimator

> Status: **Phase 1 built 2026-09-25** (setup, login, DB schema, API skeleton, AI test). Next: Phase 2.
> Owner: Senior Estimator, Bengaluru (IST, UTC+05:30). Single-user personal app.
> Meetings mix English with Tamil / Kannada / Telugu / Malayalam / Hindi words.
> **Budget rule: 100% free tiers.** AI = Google Gemini free tier (swappable to Claude or others later — see §2.2).

This file is the source of truth for architecture, data model, API and environment.
Every phase must keep it up to date.

---

## 1. Guiding rules (non-negotiable)

1. **No secrets in the mobile app.** The app only knows `API_BASE_URL` and the public
   Supabase URL + publishable key (which are safe to ship — they are protected by Row Level Security).
   Gemini, Groq, Microsoft/Google OAuth secrets live **only** in `apps/api/.env`.
2. **AI is called only from the backend**, through one `LlmProvider` interface.
   `AI_PROVIDER=gemini` (free tier, default) — model names come from env
   (`GEMINI_MODEL`, `GEMINI_MODEL_LITE`). A Claude adapter (`AI_PROVIDER=anthropic`,
   `@anthropic-ai/sdk`, `claude-sonnet-5`) can be switched on later with no other code changes.
3. **Never act without confirmation.** Dialling a number, creating a calendar event,
   creating a reminder from a note suggestion — the backend returns a *pending action*;
   the app shows a confirm sheet; only the confirm tap executes it.
4. **Never lose a recording.** Audio is written to device storage first, then uploaded
   by a resumable queue. Server deletes nothing without an explicit user action or the
   user's retention setting.
5. **No phone-call recording.** Android 10+ and iOS block it. We offer
   *Speakerphone meeting mode* (mic recording) + a consent reminder instead.
6. **Free tiers only.** No paid service may be added without the owner's explicit approval.
   Every free-tier limit we depend on is listed in §10 and shown as a meter in the app.
7. **Supported languages:** English, Tamil, Kannada, Telugu, Malayalam, Hindi — and any
   mix of them with English. Transcripts keep the original words; summaries are in English.
8. Times are stored in UTC (`timestamptz`) and displayed in `Asia/Kolkata`.
9. Money is stored as `numeric(14,2)` in INR; quantities keep their unit
   (`sqft`, `sqm`, `cum`, `MT`, `kg`, `rmt`, `nos`, `LS`, …).

---

## 2. Tech stack (as requested, with notes)

| Layer | Choice | Notes / reason |
|---|---|---|
| Mobile | **Expo SDK (latest stable) + React Native + TypeScript**, Expo Router | Android first, iOS-compatible |
| Mobile state/data | TanStack Query + Zustand; **expo-sqlite** local DB | Offline viewing of synced notes + upload queue |
| Audio | **expo-audio** (recording, background mode) | Background recording + share-target need a **development build** — Expo Go works only for Phase 1 screens (see §11) |
| Share target | `expo-share-intent` (Android intent filters + iOS share extension) | Dev build required |
| Backend | **Node.js 22 + TypeScript + Fastify** | Fastify: fast, built-in schema validation, good plugin set (rate-limit, multipart, helmet) |
| Job queue | **pg-boss** (queue inside Postgres) | No Redis needed; retries built in |
| Database | **Supabase Postgres** + `pgvector` + `pg_trgm` | Full-text + fuzzy + semantic search |
| Auth | **Supabase Auth, email OTP**; backend verifies the Supabase JWT | Plus `ALLOWED_EMAILS` allow-list so nobody else can sign up |
| Files | **Supabase Storage** private bucket, signed URLs (short expiry) | Encrypted at rest (AES-256). Free tier = 1 GB, so audio is compressed (mono, ~24 kbps ≈ 11 MB/hour) and auto-deleted from the server N days after transcription (default 30); notes and transcripts are kept forever |
| AI | **Google Gemini API free tier** via official `@google/genai` SDK; JSON-schema structured output + function calling; fallback to Groq free LLM when Gemini quota is exhausted | See §2.2 |
| Speech-to-text | **Groq free tier — Whisper large-v3** (`STT_PROVIDER=groq`) behind an `SttProvider` interface | Free, no card; all 6 languages; see §2.1 |
| Embeddings | **Local model inside the API**: `@huggingface/transformers` + `multilingual-e5-small` (384-dim) | Free, no API key, handles all 6 languages; runs on the server CPU |
| Doc parsing | `pdf-parse`, `mammoth` (DOCX), `xlsx`/SheetJS (XLSX/XLS/CSV), `officeparser` (PPTX), `yauzl` (ZIP), `sharp` + `heic-convert` (images) | Scanned PDFs / images → sent to Gemini as inline PDF / image input |
| Export | DOCX: `docx` npm; PDF: `pdfkit` (server-side) | Shared via `expo-sharing` → WhatsApp / Gmail |
| Push | **Expo Notifications** (Expo push service, free) | |
| Calendar | Microsoft Graph (Outlook/365) first, Google Calendar second | OAuth done by backend; tokens encrypted in DB |
| Hosting | **Render free web service** | Sleeps after 15 min idle; woken by uploads and by Supabase `pg_cron` for scheduled jobs (§8). ~30–60 s cold start is acceptable |
| Scheduler | **Supabase `pg_cron` + `pg_net`** (free) → `POST /internal/cron/:job` with a shared secret | Replaces paid always-on hosting |
| Audio chunking | `ffmpeg-static` on the server | Splits long meetings into ≤10-min pieces for the STT file-size limit |
| Tests | **Vitest** (backend), fixtures for every parser + AI JSON handling | |
| Monorepo | npm workspaces | `packages/shared` holds zod schemas used by both app and API |

### 2.1 Speech-to-text (free)

Requirement: English, Tamil, Kannada, Telugu, Malayalam, Hindi, and code-mixed speech.

**Choice: Groq free tier running OpenAI's open-source Whisper large-v3.** Whisper supports
all six languages. Groq offers it free with daily/hourly limits and no credit card
(exact limits re-checked at signup and recorded in §10).

How it works:
1. Server splits the recording into ~10-minute chunks (ffmpeg) with a 2-second overlap.
2. Each chunk → Groq Whisper with a **language hint** (Settings: `Auto` or a default
   language; the Record screen lets you change it per meeting — auto-detect often picks
   the wrong language in mixed speech, so a hint improves accuracy a lot).
3. Chunks are stitched by timestamp. If the free limit is hit, the job waits and resumes
   automatically (note shows "Waiting for free transcription quota — resumes at 3:00 PM").
4. **AI clean-up pass**: fixes construction terms (TMT, RMC, shuttering, BBS, M-book…),
   keeps Tamil/Kannada/Telugu/Malayalam/Hindi words, adds a short English meaning in
   brackets where helpful, and splits the text into speaker turns.

Honest limitations of the free route:
- **No true speaker identification.** Free Whisper does not label speakers. The AI infers
  turns from context ("Speaker A / Speaker B") and marks them *approximate*; you rename
  them in the transcript editor. Real diarization would need a paid service or running
  `pyannote` on your own PC — possible later, not in scope now.
- Whisper is strongest on English/Hindi/Tamil and weaker on Kannada/Telugu/Malayalam; the
  language hint and the AI clean-up pass compensate. We test with a real site meeting in Phase 2.
- `SttProvider` stays pluggable, so a better provider can be swapped in later.

Language settings (Settings → Languages):
- Default recording language: Auto / English / Tamil / Kannada / Telugu / Malayalam / Hindi.
- Transcript script: *Original script* (default) or *Romanised* (e.g. "kambi" instead of "கம்பி").
- Summary language: English (keeps notes searchable and shareable).

### 2.2 AI provider (free)

| Role | Provider / model (env) | Free limit (check in AI Studio / Groq console) |
|---|---|---|
| Main: notes, images, PDFs, day plans, chat + tools | **Gemini** `GEMINI_MODEL=gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite` (tried in order) | Per-model RPM / RPD shown in AI Studio |
| Light jobs: transcript clean-up, contact matching | **Gemini** `GEMINI_MODEL_LITE=gemini-3.5-flash-lite,gemini-3.6-flash` | Higher daily limit than Flash |
| Fallback when Gemini quota is used up | **Groq** `GROQ_LLM_MODEL=openai/gpt-oss-120b` | 1K requests/day, 8K tokens/min — short jobs only |
| Speech-to-text | **Groq** `whisper-large-v3` | 28,800 audio-seconds/day (= 8 hours/day) |

Model names are verified against the provider's model list at startup (`/v1/diagnostics/ai`);
if one disappears, the app shows "AI model not available — update GEMINI_MODEL".

**Privacy trade-off of free Gemini (important):** on the free tier Google may use prompts
and responses to improve its products, and human reviewers may read them. Vendor rates,
negotiations and project figures sent for summarising fall under this. Groq states it does
not train on API data. If this becomes a concern later, switch `AI_PROVIDER` to a paid
Gemini tier or Claude — nothing else changes.

Free Gemini models are often overloaded (HTTP 503): measured 2026-09-25, 3.7/3.8-flash failed 3/3, 3.5-flash 2/3, 3.6-flash 1/3, 3.5-flash-lite 0/3. Hence model lists (quotas are per model too) and no SDK retries.

Quota handling: every AI call goes through `aiQuota` → on a 429 it tries the fallback;
if both are exhausted the job is re-queued for when the quota resets and the note shows
"Waiting for free AI quota — resumes at 12:30 PM IST" (Gemini daily reset = midnight US Pacific = 12:30 PM IST in US summer, 1:30 PM IST in US winter).

---

## 3. Architecture

```
┌──────────────── Android / iOS phone ────────────────┐
│  Expo app (SiteMate)                                │
│   • Record (background, local file first)           │
│   • Upload queue (expo-sqlite + resumable upload)   │
│   • Share target (WhatsApp/Gmail/Files → app)       │
│   • Local cache of notes for offline viewing        │
│   • Dialer via Linking("tel:…") after confirm       │
└──────────┬───────────────────────────┬──────────────┘
           │ HTTPS + Supabase JWT      │ HTTPS (signed upload URL)
           ▼                           ▼
┌──────────────────────┐      ┌───────────────────────┐
│ SiteMate API         │      │ Supabase Storage      │
│ (Fastify, Render)    │◄────►│ private bucket        │
│  • REST endpoints    │      └───────────────────────┘
│  • pg-boss workers:  │      ┌───────────────────────┐
│    transcribe →      │◄────►│ Supabase Postgres     │
│    extract → summarise│     │ + pgvector + pg-boss  │
│    → embed           │      └───────────────────────┘
│  • /internal/cron/*  │◄──── Supabase pg_cron (07:30 plan,
│    (woken by cron)   │      19:00 recap, reminders)
│  • Local embeddings  │─────► Google Gemini API (free tier)
│  • Usage & quota log │─────► Groq Whisper + fallback LLM (free)
└──────────────────────┘─────► Microsoft Graph / Google Calendar
                       ─────► Expo Push service
```

### 3.1 Processing pipeline (meetings, memos, shared files)

```
upload complete
  → job: detect_type        (mime sniff via file-type, not just extension)
  → job: extract            (audio → chunk → Groq Whisper → AI clean-up | pdf/docx/xlsx/pptx/txt/chat → text | image/scanned PDF → Gemini vision)
  → job: summarise          (Gemini → StructuredNote JSON, zod-validated, 1 retry)
  → job: embed              (chunk transcript + note → local e5 model → pgvector)
  → job: suggest_actions    (follow-up meetings / deadlines → pending suggestions, never auto-created)
  → push notification "Note ready"
```

Each step updates `notes.status`:
`queued → uploading → transcribing → extracting → summarising → embedding → done`
or `failed` with a human-readable `error_message` + `error_hint`
(e.g. *"Transcription failed: audio file is silent. Check the mic wasn't blocked. Tap Retry."*).
All steps are idempotent and retryable (`POST /notes/:id/retry`).

### 3.2 AI usage patterns (provider-neutral interface)

`LlmProvider` exposes: `generateJson(schema, messages, opts)`, `chatWithTools(messages, tools)`,
`describeHealth()`. Gemini adapter uses `responseMimeType: "application/json"` +
`responseSchema` (converted from zod) and `functionDeclarations` for tools.

| Use | Pattern |
|---|---|
| Structured meeting note | `generateJson(StructuredNoteSchema, …)` → **zod-validate**; on failure retry once with the validation errors appended; still failing → `failed` with hint |
| Image (whiteboard, bill, drawing, handwriting) | inline image part (JPEG/PNG; HEIC converted to JPEG) + same schema |
| Scanned PDF | inline PDF part |
| Transcript clean-up + speaker turns | `{ segments: [{speaker, text, gloss}] }`; preserves original-language words |
| Contact resolution ("Call Ramesh from the steel vendor") | `{ candidates: [{contact_id, confidence, reason}] }` over a short list pre-filtered by trigram search |
| Chat assistant | tool-use loop (search_notes, list_tasks, create_task, propose_calendar_event, propose_call, summarise_project); **propose_\*** tools only create `pending_actions` |
| Daily plan / evening recap | `DayPlanSchema` |

- Long transcripts: Gemini's large context handles a full meeting in one call; very long ones are summarised per chunk then merged.
- Every call logs model, purpose, input/output tokens, provider → `usage_events` (cost ₹0 on free tier; field kept for later paid use).


### 3.3 StructuredNote schema (lives in `packages/shared/src/schemas/note.ts`)

```ts
StructuredNote = {
  title: string;
  meeting_date: string | null;        // ISO date, if spoken/known
  location: string | null;
  participants: { name: string; role: string | null; company: string | null;
                  speaker_label: string | null; contact_id: string | null }[];
  summary: string;                    // 5–8 lines
  key_decisions: string[];
  action_items: { task: string; owner: string | null; due_date: string | null;
                  priority: "high" | "medium" | "low"; source_quote: string | null }[];
  figures: { kind: "amount" | "quantity" | "rate" | "percentage" | "date" | "other";
             value: number | null; raw_text: string;          // e.g. "₹ 4,850 per MT"
             unit: string | null;                              // sqft, cum, MT, nos …
             currency: "INR" | null; item: string | null;      // "TMT Fe550D 12mm"
             vendor: string | null; project: string | null;
             reference_no: string | null }[];                  // WBS / PO / WO number
  vendors_contractors: string[];
  projects_mentioned: string[];
  follow_ups: { description: string; suggested_date: string | null;
                type: "meeting" | "call" | "deadline" | "reminder" }[];
  open_questions: string[];
  languages_detected: ("en" | "ta" | "kn" | "te" | "ml" | "hi")[];
  language_notes: string | null;      // e.g. "Mixed English/Tamil; 'kambi' = rebar"
}
```

Indian number formats (lakh / crore, "4.5 L", "2 Cr") are normalised to plain numbers
in `value`, keeping the spoken form in `raw_text`. Covered by unit tests.

---

## 4. Folder structure

```
sitemate/
├── CLAUDE.md                  ← this file
├── README.md                  ← step-by-step setup/deploy for a non-developer
├── render.yaml                ← Render free-tier blueprint for the API
├── .env.example               ← root pointer; real examples in each app
├── package.json               ← npm workspaces
├── apps/
│   ├── mobile/                ← Expo app
│   │   ├── src/app/           ← Expo Router screens
│   │   │   ├── (auth)/login.tsx, verify.tsx
│   │   │   ├── (tabs)/today.tsx, record.tsx, notes/, chat.tsx, more/
│   │   │   ├── note/[id].tsx, project/[id].tsx, contact/[id].tsx
│   │   │   └── share-intent.tsx
│   │   ├── src/
│   │   │   ├── lib/           ← config, supabase client, typed api client, auth context
│   │   │   ├── audio/         ← recorder, consent sheet, background config
│   │   │   ├── offline/       ← sqlite schema, upload queue, sync
│   │   │   ├── components/    ← big-button UI kit, status chips
│   │   │   ├── theme/         ← light/dark, high-contrast for sunlight
│   │   ├── app.json           ← permissions, share intent, background audio (config plugins)
│   │   ├── eas.json
│   │   └── .env.example
│   └── api/                   ← Fastify backend
│       ├── src/
│       │   ├── server.ts
│       │   ├── config/env.ts          ← zod-validated env
│       │   ├── plugins/               ← auth, rate-limit, error handler
│       │   ├── routes/                ← one file per resource (see §6)
│       │   ├── services/
│       │   │   ├── ai/                ← LlmProvider, providers/{gemini,groq,anthropic}.ts, quota.ts, prompts/, structuredNote.ts, chatAgent.ts, tools/
│       │   │   ├── stt/               ← SttProvider + groqWhisper.ts, chunker.ts
│       │   │   ├── embeddings/        ← localE5.ts (transformers.js)
│       │   │   ├── extract/           ← pdf, docx, xlsx, pptx, text, whatsapp, image, zip
│       │   │   ├── calendar/          ← CalendarProvider + outlook.ts, google.ts
│       │   │   ├── tasks/             ← TaskProvider + local.ts (ticktick.ts later)
│       │   │   ├── export/            ← pdf.ts, docx.ts
│       │   │   ├── push/              ← expo push
│       │   │   └── usage/             ← token + free-quota logging
│       │   ├── jobs/                  ← pg-boss workers + cron schedules
│       │   └── db/                    ← SQL client (postgres.js), queries
│       ├── test/
│       │   ├── fixtures/              ← sample pdf/docx/xlsx/pptx/whatsapp/zip/heic
│       │   ├── extract.*.test.ts
│       │   ├── structuredNote.test.ts ← valid/invalid/partial JSON, retry path
│       │   └── indianNumbers.test.ts
│       └── .env.example
├── packages/
│   └── shared/                ← zod schemas + TS types (StructuredNote, DayPlan, API DTOs)
└── supabase/
    ├── migrations/            ← numbered SQL migrations (schema + RLS + indexes)
    └── seed.sql               ← sample project "Essence" for testing
```

---

## 5. Data model (PostgreSQL)

All tables have `id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users`,
`created_at`, `updated_at`. **Row Level Security ON for every table** (`user_id = auth.uid()`),
even though the API uses a service connection — defence in depth.

```
projects ─┬─< notes >─┬── note_sources (files / recordings)
          │           ├─< transcript_segments
          │           ├─< tasks >── contacts
          │           ├─< figures
          │           ├─< follow_up_suggestions
          │           └─< note_contacts >── contacts
          ├─< files
          └─< tasks
chat_threads ─< chat_messages ─< message_sources >── notes / files
search_chunks (pgvector, 384-dim) ── notes / files
```

| Table | Key columns | Purpose |
|---|---|---|
| `user_settings` | timezone (`Asia/Kolkata`), morning_plan_time (07:30), evening_recap_time (19:00), evening_recap_enabled, reminder_minutes (15), audio_retention_days (default 30), default_language (`auto/en/ta/kn/te/ml/hi`), transcript_script (`original/romanised`), theme | One row |
| `projects` | name, code, client, location, status (`active/closed`), color, wbs_prefix | e.g. "Aratt Alchemy Essence" |
| `contacts` | name, company, role, phones text[], email, notes, source (`phone/manual`), device_contact_id, name_aliases text[] (e.g. "Ramesh Steel") | Imported + own |
| `contact_projects` | contact_id, project_id | many-to-many |
| `notes` | kind (`meeting / memo / call / file / chat_export`), title, status, language_hint, error_message, error_hint, started_at, duration_sec, location, project_id, contact_id (for call notes), structured jsonb (StructuredNote), summary text, transcript_text, user_edited bool, language_detected, search_tsv tsvector | **Central entity** — every meeting, memo, call note, or processed file |
| `recordings` | note_id, storage_path, mime, size_bytes, duration_sec, sha256, local_id (device UUID for idempotent upload), upload_status, deleted_at | Audio assets |
| `files` | note_id (nullable until attached), project_id, original_name, mime, size_bytes, storage_path, sha256, source (`share/upload`), extracted_text, page_count | Any shared/uploaded file, original kept |
| `transcript_segments` | note_id, idx, speaker_label, speaker_contact_id, start_ms, end_ms, text, edited bool | Editable, searchable transcript |
| `note_contacts` | note_id, contact_id, speaker_label, role_in_meeting | Participants |
| `tasks` | note_id, project_id, owner_contact_id, owner_text, title, due_date, priority, status (`open/done/cancelled`), completed_at, external_provider, external_id | Action items; `external_*` ready for TickTick |
| `figures` | note_id, project_id, kind, value numeric, unit, currency, item, vendor_text, reference_no, raw_text | Searchable ₹ / qty / rate |
| `follow_up_suggestions` | note_id, type, description, suggested_start, status (`pending/accepted/dismissed`), calendar_event_id | Never auto-created |
| `pending_actions` | kind (`call / calendar_event / task / reminder`), payload jsonb, status (`pending/confirmed/rejected/expired`), expires_at, origin (`chat/note/voice_command`) | Confirmation gate |
| `calendar_accounts` | provider (`microsoft/google`), account_email, access_token_enc, refresh_token_enc, expires_at, scopes, calendar_id | Tokens encrypted with `TOKEN_ENCRYPTION_KEY` (AES-256-GCM) |
| `calendar_events_cache` | account_id, external_id, title, starts_at, ends_at, location, attendees jsonb, project_id, note_id, reminder_sent_at | Synced every 15 min + before plan |
| `day_plans` | plan_date, kind (`morning/evening`), content jsonb (DayPlanSchema), pushed_at | Today screen |
| `push_tokens` | expo_push_token, device_name, last_seen_at | |
| `chat_threads` / `chat_messages` | role, content jsonb (provider-neutral parts), tokens | Chat history |
| `message_sources` | message_id, note_id, file_id, segment_id, snippet | Source links in answers |
| `search_chunks` | note_id, file_id, chunk_idx, text, embedding vector(384), project_id, occurred_at | RAG; HNSW index |
| `usage_events` | service (`llm/stt`), provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, audio_seconds, cost_usd numeric(10,5), note_id | Settings → Usage & free-quota meters |
| `audit_log` | action, entity, entity_id, meta | Deletions, confirmations, exports |

Full-text uses the `simple` Postgres config (works for all Indic scripts) + trigram.
Indexes: `notes.search_tsv` (GIN), `transcript_segments.text` + `files.extracted_text` (GIN trigram),
`search_chunks.embedding` (HNSW, cosine), foreign keys, `(user_id, due_date)` on tasks.

**Global search** = Postgres full-text + trigram (catches Tanglish spellings like
"kambi"/"kampi") merged with vector search, ranked by reciprocal-rank fusion.

---

## 6. API endpoints (all under `/v1`, all require `Authorization: Bearer <supabase JWT>` except `/health` and OAuth callbacks)

**System**
- `GET /health` — liveness
- `GET /v1/me` — profile + settings (creates the settings row on first call)
- `POST /v1/diagnostics/ai` — Phase 1 connection test (tiny prompt to Gemini + Groq, returns model, reply, tokens)

**Notes & recordings**
- `POST /v1/notes` — create draft note (kind, project_id?, contact_id?, local_id) → returns note + signed upload URL
- `POST /v1/notes/:id/recordings/complete` — tell server the audio upload finished → enqueue pipeline
- `GET /v1/notes?project_id&contact_id&kind&status&q&cursor` — list
- `GET /v1/notes/:id` — full note (structured, tasks, figures, sources)
- `PATCH /v1/notes/:id` — edit title/summary/structured fields/project/participants
- `GET /v1/notes/:id/transcript` — segments; `PATCH /v1/notes/:id/transcript` — edit segments / speaker names
- `POST /v1/notes/:id/resummarise` — re-run AI on (edited) transcript
- `POST /v1/notes/:id/retry` — retry failed step
- `DELETE /v1/notes/:id/recording` — delete audio only (keep note)
- `DELETE /v1/notes/:id` — delete note (soft delete, 30-day purge)
- `POST /v1/memos/text` — quick text memo → structured note

**Files**
- `POST /v1/files` — create upload slot (name, mime, size, sha256) → signed URL (dedupe on sha256)
- `POST /v1/files/:id/complete` — enqueue extraction
- `POST /v1/files/:id/attach` — `{ note_id }` or `{ project_id, create_note: true }`
- `GET /v1/files/:id/download` — short-lived signed URL to open / re-share original

**Projects / contacts / tasks**
- `GET|POST /v1/projects`, `GET|PATCH /v1/projects/:id`
- `GET /v1/projects/:id/timeline` — meetings, files, open tasks, figures
- `GET|POST /v1/contacts`, `PATCH|DELETE /v1/contacts/:id`
- `POST /v1/contacts/import` — batch upsert from phone (only fields you choose)
- `POST /v1/contacts/resolve` — `{ utterance }` → ranked candidates + a `pending_action` of kind `call`
- `GET|POST /v1/tasks`, `PATCH /v1/tasks/:id`

**Confirmations**
- `GET /v1/pending-actions?status=pending`
- `POST /v1/pending-actions/:id/confirm` — executes (calendar create) or returns dial payload (call)
- `POST /v1/pending-actions/:id/reject`

**Calendar & planner**
- `GET /v1/calendar/microsoft/connect` → redirect; `GET /oauth/microsoft/callback`
- `GET /v1/calendar/google/connect` → redirect; `GET /oauth/google/callback`
- `GET /v1/calendar/events?from&to`
- `DELETE /v1/calendar/accounts/:id` — disconnect
- `GET /v1/plans/today`, `POST /v1/plans/regenerate`
- `POST /v1/push-tokens`

**Chat & search**
- `POST /v1/chat/threads`, `GET /v1/chat/threads`
- `POST /v1/chat/threads/:id/messages` — streams reply (Server-Sent Events) with source links
- `GET /v1/search?q&project_id&type` — global search

**Export**
- `POST /v1/export/note/:id?format=pdf|docx` → signed download URL
- `POST /v1/export/project/:id?format=pdf|docx&from&to`

**Settings / privacy / usage**
- `PATCH /v1/settings`
- `POST /v1/privacy/purge-audio` — `{ older_than_days }` (keeps notes & transcripts)
- `GET /v1/usage?month=2026-09` — AI requests/tokens vs free limits, Groq audio minutes vs free limit, storage vs 1 GB

**Internal (called only by Supabase pg_cron, requires `X-Cron-Secret` header)**
- `POST /internal/cron/:job` — `morning_plan`, `evening_recap`, `meeting_reminders`, `calendar_sync`, `audio_retention`, `keepalive`

**Rate limits** (`@fastify/rate-limit`): 60 req/min general; 10/min for AI-heavy
endpoints (chat, resummarise, resolve); 30/hour uploads. A **quota guard** keeps AI calls
under the free-tier RPM/RPD so Google/Groq never block the account.

---

## 7. Mobile screens & UX

Bottom tabs: **Today · Record · Notes · Chat · More** (More → Contacts, Projects, Settings, Usage).

- **Today** — morning plan card, meetings (with "Start recording" button), overdue / due tasks, calls to make, pending confirmations.
- **Record** — one huge button (≥ 120 dp), consent sheet before start ("Inform participants that this is being recorded"), timer, pause/resume, "Speakerphone meeting mode" toggle, project + contact picker, quick-memo mode (voice or text). Recording continues with screen locked (Android foreground service notification).
- **Notes** — list with status chips `Uploading → Transcribing → Summarising → Done / Failed (tap for fix)`; filter by project/contact/kind; note detail tabs: Summary · Actions · Figures · Transcript · Files.
- **Chat** — text + mic input, answers cite sources (tap → opens note at that segment), confirm sheets for proposed calls/events.
- **Contacts** — import from phone (permission prompt), search, tap-to-call (confirm first), after returning from the dialer → "Add notes for this call?" prompt (detected via AppState when app returns to foreground within 2 h of a dial).
- **Design** — min 56 dp tap targets, 18 sp base font, high-contrast "Sunlight" theme option, light/dark follows system, one-handed reach (primary actions bottom).

Offline: recordings and text memos always work; synced notes readable from SQLite cache; queue shows "3 uploads waiting for network"; retry with exponential backoff; uploads keyed by `local_id` so a retry never creates duplicates.

---

## 8. Scheduled jobs (Supabase pg_cron → API, timezone Asia/Kolkata)

Render's free server sleeps, so the schedule lives in the database (free, always on).
`pg_cron` + `pg_net` send an HTTPS request to `/internal/cron/:job`, which wakes the server.

| Job | When | What |
|---|---|---|
| `calendar_sync` | every 15 min, 7 AM–9 PM | Pull next 7 days from connected calendars |
| `meeting_reminders` | every 5 min, 7 AM–9 PM | Push 15 min before events, action button "Start recording" (deep link `sitemate://record?event=…`) |
| `morning_plan` | user setting (07:30) | Calendar + due/overdue tasks + follow-up calls → AI DayPlan → push (may arrive ~1 min late while the server wakes) |
| `evening_recap` | user setting (19:00), optional | Done / pending / carry-forward → push |
| `audio_retention` | daily 02:00 | Delete server audio older than X days (notes + transcripts kept) |
| `keepalive` | daily | Stops the Supabase free project auto-pausing after 7 idle days |

Reminder checks pause overnight (9 PM–7 AM) to stay within Render's free 750 instance-hours/month.

---

## 9. Security & privacy

- HTTPS only (Render/Fly provide TLS); `@fastify/helmet`; CORS locked to app scheme.
- Supabase JWT verified on every request against `SUPABASE_JWT_SECRET` / JWKS; email must be in `ALLOWED_EMAILS`.
- Storage bucket private; signed URLs expire in 10 min.
- At rest: Supabase encrypts DB + storage (AES-256). OAuth tokens additionally encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`). Optional `AUDIO_ENCRYPTION=on` encrypts audio before storage.
- **Free Gemini may use submitted content to improve Google products (see §2.2).** Groq states API data is not used for training. Switching to a paid provider later removes this.
- `/internal/cron/*` requires `CRON_SECRET`.
- Consent sheet before every recording (can't be disabled; can be shortened after first use).
- Deletions: single recording, all audio older than X days, full note, and "delete everything" (typed confirmation). All logged in `audit_log`.
- Logs never contain transcript text or tokens.

---

## 10. Costs — ₹0 per month (free tiers only)

| Service | Used for | Free limit to watch |
|---|---|---|
| Google Gemini API (AI Studio key) | notes, image/PDF reading, chat, day plans | Per-model requests/min & /day (AI Studio → Rate limits) |
| Groq | speech-to-text (Whisper) + fallback AI | Whisper 8 h audio/day; LLM 1K req/day, 8K tokens/min |
| Local embeddings (e5-small) | chat search | Runs inside our server |
| Supabase | DB, login, file storage, scheduler | 500 MB DB, 1 GB storage, pauses after 7 idle days (keepalive job) |
| Render | API server | 750 hours/month, sleeps when idle, 512 MB RAM |
| Expo / EAS Build | APK builds, push notifications | ~30 builds/month |
| Microsoft Graph, Google Calendar | calendar | Free app registrations (Azure / Google Cloud) |

No credit card is needed for any of these. Settings → Usage shows every limit as a meter and warns at 80%.

---

## 11. Environment variables

`apps/api/.env` (never committed)

```
NODE_ENV=development
PORT=8080
PUBLIC_BASE_URL=https://sitemate-api.onrender.com
APP_SCHEME=sitemate
TZ_DEFAULT=Asia/Kolkata

# Database / Supabase
DATABASE_URL=postgresql://...            # Supabase connection string (pooler)
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...            # server only!
SUPABASE_JWT_SECRET=...
STORAGE_BUCKET=sitemate-private
ALLOWED_EMAILS=you@example.com

# AI (free)
AI_PROVIDER=gemini                       # gemini | anthropic (later)
GEMINI_API_KEY=                          # from aistudio.google.com
GEMINI_MODEL=gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite   # tried in order
GEMINI_MODEL_LITE=gemini-3.5-flash-lite,gemini-3.6-flash
AI_FALLBACK_PROVIDER=groq
GROQ_LLM_MODEL=openai/gpt-oss-120b
# Optional, only if you switch to Claude later:
# ANTHROPIC_API_KEY=
# ANTHROPIC_MODEL=claude-sonnet-5

# Speech-to-text (free tier)
STT_PROVIDER=groq
GROQ_API_KEY=
STT_MODEL=whisper-large-v3
STT_CHUNK_SECONDS=600

# Embeddings (local, no key needed)
EMBEDDINGS_MODEL=Xenova/multilingual-e5-small

# Scheduler
CRON_SECRET=                             # long random string, also stored in Supabase

# Calendar OAuth
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=common
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Security
TOKEN_ENCRYPTION_KEY=                    # 32 random bytes, base64
AUDIO_ENCRYPTION=off

# Limits
RATE_LIMIT_PER_MIN=60
```

`apps/mobile/.env` (safe/public values only — prefixed `EXPO_PUBLIC_`)

```
EXPO_PUBLIC_API_BASE_URL=https://sitemate-api.onrender.com
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...  # public by design, protected by RLS
```

---

## 12. Build phases

| Phase | Deliverable | How you test on Android |
|---|---|---|
| 1 | Monorepo, Supabase schema + RLS, Fastify skeleton, OTP login, `/diagnostics/ai` | **Expo Go** (scan QR) — log in, tap "Test AI" |
| 2 | Record (with language picker) → upload queue → Groq Whisper → AI clean-up → StructuredNote; notes list/detail; transcript edit; quick memo; test with a real mixed-language meeting | **Development build** (EAS, installed once as APK) — background recording needs it |
| 3 | Share target + manual upload; all extractors; attach-to-project flow | Dev build — share a PDF from WhatsApp |
| 4 | Contacts import, voice "call X", confirm → dialer, post-call memo, speakerphone mode | Dev build |
| 5 | Outlook then Google OAuth, calendar sync, morning plan, evening recap, reminders, follow-up suggestions | Dev build + push notifications |
| 6 | Chat with RAG (pgvector), tool use, confirmations, voice input, global search | Dev build |
| 7 | PDF/DOCX export + share, offline polish, error states, usage & free-quota screen, **installable release APK** via EAS Build (free) | Install APK directly |

Each phase ends with: tests passing (`npm test`), README section "How to run Phase N", and this file updated.

---

## 13. Conventions

- TypeScript `strict`; zod at every boundary (env, HTTP input, AI output, file parsers).
- Shared types only from `packages/shared` — no duplicate interfaces.
- Provider SDK types stay inside `services/ai/providers/*`; the rest of the code uses the neutral `LlmProvider` types.
- Prompts live in `apps/api/src/services/ai/prompts/*.ts`, versioned (`PROMPT_VERSION`) and stored on each note so re-summaries are traceable.
- Error responses: `{ error: { code, message, hint } }` — `hint` is written for the user.
- Commits: small, one feature each. No secrets in git (`.env` in `.gitignore`, pre-commit secret scan).
