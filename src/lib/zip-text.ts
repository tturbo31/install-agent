// ─── ZIP codes typed in free text ────────────────────────────────────────────
// Different from extractZip (scheduler.ts), which only looks at ADDRESSES and
// therefore ignores a "33130" typed on its own as an answer ("what's the zip?"
// → "33130"). Here a 5-digit token counts as a ZIP when it starts with 33 or 34
// (South Florida), is not glued to "$" / digits, is not an apartment or unit
// number and is not followed by a street name (house number: "33055 SW 12 St",
// "33055 Southwest 12th Street").
// Used by clientAlreadyGaveZip (ai.ts) and withEarlierBookingFacts
// (booking-facts.ts) so a ZIP the client already typed is never asked again.
// Text detection only: the route optimization layer that once lived next to
// this helper was removed on 2026-09-16 (owner's decision), so there is no geo
// table and no routing here.
const STREET_WORD_AFTER = /^\s*(?:[nsew]{1,2}\.?\s|(?:north|south|east|west|northwest|northeast|southwest|southeast|norte|sul|leste|oeste)\b|\d+(?:st|nd|rd|th)\b|(?:(?:[a-z'.]+|\d+(?:st|nd|rd|th)?)\s+){0,4}(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|calle|avenida|rua)\b)/i;
const UNIT_BEFORE = /(?:\b(?:apt|apto|apartment|apartamento|unit|unidad|unidade|suite|ste|room|rm|lot|bldg|building)\.?\s*#?\s*|#\s*)$/i;

export function zipsInText(text: string): string[] {
  const t = (text || "").toString();
  const out: string[] = [];
  // Lookahead case-insensitive ("33130 USD", "33150 SQFT"); "ft" only as a
  // unit, never "Ft Lauderdale".
  const re = /(?<![\d$,.#-])\b(3[34]\d{3})(?:-\d{4})?\b(?![\d,.]*\s*(?:sq|sf|ft(?!\.?\s*lauderdale)|feet|pies|k\b|dollars|usd))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const zip = m[1];
    if (UNIT_BEFORE.test(t.slice(0, m.index))) continue; // "apt 33130" = unit number
    if (STREET_WORD_AFTER.test(t.slice(m.index + m[0].length))) continue; // house number
    out.push(zip);
  }
  return out;
}
