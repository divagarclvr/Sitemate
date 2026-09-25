import type { z } from "zod";
import { AppError } from "./errors";

/** Validates request input with zod; bad input becomes a 400 the app can show. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new AppError(400, "BAD_REQUEST", `Invalid request — ${detail}`);
  }
  return r.data;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
