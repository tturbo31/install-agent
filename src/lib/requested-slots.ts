// ─── The times the client asked for, looked up by CODE (pure, SDK-free) ─────
// WHY (Julie, WhatsApp 2026-09-21): since 2026-09-17 every schedule line
// carries TWO lists, the hours we offer and, in a parenthesis, the hours that
// are "open only if the client asks for one of these". A client who names her
// own times ("Do you have Wed at 6:00 pm or 7:00pm Or Thursday or Friday")
// makes the model cross three lines by two lists with nowhere to think, and it
// thought OUT LOUD: 1,245 characters about "the parenthesis" went to the client.
// Replaying that turn showed the lookup itself was unreliable too:
//   "do you have wednesday at 7 or thursday at 6?"  → Wednesday 7pm IS open and
//     was ignored 6 times in 6 ("Wednesday I have 9am, 11am, 1pm, 3pm, or 5pm");
//   "can you do wednesday at 6pm?" → 6pm is NOT open on that line and was
//     accepted 4 times in 6 ("Wednesday at 6pm works, that's yours").
// A lookup is code's job. This module reads the schedule note that goes to the
// model (the single source of truth, no second query), reads the times and days
// the client named in the un-answered burst, and states the answer as facts, so
// the model has nothing to work out and nothing to narrate.
//
// It states FACTS and one line on how to use them. It adds no step to the sales
// flow, and it only exists on a turn where the client named a time or a part of
// the day. getAIResponse attaches it, so the three channels get it at once.

export type ScheduleDay = {
  date: string;        // YYYY-MM-DD
  weekday: number;     // 0 = Sunday
  label: string;       // "Wednesday Sep 23"
  open: number[];      // every open hour that day, minutes since midnight, sorted
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const toMinutes = (h: number, m: number, ap: string): number => ((h % 12) + (/p/i.test(ap) ? 12 : 0)) * 60 + m;

export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 || 12}${m === 0 ? "" : ":" + String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

// Reads the lines written by getRealAvailabilityContext:
//   • Wednesday, September 23, 2026 [2026-09-23]: 9am, 11am (open only if the client asks for one of these: 2pm, 8pm)
//   • Monday, September 21, 2026 [2026-09-21]: fully booked
// Offered and on-request hours are both OPEN, which is all a client's own
// request needs to know.
export function parseScheduleNote(availability: string): ScheduleDay[] {
  const days: ScheduleDay[] = [];
  for (const m of (availability || "").matchAll(/^• (\w+), (\w+) (\d{1,2}), \d{4} \[(\d{4}-\d{2}-\d{2})\]: (.*)$/gm)) {
    const weekday = WEEKDAYS.indexOf(m[1]);
    if (weekday < 0) continue;
    const open = [...m[5].matchAll(/\b(\d{1,2})(?::(\d{2}))?(am|pm)\b/g)].map((t) => toMinutes(Number(t[1]), Number(t[2] ?? 0), t[3]));
    days.push({ date: m[4], weekday, label: `${m[1]} ${m[2].slice(0, 3)} ${Number(m[3])}`, open: [...new Set(open)].sort((a, b) => a - b) });
  }
  return days;
}

// ─── What the client named ──────────────────────────────────────────────────
// (?![a-zà-ÿ]) instead of a closing \b: JS word boundaries are ASCII-only.
const DAY_WORDS: Array<[number, RegExp]> = [
  [0, /\b(?:sundays?|domingos?)(?![a-zà-ÿ])/gi],
  [1, /\b(?:mondays?|lunes|segundas?(?:[\s-]?feira)?)(?![a-zà-ÿ])/gi],
  [2, /\b(?:tuesdays?|tues?|martes|ter[cç]as?(?:[\s-]?feira)?)(?![a-zà-ÿ])/gi],
  [3, /\b(?:wednesdays?|wed|mi[eé]rcoles|quartas?(?:[\s-]?feira)?)(?![a-zà-ÿ])/gi],
  [4, /\b(?:thursdays?|thurs?|thu|jueves|quintas?(?:[\s-]?feira)?)(?![a-zà-ÿ])/gi],
  [5, /\b(?:fridays?|fri|viernes|sextas?(?:[\s-]?feira)?)(?![a-zà-ÿ])/gi],
  [6, /\b(?:saturdays?|s[áa]bados?)(?![a-zà-ÿ])/gi],
];
const TODAY = /\b(?:today|tonight|this\s+(?:morning|afternoon|evening)|hoy|esta\s+(?:tarde|noche)|hoje)(?![a-zà-ÿ])/gi;
// "mañana" is tomorrow unless it is "la mañana" (the morning).
const TOMORROW = /\b(?:tomorrow|tmrw|amanh[ãa])(?![a-zà-ÿ])|(?<!\b(?:la|las|de\s+la|por\s+la|en\s+la|esta|toda\s+la)\s)\bma[ñn]ana(?![a-zà-ÿ])/gi;
const NEXT_WEEK = /\bnext\s+week\b|\b(?:la\s+)?pr[oó]xima\s+semana\b|\bsemana\s+que\s+(?:vem|viene)\b|\bweek\s+after\b/i;
const DATE_NUMBER = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b|\b(\d{1,2})\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre|janeiro|fevereiro|mar[cç]o|maio|junho|julho|setembro|outubro|novembro|dezembro)\b/gi;

export type Window = { from: number; to: number; label: string };

// The team works 9am to 8pm: a bare "7" is 7pm, a bare "9" is 9am.
const inferAmPm = (h: number): string => (h >= 9 && h <= 11 ? "am" : "pm");

// A part of the day or a boundary ("after 6", "evenings", "por la tarde").
export function windowNamed(t: string): Window | null {
  const bound = /\b(after|past|despu[eé]s\s+de(?:\s+las?)?|depois\s+d[ae]s?|a\s+partir\s+d[ae](?:\s+las?|s)?|before|antes\s+de(?:\s+las?)?|antes\s+d[ae]s?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(t);
  if (bound) {
    const h = Number(bound[2]);
    if (h >= 1 && h <= 12) {
      const at = toMinutes(h, Number(bound[3] ?? 0), bound[4] ?? inferAmPm(h));
      return /^(?:before|antes)/i.test(bound[1]) ? { from: 0, to: at - 1, label: `before ${fmtMinutes(at)}` } : { from: at, to: 24 * 60, label: `from ${fmtMinutes(at)} on` };
    }
  }
  if (/\b(?:mornings?|in\s+the\s+am|(?:por|en|de)\s+la\s+ma[ñn]ana|(?:de|pela|na)\s+manh[ãa])(?![a-zà-ÿ])/i.test(t)) return { from: 0, to: 11 * 60 + 59, label: "in the morning" };
  if (/\b(?:afternoons?|(?:por|en|de)\s+la\s+tarde|(?:de|[àa]|pela|na)\s+tarde)(?![a-zà-ÿ])/i.test(t)) return { from: 12 * 60, to: 16 * 60 + 59, label: "in the afternoon" };
  if (/\b(?:evenings?|tonight|nights?|after\s+work|(?:por|en|de)\s+la\s+noche|esta\s+noche|(?:de|[àa]|pela|na)\s+noite)(?![a-zà-ÿ])/i.test(t)) return { from: 17 * 60, to: 24 * 60, label: "in the evening" };
  return null;
}

type Mention<T> = { at: number; value: T };

// Clock times the client named, with where. A bare hour counts only behind
// "at / a las / às / around" and only in a message with no long number (an
// address, a zip, a phone or a size would make "at 12" mean anything).
function timeMentions(text: string): Array<Mention<number>> {
  // "6:00 p.m." / "6 PM" → "6:00pm" / "6pm", same length is not needed: only the order of the mentions matters.
  const t = (text || "").replace(/(\d)\s*[.:]\s*(\d{2})\s*(a|p)\.?\s*m\.?/gi, "$1:$2$3m").replace(/\b(\d{1,2})\s*(a|p)\.?\s*m\b\.?/gi, "$1$2m");
  const out: Array<Mention<number>> = [];
  const add = (at: number, min: number) => { if (min >= 6 * 60 && min <= 22 * 60 && !out.some((o) => o.value === min && Math.abs(o.at - at) < 3)) out.push({ at, value: min }); };
  // "6 or 7pm", "9 o 11am": the am/pm covers both (11 or 1pm: 11 is am).
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(?:or|o|ou|and|y|e|to|-)\s*(?:a\s+las?\s+|[àa]s\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) add(m.index ?? 0, toMinutes(h, Number(m[2] ?? 0), h > Number(m[3]) && /p/i.test(m[5]) ? "am" : m[5]));
  }
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    const h = Number(m[1]);
    if (h >= 1 && h <= 12) add(m.index ?? 0, toMinutes(h, Number(m[2] ?? 0), m[3]));
  }
  if (!/\d{3,}/.test(t.replace(/\b\d{1,2}:\d{2}\b/g, ""))) {
    const NOT_A_TIME = "(?!\\s*(?:am|pm|:\\d|\\d|sq|ft|feet|pies|p[eé]s|rooms?|bed|steps?|escalones|degraus|%))";
    // "at 7", "a las 7", "às 10", and the second half of "at 9 or 11".
    for (const m of t.matchAll(new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:at|@|around|about|a\\s+las?|como\\s+a\\s+las?|[àa]s|l[aá]\\s+pelas)\\s+(\\d{1,2})(?::(\\d{2}))?${NOT_A_TIME}(?:\\s*(?:or|o|ou|y|e)\\s*(?:a\\s+las?\\s+|[àa]s\\s+)?(\\d{1,2})${NOT_A_TIME}(?![a-zà-ÿ]))?`, "giu"))) {
      const h = Number(m[1]);
      if (h >= 1 && h <= 12) add(m.index ?? 0, toMinutes(h, Number(m[2] ?? 0), inferAmPm(h)));
      const h2 = Number(m[3]);
      if (m[3] && h2 >= 1 && h2 <= 12) add((m.index ?? 0) + 1, toMinutes(h2, 0, inferAmPm(h2)));
    }
    for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:am|pm))/gi)) {
      const h = Number(m[1]);
      if (h >= 1 && h <= 12) add(m.index ?? 0, toMinutes(h, Number(m[2]), inferAmPm(h)));
      else if (h >= 13 && h <= 22) add(m.index ?? 0, h * 60 + Number(m[2]));
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function timesNamed(text: string): number[] {
  return [...new Set(timeMentions(text).map((m) => m.value))].sort((a, b) => a - b);
}

// The schedule lines the client's words point at, with where they were said.
function dayMentions(text: string, days: ScheduleDay[]): Array<Mention<ScheduleDay>> {
  if (days.length === 0) return [];
  const out: Array<Mention<ScheduleDay>> = [];
  const add = (at: number, d?: ScheduleDay) => { if (d) out.push({ at, value: d }); };
  for (const m of text.matchAll(TODAY)) add(m.index ?? 0, days[0]);
  for (const m of text.matchAll(TOMORROW)) add(m.index ?? 0, days[1]);
  // "next week": the first line of that weekday from next Monday on.
  const nextMonday = days.findIndex((d, i) => i > 0 && d.weekday === 1);
  const from = NEXT_WEEK.test(text) && nextMonday > 0 ? nextMonday : 0;
  for (const [num, re] of DAY_WORDS) for (const m of text.matchAll(re)) add(m.index ?? 0, days.slice(from).find((d) => d.weekday === num));
  // "the 25th", "Sept 25", "25 de septiembre".
  for (const m of text.matchAll(DATE_NUMBER)) add(m.index ?? 0, days.find((d) => Number(d.date.slice(8)) === Number(m[1] ?? m[2] ?? m[3])));
  return out.sort((a, b) => a.at - b.at);
}

export function daysNamed(text: string, days: ScheduleDay[]): ScheduleDay[] {
  return [...new Set(dayMentions(text, days).map((m) => m.value))].sort((a, b) => (a.date < b.date ? -1 : 1));
}

const closest = (open: number[], want: number): number[] => {
  const before = [...open].reverse().find((x) => x < want);
  const after = open.find((x) => x > want);
  return [before, after].filter((x): x is number => x !== undefined);
};

// The note, or null when the client named no time and no part of the day (the
// model then reads the schedule lines as it always did).
export function requestedTimesNote(clientText: string, availability: string): string | null {
  const text = (clientText || "").split(/\n\n?\[SYSTEM:/)[0];
  if (!text.trim()) return null;
  const days = parseScheduleNote(availability);
  if (days.length === 0) return null;
  const tMentions = timeMentions(text);
  const times = [...new Set(tMentions.map((m) => m.value))].sort((a, b) => a - b);
  const win = times.length === 0 ? windowNamed(text) : null;
  if (times.length === 0 && !win) return null;
  const dMentions = dayMentions(text, days);
  const named = [...new Set(dMentions.map((m) => m.value))].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (times.length > 3 || named.length > 3) return null; // a list that long is not a request, the model reads it
  const facts: string[] = [];

  if (named.length > 0) {
    // Each time belongs to the day said just before it ("Wed at 7 or Thursday
    // at 6"), or to the first day when it comes before any ("at 5 on Friday").
    // A day with no time of its own takes them all ("… Or Thursday or Friday").
    const own = new Map<ScheduleDay, Set<number>>();
    for (const tm of tMentions) {
      const before = dMentions.filter((d) => d.at <= tm.at);
      const day = (before[before.length - 1] ?? dMentions[0]).value;
      if (!own.has(day)) own.set(day, new Set());
      own.get(day)!.add(tm.value);
    }
    for (const d of named) {
      if (d.open.length === 0) {
        const next = days.find((x) => x.date > d.date && x.open.length > 0);
        facts.push(`${d.label}: nothing open that day${next ? ` (next open: ${next.label} at ${fmtMinutes(next.open[0])})` : ""}.`);
        continue;
      }
      if (win) {
        const inWin = d.open.filter((x) => x >= win.from && x <= win.to);
        facts.push(inWin.length > 0
          ? `${d.label} ${win.label}: OPEN at ${inWin.slice(0, 4).map(fmtMinutes).join(", ")}.`
          : `${d.label} ${win.label}: nothing open (that day has ${d.open.slice(0, 4).map(fmtMinutes).join(", ")}).`);
        continue;
      }
      for (const want of [...(own.get(d) ?? times)].sort((a, b) => a - b)) {
        facts.push(d.open.includes(want)
          ? `${d.label} at ${fmtMinutes(want)}: OPEN.`
          : `${d.label} at ${fmtMinutes(want)}: NOT open (closest open that day: ${closest(d.open, want).map(fmtMinutes).join(", ") || "none"}).`);
      }
    }
  } else {
    // A time or a part of the day with no day: the soonest days that have it.
    const hits: string[] = [];
    for (const d of days) {
      if (hits.length >= 2) break;
      const match = win ? d.open.filter((x) => x >= win.from && x <= win.to) : d.open.filter((x) => times.includes(x));
      if (match.length > 0) hits.push(`${d.label} at ${match.slice(0, 3).map(fmtMinutes).join(", ")}`);
    }
    const what = win ? win.label : "at " + times.map(fmtMinutes).join(" / ");
    facts.push(hits.length > 0 ? `Soonest days OPEN ${what}: ${hits.join("; ")}.` : `Nothing open ${what} in the coming days.`);
  }
  if (facts.length === 0) return null;
  return `[REQUESTED TIMES, already looked up for you in the schedule above: ${facts.join(" ")} These are facts: do not re-check them and never explain or mention them, just answer. A time marked OPEN that the client asked for is accepted. A time marked NOT open is never accepted, offer the closest ones instead. Two options at most.]`;
}

// The client's un-answered burst (every bubble since our last message),
// without the [SYSTEM: …] notes the webhooks append.
export function unansweredBurstText(messages: Array<{ role: string; content: string }>): string {
  const out: string[] = [];
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") break;
    if (messages[i].role === "user") out.unshift((messages[i].content || "").split(/\n\n?\[SYSTEM:/)[0]);
  }
  return out.join("\n");
}

// Attaches the note to the client's last message when that message carries the
// schedule. Read last, right after the schedule it refers to.
export function withRequestedTimesNote<T extends { role: string; content: string }>(messages: T[]): T[] {
  const last = messages?.[messages.length - 1];
  if (!last || last.role !== "user" || !/REAL-TIME SCHEDULE AVAILABILITY/.test(last.content) || /\[REQUESTED TIMES,/.test(last.content)) return messages;
  const note = requestedTimesNote(unansweredBurstText(messages), last.content.slice(last.content.indexOf("REAL-TIME SCHEDULE AVAILABILITY")));
  if (!note) return messages;
  return [...messages.slice(0, -1), { ...last, content: `${last.content}\n\n${note}` }];
}
