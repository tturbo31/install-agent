// Owner rule 2026-09-17: "lotar a agenda do Alexandre primeiro, antes do Chris;
// o Diego (horários pares) na frente do Chris; lotar o dia mais próximo de todos
// os vendedores, nenhum dia picado".
// The schedule the model reads used to be a seller-less union of every open
// hour, so with Alexandre's 9am taken it still listed 9am (Chris's) and the
// next client landed on Chris while Alexandre had 1pm, 3pm, 5pm open. Now:
//  • splitDaySlotsByPriority (STRICT order since the afternoon of 17/09,
//    owner: "Alexandre, depois Diego, depois Chris, tem que ser nessa ordem"):
//    a seller's hours are only OFFERED once every seller in front of him has
//    no open hour left that day, whatever the hour grids; they stay bookable
//    and are shown in a parenthesis "open only if the client asks for one of
//    these". Single exception: the seller in front has ONE hour left → the
//    offer is topped up with the next seller's earliest hour, same day.
//  • getRealAvailabilityContext / getNextOpenSlots / getPreferredSlots (the
//    canned offers) all use it; createBooking still books ANY free seller
//    (pickSellerForSlot, lowest priority number first) so an asked-for hour
//    is never refused.
//  1. DETERMINISTIC (no API, no DB): the split with the real grids.
//  2. STATIC: wiring + the instruction bullet + rule 33.
//  3. LIVE DB (read-only): the real schedule text is consistent with the split
//     (preferred ∪ parenthesis = every open hour, chronological).
//  4. LIVE MODEL: offers only the listed hours, never a parenthesis hour; a
//     client asking for a parenthesis hour is accepted.
// Set DET_ONLY=1 to skip 3 and 4.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { splitDaySlotsByPriority, getRealAvailabilityContext, getAvailableSlots, getPreferredSlots, getEasternDateContext, slotsForWeekday, type Seller, type BookingRow } from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); process.env[m[1]] = v; }
  }
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const fmt12 = (s: string) => { const [h, m] = s.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h >= 12 ? "pm" : "am"}`; };
const clockTimes = (t: string) => [...t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi)].map((m) => `${parseInt(m[1], 10)}${m[2].toLowerCase()}`);

// The real grids (scheduler DB, 2026-09-17): Alexandre p1 Mon-Sat 9/11/1/3/5;
// Diego p2 Mon-Fri 2/4/6/8pm + Sunday 9..7pm; Chris p3 Sun-Fri 9/11/1/3/5/7pm.
const A: Seller = { id: "A", name: "Alexandre", priority: 1, enabled_weekdays: [1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00"], weekday_time_slots: null, active: true };
const D: Seller = { id: "D", name: "Diego", priority: 2, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["14:00", "16:00", "18:00", "20:00"], weekday_time_slots: { "0": ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] }, active: true };
const C: Seller = { id: "C", name: "Chris", priority: 3, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], weekday_time_slots: null, active: true };
const SELLERS = [C, D, A]; // deliberately unsorted
const bk = (seller_id: string, booking_date: string, booking_time: string): BookingRow => ({ seller_id, booking_date, booking_time });
const THU = "2026-09-17"; // weekday 4
const SUN = "2026-09-20"; // weekday 0
const SAT = "2026-09-19"; // weekday 6
const noOff = new Set<string>();

async function main() {
  console.log("\n[1] DETERMINISTIC — splitDaySlotsByPriority, strict order Alexandre → Diego → Chris");
  const j = (r: { preferred: string[]; onRequest: string[] }) => `${r.preferred.join(",")} | ${r.onRequest.join(",")}`;
  const FULL_A = ["09:00", "11:00", "13:00", "15:00", "17:00"].map((t) => bk("A", THU, t));
  const FULL_D = ["14:00", "16:00", "18:00", "20:00"].map((t) => bk("D", THU, t));
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [], noOff);
    ck("empty weekday: offered = Alexandre's day only (9am, 11am, 1pm, 3pm, 5pm)", r.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00", j(r));
    ck("empty weekday: Diego's 2/4/6/8pm and Chris's 7pm wait in the parenthesis", r.onRequest.join(",") === "14:00,16:00,18:00,19:00,20:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "09:00")], noOff);
    ck("Alexandre's 9am taken: 9am (Chris) is NOT offered, goes to the parenthesis", !r.preferred.includes("09:00") && r.onRequest.includes("09:00"), j(r));
    ck("…and the offer is Alexandre's 11am, 1pm, 3pm, 5pm only (no Diego, no Chris)", r.preferred.join(",") === "11:00,13:00,15:00,17:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_A.slice(0, 4), noOff);
    ck("Alexandre has ONE hour left (5pm): offer = 5pm + Diego's earliest (2pm), same day", r.preferred.join(",") === "14:00,17:00", j(r));
    ck("…the rest of Diego's day and all of Chris's stay in the parenthesis", r.onRequest.join(",") === "09:00,11:00,13:00,15:00,16:00,18:00,19:00,20:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_A, noOff);
    ck("Alexandre FULL: Diego's day is offered (2pm, 4pm, 6pm, 8pm), Chris still waits", r.preferred.join(",") === "14:00,16:00,18:00,20:00" && r.onRequest.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_A, bk("C", THU, "09:00"), bk("D", THU, "14:00")], noOff);
    ck("Alexandre full, Chris 9am + Diego 2pm taken: offer = 4pm, 6pm, 8pm (Diego); Chris's 11am..7pm on request", r2.preferred.join(",") === "16:00,18:00,20:00" && r2.onRequest.join(",") === "11:00,13:00,15:00,17:00,19:00", j(r2));
    const r3 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_A, ...FULL_D.slice(0, 3)], noOff);
    ck("Alexandre full, Diego has ONE hour left (8pm): offer = Chris's 9am + 8pm, same day", r3.preferred.join(",") === "09:00,20:00" && r3.onRequest.join(",") === "11:00,13:00,15:00,17:00,19:00", j(r3));
    const r4 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_A, ...FULL_D], noOff);
    ck("Alexandre AND Diego full: Chris's whole day opens (9am first), nothing on request", r4.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r4.onRequest.length === 0, j(r4));
    const r5 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_A, ...FULL_D, ...["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].map((t) => bk("C", THU, t))], noOff);
    ck("everyone full: nothing offered, nothing on request", r5.preferred.length === 0 && r5.onRequest.length === 0, j(r5));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [], new Set<string>([`A|${THU}`]));
    ck("Alexandre on a day off: Diego's day is offered, Chris waits", r.preferred.join(",") === "14:00,16:00,18:00,20:00" && r.onRequest.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [], new Set<string>([`A|${THU}`, `D|${THU}`]));
    ck("Alexandre and Diego off: Chris's day is offered normally", r2.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r2.onRequest.length === 0, j(r2));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, SUN, 0, [], noOff);
    ck("Sunday (Diego and Chris, same grid): Diego's day is offered, Chris's identical hours are not doubled", r.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r.onRequest.length === 0, j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, SUN, 0, [bk("D", SUN, "09:00"), bk("D", SUN, "11:00")], noOff);
    ck("Sunday, Diego's 9am + 11am taken: offer starts at 1pm (Diego), Chris's 9am/11am on request", r2.preferred.join(",") === "13:00,15:00,17:00,19:00" && r2.onRequest.join(",") === "09:00,11:00", j(r2));
    const r3 = splitDaySlotsByPriority(SELLERS, SUN, 0, ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].map((t) => bk("D", SUN, t)), noOff);
    ck("Sunday, Diego full: Chris's day is offered", r3.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r3.onRequest.length === 0, j(r3));
    const r4 = splitDaySlotsByPriority(SELLERS, SUN, 0, ["09:00", "11:00", "13:00", "15:00", "17:00"].map((t) => bk("D", SUN, t)), noOff);
    ck("Sunday, Diego has ONE hour left (7pm): offer = Chris's 9am + 7pm", r4.preferred.join(",") === "09:00,19:00" && r4.onRequest.join(",") === "11:00,13:00,15:00,17:00", j(r4));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, SAT, 6, [], noOff);
    ck("Saturday (only Alexandre works): his hours, nothing on request", r.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00" && r.onRequest.length === 0, j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "13:00"), bk("A", THU, "15:00"), bk("A", THU, "17:00")], noOff, "12:30");
    ck("today, notice at 12:30: Alexandre's remaining hours all taken → Diego's 2/4/6/8pm offered, Chris's 1pm..7pm on request", r.preferred.join(",") === "14:00,16:00,18:00,20:00" && r.onRequest.join(",") === "13:00,15:00,17:00,19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "13:00")], noOff, "12:30");
    ck("today, notice at 12:30, Alexandre still has 3pm/5pm: offer = 3pm, 5pm; everything else on request", r2.preferred.join(",") === "15:00,17:00" && r2.onRequest.join(",") === "13:00,14:00,16:00,18:00,19:00,20:00", j(r2));
    const r3 = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "13:00"), bk("A", THU, "15:00")], noOff, "12:30");
    ck("today, notice at 12:30, Alexandre has only 5pm: offer = 2pm (Diego) + 5pm", r3.preferred.join(",") === "14:00,17:00" && r3.onRequest.join(",") === "13:00,15:00,16:00,18:00,19:00,20:00", j(r3));
  }
  {
    const A2: Seller = { ...A, id: "A2", name: "Twin", priority: 1 };
    const r = splitDaySlotsByPriority([A, A2, C], THU, 4, [bk("A", THU, "09:00")], noOff);
    ck("equal priorities never hold each other back (twin's 9am still offered)", r.preferred.includes("09:00"), j(r));
  }
  {
    const r = splitDaySlotsByPriority([{ ...A, active: false }, C], THU, 4, [], noOff);
    ck("inactive higher-priority seller does not hold anyone back", r.preferred.includes("09:00") && r.onRequest.length === 0, j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "09:00")], noOff);
    ck("preferred and on-request never overlap", r.preferred.every((t) => !r.onRequest.includes(t)));
    ck("preferred ∪ on-request = every open hour of the day", [...r.preferred, ...r.onRequest].sort().join(",") === "09:00,11:00,13:00,14:00,15:00,16:00,17:00,18:00,19:00,20:00", j(r));
    ck("slotsForWeekday still the only grid source (Diego Sunday override)", slotsForWeekday(D, 0).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && slotsForWeekday(D, 4).join(",") === "14:00,16:00,18:00,20:00");
  }

  console.log("\n[2] STATIC — wiring");
  const sc = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8").replace(/\r\n/g, "\n");
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8").replace(/\r\n/g, "\n");
  ck("getRealAvailabilityContext uses splitDaySlotsByPriority and prints the parenthesis", /const \{ preferred, onRequest \} = splitDaySlotsByPriority\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);\s*const slots = preferred;/.test(sc) && /open only if the client asks for one of these: " \+ onRequest\.map\(fmt12\)/.test(sc) && /\$\{onRequestNote\}`\);/.test(sc));
  ck("getNextOpenSlots uses the split (preferred first)", /const times = preferred\.length > 0 \? preferred : onRequest;\s*if \(times\.length > 0\) out\.push/.test(sc));
  ck("getPreferredSlots exists and the canned offers use it", /export async function getPreferredSlots\(dateStr: string\)/.test(sc) && /let slots = await getPreferredSlots\(dateStr\);/.test(sc) && /await getPreferredSlots\(requestedDate\)\)\.filter/.test(sc));
  ck("createBooking still books ANY free seller (pickSellerForSlot over all sellers, lowest priority first)", /const seller = pickSellerForSlot\(sellers, bookings, req\.bookingDate, req\.bookingTime, daysOff\);/.test(sc) && /\.sort\(\(a, b\) => a\.priority - b\.priority\);\s*return candidates\[0\] \?\? null;/.test(sc));
  ck("schedule bullet: parenthesis hours never offered, accepted when asked", /ONE TEAM MEMBER'S DAY FILLS BEFORE THE NEXT ONE'S \(owner's rule 2026-09-17\)/.test(sc) && /If the client, on their own, asks for one of those parenthesis times, it IS open: accept it and book it normally/.test(sc));
  ck("SOONEST DAY FIRST bullet still there", /SOONEST DAY FIRST \(owner's rule/.test(sc) && /EARLIEST two open times/.test(sc));
  ck("ai.ts rule 33 knows the parenthesis hours are not offered", /inside a parenthesis as 'open only if the client asks for one of these' are NOT offered by you/.test(ai));

  if (process.env.DET_ONLY === "1") return done();

  console.log("\n[3] LIVE DB (read-only) — real schedule text vs the split");
  const avail = await getRealAvailabilityContext();
  const dayLines = avail.split("\n").filter((l) => l.startsWith("• "));
  console.log(dayLines.slice(0, 5).join("\n"));
  ck("schedule read", dayLines.length === 21, String(dayLines.length));
  let checked = 0;
  for (const line of dayLines.slice(1, 6)) { // skip today (same-day notice differs from getAvailableSlots)
    const date = (/\[(\d{4}-\d{2}-\d{2})\]/.exec(line) ?? [])[1];
    if (!date || /fully booked/.test(line)) continue;
    const main = (line.split("]: ")[1] ?? "").replace(/\s*\(open only if[^)]*\)\s*$/, "").split(", ").map((s) => s.trim()).filter(Boolean);
    const paren = (/\(open only if the client asks for one of these: ([^)]*)\)/.exec(line) ?? [])[1]?.split(", ").map((s) => s.trim()) ?? [];
    const all = (await getAvailableSlots(date)).map(fmt12);
    const pref = (await getPreferredSlots(date)).map(fmt12);
    ck(`${date}: listed ∪ parenthesis = every open hour (${all.join(",")})`, [...main, ...paren].sort().join(",") === [...all].sort().join(","), `${main.join(",")} + (${paren.join(",")}) vs ${all.join(",")}`);
    ck(`${date}: listed hours = getPreferredSlots, chronological`, main.join(",") === pref.join(","), `${main.join(",")} vs ${pref.join(",")}`);
    checked++;
  }
  ck("at least one future day compared", checked >= 1, String(checked));

  console.log("\n[4] LIVE MODEL — offers only the listed hours; accepts a parenthesis hour when asked");
  const sched = [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    "• Thursday, September 17, 2026 [2026-09-17]: fully booked",
    "• Friday, September 18, 2026 [2026-09-18]: 1pm, 2pm (open only if the client asks for one of these: 11am, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm)",
    "• Saturday, September 19, 2026 [2026-09-19]: 9am, 11am, 1pm, 3pm, 5pm",
    "• Sunday, September 20, 2026 [2026-09-20]: 9am, 11am, 1pm, 3pm, 5pm, 7pm",
  ].join("\n") + avail.slice(avail.indexOf("\nIMPORTANT"));
  const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), sched].join("\n\n")}]`;
  const base: ChatMessage[] = [
    { role: "user", content: "Hi, I want luxury vinyl for my whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. When works for you?" },
  ];
  for (let i = 1; i <= 2; i++) {
    const r = await getAIResponse([...base, { role: "user", content: `I'm flexible, any day works.${sys}` }], null, null, null, false);
    const t = r.text; const c = clockTimes(t);
    console.log(`   offer #${i} →`, t.replace(/\s+/g, " ").slice(0, 240));
    // The two-slot count itself is guarded by no-route-verify C1; here the point is the PARENTHESIS:
    // Friday's offer must start with its first two listed hours and never name 11am/3pm/7pm for Friday.
    const fridayClause = (/friday[^.!?\n]*/i.exec(t) ?? [""])[0];
    ck(`offer #${i}: Friday's first two listed hours (1pm, 2pm) come first, never Friday 11am/3pm/7pm`, c[0] === "1pm" && c[1] === "2pm" && !/\b(?:11\s*am|3\s*pm|7\s*pm)\b/i.test(fridayClause), `${c.join(",")} | ${t}`);
    ck(`offer #${i}: no leak of the rule (parenthesis / team member / fills)`, !/parenthes|team member|only if the client asks|fills before|owner/i.test(t), t);
  }
  {
    const r = await getAIResponse([...base, { role: "user", content: `Can you come Friday at 11am? That's the only time I can do.${sys}` }], null, null, null, false);
    const t = r.text;
    console.log("   asks 11am →", t.replace(/\s+/g, " ").slice(0, 240));
    ck("client asks for a parenthesis hour (Friday 11am): accepted, never 'not available'", /11\s*am/i.test(t) && !/not\s+(?:open|available)|isn'?t\s+(?:open|available|on)|no longer|fully booked|don'?t have 11/i.test(t), t);
    ck("…and moves on to the details (address with zip + phone), no [BOOK] yet", /address|zip|phone|number/i.test(t) && !/\[BOOK:/.test(t), t);
  }
  done();
}
function done() {
  console.log(`\n=========== SELLER-PRIORITY-FILL-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
