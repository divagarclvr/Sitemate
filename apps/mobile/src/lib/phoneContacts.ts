import { Contact, ContactField, requestPermissionsAsync } from "expo-contacts";
import { api } from "./api";

export interface ImportResult {
  received: number;
  with_numbers: number;
  created: number;
  updated: number;
}

/**
 * Copies phone contacts into SiteMate: only name, company, job title and phone numbers.
 * Safe to run again — existing contacts are updated, your own edits are kept.
 */
export async function importPhoneContacts(onProgress?: (done: number) => void): Promise<ImportResult | "denied"> {
  const perm = await requestPermissionsAsync();
  if (perm.status !== "granted") return "denied";

  const fields = [ContactField.FULL_NAME, ContactField.COMPANY, ContactField.JOB_TITLE, ContactField.PHONES] as const;
  const all: { device_contact_id: string; name: string; company: string | null; role: string | null; phones: string[] }[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await Contact.getAllDetails(fields, { limit: pageSize, offset });
    for (const c of page) {
      const phones = [...new Set((c.phones ?? []).map((p) => (p.number ?? "").trim()).filter((n) => n.replace(/\D/g, "").length >= 5))];
      const name = (c.fullName ?? "").trim();
      if (!name || phones.length === 0) continue;
      all.push({ device_contact_id: c.id, name: name.slice(0, 120), company: c.company?.trim() || null, role: c.jobTitle?.trim() || null, phones: phones.slice(0, 10) });
    }
    onProgress?.(all.length);
    if (page.length < pageSize) break;
  }

  const total: ImportResult = { received: 0, with_numbers: 0, created: 0, updated: 0 };
  for (let i = 0; i < all.length; i += 500) {
    const r = await api<ImportResult>("/v1/contacts/import", { method: "POST", body: JSON.stringify({ contacts: all.slice(i, i + 500) }) });
    total.received += r.received;
    total.with_numbers += r.with_numbers;
    total.created += r.created;
    total.updated += r.updated;
  }
  return total;
}
