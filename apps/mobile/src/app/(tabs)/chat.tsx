import type { ChatMessageDto, ChatReply, ChatThreadDto, ConfirmResult, PendingActionDto } from "@sitemate/shared";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSpeechInput } from "@/audio/speechInput";
import { BigButton, Body, ErrorBox } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { dial } from "@/lib/calls";
import { todayKey } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";

const SUGGESTIONS = [
  "What's pending for me today?",
  "Summarise my last meeting",
  "What rates did vendors quote for steel?",
  "What did we agree on the last call?",
];

/** Kept while the app is open, so leaving the Chat tab and coming back keeps the conversation. */
let activeThread: string | null = null;
let activeMessages: ChatMessageDto[] = [];

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function ActionCard({ action, onDone }: { action: PendingActionDto; onDone: (status: PendingActionDto["status"]) => void }) {
  const t = useTheme();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contact = action.payload as { contact_id?: string; name?: string; phones?: string[] };

  const confirm = async (phone?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ConfirmResult>(`/v1/pending-actions/${action.id}/confirm`, { method: "POST", body: "{}" });
      onDone("confirmed");
      void qc.invalidateQueries({ queryKey: todayKey });
      if (r.dial) await dial({ id: r.dial.contact_id, name: r.dial.name }, phone ?? r.dial.phones[0]!);
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : String(e));
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    setBusy(true);
    try {
      await api(`/v1/pending-actions/${action.id}/reject`, { method: "POST", body: "{}" });
      onDone("rejected");
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const border = action.status === "pending" ? t.primary : t.border;
  return (
    <View style={[styles.action, { borderColor: border, backgroundColor: t.card }]}>
      <Text style={{ color: t.text, fontSize: sizes.font, fontWeight: "700" }}>
        {action.kind === "call" ? "📞 " : action.kind === "calendar_event" ? "📅 " : "☐ "}
        {action.summary}
      </Text>
      {action.status === "pending" ? (
        <>
          {action.kind === "call" ? (
            (contact.phones ?? []).map((ph) => <BigButton key={ph} label={`Call ${ph}`} loading={busy} onPress={() => void confirm(ph)} />)
          ) : (
            <BigButton label="Confirm" loading={busy} onPress={() => void confirm()} />
          )}
          <BigButton label="No thanks" variant="secondary" disabled={busy} onPress={() => void reject()} />
        </>
      ) : (
        <Text style={{ color: t.muted, fontSize: 15 }}>
          {action.status === "confirmed" ? (action.kind === "call" ? "✔ Opened the dialer" : "✔ Done") : action.status === "rejected" ? "Dismissed" : "Expired — ask again"}
        </Text>
      )}
      {error && <Text style={{ color: t.danger, fontSize: 15 }}>{error}</Text>}
    </View>
  );
}

function Bubble({ m, onAction }: { m: ChatMessageDto; onAction: (actionId: string, status: PendingActionDto["status"]) => void }) {
  const t = useTheme();
  const mine = m.role === "user";
  return (
    <View style={{ alignItems: mine ? "flex-end" : "flex-start", gap: 8 }}>
      <View style={[styles.bubble, { backgroundColor: mine ? t.primary : t.card, borderColor: mine ? t.primary : t.border }]}>
        <Text selectable style={{ color: mine ? t.onPrimary : t.text, fontSize: sizes.font, lineHeight: sizes.font * 1.4 }}>
          {m.text}
        </Text>
      </View>
      {m.sources.length > 0 && (
        <View style={{ gap: 6, maxWidth: "94%" }}>
          <Text style={{ color: t.muted, fontSize: 13 }}>Based on</Text>
          {m.sources.map((s) => (
            <Pressable
              key={s.note_id}
              onPress={() => router.push({ pathname: "/note/[id]", params: { id: s.note_id } })}
              style={[styles.source, { borderColor: t.border, backgroundColor: t.card }]}
            >
              <Text style={{ color: t.primary, fontSize: 15, fontWeight: "600" }} numberOfLines={2}>
                📄 {s.title ?? "Note"} · {shortDate(s.date)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {m.actions.map((a) => (
        <ActionCard key={a.id} action={a} onDone={(status) => onAction(a.id, status)} />
      ))}
    </View>
  );
}

export default function ChatScreen() {
  const t = useTheme();
  const [threadId, setThreadId] = useState<string | null>(activeThread);
  const [messages, setMessages] = useState<ChatMessageDto[]>(activeMessages);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [history, setHistory] = useState<ChatThreadDto[] | null>(null);
  const scroller = useRef<ScrollView>(null);

  const speech = useSpeechInput(
    (spoken) => setText((cur) => (cur ? `${cur} ${spoken}` : spoken)),
    (message, hint) => setError({ message, hint }),
  );

  useEffect(() => {
    activeThread = threadId;
    activeMessages = messages;
  }, [threadId, messages]);

  const fail = (e: unknown) => setError(e instanceof ApiRequestError ? { message: e.message, hint: e.hint } : { message: String(e) });

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || sending) return;
    setError(null);
    setText("");
    setSending(true);
    const mine: ChatMessageDto = { id: `local-${Date.now()}`, role: "user", text: message, created_at: new Date().toISOString(), sources: [], actions: [] };
    setMessages((cur) => [...cur, mine]);
    try {
      let id = threadId;
      if (!id) {
        id = (await api<ChatThreadDto>("/v1/chat/threads", { method: "POST", body: "{}" })).id;
        setThreadId(id);
      }
      const r = await api<ChatReply>(`/v1/chat/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ message }) });
      setMessages((cur) => [...cur, r.message]);
    } catch (e) {
      fail(e);
      setText(message); // keep what was typed so it can be sent again
      setMessages((cur) => cur.filter((m) => m.id !== mine.id));
    } finally {
      setSending(false);
    }
  };

  const newChat = () => {
    setThreadId(null);
    setMessages([]);
    setError(null);
    setHistory(null);
  };

  const openHistory = async () => {
    if (history) return setHistory(null);
    try {
      setHistory(await api<ChatThreadDto[]>("/v1/chat/threads"));
    } catch (e) {
      fail(e);
    }
  };

  const openThread = async (id: string) => {
    try {
      const r = await api<{ messages: ChatMessageDto[] }>(`/v1/chat/threads/${id}`);
      setThreadId(id);
      setMessages(r.messages);
      setHistory(null);
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const setActionStatus = (actionId: string, status: PendingActionDto["status"]) =>
    setMessages((cur) => cur.map((m) => ({ ...m, actions: m.actions.map((a) => (a.id === actionId ? { ...a, status } : a)) })));

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View style={styles.header}>
          <Text style={{ color: t.text, fontSize: sizes.fontLarge + 4, fontWeight: "800", flex: 1 }}>Chat</Text>
          <Pressable onPress={() => void openHistory()} style={[styles.pill, { borderColor: t.border, backgroundColor: t.card }]}>
            <Text style={{ color: t.text, fontWeight: "600" }}>History</Text>
          </Pressable>
          <Pressable onPress={newChat} style={[styles.pill, { borderColor: t.border, backgroundColor: t.card }]}>
            <Text style={{ color: t.text, fontWeight: "600" }}>＋ New</Text>
          </Pressable>
        </View>

        <ScrollView
          ref={scroller}
          contentContainerStyle={{ padding: sizes.gap, gap: 16, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
        >
          {history && (
            <View style={{ gap: 8 }}>
              <Body muted>Earlier chats</Body>
              {history.length === 0 && <Body muted>No earlier chats.</Body>}
              {history.map((h) => (
                <Pressable key={h.id} onPress={() => void openThread(h.id)} style={[styles.source, { borderColor: t.border, backgroundColor: t.card }]}>
                  <Text style={{ color: t.text, fontSize: sizes.font }} numberOfLines={1}>
                    {h.title ?? "Chat"}
                  </Text>
                  <Text style={{ color: t.muted, fontSize: 13 }}>{new Date(h.updated_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {messages.length === 0 && !history && (
            <View style={{ gap: 10 }}>
              <Body>Ask about your meetings, calls, files, tasks and contacts — by typing or tapping 🎤. You can use English, Tamil, Kannada, Telugu, Malayalam or Hindi.</Body>
              <Body muted>Try:</Body>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => void send(s)} style={[styles.source, { borderColor: t.primary, backgroundColor: t.card }]}>
                  <Text style={{ color: t.primary, fontSize: sizes.font, fontWeight: "600" }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {messages.map((m) => (
            <Bubble key={m.id} m={m} onAction={setActionStatus} />
          ))}
          {sending && (
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              <ActivityIndicator color={t.primary} />
              <Body muted>Looking through your notes…</Body>
            </View>
          )}
          {error && <ErrorBox message={error.message} hint={error.hint} />}
        </ScrollView>

        <View style={[styles.inputRow, { borderTopColor: t.border, backgroundColor: t.bg }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={speech.listening ? "Listening… tap ■ when done" : "Ask anything about your work"}
            placeholderTextColor={t.muted}
            multiline
            style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
          />
          <Pressable
            onPress={speech.toggle}
            disabled={speech.transcribing || sending}
            accessibilityRole="button"
            accessibilityLabel={speech.listening ? "Stop listening" : "Speak your question"}
            style={[styles.round, { backgroundColor: speech.listening ? t.danger : t.card, borderColor: t.border, opacity: speech.transcribing ? 0.5 : 1 }]}
          >
            {speech.transcribing ? <ActivityIndicator color={t.primary} /> : <Text style={{ fontSize: 24, color: speech.listening ? "#fff" : t.text }}>{speech.listening ? "■" : "🎤"}</Text>}
          </Pressable>
          <Pressable
            onPress={() => void send(text)}
            disabled={!text.trim() || sending}
            accessibilityRole="button"
            accessibilityLabel="Send"
            style={[styles.round, { backgroundColor: t.primary, borderColor: t.primary, opacity: !text.trim() || sending ? 0.4 : 1 }]}
          >
            <Text style={{ fontSize: 24, color: t.onPrimary }}>➤</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: sizes.gap, paddingTop: sizes.gap, paddingBottom: 4 },
  pill: { minHeight: 40, paddingHorizontal: 14, borderWidth: 1, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  bubble: { maxWidth: "94%", borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, paddingVertical: 10 },
  source: { borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 12, paddingVertical: 10 },
  action: { borderWidth: 2, borderRadius: sizes.radius, padding: 12, gap: 8, alignSelf: "stretch" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: 1 },
  input: { flex: 1, minHeight: sizes.tap, maxHeight: 130, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, fontSize: sizes.font },
  round: { width: sizes.tap, height: sizes.tap, borderRadius: sizes.tap / 2, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
