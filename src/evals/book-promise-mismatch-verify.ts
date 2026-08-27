/**
 * REGRESSION GUARD for the two booking failures found in the 4-day review
 * of 2026-08-24 (both "the AI failed to book / booked the wrong visit"):
 *
 * 1. SILENT SLOT SWAP (MARIA HERNANDEZ, Messenger, 2026-08-23): the bot offered
 *    "hoy domingo a las 11am, 1pm, ..., o el martes 25 a las 9am, 1pm, ...",
 *    the client picked "Hoy ahora" and sent her address, the bot echoed
 *    "Perfecto, tengo hoy a las 11am" — and the model's [BOOK] silently wrote
 *    TUESDAY the 25th at 1pm. Every guard passed ("hoy" is a valid day pick,
 *    1pm was in the offer list, no weekday word disagreed). The client sat home
 *    all Sunday asking "Todavía están viniendo hoy?" into the booked-silence.
 *    FIX: bookedSlotMismatchesPromise — the [BOOK] must match the NEWEST
 *    concrete promise (single-hour message) in the conversation.
 *
 * 2. CLIENT-PROPOSED SLOT BLOCKED (LISSETTE, Instagram, 2026-08-24): the client
 *    opened with "are you available next Wednesday September 2nd at 6:00 pm?",
 *    the bot accepted ("Yes, ... 6pm works perfectly! Can I get your name..."),
 *    the client sent name + address + zip + phone — and clientConfirmedSlot
 *    blocked the [BOOK] (the proposal PRECEDES the bot's first clock-time
 *    message, outside the pick window), sending the canned "I just need to
 *    confirm the day and time" to a client who had given everything.
 *    FIX: clientConfirmedSlot rule 3 — a client-proposed day+time that the
 *    bot's immediate reply ACCEPTS (same hour + affirmative) IS a pick.
 *
 * Pure logic, zero API calls. Run: npx tsx src/evals/book-promise-mismatch-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  bookedSlotMismatchesPromise,
  clientConfirmedSlot,
  easternTodayStr,
} from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });

const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function plusDays(n: number): { dateStr: string; wdEN: string; dayNum: number } {
  const d = new Date(easternTodayStr() + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return { dateStr: d.toISOString().slice(0, 10), wdEN: DAY_EN[d.getUTCDay()], dayNum: d.getUTCDate() };
}
const today = easternTodayStr();

async function main() {
  console.log("\n========== BOOK-PROMISE-MISMATCH VERIFY (2026-08-24 review fixes) ==========");

  // ── 1. THE MARIA TRANSCRIPT: promise said "hoy a las 11am", [BOOK] wrote +2d 1pm ──
  console.log("\n[1] Silent slot swap is BLOCKED (Maria Hernandez case)");
  const maria = [
    U("Hacen estimado"),
    A("Sí, el estimado es gratis y lo hago en persona. ¿Tienes en mente un área en específico o es toda la casa?"),
    U("Si quisiera un estimado yo vivo en Miami Lakes por ahora dos cuartos según el precio sería la casa entera"),
    A("Miami Lakes está dentro de nuestra área, perfecto. Tengo disponible hoy domingo a las 11am, 1pm, 2pm, 3pm, 4pm, 5pm o 6pm, o el martes 25 a las 9am, 1pm, 2pm, 3pm, 5pm o 6pm, ¿cuál te queda mejor?"),
    U("Hoy ahora si quieres te mando la dirección 17428 nw 76 ct Hialeah 33015"),
    A("Perfecto, tengo hoy a las 11am. ¿Me puedes dar tu nombre y número de teléfono para apartar la visita?"),
    U("Mi teléfono 7865541879 maria Hernandez"),
  ];
  const swapped = plusDays(2).dateStr; // the model booked two days later at a different hour
  const r1 = bookedSlotMismatchesPromise(maria, swapped, "13:00");
  ck("swapped day+hour → MISMATCH (blocked)", r1.mismatch === true, JSON.stringify(r1));
  ck("promisedDate resolves 'hoy' to today", r1.promisedDate === today, JSON.stringify(r1));
  ck("the promised slot itself (today 11:00) → allowed", bookedSlotMismatchesPromise(maria, today, "11:00").mismatch === false);
  ck("same hour but wrong day → still MISMATCH", bookedSlotMismatchesPromise(maria, swapped, "11:00").mismatch === true);
  ck("right day but wrong hour → still MISMATCH", bookedSlotMismatchesPromise(maria, today, "13:00").mismatch === true);
  ck("phone digits in the client's last message never anchor the promise",
    bookedSlotMismatchesPromise([...maria, U("7865541879")], today, "11:00").mismatch === false);

  // ── 2. PROMISE GUARD abstains when there is no single concrete promise ──────
  console.log("\n[2] No false blocks on legitimate flows");
  const tmr = plusDays(1);
  ck("multi-slot offer as last message → abstains (clientConfirmedSlot's job)",
    bookedSlotMismatchesPromise([
      A(`I have tomorrow at 2pm or 3pm, which works?`),
    ], tmr.dateStr, "15:00").mismatch === false);
  ck("client pick 'Tuesday at 2pm' matches [BOOK] 14:00 → allowed",
    bookedSlotMismatchesPromise([
      A("I have Tuesday at 2pm or 3pm, which works?"),
      U("Tuesday at 2pm"),
    ], plusDays(9).dateStr, "14:00").mismatch === false);
  ck("'Tuesday 2pm' (no 'at') — the 2 is an HOUR, never day-of-month 2",
    bookedSlotMismatchesPromise([
      A("I have Tuesday at 2pm or 3pm, which works?"),
      U("Tuesday 2pm"),
    ], plusDays(9).dateStr, "14:00").mismatch === false);
  ck("echo 'tomorrow at 3pm' + [BOOK] tomorrow 15:00 → allowed",
    bookedSlotMismatchesPromise([
      A("Perfect, tomorrow at 3pm it is! What's your name and address?"),
      U("John, 123 NW 5th St Miami FL 33125"),
    ], tmr.dateStr, "15:00").mismatch === false);
  ck("echo 'tomorrow at 3pm' + [BOOK] on another day → MISMATCH",
    bookedSlotMismatchesPromise([
      A("Perfect, tomorrow at 3pm it is! What's your name and address?"),
      U("John, 123 NW 5th St Miami FL 33125"),
    ], plusDays(4).dateStr, "15:00").mismatch === true);
  ck("'en la mañana' is the MORNING, not tomorrow",
    bookedSlotMismatchesPromise([
      A("Nos vemos hoy en la mañana a las 9am, ¿me das tu nombre?"),
      U("Carlos"),
    ], today, "09:00").mismatch === false);
  ck("a LATER client day-change supersedes the older echo (no false block)",
    bookedSlotMismatchesPromise([
      A("Perfect, I'm holding today at 3pm for you! Name and address?"),
      U("mejor el miércoles"),
    ], plusDays(3).dateStr, "15:00").mismatch === false);
  ck("hour-only promise ('3pm it is') + [BOOK] 17:00 → MISMATCH",
    bookedSlotMismatchesPromise([
      A("Perfect, 3pm it is! Can I get your name and the address?"),
      U("Ana Diaz, 44 SW 2nd Ave Miami FL 33130"),
    ], plusDays(3).dateStr, "17:00").mismatch === true);
  ck("unparseable time → fail-open", bookedSlotMismatchesPromise([A("3pm works")], today, "whenever").mismatch === false);
  ck("no slot signal anywhere → fail-open", bookedSlotMismatchesPromise([U("hola"), A("hola!")], today, "15:00").mismatch === false);

  // ── 3. THE LISSETTE TRANSCRIPT: client-proposed slot + bot acceptance = pick ──
  console.log("\n[3] Client-proposed slot accepted by the bot counts as confirmed");
  const lissette = [
    U("[Client replied to our ad]"),
    U("What is included in the materials package?"),
    A("Hello! We run separate promotions for tile, vinyl, and hardwood. Which one are you interested in?"),
    U("Vinyl or tile. Will be messaging soon for a quote."),
    A("Great, both have different rates! Reach out whenever you are ready and I will get your free quote."),
    U("Good evening are you available next Wednesday September 2nd at 6:00 pm to do a quote?"),
    A("Yes, Wednesday September 2nd at 6pm works perfectly! Can I get your name, the full property address with the zip code, and the best phone number to confirm the visit?"),
    U("Lissette 2136 Nova Village Dr. Davie,FL 33317 954-296-0676"),
  ];
  ck("LISSETTE: clientConfirmedSlot=true (was false → canned day/time re-ask loop)", clientConfirmedSlot(lissette) === true);
  ck("LISSETTE: [BOOK] at the accepted 18:00 passes the promise guard",
    bookedSlotMismatchesPromise(lissette, "2026-09-02", "18:00").mismatch === false);
  ck("LISSETTE: [BOOK] at a different hour is blocked by the promise guard",
    bookedSlotMismatchesPromise(lissette, "2026-09-02", "14:00").mismatch === true);

  // Relative variant so this eval never goes stale: proposal next week.
  const nx = plusDays(7);
  const proposal = [
    U(`Good evening are you available next ${nx.wdEN} the ${nx.dayNum}th at 6:00 pm to do a quote?`),
    A(`Yes, ${nx.wdEN} the ${nx.dayNum}th at 6pm works perfectly! Can I get your name, the full property address with the zip code, and the best phone number?`),
    U("Maria 2136 Nova Village Dr. Davie FL 33317 954-296-0676"),
  ];
  ck("relative proposal accepted → confirmed", clientConfirmedSlot(proposal) === true);
  ck("relative proposal + [BOOK] at 18:00 on that day → allowed",
    bookedSlotMismatchesPromise(proposal, nx.dateStr, "18:00").mismatch === false);

  // ── 4. A COUNTER-OFFER must NOT unlock the booking ──────────────────────────
  console.log("\n[4] Counter-offers and vague data still block");
  ck("proposal + counter-offer (other hours) + address only → NOT confirmed",
    clientConfirmedSlot([
      U("Can you do Friday at 5pm?"),
      A("Friday is fully booked, but I have Saturday at 9am or 11am, which works?"),
      U("John Smith 123 NW 5th St Miami FL 33125 3055550101"),
    ]) === false);
  ck("RODOLFO baseline still blocked (address+phone are not a slot pick)",
    clientConfirmedSlot([
      A("¿Qué día te queda mejor, hoy jueves a las 11am o mañana viernes a las 9am?"),
      U("Podemos aser un appt pero igual no estoy preparado"),
      U("3055550101 44 SW 8th St Miami FL 33130"),
    ]) === false);

  // ── 5. WIRING: the promise guard blocks in all 3 webhooks before createBooking ──
  console.log("\n[5] Guard wired into the 3 webhooks");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports bookedSlotMismatchesPromise`, /bookedSlotMismatchesPromise/.test(src), rel);
    ck(`${name}: blocks on mismatch and re-offers the promised day's real times`,
      /bookedSlotMismatchesPromise\(history,\s*bookingData\.date,\s*bookingData\.time\)[\s\S]{0,300}needTimeChoiceMessage\(lang,\s*pm\.promisedDate\s*\?\?\s*bookingData\.date(?:,\s*bookingData\.address)?\)/.test(src), rel);
    ck(`${name}: guard sits before createBooking`, src.indexOf("bookedSlotMismatchesPromise(history") < src.indexOf("createBooking("), rel);
  }

  console.log(`\n========== BOOK-PROMISE-MISMATCH-VERIFY: ${pass} passed, ${fail} failed ==========`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
