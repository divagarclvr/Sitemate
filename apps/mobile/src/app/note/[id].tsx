import { IN_PROGRESS, type FigureDto, type FileDto, type NoteDetail, type NoteRef, type TaskDto, type TranscriptSegmentDto } from "@sitemate/shared";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Chip, StatusBadge } from "@/components/pickers";
import { BigButton, Body, Card, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { formatDuration } from "@/audio/recording";
import { api, ApiRequestError } from "@/lib/api";
import { describeSize, fileIcon } from "@/offline/incoming";
import { useNote, useNoteAction } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";

type Tab = "summary" | "actions" | "figures" | "transcript";

const inr = (v: number) => "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const note = useNote(id);
  const [tab, setTab] = useState<Tab>("summary");
  const [editTitle, setEditTitle] = useState<string | null>(null);

  const patch = useNoteAction(id, (body: object) => api(`/v1/notes/${id}`, { method: "PATCH", body: JSON.stringify(body) }));
  const retry = useNoteAction(id, () => api(`/v1/notes/${id}/retry`, { method: "POST", body: "{}" }));
  const resummarise = useNoteAction(id, () => api(`/v1/notes/${id}/resummarise`, { method: "POST", body: "{}" }));

  if (note.isLoading) return <Screen><Body muted>Loading…</Body></Screen>;
  if (note.error || !note.data) {
    const e = note.error;
    return (
      <Screen>
        <BackButton />
        <ErrorBox message={e?.message ?? "Note not found"} hint={e instanceof ApiRequestError ? e.hint : undefined} />
      </Screen>
    );
  }
  const n = note.data;
  const working = IN_PROGRESS.includes(n.status);

  return (
    <Screen>
      <BackButton />
      <Pressable onPress={() => setEditTitle(n.title ?? "")} accessibilityHint="Tap to edit the title">
        <Title>{n.title ?? "Processing…"} ✎</Title>
      </Pressable>
      <View style={styles.rowWrap}>
        <StatusBadge status={n.status} />
        {n.project_name && <Text style={{ color: t.primary, fontWeight: "700", fontSize: 16 }}>{n.project_name}</Text>}
        <Text style={{ color: t.muted, fontSize: 15 }}>
          {n.started_at ? new Date(n.started_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : ""}
          {n.duration_sec ? ` · ${formatDuration(n.duration_sec * 1000)}` : ""}
        </Text>
      </View>

      {working && (
        <Card>
          <Body>{n.progress_text ?? "Working on it…"}</Body>
          <Body muted>You can leave this screen — the note keeps processing on the server.</Body>
        </Card>
      )}
      {n.status === "failed" && (
        <>
          <ErrorBox message={n.error_message ?? "Processing failed."} hint={n.error_hint ?? undefined} />
          <BigButton label="Retry" onPress={() => retry.mutate(undefined)} loading={retry.isPending} />
        </>
      )}

      {n.has_audio && <AudioPlayerCard noteId={id} />}
      {n.files.length > 0 && <FilesCard files={n.files} />}
      {n.related_note && <NoteLinks title="Attached to meeting" notes={[n.related_note]} />}
      {n.attachments.length > 0 && <NoteLinks title="Files attached to this meeting" notes={n.attachments} />}

      <View style={styles.rowWrap}>
        {(["summary", "actions", "figures", "transcript"] as Tab[]).map((k) => (
          <Chip
            key={k}
            selected={tab === k}
            onPress={() => setTab(k)}
            label={
              k === "summary"
                ? "Summary"
                : k === "actions"
                  ? `Actions (${n.tasks.filter((x) => x.status === "open").length})`
                  : k === "figures"
                    ? `Figures (${n.figures.length})`
                    : n.kind === "file" || n.kind === "chat_export"
                      ? "Content"
                      : "Transcript"
            }
          />
        ))}
      </View>

      {tab === "summary" && <SummaryTab n={n} />}
      {tab === "actions" && <ActionsTab noteId={id} tasks={n.tasks} />}
      {tab === "figures" && <FiguresTab figures={n.figures} />}
      {tab === "transcript" && <TranscriptTab noteId={id} segments={n.segments} onResummarise={() => resummarise.mutate(undefined)} resummarising={resummarise.isPending || working} />}

      <DangerZone n={n} />

      <EditModal
        visible={editTitle !== null}
        title="Edit title"
        initial={editTitle ?? ""}
        onCancel={() => setEditTitle(null)}
        onSave={(title) => {
          patch.mutate({ title });
          setEditTitle(null);
        }}
      />
    </Screen>
  );
}

function BackButton() {
  return <BigButton label="‹ Back to notes" variant="secondary" onPress={() => (router.canGoBack() ? router.back() : router.navigate("/notes"))} />;
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <Card>
      <Body muted>{title}</Body>
      {items.map((x, i) => (
        <Body key={i}>• {x}</Body>
      ))}
    </Card>
  );
}

function SummaryTab({ n }: { n: NoteDetail }) {
  const s = n.structured;
  if (!s) return <Body muted>The summary will appear here when processing finishes.</Body>;
  return (
    <>
      <Card>
        <Body muted>Summary</Body>
        <Body>{n.summary ?? s.summary}</Body>
      </Card>
      <Section title="Key decisions" items={s.key_decisions} />
      <Section
        title="Follow-ups"
        items={n.follow_ups.map((f) => `${f.description}${f.suggested_start ? ` — ${new Date(f.suggested_start).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}`)}
      />
      <Section title="Open questions" items={s.open_questions} />
      <Section title="People" items={s.participants.map((p) => [p.name, p.role, p.company].filter(Boolean).join(" · "))} />
      <Section title="Vendors / contractors" items={s.vendors_contractors} />
      {s.language_notes && <Section title="Language notes" items={[s.language_notes]} />}
    </>
  );
}

function ActionsTab({ noteId, tasks }: { noteId: string; tasks: TaskDto[] }) {
  const t = useTheme();
  const toggle = useNoteAction(noteId, (task: TaskDto) =>
    api(`/v1/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ status: task.status === "done" ? "open" : "done" }) }),
  );
  if (!tasks.length) return <Body muted>No action items in this note.</Body>;
  return (
    <>
      {tasks.map((task) => (
        <Pressable
          key={task.id}
          onPress={() => toggle.mutate(task)}
          style={[styles.task, { borderColor: t.border, backgroundColor: t.card }]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: task.status === "done" }}
        >
          <Text style={{ fontSize: 26, color: task.status === "done" ? t.success : t.muted }}>{task.status === "done" ? "☑" : "☐"}</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: t.text, fontSize: sizes.font, textDecorationLine: task.status === "done" ? "line-through" : "none" }}>{task.title}</Text>
            <Text style={{ color: task.priority === "high" ? t.danger : t.muted, fontSize: 14 }}>
              {[task.owner_text && `Owner: ${task.owner_text}`, task.due_date && `Due ${new Date(task.due_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`, `${task.priority} priority`]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          </View>
        </Pressable>
      ))}
    </>
  );
}

function FiguresTab({ figures }: { figures: FigureDto[] }) {
  const t = useTheme();
  if (!figures.length) return <Body muted>No amounts, rates or quantities were mentioned.</Body>;
  return (
    <>
      {figures.map((f) => (
        <Card key={f.id}>
          <Text style={{ color: t.text, fontSize: sizes.fontLarge, fontWeight: "800" }}>
            {f.value != null ? (f.currency === "INR" ? inr(f.value) : f.value.toLocaleString("en-IN")) : f.raw_text}
            {f.unit ? <Text style={{ fontSize: sizes.font, color: t.muted }}>{f.currency === "INR" ? ` / ${f.unit}` : ` ${f.unit}`}</Text> : null}
          </Text>
          <Body>{[f.item, f.vendor_text].filter(Boolean).join(" · ") || f.kind}</Body>
          <Body muted>
            “{f.raw_text}”{f.reference_no ? ` · Ref ${f.reference_no}` : ""}
          </Body>
        </Card>
      ))}
    </>
  );
}

function TranscriptTab(props: { noteId: string; segments: TranscriptSegmentDto[]; onResummarise: () => void; resummarising: boolean }) {
  const t = useTheme();
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<TranscriptSegmentDto | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const saveSegment = useNoteAction(props.noteId, (v: { id: string; text: string }) =>
    api(`/v1/notes/${props.noteId}/segments/${v.id}`, { method: "PATCH", body: JSON.stringify({ text: v.text }) }),
  );
  const rename = useNoteAction(props.noteId, (v: { from: string; to: string }) =>
    api(`/v1/notes/${props.noteId}/rename-speaker`, { method: "POST", body: JSON.stringify(v) }),
  );

  if (!props.segments.length) return <Body muted>The transcript will appear here after transcription.</Body>;
  const shown = q ? props.segments.filter((s) => s.text.toLowerCase().includes(q.toLowerCase())) : props.segments;

  return (
    <>
      <TextInput
        value={q}
        onChangeText={setQ}
        placeholder="Search the transcript"
        placeholderTextColor={t.muted}
        style={[styles.search, { color: t.text, borderColor: t.border, backgroundColor: t.card }]}
      />
      <Body muted>Tap a line to correct it. Tap a speaker name to rename that speaker everywhere.</Body>
      {(edited || props.segments.some((s) => s.edited)) && (
        <BigButton label="Update summary from edited transcript" onPress={props.onResummarise} loading={props.resummarising} />
      )}
      {shown.map((s) => (
        <View key={s.id} style={[styles.segment, { borderColor: t.border, backgroundColor: t.card }]}>
          <View style={styles.rowBetween}>
            {s.speaker_label ? (
              <Pressable onPress={() => setRenaming(s.speaker_label)}>
                <Text style={{ color: t.primary, fontWeight: "700", fontSize: 15 }}>{s.speaker_label} ✎</Text>
              </Pressable>
            ) : <View />}
            {s.start_ms != null && <Text style={{ color: t.muted, fontSize: 13 }}>{formatDuration(s.start_ms)}</Text>}
          </View>
          <Pressable onPress={() => setEditing(s)}>
            <Text style={{ color: t.text, fontSize: sizes.font, lineHeight: sizes.font * 1.45 }}>{s.text}</Text>
            {s.gloss && <Text style={{ color: t.muted, fontSize: 15, fontStyle: "italic" }}>[{s.gloss}]</Text>}
          </Pressable>
        </View>
      ))}

      <EditModal
        visible={!!editing}
        title="Correct this line"
        multiline
        initial={editing?.text ?? ""}
        onCancel={() => setEditing(null)}
        onSave={(text) => {
          if (editing) saveSegment.mutate({ id: editing.id, text });
          setEditing(null);
          setEdited(true);
        }}
      />
      <EditModal
        visible={!!renaming}
        title={`Who is ${renaming}?`}
        initial=""
        placeholder="e.g. Ramesh (Balaji Steels)"
        onCancel={() => setRenaming(null)}
        onSave={(to) => {
          if (renaming) rename.mutate({ from: renaming, to });
          setRenaming(null);
          setEdited(true);
        }}
      />
    </>
  );
}

function AudioPlayerCard({ noteId }: { noteId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const player = useAudioPlayer(url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);

  const load = async () => {
    try {
      const r = await api<{ url: string }>(`/v1/notes/${noteId}/audio-url`);
      setUrl(r.url);
      setTimeout(() => player.play(), 300);
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <Card>
      <View style={styles.rowBetween}>
        <Body muted>Recording</Body>
        {status.duration > 0 && (
          <Body muted>
            {formatDuration(status.currentTime * 1000)} / {formatDuration(status.duration * 1000)}
          </Body>
        )}
      </View>
      {err && <Body muted>{err}</Body>}
      <BigButton
        variant="secondary"
        label={!url ? "▶ Play recording" : status.playing ? "⏸ Pause" : "▶ Play"}
        onPress={() => (!url ? load() : status.playing ? player.pause() : player.play())}
      />
    </Card>
  );
}

function FilesCard({ files }: { files: FileDto[] }) {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const link = (f: FileDto) => api<{ url: string; file_name: string; mime: string | null }>(`/v1/files/${f.id}/download-url`);

  const open = async (f: FileDto) => {
    setErr(null);
    setBusy(f.id + "open");
    try {
      await Linking.openURL((await link(f)).url);
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Downloads the original, then opens Android's share sheet (WhatsApp, Gmail…). */
  const share = async (f: FileDto) => {
    setErr(null);
    setBusy(f.id + "share");
    try {
      const { url, file_name, mime } = await link(f);
      const dir = new Directory(Paths.cache, "shared");
      if (!dir.exists) dir.create({ intermediates: true });
      const dest = new File(dir, file_name.replace(/[\/:*?"<>|]/g, "_"));
      if (dest.exists) dest.delete();
      const saved = await File.downloadFileAsync(url, dest);
      await shareAsync(saved.uri, { mimeType: mime ?? undefined, dialogTitle: file_name });
    } catch (e) {
      setErr(e instanceof ApiRequestError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Body muted>Original file</Body>
      {files.map((f) => (
        <View key={f.id} style={{ gap: 8 }}>
          <Text style={{ color: t.text, fontSize: sizes.font, fontWeight: "600" }}>
            {fileIcon(f.original_name, f.mime)} {f.original_name}
          </Text>
          <Text style={{ color: t.muted, fontSize: 14 }}>
            {[describeSize(f.size_bytes), f.page_count ? `${f.page_count} page${f.page_count > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ")}
          </Text>
          <View style={styles.rowWrap}>
            <View style={{ flex: 1 }}>
              <BigButton label="Open" variant="secondary" onPress={() => open(f)} loading={busy === f.id + "open"} />
            </View>
            <View style={{ flex: 1 }}>
              <BigButton label="Share" variant="secondary" onPress={() => share(f)} loading={busy === f.id + "share"} />
            </View>
          </View>
        </View>
      ))}
      {err && <Body muted>{err}</Body>}
    </Card>
  );
}

function NoteLinks({ title, notes }: { title: string; notes: NoteRef[] }) {
  const t = useTheme();
  return (
    <Card>
      <Body muted>{title}</Body>
      {notes.map((r) => (
        <Pressable key={r.id} onPress={() => router.push({ pathname: "/note/[id]", params: { id: r.id } })} accessibilityRole="link">
          <Text style={{ color: t.primary, fontSize: sizes.font, fontWeight: "600" }}>
            {r.title ?? "Note"}
            {r.started_at ? ` · ${new Date(r.started_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : ""} ›
          </Text>
        </Pressable>
      ))}
    </Card>
  );
}

function DangerZone({ n }: { n: NoteDetail }) {
  const delRecording = useNoteAction(n.id, () => api(`/v1/notes/${n.id}/recording`, { method: "DELETE" }));
  const delNote = useNoteAction(n.id, () => api(`/v1/notes/${n.id}`, { method: "DELETE" }));
  return (
    <View style={{ gap: 12, marginTop: 24 }}>
      {n.has_audio && (
        <BigButton
          label="Delete audio (keep note)"
          variant="secondary"
          onPress={() =>
            Alert.alert("Delete the audio?", "The note and transcript stay. The recording can't be played again.", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete audio", style: "destructive", onPress: () => delRecording.mutate(undefined) },
            ])
          }
        />
      )}
      <BigButton
        label="Delete note"
        variant="danger"
        onPress={() =>
          Alert.alert("Delete this note?", "The note, transcript and audio will be removed.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () => delNote.mutate(undefined, { onSuccess: () => router.navigate("/notes") }),
            },
          ])
        }
      />
    </View>
  );
}

function EditModal(props: {
  visible: boolean;
  title: string;
  initial: string;
  placeholder?: string;
  multiline?: boolean;
  onSave: (v: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [value, setValue] = useState(props.initial);
  return (
    <Modal visible={props.visible} animationType="slide" onShow={() => setValue(props.initial)} onRequestClose={props.onCancel}>
      <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: sizes.gap, gap: 12, paddingTop: 48 }} keyboardShouldPersistTaps="handled">
        <Title>{props.title}</Title>
        <Field
          label=""
          value={value}
          onChangeText={setValue}
          multiline={props.multiline}
          placeholder={props.placeholder}
          autoFocus
          style={props.multiline ? { minHeight: 160, textAlignVertical: "top", paddingTop: 12 } : undefined}
        />
        <BigButton label="Save" disabled={!value.trim()} onPress={() => props.onSave(value.trim())} />
        <BigButton label="Cancel" variant="secondary" onPress={props.onCancel} />
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  rowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  task: { flexDirection: "row", gap: 12, alignItems: "center", borderWidth: 1, borderRadius: sizes.radius, padding: 12, minHeight: sizes.tap },
  segment: { borderWidth: 1, borderRadius: sizes.radius, padding: 12, gap: 6 },
  search: { minHeight: 50, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, fontSize: sizes.font },
});
