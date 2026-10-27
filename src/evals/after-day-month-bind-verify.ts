/**
 * REGRESSION GUARD — "any date after the 18th" (WhatsApp client, 25/10/2026 21:30 ET).
 *
 * The client wrote "will do a date in December any date after the 18th". The bot
 * answered "Does Friday the 18th work, at 9am or 8pm?" and, when she repeated it,
 * "I've got Wednesday December 18th at 9am or 8pm" (December 18, 2026 is a FRIDAY;
 * she had to correct the bot). Two causes:
 *   1. clientRequestedWindows resolved the bare "the 18th" to the NEAREST 18th
 *      (November 18, a Wednesday) instead of the December named in the same message,
 *      and the bare "December" to its first week: the schedule listed Nov 18-24 and
 *      Dec 1-7, never Dec 18 or the days after it. The model took "Wednesday" and
 *      "9am or 8pm" from the November 18 line and "December" from the client. "after
 *      the 18th" was not read at all, so the 18th itself was offered.
 *   2. reconcileOfferedDates (the weekday↔date guard of the sentence we send) only
 *      works inside the 21-day window and lets the weekday win: beyond it nothing
 *      checked "Wednesday December 18th".
 * Fix: a bare day of the month takes the month named in the same message (the bare
 * month is then that day, not its first week); "after the 18th" / "después del 18" /
 * "depois do dia 18" lists the days that FOLLOW and the schedule says the 18th itself
 * is not wanted; "before" lists the days before; a long month glued to the next word
 * ("Decemberany") still counts; on a date the client named, the weekday word is fixed
 * to the date (any distance ahead, EN/ES/PT) and the three webhooks pass the history.
 *
 * Pure parts: zero API calls. [4] reads the real schedule (DB, read-only).
 * LIVE=1 N=2: replays the client's message through the brain with the webhook notes.
 * Run: npx tsx src/evals/after-day-month-bind-verify.ts   |   LIVE=1 N=2 npx tsx src/evals/after-day-month-bind-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  clientRequestedWindows,
  clientNamedDates,
  reconcileOfferedDates,
  getRealAvailabilityContext,
  getEasternDateContext,
  easternTodayStr,
  offeredSlotsOf,
  scheduleLinesOf,
} from "../lib/scheduler";
import { offerLineDeviation } from "../lib/offer-line-guard";
import { getAIResponse, adFlooringTypeNote } from "../lib/ai";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 260)}»`); }
}
type Msg = { role: "user" | "assistant"; content: string; at?: string };
const U = (content: string, at?: string): Msg => (at ? { role: "user", content, at } : { role: "user", content });
const A = (content: string, at?: string): Msg => (at ? { role: "assistant", content, at } : { role: "assistant", content });
const J = (x: unknown) => JSON.stringify(x);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ymd = (s: string) => { const d = new Date(s + "T12:00:00Z"); return { weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate(), year: d.getUTCFullYear() }; };
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const todayET = easternTodayStr();

// The client's message, verbatim (no personal data in it), written 25/10/2026 21:31 ET.
const REAL = "I’m just shopping around not quite ready but looking to start early January will do a date in December any date after the 18th";
const REAL_GLUED = "I’m just shopping around not quite ready but looking to start early January will do a date in Decemberany date after the 18th";
const AT = "2026-10-26T01:31:08Z";
const T = "2026-10-25", H = "2026-11-14"; // today + the end of the 21-day list, as on the night of the case
const w = (msgs: Msg[], today = T, horizon = H) => clientRequestedWindows(msgs, today, horizon);
const at = (c: string) => U(c, AT);
const DEC19 = { from: "2026-12-19", to: "2026-12-25", after: "2026-12-18" };
const JAN1 = { from: "2027-01-01", to: "2027-01-07" };

async function main() {
  console.log("\n============== AFTER-DAY / MONTH-BIND VERIFY (WhatsApp, 25/10/2026) ==============");

  // ── 1. THE WINDOWS THE CLIENT ASKED FOR ────────────────────────────────────
  console.log("\n[1] clientRequestedWindows: the bare day takes the month named in the message; 'after' starts the day after");
  ck("the real message → Dec 19..25 (after Dec 18) + early January, nothing in November, no Dec 1..7", J(w([at(REAL)])) === J([DEC19, JAN1]), J(w([at(REAL)])));
  ck("the glued 'Decemberany date after the 18th' → the same", J(w([at(REAL_GLUED)])) === J([DEC19, JAN1]), J(w([at(REAL_GLUED)])));
  ck("'a date in December any date after the 18th' alone → only Dec 19..25 (the bare December is that day, not its first week)", J(w([at("a date in December any date after the 18th")])) === J([DEC19]), J(w([at("a date in December any date after the 18th")])));
  ck("'the 18th' with no month → the nearest 18th (Nov 18..24), as before", J(w([at("I can do the 18th")])) === J([{ from: "2026-11-18", to: "2026-11-24" }]), J(w([at("I can do the 18th")])));
  ck("'after the 18th' with no month → Nov 19..25, after Nov 18", J(w([at("any day after the 18th")])) === J([{ from: "2026-11-19", to: "2026-11-25", after: "2026-11-18" }]), J(w([at("any day after the 18th")])));
  ck("'Friday the 18th' → the first 18th that is a Friday: Dec 18..24 (Nov 18 is a Wednesday)", J(w([at("Friday the 18th works")])) === J([{ from: "2026-12-18", to: "2026-12-24" }]), J(w([at("Friday the 18th works")])));
  ck("'Wednesday December 18th' (the client's wrong weekday) → Dec 18..24, the date wins", J(w([at("Wednesday December 18th works")])) === J([{ from: "2026-12-18", to: "2026-12-24" }]), J(w([at("Wednesday December 18th works")])));
  ck("'after December 18th' → Dec 19..25 after Dec 18", J(w([at("anything after December 18th")])) === J([DEC19]), J(w([at("anything after December 18th")])));
  ck("'después del 18 de diciembre' → Dec 19..25", J(w([at("después del 18 de diciembre")])) === J([DEC19]), J(w([at("después del 18 de diciembre")])));
  ck("'depois do dia 18 de dezembro' → Dec 19..25", J(w([at("pode ser depois do dia 18 de dezembro")])) === J([DEC19]), J(w([at("pode ser depois do dia 18 de dezembro")])));
  ck("'en diciembre, después del 18' → Dec 19..25", J(w([at("en diciembre, después del 18")])) === J([DEC19]), J(w([at("en diciembre, después del 18")])));
  ck("'después del 18' with no month → Nov 19..25 after Nov 18 ('del 18' is a day of the month)", J(w([at("después del 18")])) === J([{ from: "2026-11-19", to: "2026-11-25", after: "2026-11-18" }]), J(w([at("después del 18")])));
  ck("'a partir del 18' → Nov 18..24 (inclusive)", J(w([at("a partir del 18")])) === J([{ from: "2026-11-18", to: "2026-11-24" }]), J(w([at("a partir del 18")])));  ck("'before December 18th' → Dec 11..17", J(w([at("before December 18th please")])) === J([{ from: "2026-12-11", to: "2026-12-17" }]), J(w([at("before December 18th please")])));
  ck("'a partir del 18 de diciembre' includes the 18th → Dec 18..24, no 'after'", J(w([at("a partir del 18 de diciembre")])) === J([{ from: "2026-12-18", to: "2026-12-24" }]), J(w([at("a partir del 18 de diciembre")])));
  ck("'from December 18th on' includes the 18th", J(w([at("from December 18th on")])) === J([{ from: "2026-12-18", to: "2026-12-24" }]), J(w([at("from December 18th on")])));
  ck("'after 5pm on the 18th' is a time, not an 'after the day' → Nov 18..24", J(w([at("after 5pm on the 18th")])) === J([{ from: "2026-11-18", to: "2026-11-24" }]), J(w([at("after 5pm on the 18th")])));
  ck("'December 15th or the 20th' → the 20th is December too, merged Dec 15..26", J(w([at("December 15th or the 20th")])) === J([{ from: "2026-12-15", to: "2026-12-26" }]), J(w([at("December 15th or the 20th")])));
  ck("'first week of January, or the 15th' → both kept (a month PART is its own option)", J(w([at("first week of January, or the 15th")])) === J([JAN1, { from: "2027-01-15", to: "2027-01-21" }]), J(w([at("first week of January, or the 15th")])));
  ck("'the 15th of December' → Dec 15..21 (bound through 'of')", J(w([at("I'm back the 15th of December")])) === J([{ from: "2026-12-15", to: "2026-12-21" }]), J(w([at("I'm back the 15th of December")])));
  ck("'15 de diciembre' → Dec 15..21 only, no first-week window", J(w([at("vuelvo el 15 de diciembre")])) === J([{ from: "2026-12-15", to: "2026-12-21" }]), J(w([at("vuelvo el 15 de diciembre")])));
  ck("'December 15th' unchanged → Dec 15..21", J(w([at("I'm back December 15th, can we do it then?")])) === J([{ from: "2026-12-15", to: "2026-12-21" }]));
  ck("'in December' alone → its first week, as before", J(w([at("I'm only available in December")])) === J([{ from: "2026-12-01", to: "2026-12-07" }]), J(w([at("I'm only available in December")])));
  ck("'mediados de enero' → Jan 14..20, as before", J(w([at("a mediados de enero")])) === J([{ from: "2027-01-14", to: "2027-01-20" }]));
  ck("'I may come by the showroom' is not May", w([at("I may come by the showroom")]).length === 0);
  ck("'maybe decemberish' is not a date… but IS December (glued long month)", J(w([at("maybe decemberish")])) === J([{ from: "2026-12-01", to: "2026-12-07" }]), J(w([at("maybe decemberish")])));
  ck("a story about a past date does not count ('we moved in on 9/30')", w([at("we moved in on 9/30")]).length === 0);
  ck("a street address's '7th' is not a day", w([at("123 NW 7th st, Miami")]).length === 0);
  ck("the bot's own 'after December 18th' does not count", w([A("I can do anything after December 18th", AT)]).length === 0);
  const merged = w([at("December 15th or after the 18th")]);
  ck("'December 15th or after the 18th' → one window Dec 15..25 that includes the 18th: no 'after' left", J(merged) === J([{ from: "2026-12-15", to: "2026-12-25" }]), J(merged));

  // ── 2. THE DATES THE CLIENT NAMED ─────────────────────────────────────────
  console.log("\n[2] clientNamedDates: what the weekday↔date guard treats as the client's own date");
  const named = clientNamedDates([at(REAL)], T);
  ck("the real message names December 18 (and not November 18)", named.has("2026-12-18") && !named.has("2026-11-18"), [...named].join(","));
  ck("'December 18th a Friday' names December 18", clientNamedDates([at("December 18th a Friday")], T).has("2026-12-18"));
  ck("'33404' and a street address name no date", clientNamedDates([at("33404"), at("105harbor street riviera beaches")], T).size === 0);
  ck("the bot's dates are not the client's", clientNamedDates([A("Does Friday the 18th work?", AT)], T).size === 0);

  // ── 3. THE WEEKDAY WORD FIXED TO THE CLIENT'S DATE ────────────────────────
  console.log("\n[3] reconcileOfferedDates with the history: on a client-named date the weekday word is rewritten (EN/ES/PT)");
  {
    const hist = [at(REAL)];
    const r1 = reconcileOfferedDates("Got it, no rush at all. I've got Wednesday December 18th at 9am or 8pm, which works better for you?", T, hist);
    ck("'Wednesday December 18th' → 'Friday December 18th' (1 correction)", /Friday December 18th at 9am or 8pm/.test(r1.text) && r1.corrections.length === 1, r1.text + " | " + J(r1.corrections));
    const r2 = reconcileOfferedDates("Perfect, I'm holding that Wednesday December 18th at 9am for you! Can I get the full property address to lock it in?", T, hist);
    ck("'holding that Wednesday December 18th' → Friday", /holding that Friday December 18th at 9am/.test(r2.text), r2.text);
    const r3 = reconcileOfferedDates("I've got Friday December 18th at 9am or 8pm, which works better?", T, hist);
    ck("a correct 'Friday December 18th' is untouched", r3.text.includes("Friday December 18th") && r3.corrections.length === 0, r3.text);
    const r4 = reconcileOfferedDates("Got it, I've got Wednesday December 18th at 9am or 8pm", T);
    ck("WITHOUT the history (no client date) a date beyond the 21 days stays untouched, as before", r4.corrections.length === 0, r4.text);
    const r5 = reconcileOfferedDates("Wednesday, December 18 at 9am", T, hist);
    ck("'Wednesday, December 18' keeps the comma and the capital: 'Friday, December 18'", r5.text === "Friday, December 18 at 9am", r5.text);
    const es = reconcileOfferedDates("Te tengo el miércoles 18 de diciembre a las 9am o 8pm, cuál te queda mejor?", T, [at("después del 18 de diciembre")]);
    ck("ES: 'miércoles 18 de diciembre' → 'viernes 18 de diciembre'", /el viernes 18 de diciembre a las 9am/.test(es.text) && es.corrections.length === 1, es.text);
    const pt = reconcileOfferedDates("Tenho quarta-feira, 18 de dezembro às 9am ou 8pm, qual fica melhor?", T, [at("depois do dia 18 de dezembro")]);
    ck("PT: 'quarta-feira, 18 de dezembro' → 'sexta-feira, 18 de dezembro'", /Tenho sexta-feira, 18 de dezembro às 9am/.test(pt.text) && pt.corrections.length === 1, pt.text);
    const pt2 = reconcileOfferedDates("Tenho quarta, dia 18 de dezembro às 9am", T, [at("depois do dia 18 de dezembro")]);
    ck("PT without -feira: 'quarta, dia 18 de dezembro' → 'sexta, dia 18 de dezembro'", /Tenho sexta, dia 18 de dezembro/.test(pt2.text), pt2.text);
    const tag = `Perfect, Wednesday December 18th at 9am it is! [BOOK:{"date":"2026-12-18","time":"09:00","address":"105 Harbor Street, Riviera Beach, FL 33404","phone":"15610000000","name":""}]`;
    const r6 = reconcileOfferedDates(tag, T, [at(REAL), at("Yes 9am works"), at("105harbor street riviera beaches 33404")]);
    ck("a [BOOK] tag stays byte-identical while the prose weekday is fixed", r6.text.includes(`[BOOK:{"date":"2026-12-18","time":"09:00"`) && r6.text.startsWith("Perfect, Friday December 18th at 9am it is!"), r6.text);
    // Inside the 21 days the OLD rule (weekday wins) still runs when the client named no date…
    const old = reconcileOfferedDates("I have Friday July 31 at 7pm or Sunday August 3 at 11am, which works better for you?", "2026-07-29");
    ck("old behaviour intact: 'Sunday August 3' (a Monday) → 'Sunday August 2', 'Friday July 31' untouched", /Friday July 31 at 7pm or Sunday August 2 at 11am/.test(old.text), old.text);
    // …and the client's own date wins even inside the 21 days.
    const inWin = reconcileOfferedDates("Sure, Thursday October 30th at 9am or 5pm, which works?", T, [at("can you come October 30th?")]);
    ck("client-named date inside the 21 days: 'Thursday October 30th' → 'Friday October 30th' (October 30, 2026 is a Friday)", /Friday October 30th at 9am or 5pm/.test(inWin.text), inWin.text);
    const inWinOld = reconcileOfferedDates("Sure, Thursday October 30th at 9am or 5pm, which works?", T);
    ck("same sentence with no client date: the weekday wins as before → 'Thursday October 29th'", /Thursday October 29th/.test(inWinOld.text), inWinOld.text);
    // The fixed sentence is readable by the slot parsers (weekday and date agree again).
    const slots = offeredSlotsOf(r1.text, T);
    ck("after the fix the offered slots resolve to 2026-12-18 (before: weekday≠date → unreadable)", slots.length === 2 && slots.every((s) => s.date === "2026-12-18") && offeredSlotsOf("I've got Wednesday December 18th at 9am or 8pm", T).length === 0, J(slots));
    const avail = "REAL-TIME SCHEDULE AVAILABILITY:\n• Friday, December 18, 2026 [2026-12-18]: 9am, 11am, 1pm";
    const dev = offerLineDeviation(r1.text, avail, hist, T);
    ck("…so the offer-line guard can judge the 8pm against that day's line", dev?.kind === "off-line", J(dev));
  }

  // ── 4. THE REAL SCHEDULE TEXT (DB, read-only) ─────────────────────────────
  console.log("\n[4] getRealAvailabilityContext lists Dec 19..25 with the AFTER note, never November 18 or Dec 1..7");
  if (todayET > "2026-12-10") {
    console.log("  ⏭  (December 18, 2026 is too close or past: the live listing is covered by [1] with frozen dates)");
  } else {
    const avail = await getRealAvailabilityContext({ history: [U(REAL)] });
    const live = !/Could not fetch real-time schedule/.test(avail);
    if (!live) console.log("  ⚠ schedule not readable from here (DB/env) — skipping the live checks");
    if (live) {
      const dates = scheduleLinesOf(avail).map((l) => l.date);
      ck("seven lines Dec 19..25", ["2026-12-19", "2026-12-20", "2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-25"].every((d) => dates.includes(d)), dates.filter((d) => d >= "2026-12-01").join(","));
      ck("no line for December 18, none for November 18, none for Dec 1..7", !dates.includes("2026-12-18") && !dates.includes("2026-11-18") && !dates.some((d) => d >= "2026-12-01" && d <= "2026-12-07"), dates.filter((d) => d >= "2026-11-15").join(","));
      ck("early January still listed (Jan 1..7)", dates.includes("2027-01-01") && dates.includes("2027-01-07"));
      ck("the AFTER note names Friday, December 18 [2026-12-18]", /\(the client asked for a date AFTER Friday, December 18 \[2026-12-18\]: that day itself is not wanted, never offer it; start from the first line below\)/.test(avail), avail.split("\n").filter((l) => /AFTER/.test(l)).join(" | "));
      ck("rule: the day number belongs to the month the client named, weekday read from THAT line", /belongs to the month the client named and its week is listed under DATES THE CLIENT ASKED FOR: read its weekday from THAT line/.test(avail));
    }
  }

  // ── 5. STATIC: the webhooks pass the history to the weekday↔date guard ────
  console.log("\n[5] The three webhooks pass the history to reconcileOfferedDates");
  for (const f of ["src/app/api/wa-webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/webhook/route.ts"]) {
    const src = readFileSync(join(process.cwd(), f), "utf-8");
    ck(`${f}: reconcileOfferedDates(..., undefined, history)`, /reconcileOfferedDates\((?:safeResponse|safeAiText), undefined, history\)/.test(src));
  }

  // ── 6. LIVE: the model, given the fixed schedule, offers from December 19 ──
  if (process.env.LIVE === "1" && todayET <= "2026-12-10") {
    const N = Number(process.env.N ?? 2);
    console.log(`\n━━ LIVE: replay of the client's message through the brain (WhatsApp webhook notes), ${N} sample(s) ━━`);
    const phone = "15610000000";
    const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
    const tmr = ymd(addDays(todayET, 1));
    const hist: Msg[] = [
      U("What is the installation process?"),
      A("We come in, lay everything out, move the furniture, install the tile, and leave the space clean and ready to use, usually done in 2 to 3 days. Are you thinking of one area or the whole house?"),
      U("Yes"),
      A("Which type of flooring are you looking at, tile, vinyl, or hardwood?"),
      U("Tile \nDownstairs living and kitchen"),
      U("With bathroom"),
      A("Tile for the living room, kitchen and bathroom is a solid combo. For that size I need to measure in person to give you the best price, it's a free visit and I bring the samples. What's the zip code of the property?"),
      U("33404"),
      A(`33404 is covered! I have ${DAYS[tmr.weekday]} the ${ord(tmr.day)} at 2pm or 4pm, which works better for you?`),
      U(REAL),
    ];
    const availability = await getRealAvailabilityContext({ history: hist });
    const parts = [getEasternDateContext(), availability, waNote, adFlooringTypeNote("tile")];
    const messages = hist.map(({ role, content }) => ({ role, content }));
    messages[messages.length - 1] = { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n[SYSTEM: ${parts.join("\n\n")}]` };
    for (let i = 0; i < N; i++) {
      let text = "";
      try { text = (await getAIResponse(messages, null, null, null, false)).text; } catch (e) { ck(`#${i + 1}: model call`, false, String(e)); continue; }
      const fixed = reconcileOfferedDates(text, todayET, hist);
      const slots = offeredSlotsOf(fixed.text, todayET);
      ck(`#${i + 1}: offers visit times`, slots.length > 0, text);
      ck(`#${i + 1}: every offered time is on Dec 19..25 (never the 18th, never November)`, slots.length > 0 && slots.every((s) => s.date >= "2026-12-19" && s.date <= "2026-12-25"), `${J(slots.map((s) => `${s.date} ${s.label}`))} | ${text}`);
      ck(`#${i + 1}: the times are on their day's line`, offerLineDeviation(fixed.text, availability, hist, todayET) === null, J(offerLineDeviation(fixed.text, availability, hist, todayET)));
      ck(`#${i + 1}: the weekday matched the date in the draft itself (no correction needed)`, fixed.corrections.length === 0, J(fixed.corrections) + " | " + text);
      console.log(`     → ${text.replace(/\s+/g, " ").slice(0, 240)}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed${fails.length ? "\n  - " + fails.join("\n  - ") : ""}`);
  process.exit(fail ? 1 : 0);
}
void main();
