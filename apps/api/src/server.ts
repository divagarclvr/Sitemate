import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./db/client";
import { Worker } from "./jobs/queue";
import { supabaseVerifier } from "./plugins/auth";
import { createAiProviders } from "./services/ai";
import { NotePipeline } from "./services/notes/pipeline";
import { supabaseStorage } from "./services/storage";
import { GroqWhisper } from "./services/stt/groqWhisper";

async function main() {
  const env = loadEnv();
  if (!env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is needed for speech-to-text. Add it to apps/api/.env");

  const db = createDb(env.DATABASE_URL);
  const ai = createAiProviders(env);
  const storage = supabaseStorage(env);
  const stt = new GroqWhisper(env.GROQ_API_KEY, env.STT_MODEL);
  const pipeline = new NotePipeline({ db, env, storage, stt, llm: ai.llm });

  let worker: Worker | null = null;
  const app = await buildApp({
    env,
    db,
    ai,
    storage,
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
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
  await worker?.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
