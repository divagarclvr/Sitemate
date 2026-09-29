/**
 * Runs an audio file through transcription + AI note WITHOUT the app or database,
 * to check quality for a language. Nothing is saved.
 *
 *   npm run try:audio -w @sitemate/api -- "C:\path\to\recording.m4a" ta
 *
 * Language: auto | en | ta | kn | te | ml | hi (default auto)
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { LanguageHint, StructuredNoteSchema } from "@sitemate/shared";
import { loadEnv } from "../config/env";
import { createAiProviders } from "../services/ai";
import { generateValidatedJson } from "../services/ai/json";
import { CleanedTranscriptSchema, NOTE_SYSTEM, cleanupSystem, noteUserPrompt } from "../services/ai/prompts/note";
import { normaliseFigures } from "../services/notes/indianNumbers";
import { cleanAudio, splitAudio, stitchSegments } from "../services/stt/chunker";
import { GroqWhisper } from "../services/stt/groqWhisper";

const [file, lang = "auto"] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run try:audio -w @sitemate/api -- "path\\to\\audio.m4a" [auto|en|ta|kn|te|ml|hi]');
  process.exit(1);
}

const env = loadEnv({ ...process.env, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY || "unused" });
const ai = createAiProviders(env);
const stt = new GroqWhisper(env.GROQ_API_KEY, env.STT_MODEL);
const language = LanguageHint.parse(lang);

const t0 = Date.now();
const audio = await cleanAudio(await readFile(file), basename(file));
const chunks = await splitAudio(audio.data, audio.filename, env.STT_MAX_MB * 1024 * 1024, env.STT_CHUNK_SECONDS);
const parts = [];
for (const c of chunks) {
  const r = await stt.transcribe(c.data, c.filename, language);
  parts.push({ offsetMs: c.offsetMs, segments: r.segments });
  console.log(`\n── Transcribed ${c.filename} (${r.durationSec}s, detected: ${r.language}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const raw = stitchSegments(parts);
console.log(raw.map((s) => s.text).join("\n"));

const clean = await generateValidatedJson(
  ai.llm,
  CleanedTranscriptSchema,
  [{ role: "user", parts: [{ type: "text", text: raw.map((s) => s.text).join("\n") }] }],
  { system: cleanupSystem("original"), tier: "lite", maxOutputTokens: 16000, temperature: 0.2 },
);
console.log(`\n── Cleaned transcript (${clean.results.at(-1)!.provider} · ${clean.results.at(-1)!.model})`);
const transcript = clean.data.segments.map((s) => `${s.speaker}: ${s.text}${s.gloss ? `  [${s.gloss}]` : ""}`).join("\n");
console.log(transcript);

const note = await generateValidatedJson(
  ai.llm,
  StructuredNoteSchema,
  [{ role: "user", parts: [{ type: "text", text: noteUserPrompt({ kind: "meeting", startedAt: new Date(), durationSec: null, projectName: null, transcript }) }] }],
  { system: NOTE_SYSTEM, tier: "main", maxOutputTokens: 16000, temperature: 0.2 },
);
console.log(`\n── Meeting note (${note.results.at(-1)!.provider} · ${note.results.at(-1)!.model}, attempts: ${note.attempts})`);
console.log(JSON.stringify({ ...note.data, figures: normaliseFigures(note.data.figures) }, null, 2));
console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
