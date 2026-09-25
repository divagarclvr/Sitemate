import type { FastifyBaseLogger } from "fastify";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import { ProviderUnavailableError, QuotaExceededError } from "../services/ai/types";
import type { NotePipeline } from "../services/notes/pipeline";

export type JobKind = "process_recording" | "process_text" | "resummarise";

interface JobRow {
  id: string;
  kind: JobKind;
  note_id: string;
  attempts: number;
}

/** Ordinary errors are retried this many times; waiting for free quota doesn't count. */
const MAX_ATTEMPTS = 3;
/** Give up waiting for free quota after this many tries (≈ 2 days at 1–2 h apart). */
const MAX_QUOTA_WAITS = 40;

export async function enqueue(db: Sql, job: { userId: string; noteId: string; kind: JobKind }) {
  // One active job per note: replace anything still queued for it.
  await db`delete from jobs where note_id = ${job.noteId} and status = 'queued'`;
  await db`insert into jobs (user_id, note_id, kind) values (${job.userId}, ${job.noteId}, ${job.kind})`;
}

/** What to do after a job failed. Exported for tests. */
export function retryPlan(err: unknown, attempts: number): { retryInSec: number; waiting: boolean } | null {
  if (err instanceof QuotaExceededError) return attempts < MAX_QUOTA_WAITS ? { retryInSec: 60 * 60, waiting: true } : null;
  if (err instanceof ProviderUnavailableError) return attempts < MAX_QUOTA_WAITS ? { retryInSec: 5 * 60, waiting: true } : null;
  if (err instanceof AppError && err.statusCode < 500 && err.code !== "NO_AUDIO") return null; // user-fixable, retrying won't help
  return attempts < MAX_ATTEMPTS ? { retryInSec: 60 * attempts, waiting: false } : null;
}

/** Polls the jobs table and runs one job at a time. Safe with several server instances (SKIP LOCKED). */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private db: Sql,
    private pipeline: NotePipeline,
    private log: FastifyBaseLogger,
    private pollMs: number,
  ) {}

  async start() {
    // Jobs left "running" by a crash or restart go back to the queue.
    await this.db`update jobs set status = 'queued', locked_at = null
                  where status = 'running' and locked_at < now() - interval '15 minutes'`;
    this.schedule(500);
  }

  /** Check for work now (called right after a job is queued). */
  kick() {
    if (!this.running && !this.stopped) this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (!this.stopped && (await this.runOne())) {
        /* keep going while there is work */
      }
    } catch (err) {
      this.log.error({ err }, "worker loop error");
    } finally {
      this.running = false;
      if (!this.stopped) this.schedule(this.pollMs);
    }
  }

  private async runOne(): Promise<boolean> {
    const [job] = await this.db<JobRow[]>`
      update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
      where id = (
        select id from jobs where status = 'queued' and run_after <= now()
        order by run_after limit 1 for update skip locked
      )
      returning id, kind, note_id, attempts`;
    if (!job) return false;

    this.log.info({ job: job.id, kind: job.kind, note: job.note_id, attempt: job.attempts }, "job started");
    try {
      if (job.kind === "process_recording") await this.pipeline.processRecording(job.note_id);
      else if (job.kind === "process_text") await this.pipeline.processText(job.note_id);
      else await this.pipeline.resummarise(job.note_id);
      await this.db`update jobs set status = 'done', last_error = null where id = ${job.id}`;
      this.log.info({ job: job.id }, "job done");
    } catch (err) {
      await this.handleFailure(job, err);
    }
    return true;
  }

  private async handleFailure(job: JobRow, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const plan = retryPlan(err, job.attempts);
    this.log.warn({ job: job.id, err: message, plan }, "job failed");

    if (plan) {
      await this.db`
        update jobs set status = 'queued', locked_at = null, last_error = ${message},
          run_after = now() + make_interval(secs => ${plan.retryInSec})
        where id = ${job.id}`;
      if (plan.waiting) {
        const text = err instanceof QuotaExceededError
          ? "Waiting for the free AI limit to reset — will continue automatically"
          : "The free AI service is busy — will try again in a few minutes";
        await this.db`update notes set status = 'waiting_quota', progress_text = ${text} where id = ${job.note_id}`;
      }
      return;
    }

    const friendly =
      err instanceof AppError
        ? { message: err.message, hint: err.hint ?? null }
        : err instanceof ProviderUnavailableError
          ? { message: "The free AI service stayed unavailable for too long.", hint: "Tap Retry to try again." }
          : { message: "Processing failed.", hint: "Tap Retry. If it keeps failing, the recording may be damaged." };
    await this.db`update jobs set status = 'failed', locked_at = null, last_error = ${message} where id = ${job.id}`;
    await this.db`
      update notes set status = 'failed', progress_text = null,
        error_message = ${friendly.message}, error_hint = ${friendly.hint}
      where id = ${job.note_id}`;
  }
}
