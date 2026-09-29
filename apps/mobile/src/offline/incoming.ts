/**
 * Files waiting on the "Save to SiteMate" screen — from Android's Share menu or the
 * in-app file picker. Kept in memory only until the user saves or cancels.
 */
export interface IncomingFile {
  uri: string;
  name: string;
  mime: string | null;
  size: number | null;
}

export interface Incoming {
  files: IncomingFile[];
  /** Plain text shared from another app (becomes a text memo). */
  text: string | null;
  source: "share" | "picker";
}

let current: Incoming | null = null;
const listeners = new Set<() => void>();

export const incoming = {
  set(value: Incoming | null) {
    current = value;
    listeners.forEach((l) => l());
  },
  get: () => current,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function describeSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileIcon(name: string, mime: string | null) {
  const n = name.toLowerCase();
  const m = (mime ?? "").toLowerCase();
  if (/whatsapp chat/.test(n)) return "💬";
  if (m.startsWith("image/") || /\.(jpe?g|png|heic|webp)$/.test(n)) return "🖼️";
  if (m.startsWith("audio/") || /\.(opus|ogg|mp3|m4a|wav|aac|amr)$/.test(n)) return "🎙️";
  if (/\.pdf$/.test(n) || m === "application/pdf") return "📄";
  if (/\.(xlsx?|csv)$/.test(n)) return "📊";
  if (/\.docx?$/.test(n)) return "📝";
  if (/\.pptx?$/.test(n)) return "📽️";
  return "📎";
}
