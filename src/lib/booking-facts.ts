// ─── Booking facts typed BEFORE the 15-message window ────────────────────────
// The three webhooks hand the model and every booking guard only the last 15
// messages of the conversation. Margarita León (IG, 2026-09-12): she typed the
// zip ("33180 It is a condo") 16 bubbles before the details ask, so neither the
// model nor clientAlreadyGaveZip could see it and the bot asked "What's the zip
// code for that address?" again — exactly the re-ask the owner flagged. This
// helper carries the OLDER client bubbles that hold booking facts (a zip, a
// street address, a phone, a name intro) into the window, in their original
// order, so the model reads them and the guards (bookingAddressHasZip,
// clientProvidedName, reconcileBookingPhone…) accept them. Only the current
// booking episode counts: nothing before the last completed booking
// confirmation, nothing older than 14 days. Real client bubbles only — nothing
// is synthesized.
import { zipsInText } from "./zip-text";

export type HistoryRow = { role: string; content: string; created_at?: string | null };

const STREET_RE = /\b\d{2,6}\s+(?:[nsew]{1,2}\.?\s+)?(?:[a-zà-ú0-9]+\s+){0,4}?(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terrace|pl|place|hwy|highway|cir|circle|calle|avenida|trail|trl|pkwy|parkway|loop|run|path|cv|cove)\b/i;
const PHONE_RE = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;
const NAME_INTRO = /\b(?:my name is|name is|me llamo|mi nombre es|meu nome [eé]|name\s*:|nombre\s*:|nome\s*:)\s*[A-Za-zÀ-ú]/i;
const CLIENT_SYSTEM_BRACKETS = /\[(?:Client (?:shared|replied)|Floor plan analysis|Image|Photo|Attachment|Sticker|Video|floor plan or photo)[^\]]*\]/gi;
// A completed booking closes the episode: the canned confirmation / reschedule
// lines the webhooks send when a visit was actually written.
const BOOKING_DONE = /^\s*(?:Appointment confirmed|Cita confirmada|Visita confirmada|All set, your visit has been rescheduled|Listo, tu visita qued[oó] reagendada|Pronto, sua visita foi remarcada)/i;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

const prose = (s: string) => (s || "").split(/\n\n?\[SYSTEM:/)[0].replace(CLIENT_SYSTEM_BRACKETS, " ").trim();

export function carriesBookingFact(text: string): boolean {
  const t = prose(text);
  if (!t) return false;
  return zipsInText(t).length > 0 || STREET_RE.test(t) || PHONE_RE.test(t) || NAME_INTRO.test(t);
}

// `older` = the rows before the window (chronological), `recent` = the window
// itself (chronological). Returns recent when there is nothing to carry.
export function withEarlierBookingFacts<T extends HistoryRow>(older: T[], recent: T[], maxFacts = 6): T[] {
  if (!older?.length) return recent;
  let start = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    if (older[i].role === "assistant" && BOOKING_DONE.test(prose(older[i].content))) { start = i + 1; break; }
  }
  const newestAt = recent[recent.length - 1]?.created_at ?? older[older.length - 1]?.created_at ?? null;
  const cutoff = newestAt ? new Date(newestAt).getTime() - MAX_AGE_MS : 0;
  const facts: T[] = [];
  for (let i = start; i < older.length; i++) {
    const m = older[i];
    if (m.role !== "user") continue;
    if (m.created_at && new Date(m.created_at).getTime() < cutoff) continue;
    if (carriesBookingFact(m.content)) facts.push(m);
  }
  if (!facts.length) return recent;
  return [...facts.slice(-maxFacts), ...recent];
}
