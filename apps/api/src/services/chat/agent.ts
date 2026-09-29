import type { ChatSource, PendingActionDto } from "@sitemate/shared";
import { z } from "zod";
import type { Sql } from "../../db/client";
import { AppError } from "../../errors";
import { generateValidatedJson } from "../ai/json";
import type { LlmMessage, LlmProvider } from "../ai/types";
import { runTool, ToolArgs, TOOL_NAMES, type ToolContext } from "./tools";

/**
 * The chat "brain". Works with any AI provider (including the free backup): each turn the AI replies with
 * one JSON step — either "use this tool" or "here is the answer" — and the server runs the tool and feeds
 * the result back. Facts come only from tool results, so answers can be traced to notes.
 */
export const AgentStep = z
  .object({
    action: z.enum(["tool", "answer"]),
    tool: z.enum(TOOL_NAMES).nullish(),
    args: ToolArgs.nullish(),
    answer: z.string().max(4000).nullish(),
    source_note_ids: z.array(z.string()).max(10).nullish(),
  })
  .refine((s) => (s.action === "tool" ? !!s.tool : !!s.answer?.trim()), { message: "action 'tool' needs a tool; action 'answer' needs an answer" });
export type AgentStep = z.infer<typeof AgentStep>;

const MAX_TOOL_STEPS = 5;
const MAX_RESULT_CHARS = 7000;

export function systemPrompt(today: string, timezone: string): string {
  return `You are SiteMate, the personal assistant of a Senior Estimator at a construction company in Bengaluru, India.
You answer questions about the user's own meetings, calls, files, tasks, contacts and calendar, using tools. Today is ${today} (${timezone}).

Reply with ONE JSON object each turn:
{"action":"tool","tool":"<name>","args":{...}}  — to look something up or propose something
{"action":"answer","answer":"<text for the user>","source_note_ids":["<note_id>", ...]}  — when you can answer

Tools (args not needed can be left out):
- search_notes {query, project?, days?} — find meetings/calls/files/memos by topic, person or words. Returns note_ids.
- get_note {note_id} — full summary, decisions, action items, figures and start of transcript of one note.
- search_figures {query, project?, days?} — rates, quantities and amounts mentioned in notes, by item / vendor / reference number.
- list_tasks {status: "open"|"done", project?, query?} — action items.
- list_events {from?, to?} — meetings in the calendar (dates YYYY-MM-DD; default next 7 days).
- find_contact {query} — look up a person; returns contact_id and phone numbers.
- propose_call {contact_id, reason?} — suggest calling someone. NOTHING is dialled; the user confirms in the app.
- propose_event {title, date, start_time?, duration_min?} — suggest a calendar meeting (date YYYY-MM-DD, start_time HH:MM 24-hour; leave start_time out for all-day).
- propose_task {title, date?} — suggest a task (date = due date).

Rules:
- Never guess facts, numbers, rates or dates. If you don't know, look it up. If the tools find nothing, say so plainly.
- To answer about a note's details, search first, then get_note when the snippet is not enough.
- Put the note_ids your answer is based on in source_note_ids (only ids returned by tools).
- To call someone, use find_contact then propose_call. Never say a call, meeting or task was made — say you have suggested it and that the user must confirm.
- Write for a phone screen: short, plain English, no markdown headings. Use "•" bullets for lists. Money as ₹ with Indian grouping (₹4,85,000). Keep names, vendors and units exactly as in the notes. Mention the note's date when useful (e.g. 12 Sep).
- If the question is not about the user's own work data, answer briefly and helpfully from general knowledge.`;
}

export interface AgentInput {
  question: string;
  /** Earlier turns of this chat (oldest first), plain text only. */
  history: { role: "user" | "assistant"; text: string }[];
  /** Search the notes for the question before the first AI call (saves a round trip). Default on. */
  prefetch?: boolean;
}

export interface AgentResult {
  answer: string;
  sources: ChatSource[];
  actions: PendingActionDto[];
}

const clip = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}…(cut)` : s;
};

async function logUsage(db: Sql, userId: string, results: { provider: string; model: string; inputTokens: number | null; outputTokens: number | null }[]) {
  for (const r of results) {
    await db`
      insert into usage_events (user_id, service, provider, model, purpose, input_tokens, output_tokens)
      values (${userId}, 'llm', ${r.provider}, ${r.model}, 'chat', ${r.inputTokens}, ${r.outputTokens})`.catch(() => undefined);
  }
}

export async function runAgent(llm: LlmProvider, ctx: ToolContext, input: AgentInput): Promise<AgentResult> {
  const system = systemPrompt(ctx.today, ctx.timezone);
  const messages: LlmMessage[] = [
    ...input.history.slice(-8).map((h): LlmMessage => ({ role: h.role, parts: [{ type: "text", text: h.text.slice(0, 3000) }] })),
    { role: "user", parts: [{ type: "text", text: input.question }] },
  ];

  const seen = new Map<string, true>();
  const actions: PendingActionDto[] = [];
  let answer: string | null = null;
  let cited: string[] = [];

  // Free AI is slow and often busy, so every round trip counts: search first, so most questions need one AI call.
  if (input.prefetch !== false && input.question.trim().length >= 4) {
    try {
      const first = await runTool(ctx, "search_notes", { query: input.question });
      first.noteIds.forEach((id) => seen.set(id, true));
      messages.push(
        { role: "assistant", parts: [{ type: "text", text: JSON.stringify({ action: "tool", tool: "search_notes", args: { query: input.question } }) }] },
        { role: "user", parts: [{ type: "text", text: `TOOL RESULT (search_notes):
${clip(first.result)}` }] },
      );
    } catch {
      /* search unavailable: the AI can still ask for it */
    }
  }

  for (let step = 0; step <= MAX_TOOL_STEPS && answer === null; step++) {
    const mustAnswer = step === MAX_TOOL_STEPS;
    const { data, results } = await generateValidatedJson(llm, AgentStep, messages, {
      system: mustAnswer ? `${system}\n\nYou have used all your lookups. Reply now with action "answer" using what you have found.` : system,
      tier: "lite", // most available free model; the list falls back to the bigger one
      temperature: 0.2,
      maxOutputTokens: 2000,
    });
    await logUsage(ctx.db, ctx.userId, results);

    if (data.action === "answer" || mustAnswer) {
      answer = data.answer?.trim() || "I couldn't finish looking that up. Try asking in a more specific way.";
      cited = data.source_note_ids ?? [];
      break;
    }

    let outcome;
    try {
      outcome = await runTool(ctx, data.tool!, data.args ?? {});
    } catch (e) {
      outcome = { result: { error: e instanceof AppError ? e.message : "The lookup failed." }, noteIds: [], actions: [] as PendingActionDto[] };
    }
    outcome.noteIds.forEach((id) => seen.set(id, true));
    actions.push(...outcome.actions);
    messages.push(
      { role: "assistant", parts: [{ type: "text", text: JSON.stringify({ action: "tool", tool: data.tool, args: data.args ?? {} }) }] },
      { role: "user", parts: [{ type: "text", text: `TOOL RESULT (${data.tool}):\n${clip(outcome.result)}` }] },
    );
  }

  // Only notes the tools really returned can be cited.
  const ids = [...new Set(cited)].filter((id) => seen.has(id)).slice(0, 6);
  const sources = ids.length
    ? await ctx.db<ChatSource[]>`
        select n.id as note_id, n.title, n.kind, to_char(coalesce(n.started_at, n.created_at), 'YYYY-MM-DD') as date, left(coalesce(n.summary, ''), 200) as snippet
        from notes n where n.user_id = ${ctx.userId} and n.deleted_at is null and n.id = any(${ctx.db.array(ids)}::uuid[])`
    : [];
  return { answer: answer ?? "", sources: ids.flatMap((id) => sources.filter((s) => s.note_id === id)), actions };
}
