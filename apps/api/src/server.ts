import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./db/client";
import { Worker } from "./jobs/queue";
import { supabaseVerifier } from "./plugins/auth";
import { createAiProviders } from "./services/ai";
import { NotePipeline } from "./services/notes/pipeline";
import { GeminiEmbeddings } from "./services/search/embeddings";
import { indexMissingNotes } from "./services/search/indexer";
import { supabaseStorage } from "./services/storage";
import { GroqWhisper } from "./services/stt/groqWhisper";

async function main() {
  const env = loadEnv();
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is needed for speech-to-text. Add it to apps/api/.env");

  const db = createDb(env.DATABASE_URL);
  const ai = createAiProviders(env);
  const storage = supabaseStorage(env);
  const stt = new GroqWhisper(env.GROQ_API_KEY, env.STT_MODEL);
  const embedder = env.GEMINI_API_KEY ? new GeminiEmbeddings(env.GEMINI_API_KEY, env.GEMINI_EMBED_MODEL) : null;
  const pipeline = new NotePipeline({ db, env, storage, stt, llm: ai.llm, embedder });

  let worker: Worker | null = null;
  const app = await buildApp({
    env,
    db,
    ai,
    storage,
    stt,
    embedder,
    verifyToken: supabaseVerifier(env),
    kickWorker: () => worker?.kick(),
  });
  if (env.WORKER_ENABLED) worker = new Worker(db, pipeline, app.log, env.WORKER_POLL_MS);

  const shutdown = async () => {
    worker?.stop();
    await app.close();
    await db.end({ timeout: 5 });
    process.exit(0);
  };
  // Notes finished while the free embedding limit was used up get their search index completed later.
  if (env.WORKER_ENABLED && embedder) {
    const catchUp = () => void indexMissingNotes(db, embedder, 5).catch((e) => app.log.warn({ err: String(e) }, "search indexing failed"));
    setTimeout(catchUp, 30_000).unref();
    setInterval(catchUp, 10 * 60_000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
  await worker?.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
