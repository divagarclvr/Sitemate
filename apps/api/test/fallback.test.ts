import { describe, expect, it } from "vitest";
import { FallbackProvider } from "../src/services/ai/fallback";
import { ProviderUnavailableError, QuotaExceededError, UnsupportedInputError } from "../src/services/ai/types";
import { ScriptedProvider, userMsg } from "./helpers";

describe("FallbackProvider", () => {
  it("uses the main provider when it works", async () => {
    const main = new ScriptedProvider("gemini", ["hello"]);
    const fb = new ScriptedProvider("groq", ["fallback"]);
    const r = await new FallbackProvider(main, fb).generate(userMsg("hi"));
    expect(r.provider).toBe("gemini");
    expect(fb.calls).toHaveLength(0);
  });

  it("switches to the fallback when the free quota is used up", async () => {
    const main = new ScriptedProvider("gemini", [new QuotaExceededError("gemini", "429")]);
    const fb = new ScriptedProvider("groq", ["fallback"]);
    const r = await new FallbackProvider(main, fb).generate(userMsg("hi"));
    expect(r.provider).toBe("groq");
  });

  it("switches to the fallback when the main AI is overloaded (503)", async () => {
    const main = new ScriptedProvider("gemini", [new ProviderUnavailableError("gemini", "503 high demand")]);
    const fb = new ScriptedProvider("groq", ["fallback"]);
    const r = await new FallbackProvider(main, fb).generate(userMsg("hi"));
    expect(r.provider).toBe("groq");
  });

  it("does not hide non-quota errors", async () => {
    const main = new ScriptedProvider("gemini", [new Error("bad key")]);
    const fb = new ScriptedProvider("groq", ["fallback"]);
    await expect(new FallbackProvider(main, fb).generate(userMsg("hi"))).rejects.toThrow("bad key");
  });

  it("reports the quota error when the fallback can't read images", async () => {
    const quota = new QuotaExceededError("gemini", "429");
    const main = new ScriptedProvider("gemini", [quota]);
    const fb = new ScriptedProvider("groq", [new UnsupportedInputError("no images")]);
    await expect(new FallbackProvider(main, fb).generate(userMsg("hi"))).rejects.toBe(quota);
  });
});
