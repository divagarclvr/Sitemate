import { describe, expect, it } from "vitest";
import {
  decodeText,
  detectKind,
  extractPdf,
  extractPresentation,
  extractSpreadsheet,
  extractWhatsAppZip,
  extractWord,
  insertVoiceNotes,
  looksLikeWhatsAppChat,
} from "../src/services/extract/documents";
import { makeDocx, makePdf, makePptx, makeWhatsAppZip, makeXlsx, WHATSAPP_CHAT } from "./fixtures";

describe("detectKind", () => {
  it("recognises file types by content and name", async () => {
    expect(await detectKind(makePdf("hi"), "quote.pdf", null)).toBe("pdf");
    expect(await detectKind(await makeDocx(["x"]), "letter.docx", null)).toBe("word");
    expect(await detectKind(makeXlsx({ A: [["x"]] }), "boq.xlsx", null)).toBe("excel");
    expect(await detectKind(Buffer.from("a,b\n1,2"), "rates.csv", "text/csv")).toBe("excel");
    expect(await detectKind(await makePptx(["x"]), "review.pptx", null)).toBe("powerpoint");
    expect(await detectKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), "IMG_1.jpg", "image/jpeg")).toBe("image");
    expect(await detectKind(Buffer.from("fake"), "PTT-1.opus", "audio/ogg")).toBe("audio");
    expect(await detectKind(Buffer.from("site visit notes"), "notes.txt", "text/plain")).toBe("text");
    expect(await detectKind(Buffer.from(WHATSAPP_CHAT), "WhatsApp Chat with Ramesh.txt", "text/plain")).toBe("whatsapp");
    expect(await detectKind(await makeWhatsAppZip(), "WhatsApp Chat with Ramesh.zip", "application/zip")).toBe("whatsapp");
  });
});

describe("document text extraction", () => {
  it("reads PDF text and page count", async () => {
    const r = await extractPdf(makePdf("TMT Fe550D rate 58500 per MT for Essence Tower 2 quotation"));
    expect(r.text).toContain("58500");
    expect(r.pageCount).toBe(1);
    expect(r.looksScanned).toBe(false);
  });

  it("flags near-empty PDFs as scans", async () => {
    expect((await extractPdf(makePdf(" "))).looksScanned).toBe(true);
  });

  it("reads Word documents", async () => {
    const text = await extractWord(await makeDocx(["Minutes of meeting", "Shuttering to start on 3 Oct"]));
    expect(text).toContain("Shuttering to start on 3 Oct");
  });

  it("reads every sheet of a spreadsheet as CSV", () => {
    const r = extractSpreadsheet(
      makeXlsx({
        BOQ: [["Item", "Qty", "Unit", "Rate"], ["RCC M25", 120, "cum", 6850]],
        Steel: [["Dia", "MT"], ["12mm", 45]],
      }),
    );
    expect(r.sheets).toBe(2);
    expect(r.text).toContain("=== Sheet: BOQ");
    expect(r.text).toContain("RCC M25,120,cum,6850");
    expect(r.text).toContain("12mm,45");
  });

  it("caps very long sheets and says so", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`row${i}`, i]);
    const r = extractSpreadsheet(makeXlsx({ Big: rows }), 10);
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("row20");
  });

  it("reads PowerPoint slides", async () => {
    const text = await extractPresentation(await makePptx(["Monthly progress review", "Tower 2 slab cast 60%"]));
    expect(text).toContain("Tower 2 slab cast 60%");
  });

  it("decodes UTF-16 text files", () => {
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("கம்பி", "utf16le")]))).toBe("கம்பி");
  });
});

describe("WhatsApp exports", () => {
  it("detects chat text", () => {
    expect(looksLikeWhatsAppChat(WHATSAPP_CHAT)).toBe(true);
    expect(looksLikeWhatsAppChat("just some notes\nabout the site")).toBe(false);
  });

  it("reads the chat and voice notes from the zip", async () => {
    const r = await extractWhatsAppZip(await makeWhatsAppZip());
    expect(r.chat).toContain("57,200 per MT");
    expect(r.audio.map((a) => a.name)).toEqual(["PTT-20250912-WA0003.opus"]);
    expect(r.otherAttachments).toContain("00000012-PHOTO-2025-09-12-10-21-00.jpg");
  });

  it("puts voice-note transcripts where they were attached", () => {
    const out = insertVoiceNotes(WHATSAPP_CHAT, new Map([["PTT-20250912-WA0003.opus", "Delivery on Monday"]]));
    expect(out).toContain('Ramesh Steel: [voice note: "Delivery on Monday"]');
  });
});
