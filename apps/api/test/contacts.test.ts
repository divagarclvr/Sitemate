import { describe, expect, it } from "vitest";
import { cleanQuery } from "../src/services/contacts/resolve";
import { safeFileName } from "../src/routes/files";
import { ImportContactsBody } from "@sitemate/shared";

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

describe("ImportContactsBody (phone contacts)", () => {
  it("shortens long values and skips odd numbers instead of rejecting the import", () => {
    const r = ImportContactsBody.safeParse({
      contacts: [
        { device_contact_id: "1", name: "  Ramesh  ", company: "x".repeat(300), role: "   ", phones: ["98450 11111", "12", "9".repeat(40)] },
      ],
    });
    expect(r.success).toBe(true);
    const c = r.data!.contacts[0]!;
    expect(c.name).toBe("Ramesh");
    expect(c.company).toHaveLength(120);
    expect(c.role).toBeNull();
    expect(c.phones).toEqual(["98450 11111"]);
  });
});
