/**
 * Turns spoken/written Indian amounts into plain numbers:
 *   "₹4.5 L" → 450000, "2 crore" → 20000000, "58.5K" → 58500, "1,25,000" → 125000.
 * Returns null when no number can be read.
 */
export function parseIndianNumber(raw: string): number | null {
  const text = raw.toLowerCase().replace(/₹|rs\.?|inr/g, " ");
  const m = text.match(/(-?\d[\d,]*(?:\.\d+)?)\s*(crores?|cr\b|lakhs?|lacs?|lakh|l\b|thousand|k\b)?/);
  if (!m) return null;

  const value = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;

  const unit = m[2] ?? "";
  const multiplier = /^(crores?|cr)$/.test(unit)
    ? 1e7
    : /^(lakhs?|lacs?|lakh|l)$/.test(unit)
      ? 1e5
      : /^(thousand|k)$/.test(unit)
        ? 1e3
        : 1;
  return Math.round(value * multiplier * 10_000) / 10_000;
}

const NUMERIC_KINDS = new Set(["amount", "quantity", "rate", "percentage"]);

/**
 * Fills missing `value`s from `raw_text` (the AI sometimes leaves them null) for money/quantities,
 * and clears numbers wrongly given to dates ("24-09-2026" is not 24).
 */
export function normaliseFigures<T extends { kind?: string; value: number | null; raw_text: string }>(figures: T[]): T[] {
  return figures.map((f) => {
    if (f.kind && !NUMERIC_KINDS.has(f.kind)) return f.kind === "date" ? { ...f, value: null } : f;
    return f.value == null ? { ...f, value: parseIndianNumber(f.raw_text) } : f;
  });
}
