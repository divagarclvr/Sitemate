/**
 * Checks your AI keys directly (no login needed).
 * Run with:  npm run check:ai -w @sitemate/api
 */
import { loadEnv } from "../config/env";
import { createAiProviders } from "../services/ai";
import type { LlmProvider } from "../services/ai/types";

const prompt =
  "Reply in ONE short line: 'SiteMate AI connected' followed by the word 'steel bar' in " +
  "Tamil, Kannada, Telugu, Malayalam and Hindi, separated by ' / '.";

async function check(label: string, p: LlmProvider | null) {
  if (!p) return console.log(`– ${label}: not configured`);
  const started = Date.now();
  try {
    const r = await p.generate([{ role: "user", parts: [{ type: "text", text: prompt }] }], {
      maxOutputTokens: 2000,
    });
    console.log(`✓ ${label} (${r.provider} · ${r.model}, ${((Date.now() - started) / 1000).toFixed(1)}s): ${r.text.trim()}`);
  } catch (err) {
    console.log(`✗ ${label} (${p.name} · ${p.modelFor("main")}): ${(err as Error).message.slice(0, 400)}`);
  }
}

const ai = createAiProviders(loadEnv());
await check("Main AI", ai.main);
await check("Backup AI", ai.fallback);
