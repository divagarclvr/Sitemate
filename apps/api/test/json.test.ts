import { StructuredNoteSchema, type StructuredNote } from "@sitemate/shared";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import { extractJson, generateValidatedJson, toProviderSchema } from "../src/services/ai/json";
import { ScriptedProvider, userMsg } from "./helpers";

const validNote: StructuredNote = {
  title: "Steel rate discussion — Essence Tower 2",
  meeting_date: "2026-09-24",
  location: "Site office",
  participants: [
    { name: "Ramesh", role: "Sales", company: "Sri Balaji Steels", speaker_label: "Speaker B", contact_id: null },
  ],
  summary: "Vendor quoted TMT Fe550D at ₹58,500/MT ex-yard. Delivery in 3 days.",
  key_decisions: ["Place PO for 45 MT after rate approval"],
  action_items: [
    { task: "Send rate comparison to management", owner: "Me", due_date: "2026-09-26", priority: "high", source_quote: null },
  ],
  figures: [
    {
      kind: "rate",
      value: 58500,
      raw_text: "58.5 thousand per MT",
      unit: "MT",
      currency: "INR",
      item: "TMT Fe550D 12mm",
      vendor: "Sri Balaji Steels",
      project: "Essence",
      reference_no: null,
    },
  ],
  vendors_contractors: ["Sri Balaji Steels"],
  projects_mentioned: ["Essence"],
  follow_ups: [{ description: "Call Ramesh for revised rate", suggested_date: "2026-09-27", type: "call" }],
  open_questions: ["Is unloading included?"],
  languages_detected: ["en", "ta"],
  language_notes: "'kambi' = rebar",
};

describe("extractJson", () => {
  it("parses plain JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses JSON inside ```json fences", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("parses JSON surrounded by chatter", () => {
    expect(extractJson('Sure! {"a":{"b":2}} Hope this helps')).toEqual({ a: { b: 2 } });
  });
  it("throws when there is no JSON", () => {
    expect(() => extractJson("sorry, I cannot")).toThrow();
  });
});

describe("toProviderSchema", () => {
  it("produces an object schema without $schema", () => {
    const s = toProviderSchema(StructuredNoteSchema);
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe("object");
    expect(s.required).toContain("action_items");
  });
});

describe("generateValidatedJson", () => {
  it("returns data on the first valid reply and sends the JSON schema", async () => {
    const ai = new ScriptedProvider("fake", [JSON.stringify(validNote)]);
    const res = await generateValidatedJson(ai, StructuredNoteSchema, userMsg("transcript"));
    expect(res.attempts).toBe(1);
    expect(res.data.figures[0]!.value).toBe(58500);
    expect(ai.calls[0]!.opts?.jsonSchema).toBeDefined();
  });

  it("retries once with the validation errors when the schema doesn't match", async () => {
    const bad = { ...validNote, action_items: [{ task: "x", priority: "urgent" }] };
    const ai = new ScriptedProvider("fake", [JSON.stringify(bad), JSON.stringify(validNote)]);
    const res = await generateValidatedJson(ai, StructuredNoteSchema, userMsg("transcript"));
    expect(res.attempts).toBe(2);
    const retryText = ai.calls[1]!.messages.at(-1)!.parts[0];
    expect(retryText).toMatchObject({ type: "text" });
    expect((retryText as { text: string }).text).toContain("action_items.0.priority");
  });

  it("retries once when the reply is not JSON at all", async () => {
    const ai = new ScriptedProvider("fake", ["I think the meeting was about steel.", JSON.stringify(validNote)]);
    const res = await generateValidatedJson(ai, StructuredNoteSchema, userMsg("transcript"));
    expect(res.attempts).toBe(2);
  });

  it("gives up after two bad replies with a user-friendly error", async () => {
    const ai = new ScriptedProvider("fake", ["nope", "{}"]);
    await expect(generateValidatedJson(ai, StructuredNoteSchema, userMsg("t"))).rejects.toSatisfy(
      (e) => e instanceof AppError && e.code === "AI_INVALID_JSON" && !!e.hint,
    );
    expect(ai.calls).toHaveLength(2);
  });

  it("rejects wrong language codes", async () => {
    const bad = { ...validNote, languages_detected: ["tamil"] };
    const ai = new ScriptedProvider("fake", [JSON.stringify(bad), JSON.stringify(bad)]);
    await expect(generateValidatedJson(ai, StructuredNoteSchema, userMsg("t"))).rejects.toBeInstanceOf(AppError);
  });
});
