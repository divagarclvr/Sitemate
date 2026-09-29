import { z } from "zod";

export const SendChatBody = z.object({ message: z.string().trim().min(1).max(2000) });

export interface ChatSource {
  note_id: string;
  title: string | null;
  kind: string;
  date: string;
  snippet: string;
}

export type PendingActionKind = "call" | "calendar_event" | "task" | "reminder";

export interface PendingActionDto {
  id: string;
  kind: PendingActionKind;
  status: "pending" | "confirmed" | "rejected" | "expired";
  /** One readable line, e.g. "Call Ramesh Kumar (Sri Balaji Steels)". */
  summary: string;
  payload: Record<string, unknown>;
}

export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  sources: ChatSource[];
  actions: PendingActionDto[];
}

export interface ChatThreadDto {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface ChatReply {
  thread_id: string;
  message: ChatMessageDto;
}

export interface ConfirmResult {
  ok: true;
  kind: PendingActionKind;
  /** For calls: the app now opens the dialer with one of these numbers. */
  dial?: { contact_id: string; name: string; phones: string[] };
  created?: "task" | "event";
}

export interface SearchHitDto {
  note_id: string;
  title: string | null;
  kind: string;
  date: string;
  project: string | null;
  snippet: string;
}
