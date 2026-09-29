import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import type { SttSegment } from "./types";

const run = promisify(execFile);

export interface AudioChunk {
  data: Buffer;
  filename: string;
  offsetMs: number;
}

/**
 * Splits a long recording into pieces of `chunkSeconds` (no re-encoding), so each piece
 * stays under the speech-to-text file-size limit. Short files are returned as one chunk.
 */
export async function splitAudio(
  audio: Buffer,
  filename: string,
  maxBytes: number,
  chunkSeconds: number,
): Promise<AudioChunk[]> {
  if (audio.length <= maxBytes) return [{ data: audio, filename, offsetMs: 0 }];
  if (!ffmpegPath) throw new Error("ffmpeg is not available to split this long recording");

  const ext = extname(filename) || ".m4a";
  const dir = await mkdtemp(join(tmpdir(), "sitemate-"));
  try {
    const input = join(dir, `input${ext}`);
    await writeFile(input, audio);
    await run(ffmpegPath as unknown as string, [
      "-hide_banner", "-loglevel", "error", "-i", input,
      "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1",
      "-c", "copy", join(dir, `part%03d${ext}`),
    ]);
    const parts = (await readdir(dir)).filter((f) => f.startsWith("part")).sort();
    return Promise.all(
      parts.map(async (p, i) => ({
        data: await readFile(join(dir, p)),
        filename: p,
        offsetMs: i * chunkSeconds * 1000,
      })),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Makes speech easier to transcribe: removes rumble and hiss, reduces steady background noise
 * (generators, fans, traffic) and evens out loudness so distant or quiet speakers are heard.
 * Output: mono 16 kHz AAC. On any ffmpeg problem, returns the original audio unchanged.
 */
export async function cleanAudio(audio: Buffer, filename: string): Promise<{ data: Buffer; filename: string }> {
  if (!ffmpegPath) return { data: audio, filename };
  const dir = await mkdtemp(join(tmpdir(), "sitemate-clean-"));
  try {
    const input = join(dir, `input${extname(filename) || ".m4a"}`);
    const output = join(dir, "clean.m4a");
    await writeFile(input, audio);
    await run(ffmpegPath as unknown as string, [
      "-hide_banner", "-loglevel", "error", "-i", input,
      "-af", "highpass=f=80,lowpass=f=7600,afftdn=nf=-25,loudnorm=I=-18:TP=-2:LRA=11",
      "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", output,
    ]);
    return { data: await readFile(output), filename: "clean.m4a" };
  } catch {
    return { data: audio, filename };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Joins per-chunk segments into one timeline. */
export function stitchSegments(chunks: { offsetMs: number; segments: SttSegment[] }[]): SttSegment[] {
  return chunks.flatMap((c) =>
    c.segments.map((s) => ({ ...s, startMs: s.startMs + c.offsetMs, endMs: s.endMs + c.offsetMs })),
  );
}
