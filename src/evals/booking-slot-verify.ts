/**
 * REGRESSION GUARD for the "booked a slot the client never picked" bug
 * (2026-07-16, RODOLFO / guzman.1988, Instagram).
 *
 * The bot offered "hoy jueves a las 11am o mañana viernes a las 9am". The client
 * answered "Podemos aser un appt pero igual no estoy preparado" (picked NOTHING),
 * then volunteered his address and phone — and the bot sent "Cita confirmada" for
 * FRIDAY 9am, a slot he never chose. The SLOT CONFIRMATION RULE lived only in the
 * prompt; nothing server-side enforced it. clientConfirmedSlot is that missing
 * enforcement: a [BOOK] is blocked unless the client actually picked a day/time.
 *
 * Proves: the exact RODOLFO transcript is blocked; every legitimate booking flow
 * (explicit time, "5pm today", reschedule confirm, single-slot yes) still passes;
 * address/phone alone never counts as a pick; all 3 webhooks wire the guard.
 *
 * ZERO API CALLS: clientConfirmedSlot is a pure function.
 * Run: npx tsx src/evals/booking-slot-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { clientConfirmedSlot, needSlotConfirmationMessage } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });

function main() {
  console.log("\n============== BOOKING-SLOT VERIFY (never book an unchosen slot) ==============");

  // ── 1. THE EXACT RODOLFO TRANSCRIPT → must be BLOCKED ────────────────────────
  console.log("\n[1] The real bug: address+phone with no slot pick → NOT confirmed");
  const rodolfo = [
    A("Sí, nuestro vinilo de lujo es un piso PVC de núcleo rígido, 100% impermeable y con garantía de 20 años. ¿Estás pensando en una sola área o toda la casa?"),
    U("Todo el segundo piso 1100 pies con escalera cuánto me sale con instalación"),
    A("Para un proyecto de 1,100 pies con escalera, necesito ir a medir en persona. Tengo disponible hoy jueves a las 11am o mañana viernes a las 9am, ¿cuál te funciona mejor?"),
    U("Podemos aser un appt pero igual no estoy todavía preparado solo estoy viendo para prepararme y aserlo"),
    A("No hay problema, la visita es totalmente gratis y no te compromete a nada."),
    U("10990 sw 225 ter"),
    A("Perfecto, y cuál es el mejor número para contactarte?"),
    U("3059427955"),
  ];
  ck("RODOLFO: no slot ever chosen → clientConfirmedSlot=false (BLOCK)", clientConfirmedSlot(rodolfo) === false, "returned true");
  ck("blocked message asks to pick day/time (ES)", /d[ií]a y (la )?hora/i.test(needSlotConfirmationMessage("es")));
  ck("blocked message asks to pick day/time (EN)", /day and time/i.test(needSlotConfirmationMessage("en")));

  // ── 2. LEGIT FLOWS → must STILL confirm (no regression) ──────────────────────
  console.log("\n[2] Legitimate bookings still go through");
  ck("explicit '9am' after a 2-slot offer", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("9am"),
  ]) === true);
  ck("'yes Thursday at 9am works'", clientConfirmedSlot([
    A("I have Thursday at 9am open, does that work?"), U("yes Thursday at 9am works"), A("Perfect, address?"), U("123 NW 5th St, Miami FL 33125"),
  ]) === true);
  // 3-day review 2026-08-25 (Carlos, Brittany, Anna — Messenger): a bare number
  // that IS one of the offered hours is a pick; the canned "confirm the day and
  // time" line went out up to 3x in a row to clients who had already answered.
  ck("bare '3' after 'martes 25 tengo 3pm, 5pm o 6pm' → pick", clientConfirmedSlot([
    U("25"), A("Para el martes 25 tengo 3pm, 5pm o 6pm, cual te queda mejor?"), U("3"),
  ]), "returned false");
  ck("bare '6' after 'Wednesday the 26th has 6pm or 8pm' → pick", clientConfirmedSlot([
    A("Wednesday the 26th has 6pm or 8pm, which works better?"), U("6"),
  ]), "returned false");
  ck("'26th at 6' after '6pm or 8pm' → pick", clientConfirmedSlot([
    A("Wednesday the 26th has 6pm or 8pm, which works better?"), U("26th at 6"),
  ]), "returned false");
  ck("bare '25' (a DAY, 1pm offered) is NOT a pick", !clientConfirmedSlot([
    A("I have Monday the 24th at 1pm or Tuesday the 25th at 1pm, which day?"), U("25"),
  ]), "returned true");
  ck("bare '9' when only 6pm/8pm were offered is NOT a pick", !clientConfirmedSlot([
    A("I have Wednesday at 6pm or 8pm, which works better?"), U("9"),
  ]), "returned true");
  ck("'5pm today' (WhatsApp flow)", clientConfirmedSlot([
    A("I have today at 5pm or 7pm. What's your address and which time works?"), U("5pm today"), A("Perfect, address?"), U("123 Main St"),
  ]) === true);
  ck("reschedule confirm 'lock it in for Wed at 1pm'", clientConfirmedSlot([
    A("No problem, I have Wednesday open at 9am, 1pm, or 3pm, what works?"), U("Yes, lock it in for Wednesday at 1pm"),
  ]) === true);
  ck("single slot + plain 'yes' → confirmed", clientConfirmedSlot([
    A("I have Monday at 3pm, does that work?"), U("yes"),
  ]) === true);
  ck("single slot + 'perfecto' → confirmed (ES)", clientConfirmedSlot([
    A("Tengo el lunes a las 3pm, ¿te funciona?"), U("perfecto"),
  ]) === true);
  ck("client picks by day 'el jueves'", clientConfirmedSlot([
    A("Tengo jueves a las 9am o viernes a las 11am, ¿cuál prefieres?"), U("el jueves"),
  ]) === true);
  ck("client picks 'the first one'", clientConfirmedSlot([
    A("I have Monday at 9am or Tuesday at 1pm, which works?"), U("the first one"),
  ]) === true);
  ck("client picks 'tomorrow' after offer", clientConfirmedSlot([
    A("I have today at 5pm or tomorrow at 9am, which works?"), U("tomorrow works"),
  ]) === true);
  ck("time survives even when address arrives later", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm?"), U("9am"), A("Great, address?"), U("9 NW 5th St Miami"), U("3055551234"),
  ]) === true);
  // Caught LIVE by the production E2E replay (2026-07-17): after the client
  // picks, the bot ECHOES the slot back ("Perfect, Sunday at 7pm it is! What's
  // the address?"). That echo also carries a clock time — anchoring the pick
  // window on the LAST timed bot message put the window after the pick and
  // blocked a fully confirmed booking. The pick must count from the FIRST offer.
  ck("bot's confirmation echo does not swallow the client's pick (E2E case)", clientConfirmedSlot([
    A("For that size I need to come measure, all free. I have Sunday at 7pm or Monday at 9am, which works better for you?"),
    U("Sunday at 7pm works for me"),
    A("Perfect, Sunday at 7pm it is! What is the property address and best phone number to confirm everything?"),
    U("123 NW 5th St, Miami FL 33125"),
    A("What is the best phone number to reach you?"),
    U("3055550123"),
  ]) === true);
  ck("echo after a single-slot 'yes' also keeps the confirmation", clientConfirmedSlot([
    A("I have Monday at 3pm, does that work?"),
    U("yes"),
    A("Great, Monday at 3pm then! What's the address?"),
    U("123 Main St"),
  ]) === true);
  // Brian Guilford (2026-07-25): smart apostrophe (U+2019), en dash, and a bare
  // "9:00" with NO am/pm — no time token matched, the [BOOK] was blocked, and
  // the bot re-asked the day/time the client had already picked.
  ck("bare '9:00' pick with smart punctuation (Guilford case)", clientConfirmedSlot([
    A("Perfect, I have Tuesday the 28th at 9am or 1pm, which works better for you?"),
    U("Let’s do 9:00–thank you"),
    A("Perfect! What is the property address?"),
    U("10611 Sw 124 Road Miami FL 33186"),
  ]) === true);
  ck("'Let’s do 9' picking an offered hour (no colon, no am/pm)", clientConfirmedSlot([
    A("I have Tuesday at 9am or 1pm, which works better for you?"), U("Let’s do 9"),
  ]) === true);

  // ── 3. NEGATIVE / SAFETY: never confirm off contact info alone ───────────────
  console.log("\n[3] Address/phone/vague replies are never a slot pick");
  ck("plain 'yes' to a TWO-slot offer → NOT confirmed (which one?)", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("yes"),
  ]) === false);
  ck("'Okay' / 'sounds good' vague → NOT confirmed", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("Okay sounds good"),
  ]) === false);
  ck("address only (no time) → NOT confirmed", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("123 NW 5th St Miami FL 33125"),
  ]) === false);
  ck("phone only → NOT confirmed", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("3059427955"),
  ]) === false);
  ck("address whose number coincidentally looks like an hour → NOT confirmed", clientConfirmedSlot([
    A("I have Monday at 9am or 11am, which works?"), U("11 NW 9th St Miami"),
  ]) === false);
  ck("'we can do an appointment' without a time → NOT confirmed", clientConfirmedSlot([
    A("I have today at 11am or tomorrow at 9am, which works?"), U("we can do an appointment but I'm not ready yet"),
  ]) === false);
  ck("'let's do 2 rooms' (number is not an offered hour) → NOT confirmed", clientConfirmedSlot([
    A("I have Monday at 9am or 1pm, which works?"), U("let’s do 2 rooms"),
  ]) === false);
  ck("no offer + no client day/time at all → NOT confirmed", clientConfirmedSlot([
    A("Our promo is $5 per sqft. One area or the whole house?"), U("whole house"), U("123 Main St"),
  ]) === false);

  // ── 4. ALL THREE WEBHOOKS WIRE THE GUARD ─────────────────────────────────────
  console.log("\n[4] Every webhook blocks a [BOOK] when the slot was not confirmed");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports clientConfirmedSlot + needSlotConfirmationMessage`, /clientConfirmedSlot/.test(src) && /needSlotConfirmationMessage/.test(src), rel);
    ck(`${name}: blocks the booking when slot not confirmed`, /!clientConfirmedSlot\(history\)\)\s*\{[\s\S]{0,160}needSlotConfirmationMessage\(lang\)/.test(src), rel);
    ck(`${name}: guard sits before createBooking`, src.indexOf("clientConfirmedSlot(history)") < src.indexOf("createBooking("), rel);
  }
  // Prompt reinforcement present.
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("prompt: address/phone is NOT a slot selection", /address or phone number by itself is NOT a slot selection/i.test(ai));

  console.log(`\n============== BOOKING-SLOT-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
