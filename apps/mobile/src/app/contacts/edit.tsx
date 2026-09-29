import { CONTACTS_ROUTE } from "@/lib/calls";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Chip } from "@/components/pickers";
import { BigButton, Body, ErrorBox, Field, Screen, Title } from "@/components/ui";
import { api, ApiRequestError } from "@/lib/api";
import { useContact, useProjects, useSaveContact } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { View } from "react-native";

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export default function EditContactScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const existing = useContact(id ?? "");
  const projects = useProjects();
  const save = useSaveContact();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [phones, setPhones] = useState("");
  const [aliases, setAliases] = useState("");
  const [notes, setNotes] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);

  useEffect(() => {
    const c = existing.data;
    if (!id || !c) return;
    setName(c.name);
    setCompany(c.company ?? "");
    setRole(c.role ?? "");
    setPhones(c.phones.join(", "));
    setAliases(c.name_aliases.join(", "));
    setNotes(c.notes ?? "");
    setProjectIds(c.project_ids);
  }, [id, existing.data]);

  const submit = () =>
    save.mutate(
      {
        id,
        body: {
          name: name.trim(),
          company: company.trim() || null,
          role: role.trim() || null,
          phones: splitList(phones),
          name_aliases: splitList(aliases),
          notes: notes.trim() || null,
          project_ids: projectIds,
        },
      },
      { onSuccess: (c) => router.replace({ pathname: "/contacts/[id]", params: { id: c.id } }) },
    );

  const remove = () =>
    Alert.alert("Delete this contact?", "Notes stay; they just won't be linked to this person.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await api(`/v1/contacts/${id}`, { method: "DELETE" });
          void qc.invalidateQueries({ queryKey: ["contacts"] });
          router.navigate(CONTACTS_ROUTE);
        },
      },
    ]);

  return (
    <Screen>
      <Title>{id ? "Edit contact" : "New contact"}</Title>
      <Field label="Name" value={name} onChangeText={setName} placeholder="Ramesh Kumar" />
      <Field label="Company" value={company} onChangeText={setCompany} placeholder="Sri Balaji Steels" />
      <Field label="Role" value={role} onChangeText={setRole} placeholder="Steel vendor – sales" />
      <Field label="Phone numbers (comma separated)" value={phones} onChangeText={setPhones} keyboardType="phone-pad" placeholder="98450 11111" />
      <Field label="Other names (comma separated)" value={aliases} onChangeText={setAliases} placeholder="Ramesh Steel, Balaji Ramesh" />
      <Body muted>Projects</Body>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(projects.data ?? []).map((p) => (
          <Chip
            key={p.id}
            label={p.name}
            selected={projectIds.includes(p.id)}
            onPress={() => setProjectIds((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
          />
        ))}
        {projects.data?.length === 0 && <Body muted>No projects yet (add them from the Record screen).</Body>}
      </View>
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 90, textAlignVertical: "top", paddingTop: 12 }} />
      {save.error && (
        <ErrorBox message={(save.error as Error).message} hint={save.error instanceof ApiRequestError ? save.error.hint : undefined} />
      )}
      <BigButton label="Save" onPress={submit} loading={save.isPending} disabled={!name.trim()} />
      <BigButton label="Cancel" variant="secondary" onPress={() => router.back()} />
      {id && <BigButton label="Delete contact" variant="danger" onPress={remove} />}
    </Screen>
  );
}
