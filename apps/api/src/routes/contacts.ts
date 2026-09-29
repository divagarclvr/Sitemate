import type { FastifyInstance } from "fastify";
import {
  ContactInput,
  ImportContactsBody,
  ResolveContactBody,
  TranscribeBody,
  UpdateContactBody,
  type ContactDetail,
  type ContactDto,
  type ResolveContactResponse,
} from "@sitemate/shared";
import { z } from "zod";
import type { Sql } from "../db/client";
import { AppError } from "../errors";
import type { LlmProvider } from "../services/ai/types";
import { CONTACT_COLUMNS, resolveContact, searchContacts } from "../services/contacts/resolve";
import { cleanAudio } from "../services/stt/chunker";
import type { SttProvider } from "../services/stt/types";
import { isUuid, parse } from "../validate";

export function contactsRoutes({ db, llm, stt }: { db: Sql; llm: LlmProvider; stt: SttProvider }) {
  const ownContact = async (userId: string, id: string) => {
    if (!isUuid(id)) throw new AppError(404, "CONTACT_NOT_FOUND", "Contact not found.");
    const [c] = await db<ContactDto[]>`select ${CONTACT_COLUMNS(db)} from contacts c where c.id = ${id} and c.user_id = ${userId}`;
    if (!c) throw new AppError(404, "CONTACT_NOT_FOUND", "Contact not found.");
    return c;
  };

  const setProjects = async (userId: string, contactId: string, projectIds: string[]) => {
    await db`delete from contact_projects where contact_id = ${contactId}`;
    if (projectIds.length) {
      await db`insert into contact_projects ${db(projectIds.map((p) => ({ user_id: userId, contact_id: contactId, project_id: p })))}
               on conflict do nothing`;
    }
  };

  return async (app: FastifyInstance) => {
    app.get("/v1/contacts", async (req): Promise<ContactDto[]> => {
      const q = parse(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
      const userId = req.user!.id;
      if (q.q?.trim()) {
        const rows = await searchContacts(db, userId, q.q, Math.min(q.limit, 50));
        return rows.map(({ score: _s, ...c }) => c as ContactDto);
      }
      return db<ContactDto[]>`select ${CONTACT_COLUMNS(db)} from contacts c where c.user_id = ${userId} order by lower(c.name) limit ${q.limit}`;
    });

    app.get<{ Params: { id: string } }>("/v1/contacts/:id", async (req): Promise<ContactDetail> => {
      const userId = req.user!.id;
      const c = await ownContact(userId, req.params.id);
      const [notes_list, open_tasks] = await Promise.all([
        db`select distinct n.id, n.kind, n.title, n.status, n.started_at from notes n
           left join note_contacts nc on nc.note_id = n.id
           where n.user_id = ${userId} and n.deleted_at is null and (n.contact_id = ${c.id} or nc.contact_id = ${c.id})
           order by n.started_at desc nulls last limit 30`,
        db`select id, title, to_char(due_date, 'YYYY-MM-DD') as due_date, note_id from tasks
           where user_id = ${userId} and owner_contact_id = ${c.id} and status = 'open' order by due_date nulls last limit 30`,
      ]);
      return { ...c, notes_list, open_tasks } as unknown as ContactDetail;
    });

    app.post("/v1/contacts", async (req): Promise<ContactDto> => {
      const b = parse(ContactInput, req.body);
      const userId = req.user!.id;
      const [row] = await db<{ id: string }[]>`
        insert into contacts (user_id, name, company, role, phones, email, notes, name_aliases, source)
        values (${userId}, ${b.name}, ${b.company ?? null}, ${b.role ?? null}, ${b.phones}, ${b.email ?? null}, ${b.notes ?? null}, ${b.name_aliases}, 'manual')
        returning id`;
      await setProjects(userId, row!.id, b.project_ids);
      return ownContact(userId, row!.id);
    });

    app.patch<{ Params: { id: string } }>("/v1/contacts/:id", async (req): Promise<ContactDto> => {
      const userId = req.user!.id;
      const c = await ownContact(userId, req.params.id);
      const b = parse(UpdateContactBody, req.body);
      await db`
        update contacts set
          name = ${b.name ?? c.name},
          company = ${b.company === undefined ? c.company : b.company},
          role = ${b.role === undefined ? c.role : b.role},
          phones = ${b.phones ?? c.phones},
          email = ${b.email === undefined ? c.email : b.email},
          notes = ${b.notes === undefined ? c.notes : b.notes},
          name_aliases = ${b.name_aliases ?? c.name_aliases}
        where id = ${c.id}`;
      if (b.project_ids) await setProjects(userId, c.id, b.project_ids);
      return ownContact(userId, c.id);
    });

    app.delete<{ Params: { id: string } }>("/v1/contacts/:id", async (req) => {
      const userId = req.user!.id;
      const c = await ownContact(userId, req.params.id);
      await db`delete from contacts where id = ${c.id}`;
      await db`insert into audit_log (user_id, action, entity, entity_id) values (${userId}, 'delete_contact', 'contact', ${c.id})`;
      return { ok: true };
    });

    /** Phone contacts → SiteMate (only name, company, job title, numbers). Safe to repeat. */
    app.post("/v1/contacts/import", { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
      const b = parse(ImportContactsBody, req.body);
      const userId = req.user!.id;
      const rows = b.contacts.filter((c) => c.phones.length > 0);
      let created = 0;
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200).map((c) => ({
          user_id: userId,
          device_contact_id: c.device_contact_id,
          name: c.name,
          company: c.company ?? null,
          role: c.role ?? null,
          phones: c.phones,
          source: "phone",
        }));
        const r = await db<{ inserted: boolean }[]>`
          insert into contacts ${db(batch)}
          on conflict (user_id, device_contact_id) where device_contact_id is not null
          do update set
            -- keep your own edits: only fill what's empty, always refresh numbers
            name = case when contacts.source = 'phone' then excluded.name else contacts.name end,
            company = coalesce(contacts.company, excluded.company),
            role = coalesce(contacts.role, excluded.role),
            phones = excluded.phones
          returning (xmax = 0) as inserted`;
        created += r.filter((x) => x.inserted).length;
      }
      return { received: b.contacts.length, with_numbers: rows.length, created, updated: rows.length - created };
    });

    app.post("/v1/contacts/resolve", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req): Promise<ResolveContactResponse> => {
      const b = parse(ResolveContactBody, req.body);
      return { query: b.utterance, candidates: await resolveContact(db, llm, req.user!.id, b.utterance) };
    });

    /** Short voice command/question → text (used by "Say who to call" and later by Chat). */
    app.post(
      "/v1/voice/transcribe",
      { bodyLimit: 4 * 1024 * 1024, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req) => {
        const b = parse(TranscribeBody, req.body);
        const audio = Buffer.from(b.audio_base64, "base64");
        const ext = b.mime.includes("ogg") ? ".ogg" : b.mime.includes("wav") ? ".wav" : ".m4a";
        const cleaned = await cleanAudio(audio, `voice${ext}`);
        const r = await stt.transcribe(cleaned.data, cleaned.filename, b.language_hint);
        const text = r.segments.map((s) => s.text).join(" ").trim();
        if (!text) throw new AppError(422, "NO_SPEECH", "I didn't catch that.", "Hold the phone closer and speak clearly, then try again.");
        return { text, language: r.language };
      },
    );
  };
}
