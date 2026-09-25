import { IN_PROGRESS, type NoteDetail, type NoteListItem, type ProjectDto } from "@sitemate/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const keys = {
  notes: ["notes"] as const,
  note: (id: string) => ["note", id] as const,
  projects: ["projects"] as const,
};

/** Notes list; refreshes every few seconds while something is still being processed. */
export function useNotes() {
  return useQuery({
    queryKey: keys.notes,
    queryFn: () => api<NoteListItem[]>("/v1/notes?limit=100"),
    refetchInterval: (q) => (q.state.data?.some((n) => IN_PROGRESS.includes(n.status)) ? 4000 : false),
  });
}

export function useNote(id: string) {
  return useQuery({
    queryKey: keys.note(id),
    queryFn: () => api<NoteDetail>(`/v1/notes/${id}`),
    refetchInterval: (q) => (q.state.data && IN_PROGRESS.includes(q.state.data.status) ? 4000 : false),
  });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<ProjectDto[]>("/v1/projects"), staleTime: 60_000 });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<ProjectDto>("/v1/projects", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
  });
}

/** Any change to a note: calls the API, then refreshes that note and the list. */
export function useNoteAction<T = unknown>(id: string, fn: (vars: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.note(id) });
      void qc.invalidateQueries({ queryKey: keys.notes });
    },
  });
}
