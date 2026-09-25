import { LANGUAGES, type LanguageHint, type NoteStatus } from "@sitemate/shared";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useCreateProject, useProjects } from "@/lib/queries";
import { sizes, useTheme } from "@/theme";
import { BigButton, Body, Field, Title } from "./ui";

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        { borderColor: selected ? t.primary : t.border, backgroundColor: selected ? t.primary : t.card },
      ]}
    >
      <Text style={{ color: selected ? t.onPrimary : t.text, fontSize: sizes.font - 1, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function LanguagePicker({ value, onChange }: { value: LanguageHint; onChange: (v: LanguageHint) => void }) {
  return (
    <View style={styles.wrap}>
      <Chip label="Auto" selected={value === "auto"} onPress={() => onChange("auto")} />
      {LANGUAGES.map((l) => (
        <Chip key={l.code} label={l.code === "en" ? l.name : `${l.name} · ${l.native}`} selected={value === l.code} onPress={() => onChange(l.code)} />
      ))}
    </View>
  );
}

/** Tap to choose a project (or create one). */
export function ProjectPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const projects = useProjects();
  const create = useCreateProject();
  const current = projects.data?.find((p) => p.id === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.select, { borderColor: t.border, backgroundColor: t.card }]}
        accessibilityRole="button"
      >
        <Text style={{ color: t.muted, fontSize: sizes.font - 3 }}>Project</Text>
        <Text style={{ color: t.text, fontSize: sizes.font + 1, fontWeight: "600" }}>{current?.name ?? "None — tap to choose"}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={{ padding: sizes.gap, gap: 12, paddingTop: 48 }}>
          <Title>Choose project</Title>
          <BigButton label="No project" variant="secondary" onPress={() => (onChange(null), setOpen(false))} />
          {projects.data?.map((p) => (
            <BigButton key={p.id} label={p.name} variant={p.id === value ? "primary" : "secondary"} onPress={() => (onChange(p.id), setOpen(false))} />
          ))}
          <Body muted>Add a new project</Body>
          <Field label="Project name" value={newName} onChangeText={setNewName} placeholder="e.g. Essence Tower Two" />
          <BigButton
            label="Add and choose"
            disabled={!newName.trim()}
            loading={create.isPending}
            onPress={() =>
              create.mutate(newName.trim(), {
                onSuccess: (p) => {
                  onChange(p.id);
                  setNewName("");
                  setOpen(false);
                },
              })
            }
          />
          <BigButton label="Close" variant="secondary" onPress={() => setOpen(false)} />
        </ScrollView>
      </Modal>
    </>
  );
}

const STATUS_TEXT: Record<NoteStatus, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  transcribing: "Transcribing",
  extracting: "Reading file",
  summarising: "Summarising",
  embedding: "Indexing",
  waiting_quota: "Waiting for free AI",
  done: "Done",
  failed: "Needs attention",
};

export function StatusBadge({ status }: { status: NoteStatus | "local" }) {
  const t = useTheme();
  const color = status === "done" ? t.success : status === "failed" ? t.danger : t.primary;
  const label = status === "local" ? "Saved on phone" : STATUS_TEXT[status];
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={{ color, fontWeight: "700", fontSize: 14 }}>{label}</Text>
    </View>
  );
}

/** Reminder shown before every recording. */
export function ConsentSheet({ visible, onAccept, onCancel }: { visible: boolean; onAccept: () => void; onCancel: () => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: t.card }]}>
          <Title>Before you record</Title>
          <Body>Tell everyone in the meeting that it is being recorded, and record only with their consent.</Body>
          <Body muted>On a speakerphone call, inform the other person too.</Body>
          <BigButton label="Everyone agreed — start" onPress={onAccept} />
          <BigButton label="Cancel" variant="secondary" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, justifyContent: "center" },
  select: { minHeight: sizes.tap, borderWidth: 1, borderRadius: sizes.radius, paddingHorizontal: 14, paddingVertical: 8, justifyContent: "center" },
  badge: { borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { padding: sizes.gap, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 32 },
});
