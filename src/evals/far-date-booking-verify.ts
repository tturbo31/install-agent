/**
 * REGRESSION GUARD — the visit booked on the wrong Friday + any future date is
 * bookable (fb_37685589211085730, Messenger 15/10/2026; owner rule 15/10/2026).
 *
 * The conversation: the bot offered "Friday the 16th at 9am or 1pm"; the client
 * answered "I'll be in town 10/26-11/3 only"; the bot offered "October 26th at
 * 9am or 11am"; the client sent ONE bubble: "9 would be great" + the street
 * address + "call me before you exit your car" + the phone. The model wrote the
 * [BOOK] for Monday 2026-10-26 09:00 and the webhook confirmed FRIDAY October 23.
 *
 * Three things failed in a row:
 *   1. pickedHourInPhrase judged the whole bubble: address + phone = "not a pick",
 *      so acceptedOfferSlot found no accepted slot;
 *   2. reconcileBookingWeekday then anchored on the LAST bot message naming a
 *      weekday ("Friday the 16th"), although a newer offer named the day by its
 *      date ("October 26th"), and the client's "10/26-11/3" did not count as a
 *      date term; it snapped Monday 26 to the nearest Friday, the 23rd;
 *   3. in the accepted-slot rule, "the offer's own date settles it" only SKIPPED
 *      the rule instead of ending the guard.
 * Plus the owner rule: the client is a snowbird who on 22/08 said "first week of
 * January" and was told "just reach out when you're ready in January". Any
 * future date is bookable: the schedule lists the week around every later date
 * the client names (clientRequestedWindows) and the booked-slot read of
 * createBooking / reschedule reaches that day (bookedRangeEnd).
 *
 * Deterministic parts: zero API calls. [6] reads the real schedule (DB).
 * Run: npx tsx src/evals/far-date-booking-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  reconcileBookingWeekday,
  acceptedOfferSlot,
  pickedHourInPhrase,
  clientRequestedWindows,
  bookedRangeEnd,
  getRealAvailabilityContext,
  easternTodayStr,
  dayOnlyPickNeedsTime,
  clientConfirmedSlot,
  bookedTimeSeenInConversation,
  bookedSlotMismatchesPromise,
} from "../lib/scheduler";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 220)}»`); }
}
type Msg = { role: string; content: string; at?: string };
const U = (content: string, at?: string): Msg => (at ? { role: "user", content, at } : { role: "user", content });
const A = (content: string, at?: string): Msg => (at ? { role: "assistant", content, at } : { role: "assistant", content });
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ymd = (s: string) => { const d = new Date(s + "T12:00:00Z"); return { weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate(), year: d.getUTCFullYear() }; };
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const todayET = easternTodayStr();

const ADDRESS_BUBBLE = "9 would be great\n300 Diplomat Pkwy I’ll need to give you parking instructions so you’ll need to call me before you exit your car 617-905-3882";

async function main() {
  console.log("\n============== FAR-DATE BOOKING VERIFY (fb_37685589211085730, 15/10/2026) ==============");

  // ── 1. THE EXACT PRODUCTION TRANSCRIPT (real timestamps) ───────────────────
  console.log("\n[1] The real conversation: the [BOOK] for Monday October 26 must stay on October 26");
  const prod: Msg[] = [
    U("I’m just looking for baseboard replacement I had floors done a few months ago and don’t like the 1/4 round", "2026-10-15T17:33:34Z"),
    A("Baseboards are $1/ft for material and $3/ft for installation, I'd measure the perimeter at the visit. What's the zip code?", "2026-10-15T17:34:02Z"),
    U("33009", "2026-10-15T17:34:16Z"),
    A("That's in our area, I have Friday the 16th at 9am or 1pm, which works better?", "2026-10-15T17:34:32Z"),
    U("I’ll be in town 10/26-11/3 only is that enough time to get and estimate and get the job done?", "2026-10-15T17:35:26Z"),
    A("Yes, plenty of time. I can come measure on October 26th at 9am or 11am, which works better?", "2026-10-15T17:35:42Z"),
    U(ADDRESS_BUBBLE, "2026-10-15T17:37:17Z"),
  ];
  {
    const acc = acceptedOfferSlot(prod);
    ck("acceptedOfferSlot: the 9am of October 26 (the pick lives in the address bubble)", acc?.date === "2026-10-26" && acc?.time === "09:00", JSON.stringify(acc));
    const ok = reconcileBookingWeekday("2026-10-26", prod, "09:00");
    ck("[BOOK] 2026-10-26 09:00 is NOT moved (was: snapped to Friday 2026-10-23)", !ok.corrected && ok.date === "2026-10-26", JSON.stringify(ok));
    if (todayET <= "2026-10-26") {
      const fix = reconcileBookingWeekday("2026-10-23", prod, "09:00");
      ck("a [BOOK] written for Friday 2026-10-23 is pulled back to the accepted October 26", fix.corrected && fix.date === "2026-10-26", JSON.stringify(fix));
      const noTs = prod.map(({ role, content }) => ({ role, content })); // what the webhooks pass
      const ok2 = reconcileBookingWeekday("2026-10-26", noTs, "09:00");
      ck("same without timestamps (webhook history)", !ok2.corrected && ok2.date === "2026-10-26", JSON.stringify(ok2));
    } else {
      console.log("  ⏭  (October 26, 2026 has passed: the frozen snap-back cases are covered by [2] with live dates)");
    }
    ck("1/4 round in the first bubble is not a date (acceptedOfferSlot unaffected)", acceptedOfferSlot(prod)?.date === "2026-10-26");
  }

  // ── 2. THE SAME CONVERSATION WITH LIVE DATES (always green) ───────────────
  console.log("\n[2] Same shape, dates relative to today: every booking guard lets the right date through");
  const d1 = addDays(todayET, 1);
  let d2 = addDays(todayET, 11);
  if (ymd(d2).weekday === ymd(d1).weekday) d2 = addDays(todayET, 12);
  const d3 = addDays(d2, 8);
  const f1 = ymd(d1), f2 = ymd(d2), f3 = ymd(d3);
  // the date the OLD guard produced: the nearest date with the first offer's weekday
  const fwd = ((f1.weekday - f2.weekday) % 7 + 7) % 7;
  const wrong = addDays(d2, Math.abs(fwd) <= Math.abs(fwd - 7) ? fwd : fwd - 7);
  const build = (offer2: string, pickBubble: Msg[]): Msg[] => [
    U("I’m just looking for baseboard replacement I had floors done a few months ago and don’t like the 1/4 round"),
    A("Baseboards are $1/ft for material and $3/ft for installation, I'd measure the perimeter at the visit. What's the zip code?"),
    U("33009"),
    A(`That's in our area, I have ${DAYS[f1.weekday]} the ${ord(f1.day)} at 9am or 1pm, which works better?`),
    U(`I’ll be in town ${f2.month + 1}/${f2.day}-${f3.month + 1}/${f3.day} only is that enough time to get and estimate and get the job done?`),
    A(offer2),
    ...pickBubble,
  ];
  const variants: Array<[string, Msg[]]> = [
    ["month-name offer, one bubble", build(`Yes, plenty of time. I can come measure on ${MONTHS[f2.month]} ${ord(f2.day)} at 9am or 11am, which works better?`, [U(ADDRESS_BUBBLE)])],
    ["numeric-date offer, one bubble", build(`Yes, plenty of time. I can come measure on ${f2.month + 1}/${f2.day} at 9am or 11am, which works better?`, [U(ADDRESS_BUBBLE)])],
    ["pick and address in separate bubbles", build(`Yes, plenty of time. I can come measure on ${MONTHS[f2.month]} ${ord(f2.day)} at 9am or 11am, which works better?`, [U("9 would be great"), U("300 Diplomat Pkwy 33009, call me before you exit your car 617-905-3882")])],
  ];
  for (const [label, hist] of variants) {
    const acc = acceptedOfferSlot(hist);
    ck(`${label}: accepted slot = ${d2} 09:00`, acc?.date === d2 && acc?.time === "09:00", JSON.stringify(acc));
    const ok = reconcileBookingWeekday(d2, hist, "09:00");
    ck(`${label}: [BOOK] ${d2} not moved`, !ok.corrected && ok.date === d2, JSON.stringify(ok));
    const fix = reconcileBookingWeekday(wrong, hist, "09:00");
    ck(`${label}: a [BOOK] on ${wrong} (${DAYS[f1.weekday]}) is pulled to ${d2}`, fix.corrected && fix.date === d2, JSON.stringify(fix));
    ck(`${label}: clientConfirmedSlot`, clientConfirmedSlot(hist));
    ck(`${label}: dayOnlyPickNeedsTime = false`, !dayOnlyPickNeedsTime(hist));
    ck(`${label}: bookedTimeSeenInConversation 09:00`, bookedTimeSeenInConversation(hist, "09:00"));
    const pm = bookedSlotMismatchesPromise(hist, d2, "09:00");
    ck(`${label}: promise guard passes ${d2} 09:00`, !pm.mismatch, JSON.stringify(pm));
  }
  // The old anchor still works when it IS the latest offer (no regression on the weekday rule).
  {
    const hist = [A(`I have ${DAYS[f1.weekday]} at 9am or 1pm, which works better?`), U("9 is good"), A("Perfect, what's the address and the best phone?"), U("300 Diplomat Pkwy 33009, 617-905-3882")];
    const fix = reconcileBookingWeekday(addDays(d1, 1), hist, "09:00");
    ck(`weekday offer answered with '9 is good': a [BOOK] one day off is snapped back to ${DAYS[f1.weekday]}`, fix.corrected && ymd(fix.date).weekday === f1.weekday, JSON.stringify(fix));
  }

  // ── 3. THE PICK INSIDE A BUSY BUBBLE ──────────────────────────────────────
  console.log("\n[3] pickedHourInPhrase judges each line / sentence, not the whole bubble");
  const off = new Set([9, 11]);
  ck("'9 would be great' + address + phone in one bubble → 9", pickedHourInPhrase(ADDRESS_BUBBLE, off) === 9);
  ck("pick sentence in the middle of a long bubble → 11", pickedHourInPhrase("Thanks for the info. 11 works for me. The address is 300 Diplomat Pkwy 33009 and my number is 617-905-3882", off) === 11);
  ck("'9 would be great' alone → 9", pickedHourInPhrase("9 would be great", off) === 9);
  ck("'I prefer 8' (Annabelle) still → 8", pickedHourInPhrase("I prefer 8", new Set([6, 8])) === 8);
  ck("'300 Diplomat Pkwy' alone → no pick", pickedHourInPhrase("300 Diplomat Pkwy", off) === null);
  ck("'Apt 9, 300 Diplomat Pkwy 33009' → no pick", pickedHourInPhrase("Apt 9, 300 Diplomat Pkwy 33009", off) === null);
  ck("'unit 9' → no pick", pickedHourInPhrase("It's unit 9", off) === null);
  ck("a phone number → no pick", pickedHourInPhrase("617-905-3882", off) === null);
  ck("'we have 9 rooms' → no pick", pickedHourInPhrase("we have 9 rooms", off) === null);
  ck("'9 bedrooms. 2 baths.' → no pick", pickedHourInPhrase("9 bedrooms. 2 baths.", off) === null);
  ck("a line longer than 90 chars with the number buried → no pick", pickedHourInPhrase("I was thinking that maybe sometime around when the kids are at school which is usually 9 but it depends on the day honestly", off) === null);

  // ── 4. FRACTIONS ARE NOT DATES ────────────────────────────────────────────
  console.log("\n[4] '1/4 round' and '1/2 inch' are fractions, '10/26' is a date");
  {
    const sat = [A("Saturday I have 9am or 11am, which works?", "2026-10-15T14:00:00Z"), U("9am works. I don't like the 1/4 round btw", "2026-10-15T14:01:00Z")];
    const acc = acceptedOfferSlot(sat);
    ck("'9am works. I don't like the 1/4 round' → Saturday 17/10, not January 4", acc?.date === "2026-10-17" && acc?.time === "09:00", JSON.stringify(acc));
    const half = [A("Saturday I have 9am or 11am, which works?", "2026-10-15T14:00:00Z"), U("11am, it's the 1/2 bath and the hallway", "2026-10-15T14:01:00Z")];
    ck("'1/2 bath' → Saturday 17/10 11:00", acceptedOfferSlot(half)?.date === "2026-10-17", JSON.stringify(acceptedOfferSlot(half)));
    const numeric = [A("Saturday I have 9am or 11am, which works?", "2026-10-15T14:00:00Z"), U("9am but on 10/26 please", "2026-10-15T14:01:00Z")];
    ck("'9am but on 10/26' → 26/10 09:00", acceptedOfferSlot(numeric)?.date === "2026-10-26", JSON.stringify(acceptedOfferSlot(numeric)));
  }

  // ── 5. THE WEEK AROUND THE DATES THE CLIENT ASKED FOR ─────────────────────
  console.log("\n[5] clientRequestedWindows: later dates, weeks and months the client named (pure)");
  const T = "2026-10-15", H = "2026-11-04"; // today + the end of the 21-day list
  const w = (msgs: Msg[], today = T, horizon = H) => clientRequestedWindows(msgs, today, horizon);
  const at = (c: string, d = "2026-10-15T17:35:00Z") => U(c, d);
  ck("'10/26-11/3': 10/26 is inside the 21 days (nothing), 11/3's week reaches past the list → Nov 5..9 only", JSON.stringify(w([at("I’ll be in town 10/26-11/3 only is that enough time?")])) === JSON.stringify([{ from: "2026-11-05", to: "2026-11-09" }]), JSON.stringify(w([at("I’ll be in town 10/26-11/3 only")])));
  ck("'10/26' alone is inside the 21 days → nothing extra", w([at("I’ll be in town 10/26")]).length === 0);
  ck("'I'm back December 15th' → Dec 15..21", JSON.stringify(w([at("I'm back December 15th, can we do it then?")])) === JSON.stringify([{ from: "2026-12-15", to: "2026-12-21" }]), JSON.stringify(w([at("I'm back December 15th, can we do it then?")])));
  ck("'15 de diciembre' → Dec 15..21", JSON.stringify(w([at("vuelvo el 15 de diciembre")])) === JSON.stringify([{ from: "2026-12-15", to: "2026-12-21" }]));
  ck("'11/10' → Nov 10..16", JSON.stringify(w([at("I'm back 11/10")])) === JSON.stringify([{ from: "2026-11-10", to: "2026-11-16" }]));
  ck("'first week of January' said on 22/08 → Jan 1..7 (next year)", JSON.stringify(w([U("Perfect I am a snowbird, I’ll be looking to having this done first week of January Thanks", "2026-08-22T17:50:48Z")], "2026-08-22", "2026-09-11")) === JSON.stringify([{ from: "2027-01-01", to: "2027-01-07" }]), JSON.stringify(w([U("first week of January", "2026-08-22T17:50:48Z")], "2026-08-22", "2026-09-11")));
  ck("'end of January' → Jan 25..31", JSON.stringify(w([at("end of January works")])) === JSON.stringify([{ from: "2027-01-25", to: "2027-01-31" }]));
  ck("'mediados de enero' → Jan 14..20", JSON.stringify(w([at("a mediados de enero")])) === JSON.stringify([{ from: "2027-01-14", to: "2027-01-20" }]));
  ck("'in 3 weeks' → Nov 5..11", JSON.stringify(w([at("I can do it in 3 weeks")])) === JSON.stringify([{ from: "2026-11-05", to: "2026-11-11" }]));
  ck("'en dos meses' → Dec 1..7", JSON.stringify(w([at("en dos meses")])) === JSON.stringify([{ from: "2026-12-01", to: "2026-12-07" }]));
  ck("'next month' → only the days past the 21-day list (Nov 5..7)", JSON.stringify(w([at("maybe next month")])) === JSON.stringify([{ from: "2026-11-05", to: "2026-11-07" }]), JSON.stringify(w([at("maybe next month")])));
  ck("'available in May' → May 1..7 next year", JSON.stringify(w([at("I'm only available in May")])) === JSON.stringify([{ from: "2027-05-01", to: "2027-05-07" }]));
  ck("'I may come' is not the month of May", w([at("I may come by the showroom")]).length === 0);
  ck("'1/4 round' is not January 4", w([at("I don't like the 1/4 round")]).length === 0);
  ck("a street address's '7th' is not a day", w([at("123 NW 7th st, Miami")]).length === 0);
  ck("the bot's own dates do not count", w([A("I can come December 15th at 9am", "2026-10-15T17:35:00Z")]).length === 0);
  ck("a story about a past date does not count ('we moved in on 9/30')", w([at("we moved in on 9/30")]).length === 0, JSON.stringify(w([at("we moved in on 9/30")])));
  ck("a plan on a month-day already passed is NEXT year ('I'm back 9/30' → 2027-09-30..10-06)", JSON.stringify(w([at("I'm back 9/30")])) === JSON.stringify([{ from: "2027-09-30", to: "2027-10-06" }]), JSON.stringify(w([at("I'm back 9/30")])));
  ck("'January 10th works' → Jan 10..16 next year", JSON.stringify(w([at("January 10th works")])) === JSON.stringify([{ from: "2027-01-10", to: "2027-01-16" }]), JSON.stringify(w([at("January 10th works")])));

  // The date-named anchor compares the DAY OF THE MONTH (no timestamps in webhook history).
  console.log("\n[5b] reconcileBookingWeekday with a date-named offer: same day of month → untouched, other day → the offer's date");
  {
    const f = ymd(d2);
    const hist = [A("I have Friday open"), U("actually the 20th works better"), A(`Great, ${MONTHS[f.month]} ${ord(f.day)} at 9am`), U("yes")];
    const same = reconcileBookingWeekday(d2, hist);
    ck(`[BOOK] ${d2} after 'Great, ${MONTHS[f.month]} ${ord(f.day)} at 9am' → untouched`, !same.corrected, JSON.stringify(same));
    const other = reconcileBookingWeekday(addDays(d2, -3), hist);
    ck(`[BOOK] three days early → moved to the offer's ${d2}`, other.corrected && other.date === d2, JSON.stringify(other));
    const twoDays = reconcileBookingWeekday(addDays(d2, -3), [A("I have Friday open"), U("hmm"), A(`I can do ${MONTHS[f.month]} ${ord(f.day)} or the ${ord(ymd(addDays(d2, 1)).day)}, 9am either day`), U("9am")]);
    ck("an offer naming TWO dates is no anchor → untouched", !twoDays.corrected, JSON.stringify(twoDays));
    const countered = reconcileBookingWeekday(addDays(d2, 1), [A(`I can come ${MONTHS[f.month]} ${ord(f.day)} at 9am or 11am`), U(`can we do the ${ord(ymd(addDays(d2, 1)).day)} instead?`), A("Sure, 9am that day?"), U("yes")], "09:00");
    ck("the client countering with another date → the model's date stands", !countered.corrected, JSON.stringify(countered));
  }
  const many = w([at("I'm back 12/15."), at("Or 12/28."), at("Maybe 1/10."), at("Or even 2/5.")]);
  ck("at most three windows, the newest mentions win, sorted", many.length === 3 && many[0].from === "2026-12-28" && many[2].from === "2027-02-05", JSON.stringify(many));
  const merged = w([at("12/15 or 12/18")]);
  ck("overlapping windows merge (12/15 + 12/18 → Dec 15..24)", JSON.stringify(merged) === JSON.stringify([{ from: "2026-12-15", to: "2026-12-24" }]), JSON.stringify(merged));
  ck("never beyond 400 days", w([at("I'm back 10/14")], "2026-10-15", "2026-11-04").length === 0 || w([at("I'm back 10/14")], "2026-10-15", "2026-11-04")[0].to <= "2027-11-19");

  // ── 6. THE REAL SCHEDULE TEXT LISTS THE REQUESTED WEEK (DB) ───────────────
  console.log("\n[6] getRealAvailabilityContext lists the week the client asked for and says any date is bookable");
  {
    const far = addDays(todayET, 45);
    const ff = ymd(far);
    const avail = await getRealAvailabilityContext({ history: [U(`I'm back ${MONTHS[ff.month]} ${ord(ff.day)}, can we do it then?`)] });
    const live = !/Could not fetch real-time schedule/.test(avail);
    if (!live) console.log("  ⚠ schedule not readable from here (DB/env) — skipping the live checks");
    if (live) {
      ck("header DATES THE CLIENT ASKED FOR present", /DATES THE CLIENT ASKED FOR/.test(avail));
      ck(`a line for [${far}] in the same format`, new RegExp(`^• ${DAYS[ff.weekday]}, ${MONTHS[ff.month]} ${ff.day}, ${ff.year} \\[${far}\\]: `, "m").test(avail), avail.split("\n").filter((l) => l.includes(far)).join(" | "));
      ck("seven days listed for the requested week", [...avail.matchAll(/^• .*\[(\d{4}-\d{2}-\d{2})\]/gm)].filter((m) => m[1] >= far && m[1] <= addDays(far, 6)).length === 7);
      ck("rule: ANY FUTURE DATE IS BOOKABLE", /ANY FUTURE DATE IS BOOKABLE, next month and next year included/.test(avail));
      ck("rule: never 'reach out when you're back'", /NEVER send them away to 'reach out when you're back'/.test(avail));
      const plain = await getRealAvailabilityContext({ history: [U("Hi, I want vinyl, I'm in Homestead 33032")] });
      ck("no requested dates → no extra section", !/DATES THE CLIENT ASKED FOR \(/.test(plain));
    }
  }

  // ── 7. STATIC: booking range + prompt ─────────────────────────────────────
  console.log("\n[7] createBooking / reschedule read booked slots up to the visit's day; the prompt no longer sends clients away");
  const sc = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck("createBooking: bookedRangeEnd(..., req.bookingDate)", /bookedRangeEnd\(future\.toISOString\(\)\.slice\(0, 10\), req\.bookingDate\)/.test(sc));
  ck("reschedule: bookedRangeEnd(..., newDate)", /bookedRangeEnd\(future\.toISOString\(\)\.slice\(0, 10\), newDate\)/.test(sc));
  ck("bookedRangeEnd: a visit past the six months extends the range", bookedRangeEnd("2027-04-15", "2027-10-26") === "2027-10-26");
  ck("bookedRangeEnd: a visit inside the six months keeps it", bookedRangeEnd("2027-04-15", "2026-12-01") === "2027-04-15");
  ck("bookedRangeEnd: a bad date keeps the six months", bookedRangeEnd("2027-04-15", "") === "2027-04-15");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system prompt: no 'reach out when they're back instead of inventing a date'", !/reach out when they're back instead of inventing a date/.test(sp));
  ck("system prompt: return date beyond the list is STILL BOOKABLE", /A return date beyond the 21-day list is STILL BOOKABLE/.test(sp));
  for (const [name, rel] of [["Instagram", "src/app/api/webhook/route.ts"], ["WhatsApp", "src/app/api/wa-webhook/route.ts"], ["Facebook", "src/app/api/fb-webhook/route.ts"]] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: passes the history to getRealAvailabilityContext`, /getRealAvailabilityContext\(\{ history \}\)/.test(src), rel);
  }

  console.log(`\n============== FAR-DATE-BOOKING-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
