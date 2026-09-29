import { router, type Href } from "expo-router";
import { Alert, AppState, Linking } from "react-native";
import { localDb } from "@/offline/db";

/**
 * Calling from SiteMate: the phone's own dialer does the call (SiteMate never records phone calls —
 * Android blocks that). When you come back to SiteMate afterwards, it offers to add notes for the call.
 * The pending call is saved on the phone so the prompt still appears if Android closed SiteMate meanwhile.
 */
localDb.execSync(`create table if not exists kv (key text primary key, value text not null)`);

interface PendingCall {
  contactId: string;
  name: string;
  at: number;
}

const KEY = "pending_call";
const MIN_CALL_MS = 8_000; // came back too quickly = call probably not made
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

function save(p: PendingCall | null) {
  if (p) localDb.runSync("insert or replace into kv (key, value) values (?, ?)", KEY, JSON.stringify(p));
  else localDb.runSync("delete from kv where key = ?", KEY);
}

function load(): PendingCall | null {
  const row = localDb.getFirstSync<{ value: string }>("select value from kv where key = ?", KEY);
  try {
    return row ? (JSON.parse(row.value) as PendingCall) : null;
  } catch {
    return null;
  }
}

/** Always called after the user confirmed — opens the dialer with the number filled in. */
export async function dial(contact: { id: string; name: string }, phone: string) {
  const number = phone.replace(/[^\d+]/g, "");
  save({ contactId: contact.id, name: contact.name, at: Date.now() });
  await Linking.openURL(`tel:${number}`);
}

/** Asks for confirmation, then dials. */
export function confirmAndDial(contact: { id: string; name: string; company?: string | null }, phone: string) {
  Alert.alert(`Call ${contact.name}?`, [contact.company, phone].filter(Boolean).join("\n"), [
    { text: "Cancel", style: "cancel" },
    { text: "Call", onPress: () => void dial(contact, phone) },
  ]);
}

function promptForNotes() {
  const p = load();
  if (!p) return;
  const age = Date.now() - p.at;
  if (age < MIN_CALL_MS) return; // still dialling / cancelled immediately — ask on a later return
  save(null);
  if (age > MAX_AGE_MS) return;
  Alert.alert("Add notes for this call?", `Call with ${p.name}`, [
    { text: "Not now", style: "cancel" },
    { text: "Type notes", onPress: () => router.navigate({ pathname: "/record", params: { contactId: p.contactId, contactName: p.name, mode: "text_memo" } }) },
    { text: "Voice note", onPress: () => router.navigate({ pathname: "/record", params: { contactId: p.contactId, contactName: p.name, mode: "voice_memo" } }) },
  ]);
}

/** Watches for the return from the dialer. Call once after sign-in. */
export function startCallNotesPrompt() {
  const check = () => setTimeout(promptForNotes, 600);
  check(); // app may have been restarted after the call
  const sub = AppState.addEventListener("change", (s) => {
    if (s === "active") check();
  });
  return () => sub.remove();
}

/** The Contacts list screen. (Expo's generated route types list it as "/contacts/index".) */
export const CONTACTS_ROUTE = "/contacts" as Href;
