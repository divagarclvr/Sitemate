import { describe, expect, it } from "vitest";
import { normaliseFigures, parseIndianNumber } from "../src/services/notes/indianNumbers";

describe("parseIndianNumber", () => {
  it.each([
    ["₹4.5 L", 450000],
    ["4.5 lakh", 450000],
    ["12 lakhs", 1200000],
    ["2 crore", 20000000],
    ["1.25 Cr", 12500000],
    ["58.5K per MT", 58500],
    ["58 thousand", 58000],
    ["₹ 4,850 per MT", 4850],
    ["1,25,000", 125000],
    ["Rs. 3,50,000/-", 350000],
    ["45 MT", 45],
    ["2400 sqft", 2400],
    ["12.5 cum", 12.5],
  ])("%s → %d", (raw, expected) => {
    expect(parseIndianNumber(raw)).toBe(expected);
  });

  it("returns null when there is no number", () => {
    expect(parseIndianNumber("about the same as last time")).toBeNull();
  });

  it("does not treat the 'l' in 'litre' or 'labour' as lakh", () => {
    expect(parseIndianNumber("20 labour")).toBe(20);
  });
});

describe("normaliseFigures", () => {
  it("fills only missing values", () => {
    const out = normaliseFigures([
      { value: null, raw_text: "3.2 lakh" },
      { value: 99, raw_text: "4 lakh" },
    ]);
    expect(out.map((f) => f.value)).toEqual([320000, 99]);
  });
});
