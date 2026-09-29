import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import JSZip from "jszip";
import mammoth from "mammoth";
import { OfficeParser } from "officeparser";
import { PDFParse } from "pdf-parse";
import * as XLSX from "xlsx";

export type FileKind =
  | "pdf"
  | "word"
  | "excel"
  | "powerpoint"
  | "image"
  | "audio"
  | "text"
  | "whatsapp"
  | "video"
  | "other";

export const KIND_LABEL: Record<FileKind, string> = {
  pdf: "PDF document",
  word: "Word document",
  excel: "Excel spreadsheet",
  powerpoint: "PowerPoint presentation",
  image: "Photo / image",
  audio: "Audio recording",
  text: "Text file",
  whatsapp: "WhatsApp chat export",
  video: "Video",
  other: "File",
};

const AUDIO_EXT = [".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".amr", ".3gp", ".flac", ".weba", ".webm"];
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".bmp", ".tif", ".tiff"];

/** Works out what a file is from its content first, then its name and MIME type. */
export async function detectKind(data: Buffer, fileName: string, mime: string | null): Promise<FileKind> {
  const ext = extname(fileName).toLowerCase();
  const sniffed = await fileTypeFromBuffer(data).catch(() => undefined);
  const m = (sniffed?.mime ?? mime ?? "").toLowerCase();

  if (ext === ".zip" || m === "application/zip") {
    return (await isWhatsAppZip(data)) ? "whatsapp" : "other";
  }
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (ext === ".docx" || m.includes("wordprocessingml")) return "word";
  if ([".xlsx", ".xls", ".csv", ".ods"].includes(ext) || m.includes("spreadsheetml") || m === "application/vnd.ms-excel" || m === "text/csv") return "excel";
  if ([".pptx", ".odp"].includes(ext) || m.includes("presentationml")) return "powerpoint";
  if (m.startsWith("image/") || IMAGE_EXT.includes(ext)) return "image";
  if (m.startsWith("video/") && !AUDIO_EXT.includes(ext)) return "video";
  if (m.startsWith("audio/") || AUDIO_EXT.includes(ext) || m === "video/mp4" && ext === ".m4a") return "audio";
  if (m.startsWith("text/") || [".txt", ".md", ".log"].includes(ext) || (!sniffed && looksLikeText(data))) {
    return looksLikeWhatsAppChat(data.toString("utf8")) ? "whatsapp" : "text";
  }
  return "other";
}

function looksLikeText(data: Buffer) {
  const sample = data.subarray(0, 4000);
  let bad = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) bad++;
  return sample.length > 0 && bad / sample.length < 0.01;
}

// ───────────────────────── PDF ─────────────────────────

export interface PdfText {
  text: string;
  pageCount: number;
  /** Too little text per page — probably a scan/photo, needs the AI to read it. */
  looksScanned: boolean;
}

export async function extractPdf(data: Buffer): Promise<PdfText> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const r = await parser.getText();
    const text = r.text.replace(/\n{3,}/g, "\n\n").trim();
    const pageCount = r.total || 1;
    return { text, pageCount, looksScanned: text.replace(/\s/g, "").length / pageCount < 30 };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

// ───────────────────────── Office ─────────────────────────

export async function extractWord(data: Buffer): Promise<string> {
  const r = await mammoth.extractRawText({ buffer: data });
  return r.value.replace(/\n{3,}/g, "\n\n").trim();
}

/** Every sheet as CSV (rows capped so huge BOQs don't overwhelm the AI). */
export function extractSpreadsheet(data: Buffer, maxRowsPerSheet = 3000): { text: string; sheets: number; truncated: boolean } {
  const wb = XLSX.read(data, { type: "buffer", cellDates: true });
  let truncated = false;
  const parts = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false, strip: true });
    const rows = csv.split("\n").filter((r) => r.replace(/,/g, "").trim());
    if (rows.length > maxRowsPerSheet) truncated = true;
    return `=== Sheet: ${name} (${rows.length} rows) ===\n${rows.slice(0, maxRowsPerSheet).join("\n")}`;
  });
  return { text: parts.join("\n\n").trim(), sheets: wb.SheetNames.length, truncated };
}

export async function extractPresentation(data: Buffer): Promise<string> {
  const ast = await OfficeParser.parseOffice(data);
  const out = await ast.to("text");
  return String((out as { value: unknown }).value ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

// ───────────────────────── WhatsApp ─────────────────────────

const WA_LINE = /^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?[^:]{1,60}:/im;

export function looksLikeWhatsAppChat(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, 60);
  return lines.filter((l) => WA_LINE.test(l)).length >= Math.min(3, lines.length);
}

async function isWhatsAppZip(data: Buffer) {
  try {
    const zip = await JSZip.loadAsync(data);
    return Object.keys(zip.files).some((n) => /(^|\/)(_chat|WhatsApp Chat.*)\.txt$/i.test(n));
  } catch {
    return false;
  }
}

export interface WhatsAppExport {
  chat: string;
  /** Voice notes / audio files inside the export, by file name. */
  audio: { name: string; data: Buffer }[];
  otherAttachments: string[];
}

/** Reads a WhatsApp "Export chat" .zip (chat text + attached voice notes). */
export async function extractWhatsAppZip(data: Buffer, maxAudio = 15): Promise<WhatsAppExport> {
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const chatName = names.find((n) => /(^|\/)(_chat|WhatsApp Chat.*)\.txt$/i.test(n)) ?? names.find((n) => n.endsWith(".txt"));
  const chat = chatName ? await zip.files[chatName]!.async("string") : "";
  const audioNames = names.filter((n) => AUDIO_EXT.includes(extname(n).toLowerCase())).slice(0, maxAudio);
  const audio = await Promise.all(
    audioNames.map(async (n) => ({ name: n.split("/").pop()!, data: Buffer.from(await zip.files[n]!.async("uint8array")) })),
  );
  const otherAttachments = names
    .filter((n) => n !== chatName && !audioNames.includes(n))
    .map((n) => n.split("/").pop()!);
  return { chat: chat.replace(/‎|‏/g, "").trim(), audio, otherAttachments };
}

/** Puts voice-note transcripts into the chat where the attachment was mentioned. */
export function insertVoiceNotes(chat: string, transcripts: Map<string, string>): string {
  let out = chat;
  for (const [name, text] of transcripts) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(<attached:\\s*${escaped}>|${escaped}\\s*\\(file attached\\))`, "g");
    const replacement = `[voice note: "${text}"]`;
    out = pattern.test(out) ? out.replace(pattern, replacement) : `${out}\n[voice note ${name}: "${text}"]`;
  }
  return out;
}

// ───────────────────────── text ─────────────────────────

export function decodeText(data: Buffer): string {
  // UTF-16 (some Windows exports) vs UTF-8
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
  return data.toString("utf8").replace(/^﻿/, "");
}
