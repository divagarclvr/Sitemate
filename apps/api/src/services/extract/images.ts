import heicConvert from "heic-convert";
import sharp from "sharp";

/** HEIC/HEIF photos (iPhones, some Android cameras) start with an "ftyp" box naming heic/mif1. */
export function isHeic(data: Buffer) {
  const brand = data.subarray(8, 12).toString("latin1");
  return data.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand);
}

/**
 * Turns any photo into a JPEG the AI can read well: converts HEIC, fixes rotation,
 * and shrinks huge camera photos (keeps text legible at 2400 px on the long side).
 */
export async function prepareImage(data: Buffer): Promise<{ data: Buffer; mimeType: "image/jpeg" }> {
  let input = data;
  if (isHeic(data)) {
    input = Buffer.from(await heicConvert({ buffer: new Uint8Array(data), format: "JPEG", quality: 0.9 }));
  }
  const out = await sharp(input, { failOn: "none" })
    .rotate() // honour EXIF orientation (phone photos)
    .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { data: out, mimeType: "image/jpeg" };
}

export const VISION_PROMPT = `Read this construction-related image or scanned document completely.
1. Transcribe ALL visible text exactly: handwriting, printed text, tables (as rows with | separators), numbers, units, amounts, dates, names, stamps.
2. If it is a drawing, whiteboard sketch or site photo, briefly describe what it shows (elements, dimensions, marks, progress).
3. If it is a bill/invoice/quotation, keep line items, quantities, rates, taxes and totals exactly as written.
Mixed English/Tamil/Kannada/Telugu/Malayalam/Hindi is common — keep original words and add English meaning in brackets.
Write [illegible] for parts you cannot read. Do not invent anything. Output plain text only.`;
