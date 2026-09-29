import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import { retryPlan } from "../src/jobs/queue";
import { ProviderUnavailableError, QuotaExceededError } from "../src/services/ai/types";
import { groupByChars, isoDate, isoTimestamp, linesToText } from "../src/services/notes/pipeline";
import { cleanAudio, splitAudio, stitchSegments } from "../src/services/stt/chunker";
import { isLikelyHallucination } from "../src/services/stt/groqWhisper";

describe("transcript helpers", () => {
  it("groups segments without exceeding the size limit", () => {
    const segs = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].map((text) => ({ text }));
    expect(groupByChars(segs, 90).map((g) => g.length)).toEqual([2, 1]);
  });

  it("never drops an oversized single segment", () => {
    expect(groupByChars([{ text: "x".repeat(500) }], 100)).toHaveLength(1);
  });

  it("formats speaker lines", () => {
    expect(
      linesToText([
        { speaker: "Speaker A", text: "Rate is 58,500", gloss: null, startMs: 0, endMs: 1 },
        { speaker: null, text: "(noise)", gloss: null, startMs: 1, endMs: 2 },
      ]),
    ).toBe("Speaker A: Rate is 58,500\n(noise)");
  });

  it("stitches chunk timelines", () => {
    const s = stitchSegments([
      { offsetMs: 0, segments: [{ startMs: 0, endMs: 1000, text: "one" }] },
      { offsetMs: 1_200_000, segments: [{ startMs: 500, endMs: 900, text: "two" }] },
    ]);
    expect(s[1]).toEqual({ startMs: 1_200_500, endMs: 1_200_900, text: "two" });
  });
});

describe("dates from the AI", () => {
  it("accepts ISO dates only", () => {
    expect(isoDate("2026-09-27")).toBe("2026-09-27");
    expect(isoDate("next Monday")).toBeNull();
    expect(isoDate(null)).toBeNull();
  });
  it("reads times as India time", () => {
    expect(isoTimestamp("2026-09-27T15:30")).toBe("2026-09-27T10:00:00.000Z");
    expect(isoTimestamp("2026-09-27")).toBe("2026-09-27T03:30:00.000Z"); // 9:00 AM IST default
    expect(isoTimestamp("soon")).toBeNull();
  });
});

describe("job retry rules", () => {
  it("waits an hour when the free quota is used up", () => {
    expect(retryPlan(new QuotaExceededError("gemini", "429"), 1)).toEqual({ retryInSec: 3600, waiting: true });
  });
  it("retries in 5 minutes when the AI is busy", () => {
    expect(retryPlan(new ProviderUnavailableError("gemini", "503"), 1)).toEqual({ retryInSec: 300, waiting: true });
  });
  it("does not retry problems the user must fix", () => {
    expect(retryPlan(new AppError(422, "SILENT_AUDIO", "no speech"), 1)).toBeNull();
  });
  it("retries unexpected errors a few times, then gives up", () => {
    expect(retryPlan(new Error("boom"), 1)).toEqual({ retryInSec: 60, waiting: false });
    expect(retryPlan(new Error("boom"), 3)).toBeNull();
  });
});

describe("splitAudio", () => {
  it("returns small files unchanged", async () => {
    const buf = Buffer.from("tiny");
    const chunks = await splitAudio(buf, "a.m4a", 1000, 600);
    expect(chunks).toEqual([{ data: buf, filename: "a.m4a", offsetMs: 0 }]);
  });

  it("splits a long recording into timed pieces with ffmpeg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitemate-test-"));
    try {
      const file = join(dir, "tone.m4a");
      // 25 seconds of mono AAC — like the phone records.
      await promisify(execFile)(ffmpegPath as unknown as string, [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=25",
        "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k", file,
      ]);
      const audio = await readFile(file);
      const chunks = await splitAudio(audio, "tone.m4a", 10, 10); // force splitting
      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks.map((c) => c.offsetMs).slice(0, 3)).toEqual([0, 10_000, 20_000]);
      expect(chunks.every((c) => c.data.length > 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Whisper hallucination filter", () => {
  it.each([
    [{ start: 0, end: 5, text: "Tmk.com, Tmk.com, Tmk.com, Tmk.com" }],
    [{ start: 0, end: 5, text: " . . ." }],
    [{ start: 0, end: 5, text: "Thank you.", no_speech_prob: 0.9, avg_logprob: -0.9 }],
    [{ start: 0, end: 5, text: "ok ok ok ok ok ok ok ok", compression_ratio: 3.1 }],
    [{ start: 0, end: 5, text: "Shri Mataji 248thaza", avg_logprob: -1.5 }],
  ])("drops %j", (seg) => {
    expect(isLikelyHallucination(seg)).toBe(true);
  });

  it("keeps normal speech", () => {
    expect(
      isLikelyHallucination({ start: 0, end: 5, text: "Send the revised quotation by tomorrow", avg_logprob: -0.3, no_speech_prob: 0.02, compression_ratio: 1.2 }),
    ).toBe(false);
  });
});

describe("cleanAudio", () => {
  it("returns audio ffmpeg can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sitemate-test-"));
    try {
      const file = join(dir, "quiet.m4a");
      await promisify(execFile)(ffmpegPath as unknown as string, [
        "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
        "-af", "volume=0.05", "-ac", "1", "-ar", "16000", "-c:a", "aac", file,
      ]);
      const out = await cleanAudio(await readFile(file), "quiet.m4a");
      expect(out.filename).toBe("clean.m4a");
      expect(out.data.length).toBeGreaterThan(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("falls back to the original when the input isn't audio", async () => {
    const junk = Buffer.from("not audio");
    const out = await cleanAudio(junk, "x.m4a");
    expect(out.data).toBe(junk);
  });
});
