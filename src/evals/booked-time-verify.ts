/**
 * REGRESSION GUARD for the "booked an HOUR nobody ever mentioned" bug
 * (2026-07-30, AXEL GONZALEZ, Messenger).
 *
 * The bot offered "el miércoles 29 a las 3pm o el jueves 30?" — Thursday came
 * with NO times. The client answered "Jueves 30 me parece bien" (a legitimate
 * DAY pick, so clientConfirmedSlot passed) and the model booked Thursday at
 * 9am — an hour that never appeared anywhere in the conversation. The seller
 * drove an hour to a 9am visit; the client had assumed 3pm.
 *
 * Two-layer fix proven here:
 *  1. bookedTimeSeenInConversation — a [BOOK] hour must have been offered by
 *     the bot or typed by the client, otherwise the booking is blocked and the
 *     bot re-offers that day's REAL open times (needTimeChoiceMessage).
 *  2. Prompt rule in getRealAvailabilityContext — when offering days, the bot
 *     MUST list open times for EVERY day offered (never a bare "or Thursday?").
 *
 * Sections 1-4 are pure (zero API calls). Section 5 replays the Axel decision
 * point against the LIVE model (skipped when ANTHROPIC_API_KEY is absent).
 * Run: npx tsx src/evals/booked-time-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  bookedTimeSeenInConversation,
  clientConfirmedSlot,
  getEasternDateContext,
  easternTodayStr,
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
  } catch { /* no .env.local — live section will be skipped */ }
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });

// Date helpers for the live replay (relative so the eval never goes stale).
const DAY_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function plusDays(n: number): { dateStr: string; wdES: string; wdEN: string; dayNum: number } {
  const d = new Date(easternTodayStr() + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  const dateStr = d.toISOString().slice(0, 10);
  return { dateStr, wdES: DAY_ES[d.getUTCDay()], wdEN: DAY_EN[d.getUTCDay()], dayNum: d.getUTCDate() };
}

async function main() {
  console.log("\n============== BOOKED-TIME VERIFY (never book an hour nobody said) ==============");

  // ── 1. THE EXACT AXEL TRANSCRIPT → 9am must be BLOCKED, 3pm would pass ──────
  console.log("\n[1] The real bug: day picked, hour invented → BLOCK");
  const axel = [
    U("Bueno gracias pensé alguien venía a hacer la cotización no me encuentro en la casa al momento"),
    A("No hay problema, la visita es completamente gratis y no hay ningún compromiso, simplemente coordinas cuando estés en casa y yo voy a medir y llevo las muestras para que escojas el piso ahí mismo. ¿Qué día te queda mejor, el miércoles 29 a las 3pm o el jueves 30?"),
    U("Jueves 30 me parece bien"),
    A("Perfecto, ¿me das la dirección de la propiedad y un número de teléfono para confirmar la visita?"),
    U("786-510-4659 2138 Ne 38 Rd Homestead FL 33033"),
  ];
  ck("AXEL: clientConfirmedSlot=true (day pick — why the old guard passed)", clientConfirmedSlot(axel) === true);
  ck("AXEL: booked 09:00 never appeared → BLOCKED", bookedTimeSeenInConversation(axel, "09:00") === false);
  ck("AXEL: 15:00 (3pm) WAS on the table → allowed", bookedTimeSeenInConversation(axel, "15:00") === true);

  // ── 2. LEGIT FLOWS → hour was genuinely on the table, must still pass ───────
  console.log("\n[2] Legitimate bookings still go through");
  ck("client typed '9am'", bookedTimeSeenInConversation([
    A("I have Monday at 9am or 1pm, which works?"), U("9am"),
  ], "09:00") === true);
  ck("bot offered '11am', client picked 'the first one' (ordinal)", bookedTimeSeenInConversation([
    A("I have Monday at 11am or Tuesday at 1pm, which works?"), U("the first one"),
  ], "11:00") === true);
  ck("bare '9:00' with smart punctuation (Guilford case)", bookedTimeSeenInConversation([
    A("Perfect, I have Tuesday the 28th at 9am or 1pm, which works better for you?"), U("Let’s do 9:00–thank you"),
  ], "09:00") === true);
  ck("Spanish 'a las 4' → 16:00", bookedTimeSeenInConversation([
    A("¿Qué día te queda mejor?"), U("El viernes a las 4 puedo"),
  ], "16:00") === true);
  ck("Portuguese 'às 2' → 14:00", bookedTimeSeenInConversation([
    A("Que dia fica melhor?"), U("Sexta às 2 pode ser"),
  ], "14:00") === true);
  ck("'noon' → 12:00", bookedTimeSeenInConversation([
    A("What time works?"), U("noon works"),
  ], "12:00") === true);
  ck("bot listed '3 pm' with space", bookedTimeSeenInConversation([
    A("I have Thursday at 9am, 11am or 3 pm, which works?"), U("Thursday 3 pm"),
  ], "15:00") === true);
  ck("unparseable time → fail-open (scheduler validates downstream)", bookedTimeSeenInConversation([
    A("hi"), U("hello"),
  ], "whenever") === true);

  // ── 3. NEGATIVE / SAFETY: numbers that are NOT clock times never match ──────
  console.log("\n[3] Phones, addresses and zips never masquerade as an hour");
  ck("phone '3059427955' does not unlock 9am", bookedTimeSeenInConversation([
    A("Which day works?"), U("thursday"), U("3059427955"),
  ], "09:00") === false);
  ck("address '11 NW 9th St' does not unlock 9am or 11am", bookedTimeSeenInConversation([
    A("Which day works?"), U("tomorrow"), U("11 NW 9th St Miami"),
  ], "09:00") === false && bookedTimeSeenInConversation([
    A("Which day works?"), U("tomorrow"), U("11 NW 9th St Miami"),
  ], "11:00") === false);
  ck("zip '33033' + street '2138' do not unlock any hour", bookedTimeSeenInConversation([
    A("Which day works?"), U("jueves"), U("2138 Ne 38 Rd Homestead FL 33033"),
  ], "09:00") === false);
  ck("hour offered ONLY in the bot's [SYSTEM: ...] suffix does not count", bookedTimeSeenInConversation([
    A("Which day works?"), U("thursday\n\n[SYSTEM: availability 9am 11am]"),
  ], "09:00") === false);

  // ── 4. WIRING: all 3 webhooks + the prompt rule ─────────────────────────────
  console.log("\n[4] Every webhook blocks the invented hour; prompt forces per-day times");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports bookedTimeSeenInConversation + needTimeChoiceMessage`, /bookedTimeSeenInConversation/.test(src) && /needTimeChoiceMessage/.test(src), rel);
    ck(`${name}: blocks when the booked hour was never mentioned`, /!bookedTimeSeenInConversation\(history,\s*bookingData\.time\)\)\s*\{[\s\S]{0,260}needTimeChoiceMessage\(lang,\s*bookingData\.date(?:,\s*bookingData\.address)?\)/.test(src), rel);
    ck(`${name}: guard sits before createBooking`, src.indexOf("bookedTimeSeenInConversation(history") < src.indexOf("createBooking("), rel);
  }
  const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck("prompt: 'NEVER offer a day without stating its available times' rule present", /NEVER offer a day without stating its available times/.test(sched));
  ck("prompt: rule lives inside getRealAvailabilityContext", sched.indexOf("NEVER offer a day without stating its available times") > sched.indexOf("getRealAvailabilityContext"));

  // ── 5. LIVE MODEL: replay the Axel decision point ───────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("\n[5] LIVE replay skipped — no ANTHROPIC_API_KEY");
  } else {
    console.log("\n[5] LIVE replay: model must offer times for BOTH days / ask the hour");
    const { getAIResponse } = await import("../lib/ai");
    const d1 = plusDays(2), d2 = plusDays(3);
    const sys = `\n\n[SYSTEM: ${getEasternDateContext()}\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• ${d1.wdEN}, [${d1.dateStr}]: 3pm\n• ${d2.wdEN}, [${d2.dateStr}]: 9am, 11am, 3pm\n\nIMPORTANT — read carefully before offering any time:\n- ONLY offer times listed above.\n- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line (e.g. 'Wednesday at 3pm, or Thursday at 9am or 11am — which works?'). NEVER offer a day without stating its available times: the client can only pick a time you actually showed, and a booking is only valid after the client explicitly chose one of the listed times. Offering 'Wednesday at 3pm or Thursday?' is FORBIDDEN — the client may pick Thursday assuming 3pm while you book a different hour.]`;

    // 5a. The exact Axel state: day picked with no hour ever offered for it.
    const replay = [
      U("Bueno gracias pensé alguien venía a hacer la cotización no me encuentro en la casa al momento"),
      A(`No hay problema, la visita es completamente gratis y no hay ningún compromiso. ¿Qué día te queda mejor, el ${d1.wdES} ${d1.dayNum} a las 3pm o el ${d2.wdES} ${d2.dayNum}?`),
      U(`${d2.wdES} ${d2.dayNum} me parece bien${sys}`),
    ] as Array<{ role: "user" | "assistant"; content: string }>;
    const r = await getAIResponse(replay, null, null, null, false);
    const txt = r.text;
    ck("no [BOOK] without an hour the client chose", !/\[BOOK:/i.test(txt), txt);
    ck("reply surfaces real hours or asks which hour", /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(txt) || /qu[eé] hora|a que hora|what time/i.test(txt), txt);

    // 5b. Fresh offer stage: every day named must carry at least one hour.
    const offer = [
      U("Hola, quiero cotizar piso para mi casa, ¿cuándo pueden venir?" + sys),
    ] as Array<{ role: "user" | "assistant"; content: string }>;
    const r2 = await getAIResponse(offer, null, null, null, false);
    const txt2 = r2.text;
    const daysNamed = [d1.wdES, d2.wdES].filter((w) => new RegExp(`\\b${w}\\b`, "i").test(txt2)).length;
    const hoursNamed = [...txt2.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi)].length;
    ck("offer names at least one day with an hour attached", daysNamed === 0 || hoursNamed >= 1, txt2);
    ck("offering BOTH days → at least 2 hours shown (no bare day)", daysNamed < 2 || hoursNamed >= 2, txt2);
  }

  console.log(`\n============== BOOKED-TIME-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
