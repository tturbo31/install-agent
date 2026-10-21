// ─── Offer-line guard: the times we name exist, and the soonest day comes first ─
// Review of 20–21/10/2026 (33 slot offers re-read against the agenda at the
// moment of each one). Two kinds of slip the prompt forbids but the model still
// makes once in a while:
//   • "Manana miercoles te queda mejor a las 9am o a las 8pm" (fb_28919223654397811,
//     20/10 21:16) while Wednesday's line ended at 5pm: the 8pm belonged to
//     Thursday. Had the client said "8pm", the booking would have bounced with
//     "that time filled up".
//   • "I have today at 2pm or 8pm tomorrow" (Jason Costello, IG 21/10 10:17)
//     while today's line still read "2pm, 3pm" and the client had named no
//     preference: today's second hour was hidden and a same-day visit was
//     offered against tomorrow (owner rule: fill the soonest day first).
// Code checks the model's draft against the SAME schedule text it was given
// (scheduleLinesOf) and, on a slip, the webhook asks the model ONCE to rewrite
// with the day's real line (retryForOfferLine, ai.ts); the rewrite is kept only
// when it passes this same check, so the client never gets anything worse than
// today. Pure module, no SDK: evals exercise it without the network.
import { scheduleLinesOf, offeredSlotsOf, offerPair, easternTodayStr, clientWords, type ScheduleLine, type OfferedSlot } from "@/lib/scheduler";

export type OfferDeviation = {
  kind: "off-line" | "day-skipped" | "day-split";
  detail: string; // for the logs
  note: string; // the [SYSTEM: ...] rewrite note appended to the client's last message
};

type Msg = { role: string; content: string };

// Our own lines that RESTATE a booked slot or a visit window are not offers.
const RESTATEMENT = /\b(?:appointment confirmed|cita confirmada|visita confirmada|your visit is confirmed|tu visita est[aá] confirmada|sua visita est[aá] confirmada|has been rescheduled|qued[oó] reagendada|foi remarcada|installation team will arrive|equipo de instalaci[oó]n|equipe de instala[cç][aã]o)\b/i;

// Words in the client's recent messages that say WHEN they can (a day, a time,
// a part of the day, a boundary, a week, "I can't"): with any of these, which
// day the model offers is the client's call and only the TIMES are checked.
// Deaccented lowercase text. False positives here only make the guard quieter.
const CLIENT_PREF =
  /(?<![a-z])(?:today|tonight|tomorrow|tmrw|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|weekdays?|morning|afternoon|evening|night|noon|after|before|between|later|earlier|sooner|next\s+week|this\s+week|week|busy|can'?t|cannot|not\s+(?:good|great|possible|today)|hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|fin\s+de\s+semana|tarde|noche|temprano|despues|antes|entre|a\s+partir|semana|no\s+puedo|ocupad[oa]|hoje|amanha|segunda|terca|quarta|quinta|sexta|manha|noite|depois|cedo|nao\s+posso|\d{1,2}\s*(?:am|pm|h)|\d{1,2}:\d{2}|(?:at|a\s+las?|as)\s+\d{1,2})(?![a-z])/;

const deaccent = (s: string) => (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// The client's last three messages, only their own words.
export function clientStatedPreference(history: Msg[]): boolean {
  const texts: string[] = [];
  for (let i = (history ?? []).length - 1; i >= 0 && texts.length < 3; i--) {
    if (history[i].role !== "user") continue;
    const t = clientWords(history[i].content || "").trim();
    if (t) texts.push(t);
  }
  return CLIENT_PREF.test(deaccent(texts.join("\n")));
}

function labelMinutes(label: string): number {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec((label || "").trim());
  if (!m) return -1;
  return ((parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0)) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}
const hhmmMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const onLine = (line: ScheduleLine, slot: OfferedSlot) => line.times.some((t) => labelMinutes(t) === hhmmMinutes(slot.time));
const pairOf = (line: ScheduleLine) => offerPair(line.times).join(" or ");
const where = (line: ScheduleLine) => `${line.display} [${line.date}]`;
const listOf = (line: ScheduleLine) => (line.times.length ? line.times.join(", ") : "fully booked");

const RULE =
  "Owner rule: SOONEST DAY FIRST, and a time that is not printed on a day's line does not exist that day. Rewrite the same reply (same language, same content and length, nothing new) changing ONLY the visit times you name: ";
const TAIL = " Name no other day and no other time. Never mention this note.";

function offLineNote(line: ScheduleLine, offered: OfferedSlot[], hasPref: boolean): string {
  const bad = offered.filter((s) => !onLine(line, s)).map((s) => s.label).join(", ");
  const fix = line.times.length === 0
    ? `that day is fully booked, so use the next listed day that has open times and name its earliest and its latest time`
    : hasPref
      ? `keep ${where(line)} and name only times printed on its line (${listOf(line)}), the ones that fit what the client said`
      : `keep ${where(line)} and name its earliest and its latest open time, ${pairOf(line)}`;
  return `[SYSTEM: OFFER CHECK FAILED, REWRITE YOUR REPLY. Your draft named ${bad} for ${where(line)}, but that day's schedule line is: ${listOf(line)}. ${RULE}${fix}.${TAIL}]`;
}
function soonestNote(soonest: ScheduleLine, offeredDays: string[], kind: "day-skipped" | "day-split", lines: ScheduleLine[]): string {
  const what = kind === "day-skipped"
    ? `Your draft offered ${offeredDays.join(" and ")} while ${where(soonest)} still has open times (${listOf(soonest)}) and the client gave no preference`
    : `Your draft named only one time of ${where(soonest)} and reached into another day, while that line still has ${listOf(soonest)} and the client gave no preference`;
  // A single open time on the soonest day: that time, plus one of the next day
  // that has any (the schedule bullet's own rule).
  const next = soonest.times.length === 1 ? lines.find((l) => l.date > soonest.date && l.times.length > 0) : undefined;
  const fix = next
    ? `offer ${where(soonest)} at ${soonest.times[0]} plus one open time of ${where(next)} (its earliest, ${next.times[0]})`
    : `offer ${where(soonest)} at ${pairOf(soonest)} (its earliest and its latest open time)`;
  return `[SYSTEM: OFFER CHECK FAILED, REWRITE YOUR REPLY. ${what}. ${RULE}${fix}.${TAIL}]`;
}

/**
 * null when the draft offers nothing, or offers only times printed on their
 * day's line and starts from the soonest open day (or from a day/time the
 * client asked for). Otherwise the kind of slip and the rewrite note.
 */
export function offerLineDeviation(reply: string, availability: string, history: Msg[], todayStr: string = easternTodayStr()): OfferDeviation | null {
  const text = reply || "";
  if (!text.trim() || /\[BOOK:/i.test(text)) return null;
  const prose = text.replace(/\[[^\]]*\]/g, " ");
  if (!/[a-z]/i.test(prose) || RESTATEMENT.test(prose)) return null;
  const lines = scheduleLinesOf(availability).filter((l) => l.date >= todayStr);
  if (lines.length === 0) return null;
  const offered = offeredSlotsOf(prose, todayStr);
  if (offered.length === 0) return null;
  const hasPref = clientStatedPreference(history);
  // A time that is not on its day's line (the day the client asked for stays).
  for (const s of offered) {
    const line = lines.find((l) => l.date === s.date);
    if (!line || onLine(line, s)) continue;
    const sameDay = offered.filter((o) => o.date === s.date);
    return { kind: "off-line", detail: `${s.label} offered for ${where(line)} but that line is "${listOf(line)}"`, note: offLineNote(line, sameDay, hasPref) };
  }
  if (hasPref) return null;
  const soonest = lines.find((l) => l.times.length > 0);
  if (!soonest) return null;
  // Only days we show a line for: a day beyond them is the client's own
  // proposal echoed back, not ours to judge.
  const known = offered.filter((o) => lines.some((l) => l.date === o.date));
  if (known.length === 0) return null;
  const days = [...new Set(known.map((o) => o.date))].sort();
  const first = days[0];
  if (first > soonest.date) {
    const named = days.map((d) => { const l = lines.find((x) => x.date === d); return l ? where(l) : d; });
    return { kind: "day-skipped", detail: `offered ${named.join(" and ")} while ${where(soonest)} has "${listOf(soonest)}"`, note: soonestNote(soonest, named, "day-skipped", lines) };
  }
  if (first === soonest.date && soonest.times.length >= 2 && days.length > 1) {
    const onSoonest = new Set(known.filter((o) => o.date === soonest.date).map((o) => o.time));
    if (onSoonest.size === 1) {
      return { kind: "day-split", detail: `only one time of ${where(soonest)} ("${listOf(soonest)}") plus another day`, note: soonestNote(soonest, days, "day-split", lines) };
    }
  }
  return null;
}
