import type { ContactCandidate, ContactDto } from "@sitemate/shared";
import { z } from "zod";
import type { Sql } from "../../db/client";
import { generateValidatedJson } from "../ai/json";
import type { LlmProvider } from "../ai/types";

/** Removes the command words so only "who" remains: "Please call Ramesh from the steel vendor" → "ramesh steel vendor". */
export function cleanQuery(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ") // \p{M}: keep vowel signs of Indian scripts
    .replace(/\b(please|pls|can you|could you|i want to|i need to|call|phone|dial|ring|contact|talk to|speak to|connect me to|with|to|the|from|of|at|mr|mrs|ms|sir|madam|anna|garu|ji)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const CONTACT_COLUMNS = (db: Sql) => db`
  c.id, c.name, c.company, c.role, c.phones, c.email, c.notes, c.name_aliases, c.source,
  coalesce(array(select cp.project_id::text from contact_projects cp where cp.contact_id = c.id), '{}') as project_ids,
  coalesce(array(select p.name from contact_projects cp join projects p on p.id = cp.project_id where cp.contact_id = c.id), '{}') as project_names`;

/** Fuzzy search over name, company, role, aliases and projects. Exported for the contacts list too. */
export async function searchContacts(db: Sql, userId: string, query: string, limit = 15) {
  const q = query.toLowerCase().trim();
  const digits = q.replace(/\D/g, "");
  return db<(ContactDto & { score: number })[]>`
    select ${CONTACT_COLUMNS(db)},
      greatest(
        word_similarity(${q}, c.search_text),
        similarity(lower(c.name), ${q}),
        coalesce((select max(word_similarity(${q}, lower(p.name))) from contact_projects cp join projects p on p.id = cp.project_id where cp.contact_id = c.id), 0) * 0.8,
        case when length(${digits}) >= 4 and exists (select 1 from unnest(c.phones) ph where regexp_replace(ph, '\\D', '', 'g') like ${"%" + digits + "%"}) then 0.95 else 0 end
      )::float8 as score
    from contacts c
    where c.user_id = ${userId}
      and (c.search_text % ${q} or ${q} <% c.search_text or c.search_text ilike ${"%" + q + "%"}
           or exists (select 1 from unnest(c.phones) ph where regexp_replace(ph, '\\D', '', 'g') like ${"%" + digits + "%"} and length(${digits}) >= 4))
    order by score desc, c.name
    limit ${limit}`;
}

const AiPick = z.object({
  matches: z.array(
    z.object({
      contact_id: z.string(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});

/**
 * "Call Ramesh from the steel vendor" → ranked contacts. Fuzzy search narrows the list; the AI picks
 * using company/role/project context. Without AI (quota), falls back to the fuzzy ranking.
 * The app always asks the user to confirm before dialling.
 */
export async function resolveContact(db: Sql, llm: LlmProvider, userId: string, utterance: string): Promise<ContactCandidate[]> {
  const q = cleanQuery(utterance) || utterance.trim();
  const found = await searchContacts(db, userId, q, 15);
  if (found.length === 0) return [];

  const strip = ({ score: _s, ...c }: ContactDto & { score: number }) => c as ContactDto;
  const fuzzy = found.map((c) => ({ contact: strip(c), confidence: Math.min(1, Number(c.score.toFixed(2))), reason: "Closest name match" }));
  if (found.length === 1 || (found[0]!.score > 0.85 && found[1]!.score < 0.5)) return fuzzy.slice(0, 3);

  try {
    const list = found
      .map((c) => `${c.id} | ${c.name} | company: ${c.company ?? "-"} | role: ${c.role ?? "-"} | aliases: ${c.name_aliases.join(", ") || "-"} | projects: ${c.project_names.join(", ") || "-"}`)
      .join("\n");
    const r = await generateValidatedJson(
      llm,
      AiPick,
      [{ role: "user", parts: [{ type: "text", text: `Request: "${utterance}"\n\nContacts (id | name | details):\n${list}` }] }],
      {
        system:
          "You help a construction estimator in Bengaluru pick which contact to call. Match the request to the most likely contacts using name (spelling may vary: Suresh/Sureshji/Suresh anna), company, role (e.g. 'steel vendor', 'plumbing contractor', 'site engineer') and project. Return up to 3 matches, best first, with confidence 0–1 and a short reason. Only use ids from the list. Return an empty list if none fit.",
        tier: "lite",
        maxOutputTokens: 1000,
        temperature: 0,
      },
    );
    const byId = new Map(found.map((c) => [c.id, strip(c)]));
    const picked = r.data.matches.filter((m) => byId.has(m.contact_id)).slice(0, 3);
    if (picked.length) return picked.map((m) => ({ contact: byId.get(m.contact_id)!, confidence: m.confidence, reason: m.reason }));
  } catch {
    // AI busy → fuzzy ranking below
  }
  return fuzzy.slice(0, 3);
}
