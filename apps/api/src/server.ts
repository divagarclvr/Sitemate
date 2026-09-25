import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { createDb } from "./db/client";
import { supabaseVerifier } from "./plugins/auth";
import { createAiProviders } from "./services/ai";

async function main() {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);
  const ai = createAiProviders(env);
  const app = await buildApp({ env, db, ai, verifyToken: supabaseVerifier(env) });

  const shutdown = async () => {
    await app.close();
    await db.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
