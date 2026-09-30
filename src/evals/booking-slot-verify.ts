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
import { clientConfirmedSlot, needSlotConfirmationMessage, isSameDaySlotTooSoon, SAME_DAY_MIN_NOTICE_MIN, hourPickedInPhrase, dayOnlyPickNeedsTime, hoursNamed, bookedTimeSeenInConversation, normalizeClockSpacing } from "../lib/scheduler";

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
  // Rowan Hobbs (WA, 2026-08-23): "today at 5pm" offered at 4:25pm and booked at
  // 4:28pm — nobody could get there. Same-day slots need real notice now.
  ck(`same-day notice is at least 2h (${SAME_DAY_MIN_NOTICE_MIN} min)`, SAME_DAY_MIN_NOTICE_MIN >= 120);
  ck("17:00 at 16:25 is TOO SOON", isSameDaySlotTooSoon("17:00", 16 * 60 + 25));
  ck("17:00 at 15:01 is TOO SOON (2h rule, boundary)", isSameDaySlotTooSoon("17:00", 15 * 60 + 1));
  ck("17:00 at 15:00 is OK", !isSameDaySlotTooSoon("17:00", 15 * 60));
  ck("09:00 at 06:00 is OK", !isSameDaySlotTooSoon("09:00", 6 * 60));
  for (const f of ["src/app/api/wa-webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/webhook/route.ts"]) {
    const src = readFileSync(join(process.cwd(), f), "utf-8");
    ck(`${f}: same-day booking alerts the owner`, /sameDayBookingAlert\(bookingData\.date, bookingData\.time/.test(src));
  }
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

  // ── 2b. Annabelle Ruiz (WhatsApp, 2026-09-30): an offered hour wrapped in words ─
  // Offer "today at 6pm or 8pm" → "I prefer 8" → address → the [BOOK] for 8pm
  // was blocked ("I just need to confirm the day and time"), her name+phone got
  // the same line behind "As I mentioned above:", and only "U said today at
  // 8:00p" + a bare "8" unlocked it.
  console.log("\n[2b] Annabelle (WA 30/09): 'I prefer 8' and friends are picks");
  const annabelleOffer = A("That 33029 is covered! The pricing in that ad varies by floor type, and the exact number is penciled in at the free in-person measure. I can come out today at 6pm or 8pm, which works better?");
  const annabelle = [
    U("I need a quote"), A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("I have dogs which one should I get"), A("Vinyl is the way to go, scratch resistant and 100% waterproof at $5 per sqft with the floor and installation included. One area or the whole house?"),
    A("For 1,000 sqft I need to come measure in person to give you the best price, it's a free visit and I bring all the samples. What's the zip code of the property?"),
    U("I saw this add on FB is this the cost"), U("33029"), annabelleOffer,
    U("I prefer 8"), A("Perfect. Can I get the full property address?"), U("17930 Sw 3 rd street\nPembroke Pines 33029"),
  ];
  ck("ANNABELLE: 'I prefer 8' after 'today at 6pm or 8pm' → confirmed (was blocked twice)", clientConfirmedSlot(annabelle) === true, "returned false");
  ck("ANNABELLE: 8pm was seen in the conversation (time-invention guard passes)", bookedTimeSeenInConversation(annabelle, "20:00") === true);
  ck("ANNABELLE: no day-only block (no day word in her burst)", dayOnlyPickNeedsTime(annabelle) === false);
  const offered68 = new Set([6, 8]);
  for (const msg of ["I prefer 8", "8 works", "8 is better for me", "make it 8", "8 pls", "8 please", "Prefiero las 8", "las 8 está bien", "8 me sirve", "prefiro 8", "8 fica melhor", "either, 6 is fine", "8 👍", "the 8 one", "I'd say 8", "8 then"]) {
    ck(`hourPickedInPhrase: "${msg}" → pick`, hourPickedInPhrase(msg, offered68) === true, "returned false");
    ck(`clientConfirmedSlot: "${msg}" after 6pm/8pm → confirmed`, clientConfirmedSlot([annabelleOffer, U(msg)]) === true, "returned false");
  }
  for (const msg of ["I have 2 dogs", "we have 2 rooms", "about 8 boxes", "Unit 6", "17930 SW 3rd St Unit 6", "Annabelle Ruiz 786-262-0225", "$8 per sqft?", "8 people live here", "in 2 weeks", "2 bedrooms and 1 bath", "9", "the 6th", "12345 SW 8 St"]) {
    ck(`hourPickedInPhrase: "${msg}" with 2pm/6pm/8pm offered → NOT a pick`, hourPickedInPhrase(msg, new Set([2, 6, 8, 1])) === false, "returned true");
  }
  ck("phrase pick only counts OFFERED hours ('I prefer 9' when 6pm/8pm offered → NOT)", clientConfirmedSlot([annabelleOffer, U("I prefer 9")]) === false, "returned true");
  ck("'8:00p' is a clock time (normalizeClockSpacing → 8:00pm)", normalizeClockSpacing("U said today at 8:00p") === "U said today at 8:00pm" && hoursNamed("U said today at 8:00p").has(8));
  ck("'8p' / '8 p.m.' / '5 a.m.' normalize too", normalizeClockSpacing("8p") === "8pm" && normalizeClockSpacing("8 p.m.") === "8pm" && normalizeClockSpacing("5 a.m.") === "5am");
  ck("'2a' (Spanish street ordinal) is NOT expanded, '8pm' untouched", normalizeClockSpacing("Calle 2a #10") === "Calle 2a #10" && normalizeClockSpacing("8pm") === "8pm" && normalizeClockSpacing("2 :00 pm") === "2:00 pm");
  ck("'U said today at 8:00p' after '6pm or 8pm' → no day-only block (the hour is named)", dayOnlyPickNeedsTime([annabelleOffer, U("It’s a gated community look for my last name on the Box RUIZ"), U("U said today at 8:00p")]) === false);
  ck("'Tomorrow, I prefer 8' after 'tomorrow at 6pm or 8pm' → no day-only block", dayOnlyPickNeedsTime([A("I have tomorrow at 6pm or 8pm, which works better?"), U("Tomorrow, I prefer 8")]) === false);
  ck("'Tomorrow' alone after 'tomorrow at 6pm or 8pm' → still blocked (Claudio rule)", dayOnlyPickNeedsTime([A("I have tomorrow at 6pm or 8pm, which works better?"), U("Tomorrow")]) === true);
  // The fallback when NO pick exists restates OUR open offer instead of the generic line,
  // and the ack rotates so a second send never gets the "As I mentioned above:" recap prefix.
  const noPick = [annabelleOffer, U("17930 Sw 3 rd street Pembroke Pines 33029")];
  const ask1 = needSlotConfirmationMessage("en", noPick);
  ck("no pick + open offer → restates the offer sentence with the times", /Got it, thanks\. I can come out today at 6pm or 8pm, which works better\?$/.test(ask1), ask1);
  const ask2 = needSlotConfirmationMessage("en", [...noPick, A(ask1), U("Annabelle Ruiz 786-262-0225")]);
  ck("second time → different ack, same offer (no duplicate → no recap prefix)", ask2 !== ask1 && /^Thanks! I can come out today at 6pm or 8pm, which works better\?$/.test(ask2), ask2);
  ck("restated offer never stacks acks", !/Got it, thanks\. Got it|Thanks! Got it/.test(ask2), ask2);
  ck("offer sentence without '?' gets a 'which one' tail", /Which one works better for you\?$/.test(needSlotConfirmationMessage("en", [A("I have Monday at 9am or 11am."), U("123 NW 5th St 33125")])));
  ck("ES restatement", /^Perfecto, anotado\. Tengo hoy a las 6pm o 8pm, cuál te queda mejor\?$/.test(needSlotConfirmationMessage("es", [A("Tengo hoy a las 6pm o 8pm, cuál te queda mejor?"), U("Calle 8 #123, 33125")])), needSlotConfirmationMessage("es", [A("Tengo hoy a las 6pm o 8pm, cuál te queda mejor?"), U("Calle 8 #123, 33125")]));
  ck("no open offer in the episode → short generic ask (no 'Perfect!')", needSlotConfirmationMessage("en", [A("Our promo is $5 per sqft."), U("123 Main St 33125")]) === "Which day and time works best for you?" && !/Perfect/.test(needSlotConfirmationMessage("es")) && needSlotConfirmationMessage("en").length < 60);

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
    // 27/09/2026: a guarda lê o EPISÓDIO corrente (slotHistory = bookingEpisodeHistory(history)), caso Brian Ander.
    // 30/09/2026: a enlatada recebe o episódio para repetir a oferta em aberto (Annabelle).
    ck(`${name}: blocks the booking when slot not confirmed (and restates the open offer)`, /!clientConfirmedSlot\(slotHistory\)\)\s*\{[\s\S]{0,160}needSlotConfirmationMessage\(lang, slotHistory\)/.test(src), rel);
    ck(`${name}: guard sits before createBooking`, src.indexOf("clientConfirmedSlot(slotHistory)") < src.indexOf("createBooking("), rel);
    ck(`${name}: slot guards read the current booking episode only`, /const slotHistory = isReschedule \? history : bookingEpisodeHistory\(history\);/.test(src), rel);
  }
  // Prompt reinforcement present.
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("prompt: address/phone is NOT a slot selection", /address or phone number by itself is NOT a slot selection/i.test(ai));

  console.log(`\n============== BOOKING-SLOT-VERIFY: ${pass} passed, ${fail} failed ==============`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
