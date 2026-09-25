import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { Sql } from "../src/db/client";
import { loadEnv } from "../src/config/env";
import { ScriptedProvider, testEnv } from "./helpers";

const main = new ScriptedProvider("gemini", ["SiteMate AI connected — கம்பி / ..."]);
const fallback = new ScriptedProvider("groq", [new Error("invalid api key")]);

const app = await buildApp({
  env: testEnv,
  db: (() => {
    throw new Error("db not used in these tests");
  }) as unknown as Sql,
  ai: { llm: main, main, fallback },
  verifyToken: async (token) => {
    if (token === "owner") return { id: "u1", email: "owner@example.com" };
    if (token === "stranger") return { id: "u2", email: "someone@else.com" };
    throw new Error("bad token");
  },
});

beforeAll(() => app.ready());
afterAll(() => app.close());

describe("API skeleton", () => {
  it("GET /health works without login", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("refuses /v1 without a token", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/diagnostics/ai" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.hint).toBeTruthy();
  });

  it("refuses an expired/invalid token", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/diagnostics/ai", headers: { authorization: "Bearer junk" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("SESSION_EXPIRED");
  });

  it("refuses a valid login whose email is not allowed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/diagnostics/ai",
      headers: { authorization: "Bearer stranger" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("EMAIL_NOT_ALLOWED");
  });

  it("runs the AI diagnostics and reports each provider separately", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/diagnostics/ai",
      headers: { authorization: "Bearer owner" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.main).toMatchObject({ provider: "gemini", ok: true });
    expect(body.fallback).toMatchObject({ provider: "groq", ok: false, error: "invalid api key" });
  });
});

describe("env", () => {
  it("explains missing variables in plain words", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });
  it("lower-cases the allowed email list", () => {
    expect(testEnv.ALLOWED_EMAILS).toEqual(["owner@example.com"]);
  });
});
