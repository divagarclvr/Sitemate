import type { FastifyInstance, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Env } from "../config/env";
import { AppError } from "../errors";

export interface AuthUser {
  id: string;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

/** Verifies a Supabase access token (JWKS by default, legacy HS256 secret if configured). */
export function supabaseVerifier(env: Env): TokenVerifier {
  const issuer = `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
  const key: Uint8Array | JWTVerifyGetKey = env.SUPABASE_JWT_SECRET
    ? new TextEncoder().encode(env.SUPABASE_JWT_SECRET)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (token) => {
    const { payload } = await jwtVerify(token, key as never, { issuer, audience: "authenticated" });
    if (!payload.sub || typeof payload.email !== "string") throw new Error("token missing sub/email");
    return { id: payload.sub, email: payload.email.toLowerCase() };
  };
}

/**
 * Adds `request.user` to every request under /v1. Only emails in ALLOWED_EMAILS get in —
 * this is a personal app, so everyone else is refused even with a valid Supabase login.
 */
export async function registerAuth(app: FastifyInstance, env: Env, verify: TokenVerifier) {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (!req.url.startsWith("/v1/")) return;

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      throw new AppError(401, "NOT_SIGNED_IN", "You are not signed in.", "Open the app and sign in again.");
    }

    let user: AuthUser;
    try {
      user = await verify(token);
    } catch {
      throw new AppError(401, "SESSION_EXPIRED", "Your session has expired.", "Sign in again with your email code.");
    }

    if (env.ALLOWED_EMAILS.length === 0 || !env.ALLOWED_EMAILS.includes(user.email)) {
      throw new AppError(
        403,
        "EMAIL_NOT_ALLOWED",
        `${user.email} is not allowed to use this SiteMate server.`,
        "Add this email to ALLOWED_EMAILS in the server settings, then restart the server.",
      );
    }
    req.user = user;
  });
}
