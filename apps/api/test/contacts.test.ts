import { describe, expect, it } from "vitest";
import { cleanQuery } from "../src/services/contacts/resolve";
import { safeFileName } from "../src/routes/files";

describe("cleanQuery (voice/text call commands)", () => {
  it.each([
    ["Call Ramesh from the steel vendor", "ramesh steel vendor"],
    ["Please call Suresh anna", "suresh"],
    ["Can you phone the plumbing contractor for Essence?", "plumbing contractor for essence"],
    ["Dial Mr. Karthik site engineer", "karthik site engineer"],
    ["ரமேஷ் ஐ call பண்ணு", "ரமேஷ் ஐ பண்ணு"],
  ])("%s → %s", (input, expected) => {
    expect(cleanQuery(input)).toBe(expected);
  });
});

describe("safeFileName", () => {
  it("keeps names readable but safe for storage", () => {
    expect(safeFileName("Quotation - Balaji Steels (rev 2).PDF")).toBe("Quotation_-_Balaji_Steels_rev_2.pdf");
    expect(safeFileName("WhatsApp Chat with Ramesh.zip")).toBe("WhatsApp_Chat_with_Ramesh.zip");
    expect(safeFileName("../../etc/passwd")).toBe("etc_passwd");
  });
});
