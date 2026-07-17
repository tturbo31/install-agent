/**
 * REGRESSION GUARD for the weekday↔date booking bug (2026-07-16).
 *
 * Facebook client at 6247 SW 139 Ave: the bot offered "Thursday at 7pm or Friday
 * at 7pm this week", the client typed "Thursday is fine", and the visit was
 * booked for FRIDAY 2026-07-17 instead of Thursday 2026-07-16 — a day late. The
 * model wrote the neighbouring day's date into [BOOK] and NOTHING server-side
 * checked it. reconcileBookingWeekday is that missing deterministic check.
 *
 * This proves:
 *   1. the exact production conversation now snaps Friday→Thursday,
 *   2. a CORRECT date is never touched (no false corrections),
 *   3. ambiguity (two weekdays, or none) is left alone (never guesses),
 *   4. it never books the past,
 *   5. all three webhooks pass `history` into processBookingCommand so the guard
 *      actually runs in production.
 *
 * ZERO API CALLS: reconcileBookingWeekday is a pure function.
 * Run: npx tsx src/evals/booking-date-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { reconcileBookingWeekday, weekdaysNamed } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (d: string) => DAYS[new Date(d + "T12:00:00Z").getUTCDay()];

// Today, computed the same way the guard does (Eastern), so "never book the past"
// assertions are stable whenever this runs.
const todayET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

function main() {
  console.log("\n============== BOOKING-DATE VERIFY (weekday↔date guard) ==============");

  // ── 1. THE EXACT PRODUCTION CONVERSATION ────────────────────────────────────
  console.log("\n[1] The real bug: 'Thursday is fine' must not book Friday");
  const prodHistory = [
    A("On weekdays we go as late as 7pm, and on weekends the latest is 5pm on Saturdays and 7pm on Sundays. What works best for you?"),
    U("Week days around 6:30 pm"),
    A("I have Thursday at 7pm or Friday at 7pm, which works better for you?"),
    U("This week?"),
    A("Yes, I have Thursday at 7pm or Friday at 7pm this week, which works better for you?"),
    U("Thursday is fine"),
    A("Perfect, what's the property address and best callback number?"),
    U("305-720-4494"),
    A("Perfect, and the property address?"),
    U("6247 SW 139 ave."),
  ];
  // The model wrote Friday 2026-07-17; the client picked Thursday (2026-07-16).
  const r1 = reconcileBookingWeekday("2026-07-17", prodHistory);
  ck("detects the mismatch and corrects", r1.corrected, JSON.stringify(r1));
  ck("snaps to Thursday 2026-07-16", r1.date === "2026-07-16", r1.date);
  ck("corrected date is actually a Thursday", weekdayOf(r1.date) === "Thursday", weekdayOf(r1.date));
  ck("keeps the intended weekday = Thursday(4)", r1.intendedWeekday === 4, String(r1.intendedWeekday));

  // If the model had ALREADY written the right date, nothing changes.
  const r1ok = reconcileBookingWeekday("2026-07-16", prodHistory);
  ck("correct date (Thursday 16) is left untouched", !r1ok.corrected && r1ok.date === "2026-07-16", JSON.stringify(r1ok));

  // ── 2. CLIENT'S OWN WEEKDAY WORD WINS, in EN/ES ─────────────────────────────
  console.log("\n[2] The client's explicit weekday word is the ground truth");
  // Client picks Monday; model wrote Tuesday's date.
  const monHist = [A("I have Monday at 9am or Tuesday at 9am, which works?"), U("monday works")];
  const r2 = reconcileBookingWeekday("2026-07-21", monHist); // 2026-07-21 is a Tuesday
  ck("EN: 'monday works' over a Tuesday date → snaps to Monday", weekdayOf(r2.date) === "Monday" && r2.corrected, JSON.stringify(r2));
  ck("EN: Monday snap is 2026-07-20 (nearest)", r2.date === "2026-07-20", r2.date);
  // Spanish: client says jueves (Thursday); model wrote miércoles (Wednesday).
  const jueHist = [A("Tengo miércoles a las 5pm o jueves a las 5pm, cuál prefieres?"), U("el jueves está bien")];
  const r2es = reconcileBookingWeekday("2026-07-15", jueHist); // 2026-07-15 is a Wednesday
  ck("ES: 'el jueves' over a Wednesday date → snaps to Thursday", weekdayOf(r2es.date) === "Thursday" && r2es.corrected, JSON.stringify(r2es));

  // ── 3. NO FALSE CORRECTIONS (safety) ────────────────────────────────────────
  console.log("\n[3] Never corrupts a correct or unknowable booking");
  // Client named TWO weekdays and never narrowed → ambiguous → leave it alone.
  const ambClient = [A("Which day works?"), U("thursday or friday both work for me")];
  const r3 = reconcileBookingWeekday("2026-07-17", ambClient); // Friday
  ck("ambiguous client (two weekdays) → not corrected", !r3.corrected && r3.date === "2026-07-17", JSON.stringify(r3));
  // No weekday anywhere (client gave only a date/time) → nothing to compare → leave it.
  const noWeekday = [A("What day works?"), U("let's do the 17th at 7pm"), A("Address?"), U("123 Main St")];
  const r3b = reconcileBookingWeekday("2026-07-17", noWeekday);
  ck("no weekday word anywhere → not corrected", !r3b.corrected, JSON.stringify(r3b));
  // Bot offered ONE weekday, client only said "yes" — bot's single offer anchors it.
  const botAnchor = [A("I have Wednesday at 3pm open, does that work?"), U("yes that works"), A("Address?"), U("123 Main St")];
  const r3c = reconcileBookingWeekday("2026-07-16", botAnchor); // 2026-07-16 Thursday, bot said Wednesday
  ck("bot's single-weekday offer anchors when client just says yes", weekdayOf(r3c.date) === "Wednesday" && r3c.corrected, JSON.stringify(r3c));
  // Malformed / empty dates are passed through untouched.
  ck("empty date passes through", reconcileBookingWeekday("", prodHistory).date === "" );
  ck("garbage date passes through", reconcileBookingWeekday("not-a-date", prodHistory).date === "not-a-date");
  ck("empty history → never corrects", !reconcileBookingWeekday("2026-07-17", []).corrected);

  // ── 3b. RESCHEDULE: a stale weekday word must NOT drag the new date back ─────
  console.log("\n[3b] Reschedule round: the current offer wins over a stale weekday");
  // Client was on Thursday, bot offers Friday, client agrees without renaming the
  // day. The booked Friday date must STAY Friday (not snap back to old Thursday).
  const reschedHist = [
    U("thursday is fine"),
    A("Appointment confirmed. I will notify you 40 minutes before arriving."),
    U("actually can we move it a day later"),
    A("Of course, I have Friday at 7pm, does that work?"),
    U("yes that works"),
  ];
  const r3resched = reconcileBookingWeekday("2026-07-17", reschedHist); // Friday
  ck("stale 'thursday' does NOT drag the new Friday date back", !r3resched.corrected && r3resched.date === "2026-07-17", JSON.stringify(r3resched));
  // But if the model STILL wrote the wrong day in that same reschedule round
  // (offer=Friday, model wrote Thursday), the offer's weekday corrects it.
  const r3resched2 = reconcileBookingWeekday("2026-07-16", reschedHist); // Thursday, wrong
  ck("reschedule: offer's Friday corrects a wrong Thursday date", r3resched2.corrected && weekdayOf(r3resched2.date) === "Friday", JSON.stringify(r3resched2));

  // ── 3c. REAL VICTIM-SCAN CASES (2026-07-16) ─────────────────────────────────
  console.log("\n[3c] The other real conversations the victim-scan surfaced");
  // Instagram Client: bot offered Friday, client countered 'today', bot booked
  // today (Thursday) CORRECTLY. The stale 'Friday' must NOT corrupt it. This is
  // the false-positive that would have made the guard itself book the wrong day.
  const todayCounter = [
    A("Hi, for 800 sqft I need to come measure in person. I have Friday at 9am or 1pm open, which works?"),
    U("Is there any chance we can get an appointment today? We are booked tomorrow"),
    A("Yes, I have today at 7pm open, does that work?"),
    U("Ok, that's fine"),
    U("280 SW 20th rd apt 908 miami fl 33129"),
  ];
  const rIC = reconcileBookingWeekday("2026-07-16", todayCounter); // Thursday (today), correct
  ck("'today' counter over a stale Friday offer → NOT corrected", !rIC.corrected && rIC.date === "2026-07-16", JSON.stringify(rIC));
  // Maritza: client asked 'Thursday as in tomorrow?', bot confirmed 'Thursday the
  // 16th', client picked 5pm — booked Sunday by the bug. Guard snaps back to Thu.
  const maritza = [
    U("4 bedrooms carpet removal and installation, living room laminate"),
    A("That's a solid multi-room project, so I need to come measure in person."),
    U("Thursday as in tomorrow?"),
    A("Yes, tomorrow Thursday the 16th, I have 11am, 3pm, or 5pm open. Which works best for you?"),
    U("5pm I'm in Homestead"),
    U("1747 Egret Rd Homestead FL 33035"),
  ];
  const rM = reconcileBookingWeekday("2026-07-19", maritza); // Sunday, wrong
  ck("Maritza: Sunday booking snaps back to the agreed Thursday", rM.corrected && weekdayOf(rM.date) === "Thursday", JSON.stringify(rM));
  // Audrey: 'No Tuesday. Wednesday?' then bot 'Wednesday I have 9am', client '9am'
  // — booked Thursday by the bug. Guard snaps to Wednesday.
  const audrey = [
    U("There's 18 steps"),
    A("The stairs come out to $2,520. When works for you?"),
    U("No Tuesday do not work for me. Wednesday?"),
    A("Wednesday I have 9am, 11am, 1pm, 3pm, or 5pm, which works best for you?"),
    U("9 am"),
    U("2882 Crestwood Terr. Margate 33063"),
  ];
  const rA = reconcileBookingWeekday("2026-07-16", audrey); // Thursday, wrong (client wanted Wednesday)
  ck("Audrey: Thursday booking snaps back to the agreed Wednesday", rA.corrected && weekdayOf(rA.date) === "Wednesday", JSON.stringify(rA));

  // Extra false-positive guards: relative-only rounds are never corrected.
  ck("'tomorrow' with a stale weekday offer → not corrected", !reconcileBookingWeekday("2026-07-17", [A("I have Monday at 9am"), U("can we do it tomorrow instead?"), A("Sure, tomorrow at 9am works"), U("ok")]).corrected);
  ck("explicit 'the 20th' with a stale weekday offer → not corrected", !reconcileBookingWeekday("2026-07-20", [A("I have Friday open"), U("actually the 20th works better"), A("Great, the 20th at 9am"), U("yes")]).corrected);

  // ── 4. NEVER BOOKS THE PAST ──────────────────────────────────────────────────
  console.log("\n[4] Correction never lands in the past");
  // Use a fabricated case: whatever the guard returns, if it corrected, the date
  // must be >= today (ET). Drive it with the live 'today'.
  for (const [dateStr, hist] of [
    ["2026-07-17", prodHistory],
    ["2026-07-21", monHist],
  ] as const) {
    const r = reconcileBookingWeekday(dateStr, hist);
    if (r.corrected) ck(`corrected ${dateStr} → ${r.date} is not in the past`, r.date >= todayET, `today=${todayET}`);
    else ck(`(${dateStr} not corrected — skip past-check)`, true);
  }
  // Direct past-guard proof: a Sunday-intent that snaps backward past today rolls +7.
  // Build a history where the client said the weekday of (today-1) so the nearest
  // match is yesterday; the guard must push it to next week.
  const y = new Date(todayET + "T12:00:00Z"); y.setUTCDate(y.getUTCDate() - 1);
  const yesterdayWeekday = DAYS[y.getUTCDay()];
  const pastHist = [A("what day?"), U(`${yesterdayWeekday} works`)];
  // Model booked "today" (wrong weekday vs yesterday's weekday) → nearest match is
  // yesterday → must roll forward, never yesterday.
  const rp = reconcileBookingWeekday(todayET, pastHist);
  if (rp.corrected) ck("snap that would land yesterday rolls forward to next week", rp.date > todayET, `today=${todayET} got=${rp.date}`);
  else ck("(no correction for the past-roll case — acceptable)", true);

  // ── 5. weekdaysNamed helper ──────────────────────────────────────────────────
  console.log("\n[5] weekdaysNamed parsing");
  ck("finds one weekday", JSON.stringify(weekdaysNamed("Thursday is fine")) === "[4]");
  ck("finds two weekdays", JSON.stringify(weekdaysNamed("thursday or friday")) === "[4,5]");
  ck("ignores the injected [SYSTEM: schedule] note (lists every weekday)", weekdaysNamed("ok\n\n[SYSTEM: Monday Tuesday Wednesday Thursday Friday]").length === 0);
  ck("ES jueves", JSON.stringify(weekdaysNamed("el jueves")) === "[4]");
  ck("no weekday → empty", weekdaysNamed("123 Main St at 7pm").length === 0);

  // ── 6. ALL THREE WEBHOOKS WIRE THE GUARD ────────────────────────────────────
  console.log("\n[6] Every webhook runs the guard (passes history into the booking path)");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports reconcileBookingWeekday`, /reconcileBookingWeekday/.test(src), rel);
    ck(`${name}: calls the guard inside processBookingCommand`, /const rec = reconcileBookingWeekday\(bookingData\.date, history\)/.test(src), rel);
    ck(`${name}: only overwrites when corrected`, /if \(rec\.corrected\)\s*\{[\s\S]{0,120}bookingData\.date = rec\.date/.test(src), rel);
    ck(`${name}: passes history into processBookingCommand`, /processBookingCommand\([\s\S]{0,200}history\s*\)/.test(src), rel);
  }

  console.log(`\n============== BOOKING-DATE-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
