import { z } from "zod";
import { AppError } from "../../errors";
import type { GenerateOptions, LlmMessage, LlmProvider, LlmResult } from "./types";

/** JSON Schema for the provider, without keys some providers reject. */
export function toProviderSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  return rest;
}

/** Extracts a JSON value from model text, tolerating ```json fences and chatter around it. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError("No JSON object found in the reply");
  }
}

export interface ValidatedJson<T> {
  data: T;
  attempts: number;
  results: LlmResult[];
}

/**
 * Asks the AI for JSON matching `schema`, validates it with zod, and retries ONCE
 * (sending the validation errors back) if the first reply is invalid.
 */
export async function generateValidatedJson<S extends z.ZodType>(
  provider: LlmProvider,
  schema: S,
  messages: LlmMessage[],
  opts: GenerateOptions = {},
): Promise<ValidatedJson<z.infer<S>>> {
  const jsonSchema = toProviderSchema(schema);
  const results: LlmResult[] = [];
  let convo = messages;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await provider.generate(convo, { ...opts, jsonSchema });
    results.push(result);

    let parsed: unknown;
    try {
      parsed = extractJson(result.text);
    } catch (e) {
      convo = retryConvo(messages, result.text, `Your reply was not valid JSON (${(e as Error).message}).`);
      continue;
    }

    const check = schema.safeParse(parsed);
    if (check.success) return { data: check.data, attempts: attempt, results };

    const problem =
      "Your JSON did not match the required schema:\n" +
      check.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    convo = retryConvo(messages, result.text, problem);
  }

  throw new AppError(
    502,
    "AI_INVALID_JSON",
    "The AI returned its answer in the wrong format twice.",
    "Tap Retry. If it keeps failing, edit the text to make it clearer and re-summarise.",
  );
}

function retryConvo(original: LlmMessage[], badReply: string, problem: string): LlmMessage[] {
  return [
    ...original,
    { role: "assistant", parts: [{ type: "text", text: badReply.slice(0, 20_000) }] },
    { role: "user", parts: [{ type: "text", text: `${problem}\nReturn the corrected JSON only.` }] },
  ];
}
