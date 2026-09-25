import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { Env } from "./config/env";
import type { Sql } from "./db/client";
import { registerAuth, type TokenVerifier } from "./plugins/auth";
import { registerErrorHandler } from "./plugins/errors";
import { diagnosticsRoutes } from "./routes/diagnostics";
import { healthRoutes } from "./routes/health";
import { meRoutes } from "./routes/me";
import type { AiProviders } from "./services/ai";

export interface AppDeps {
  env: Env;
  db: Sql;
  ai: AiProviders;
  verifyToken: TokenVerifier;
}

export async function buildApp({ env, db, ai, verifyToken }: AppDeps) {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.authorization"] },
    bodyLimit: 1024 * 1024,
    trustProxy: true, // Render/Fly sit behind a proxy; needed for correct client IPs in rate limiting
  });

  registerErrorHandler(app);
  await app.register(helmet);
  // The mobile app is not a browser, so CORS only matters for local web testing.
  await app.register(cors, { origin: env.NODE_ENV === "development" });
  await app.register(rateLimit, { max: env.RATE_LIMIT_PER_MIN, timeWindow: "1 minute" });
  await registerAuth(app, env, verifyToken);

  await app.register(healthRoutes);
  await app.register(meRoutes(db));
  await app.register(diagnosticsRoutes(ai));

  return app;
}
