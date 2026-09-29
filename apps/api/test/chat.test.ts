import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkText, noteChunks } from "../src/services/search/indexer";
import { normalise, toVectorLiteral } from "../src/services/search/embeddings";
import { keywords, rrf } from "../src/services/search/search";
import { AgentStep, runAgent, systemPrompt } from "../src/services/chat/agent";
import { summarise } from "../src/services/chat/actions";
import { runTool } from "../src/services/chat/tools";
import { ScriptedProvider } from "./helpers";

vi.mock("../src/services/chat/tools", async (orig) => ({ ...(await orig<typeof import("../src/services/chat/tools")>()), runTool: vi.fn() }));

const NOTE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** A stand-in database: every query returns nothing, except the "load cited notes" query. */
const fakeDb = () => {
  const db = ((strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("from notes n where")) {
      return Promise.resolve([{ note_id: NOTE, title: "Steel rates call", kind: "call", date: "2026-09-12", snippet: "Ramesh quoted ₹58,000 per MT" }]);
    }
    return Promise.resolve([]);
  }) as unknown as import("../src/db/client").Sql;
  (db as unknown as { array: (x: unknown) => unknown }).array = (x) => x;
  return db;
};
const ctx = () => ({ db: fakeDb(), embedder: null, userId: "u1", timezone: "Asia/Kolkata", today: "2026-09-29" });
const step = (o: object) => JSON.stringify(o);

describe("search helpers", () => {
  it("pulls keywords out of a question, keeping Indian-script words", () => {
    expect(keywords("What did Ramesh quote for TMT last week?")).toEqual(["ramesh", "quote", "tmt"]);
    expect(keywords("கம்பி ரேட் என்ன")).toContain("கம்பி");
  });

  it("merges two ranked lists so items ranked high in either list come first", () => {
    const merged = rrf<string>([
      { key: (x) => x, items: ["a", "b", "c"] },
      { key: (x) => x, items: ["c", "b", "d"] },
    ]);
    expect(merged.map((m) => m.key)).toEqual(["c", "b", "a", "d"]);
  });

  it("makes unit-length vectors and Postgres vector text", () => {
    const v = normalise([3, 4]);
    expect(v[0]).toBeCloseTo(0.6);
    expect(toVectorLiteral([0.5, -1])).toBe("[0.5,-1]");
  });
});

describe("chunking notes for search", () => {
  it("keeps short text whole and splits long text with overlap", () => {
    expect(chunkText("short note")).toEqual(["short note"]);
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} about steel rates.`).join(" ");
    const chunks = chunkText(long, 1000, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks[0]!.slice(-30)).not.toBe("");
  });

  it("starts with a facts chunk (title, date, project, decisions, figures) and adds context to every piece", () => {
    const pieces = noteChunks({
      id: "n1",
      user_id: "u1",
      project_id: null,
      kind: "call",
      title: "Steel rates call",
      summary: "Ramesh quoted a new TMT rate.",
      structured: { key_decisions: ["Order 20 MT"], figures: [{ raw_text: "₹58,000 per MT", item: "TMT Fe550D", vendor: "Sri Balaji" }] },
      transcript_text: "Ramesh: the rate is fifty eight thousand.",
      occurred_at: new Date("2026-09-12T05:00:00Z"),
      project_name: "Essence",
      contact_name: "Ramesh Kumar",
    });
    expect(pieces[0]).toContain("Steel rates call — call on 2026-09-12, project Essence, with Ramesh Kumar");
    expect(pieces[0]).toContain("Decisions: Order 20 MT");
    expect(pieces[0]).toContain("₹58,000 per MT");
    expect(pieces[1]).toContain("Steel rates call");
    expect(pieces[1]).toContain("fifty eight thousand");
  });
});

describe("chat agent", () => {
  beforeEach(() => vi.mocked(runTool).mockReset());

  it("looks something up, then answers with only the notes the tools returned", async () => {
    vi.mocked(runTool).mockResolvedValueOnce({ result: [{ note_id: NOTE, title: "Steel rates call" }], noteIds: [NOTE], actions: [] });
    const llm = new ScriptedProvider("gemini", [
      step({ action: "tool", tool: "search_notes", args: { query: "steel rate ramesh" } }),
      step({ action: "answer", answer: "Ramesh quoted ₹58,000 per MT on 12 Sep.", source_note_ids: [NOTE, OTHER] }),
    ]);
    const r = await runAgent(llm, ctx(), { question: "What did Ramesh quote for steel?", history: [], prefetch: false });
    expect(r.answer).toContain("₹58,000");
    expect(r.sources.map((s) => s.note_id)).toEqual([NOTE]); // the invented id is dropped
    expect(runTool).toHaveBeenCalledWith(expect.anything(), "search_notes", { query: "steel rate ramesh" });
    // the second call sees the tool result
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("TOOL RESULT (search_notes)");
  });

  it("collects suggested calls/tasks but never treats them as done", async () => {
    vi.mocked(runTool).mockResolvedValueOnce({
      result: { proposed: "Call Ramesh Kumar" },
      noteIds: [],
      actions: [{ id: "a1", kind: "call", status: "pending", summary: "Call Ramesh Kumar", payload: {} }],
    });
    const llm = new ScriptedProvider("gemini", [
      step({ action: "tool", tool: "propose_call", args: { contact_id: NOTE, reason: "rate" } }),
      step({ action: "answer", answer: "I've suggested calling Ramesh — please confirm below.", source_note_ids: [] }),
    ]);
    const r = await runAgent(llm, ctx(), { question: "Call Ramesh about the steel rate", history: [], prefetch: false });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.status).toBe("pending");
  });

  it("survives a failing tool and still answers", async () => {
    vi.mocked(runTool).mockRejectedValueOnce(new Error("db down"));
    const llm = new ScriptedProvider("gemini", [
      step({ action: "tool", tool: "list_tasks", args: { status: "open" } }),
      step({ action: "answer", answer: "I couldn't load your tasks just now.", source_note_ids: [] }),
    ]);
    const r = await runAgent(llm, ctx(), { question: "What's pending?", history: [], prefetch: false });
    expect(r.answer).toContain("couldn't");
    expect(JSON.stringify(llm.calls[1]!.messages)).toContain("The lookup failed");
  });

  it("stops looping after five lookups and asks for an answer", async () => {
    vi.mocked(runTool).mockResolvedValue({ result: { message: "No matching notes found." }, noteIds: [], actions: [] });
    const looping = Array.from({ length: 5 }, () => step({ action: "tool", tool: "search_notes", args: { query: "x" } }));
    const llm = new ScriptedProvider("gemini", [...looping, step({ action: "answer", answer: "Nothing found.", source_note_ids: [] })]);
    const r = await runAgent(llm, ctx(), { question: "anything?", history: [], prefetch: false });
    expect(r.answer).toBe("Nothing found.");
    expect(llm.calls).toHaveLength(6);
    expect(llm.calls[5]!.opts?.system).toContain("used all your lookups");
  });

  it("retries once when the AI's JSON is wrong, and passes chat history along", async () => {
    const llm = new ScriptedProvider("gemini", ["not json at all", step({ action: "answer", answer: "Hello!", source_note_ids: [] })]);
    const r = await runAgent(llm, ctx(), {
      prefetch: false,
      question: "and yesterday?",
      history: [
        { role: "user", text: "What's on today?" },
        { role: "assistant", text: "Two meetings." },
      ],
    });
    expect(r.answer).toBe("Hello!");
    const first = JSON.stringify(llm.calls[0]!.messages);
    expect(first).toContain("What's on today?");
    expect(first).toContain("and yesterday?");
  });

  it("searches the notes first so the AI can often answer in a single call", async () => {
    vi.mocked(runTool).mockResolvedValueOnce({ result: [{ note_id: NOTE, title: "Steel rates call" }], noteIds: [NOTE], actions: [] });
    const llm = new ScriptedProvider("gemini", [step({ action: "answer", answer: "₹58,000 per MT.", source_note_ids: [NOTE] })]);
    const r = await runAgent(llm, ctx(), { question: "What did Ramesh quote for steel?", history: [] });
    expect(llm.calls).toHaveLength(1);
    expect(runTool).toHaveBeenCalledWith(expect.anything(), "search_notes", { query: "What did Ramesh quote for steel?" });
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain("TOOL RESULT (search_notes)");
    expect(r.sources.map((s) => s.note_id)).toEqual([NOTE]);
    expect(llm.calls[0]!.opts?.tier).toBe("lite");
  });

  it("rejects steps that don't make sense", () => {
    expect(AgentStep.safeParse({ action: "tool" }).success).toBe(false);
    expect(AgentStep.safeParse({ action: "answer", answer: "  " }).success).toBe(false);
    expect(AgentStep.safeParse({ action: "tool", tool: "delete_everything" }).success).toBe(false);
    expect(AgentStep.safeParse({ action: "answer", answer: "ok" }).success).toBe(true);
  });

  it("tells the AI today's date and that calls need confirmation", () => {
    const p = systemPrompt("2026-09-29", "Asia/Kolkata");
    expect(p).toContain("2026-09-29");
    expect(p).toContain("NOTHING is dialled");
  });
});

describe("suggested actions", () => {
  it("describes each kind in one readable line", () => {
    expect(summarise("call", { name: "Ramesh Kumar", company: "Sri Balaji Steels", reason: "steel rate" })).toBe("Call Ramesh Kumar (Sri Balaji Steels) — steel rate");
    expect(summarise("calendar_event", { title: "Site review", date: "2026-10-05", start_time: "10:30", duration_min: 60 })).toBe("Add meeting “Site review” on 2026-10-05 at 10:30, 60 min");
    expect(summarise("task", { title: "Send BOQ", due_date: "2026-10-01" })).toBe("Add task “Send BOQ”, due 2026-10-01");
  });
});
