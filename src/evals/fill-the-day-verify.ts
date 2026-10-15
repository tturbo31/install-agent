// Owner rule 2026-09-30: NO seller hierarchy. "Retire a hierarquia e sempre dê
// privilégio para lotar o dia da agenda: se hoje é dia 30, ela tem que agendar
// todos os horários do dia 30." From 17/09 to 30/09 the offer followed a seller
// order (one seller's day had to fill before the next seller's hours were
// offered; the held-back hours sat in a parenthesis "open only if the client
// asks"). Real case that ended it: Annabelle Ruiz (WA, 30/09 9:12am) was
// offered "today at 6pm or 8pm" while 1pm, 5pm and 7pm were open on the other
// sellers. Now a day's schedule line is the UNION of every active seller's
// open hours (openHoursForDay), earliest first; SOONEST DAY FIRST fills today
// before tomorrow. Owner rule 2026-10-15 ("retire a prioridade dos instaladores
// ... retire a prioridade de horários"): `priority` is not read at all (a tie
// goes to the least-loaded seller, pickSellerForSlot) and the two times offered
// for a day are its earliest and its latest (offerPair), never its first two.
//  1. DETERMINISTIC (no API, no DB): openHoursForDay with the real grids.
//  2. STATIC: the hierarchy is gone from scheduler.ts / ai.ts / ig-diag, every
//     sellers read is bare, the canned offers use every open hour.
//  3. LIVE DB (read-only): the real schedule text has no parenthesis and each
//     line equals getAvailableSlots(date).
//  4. LIVE MODEL: with today's line "1pm, 5pm, 6pm, 7pm, 8pm" (Annabelle's real
//     day without the hierarchy) the offer is 1pm + 8pm (earliest + latest).
// Set DET_ONLY=1 to skip 3 and 4.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { openHoursForDay, getRealAvailabilityContext, getAvailableSlots, getPreferredSlots, getEasternDateContext, slotsForWeekday, pickSellerForSlot, offerPair, type Seller, type BookingRow } from "../lib/scheduler";

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

// The real grids (scheduler DB, 30/09/2026): Alexandre Mon-Sat 9/11/1/3/5 (p1);
// Diego Mon-Fri 2/4/6/8pm + Sunday 9..7pm (p2); Chris Sun-Fri 9/11/1/3/5/7pm (p3).
const A: Seller = { id: "A", name: "Alexandre", priority: 1, enabled_weekdays: [1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00"], weekday_time_slots: null, active: true };
const D: Seller = { id: "D", name: "Diego", priority: 2, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["14:00", "16:00", "18:00", "20:00"], weekday_time_slots: { "0": ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] }, active: true };
const C: Seller = { id: "C", name: "Chris", priority: 3, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], weekday_time_slots: null, active: true };
const SELLERS = [C, D, A]; // deliberately unsorted
const bk = (seller_id: string, booking_date: string, booking_time: string): BookingRow => ({ seller_id, booking_date, booking_time });
const WED = "2026-09-30"; // weekday 3 (Annabelle's day)
const SUN = "2026-10-04"; // weekday 0
const SAT = "2026-10-03"; // weekday 6
const noOff = new Set<string>();
const ALL_WEEKDAY = "09:00,11:00,13:00,14:00,15:00,16:00,17:00,18:00,19:00,20:00";

async function main() {
  console.log("\n[1] DETERMINISTIC — openHoursForDay = union of every seller's open hours, earliest first, no hierarchy");
  ck("empty weekday: every hour of the three grids, chronological", openHoursForDay(SELLERS, WED, 3, [], noOff).join(",") === ALL_WEEKDAY, openHoursForDay(SELLERS, WED, 3, [], noOff).join(","));
  {
    // Annabelle's real morning (30/09 at 9:12am): Alexandre 9am+3pm booked, Chris 9am+3pm booked, Diego 2pm+4pm booked.
    const real = [bk("A", WED, "09:00"), bk("A", WED, "15:00"), bk("C", WED, "09:00"), bk("C", WED, "15:00"), bk("D", WED, "14:00"), bk("D", WED, "16:00")];
    const r = openHoursForDay(SELLERS, WED, 3, real, noOff, "11:12");
    ck("ANNABELLE (9:12am, notice 2h): 1pm, 5pm, 6pm, 7pm, 8pm — 1pm and 5pm come BEFORE Diego's 6pm/8pm", r.join(",") === "13:00,17:00,18:00,19:00,20:00", r.join(","));
    const r2 = openHoursForDay(SELLERS, WED, 3, real, noOff);
    ck("same day seen from the night before: 11am, 1pm, 5pm, 6pm, 7pm, 8pm", r2.join(",") === "11:00,13:00,17:00,18:00,19:00,20:00", r2.join(","));
  }
  ck("Alexandre's 9am taken → 9am STILL open (Chris has it): the day fills, whoever is free takes it", openHoursForDay(SELLERS, WED, 3, [bk("A", WED, "09:00")], noOff).includes("09:00"));
  ck("Alexandre's AND Chris's 9am taken → 9am gone", !openHoursForDay(SELLERS, WED, 3, [bk("A", WED, "09:00"), bk("C", WED, "09:00")], noOff).includes("09:00"));
  ck("Diego's whole day taken → his 2/4/6/8pm gone, the rest stays", openHoursForDay(SELLERS, WED, 3, ["14:00", "16:00", "18:00", "20:00"].map((t) => bk("D", WED, t)), noOff).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00");
  ck("notBefore 12:30 (same-day notice) → from 1pm on", openHoursForDay(SELLERS, WED, 3, [], noOff, "12:30").join(",") === "13:00,14:00,15:00,16:00,17:00,18:00,19:00,20:00");
  ck("Diego on a day off → his hours gone", openHoursForDay(SELLERS, WED, 3, [], new Set([`D|${WED}`])).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00");
  ck("inactive seller ignored", openHoursForDay([{ ...D, active: false }, A], WED, 3, [], noOff).join(",") === "09:00,11:00,13:00,15:00,17:00");
  ck("Sunday (Diego's override grid + Chris): 9am..7pm, not doubled", openHoursForDay(SELLERS, SUN, 0, [], noOff).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00");
  ck("Sunday, Diego's 9am + 11am taken: 9am and 11am STILL open (Chris)", openHoursForDay(SELLERS, SUN, 0, [bk("D", SUN, "09:00"), bk("D", SUN, "11:00")], noOff).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00");
  ck("Saturday (only Alexandre works): his hours", openHoursForDay(SELLERS, SAT, 6, [], noOff).join(",") === "09:00,11:00,13:00,15:00,17:00");
  ck("everyone full → nothing", openHoursForDay(SELLERS, WED, 3, [...["09:00", "11:00", "13:00", "15:00", "17:00"].map((t) => bk("A", WED, t)), ...["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].map((t) => bk("C", WED, t)), ...["14:00", "16:00", "18:00", "20:00"].map((t) => bk("D", WED, t))], noOff).length === 0);
  ck("input order is irrelevant (unsorted sellers, same result)", openHoursForDay([A, D, C], WED, 3, [], noOff).join(",") === openHoursForDay([C, D, A], WED, 3, [], noOff).join(","));
  ck("slotsForWeekday still the only grid source (Diego Sunday override)", slotsForWeekday(D, 0).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && slotsForWeekday(D, 3).join(",") === "14:00,16:00,18:00,20:00");

  console.log("\n[1b] DETERMINISTIC — pickSellerForSlot: no installer order, the hour goes to the least-loaded (owner rule 2026-10-15)");
  // Wednesday 9am is open for Alexandre (priority 1) and Chris (priority 3): priority used to hand it to Alexandre every time.
  ck("tie, nobody booked: lowest id wins (A < C), never priority", pickSellerForSlot(SELLERS, [], WED, "09:00", noOff)?.id === "A");
  ck("Alexandre has 2 visits that day, Chris none → Chris takes 9am", pickSellerForSlot(SELLERS, [bk("A", WED, "11:00"), bk("A", WED, "13:00")], WED, "09:00", noOff)?.id === "C");
  ck("same load that day → fewer visits in the whole window wins", pickSellerForSlot(SELLERS, [bk("A", WED, "11:00"), bk("C", WED, "11:00"), bk("A", "2026-10-01", "09:00")], WED, "09:00", noOff)?.id === "C");
  ck("priority 1 with the fuller day loses even to priority 3", pickSellerForSlot([{ ...A, priority: 1 }, { ...C, priority: 3 }], [bk("A", WED, "11:00")], WED, "09:00", noOff)?.id === "C");
  ck("only one seller free at the hour → that one (Diego's 2pm)", pickSellerForSlot(SELLERS, [], WED, "14:00", noOff)?.id === "D");
  ck("hour taken for everyone free at it → null", pickSellerForSlot(SELLERS, [bk("A", WED, "09:00"), bk("C", WED, "09:00")], WED, "09:00", noOff) === null);
  ck("priority field is optional and ignored", pickSellerForSlot([{ ...A, priority: undefined }, C], [bk("A", WED, "11:00")], WED, "09:00", noOff)?.id === "C");

  console.log("\n[1c] DETERMINISTIC — offerPair: the day's earliest and latest, never its first two");
  ck("ANNABELLE's line 1pm,5pm,6pm,7pm,8pm → 1pm + 8pm", offerPair(["13:00", "17:00", "18:00", "19:00", "20:00"]).join(",") === "13:00,20:00");
  ck("full weekday → 9am + 8pm", offerPair(ALL_WEEKDAY.split(",")).join(",") === "09:00,20:00");
  ck("two open hours → both", offerPair(["11:00", "15:00"]).join(",") === "11:00,15:00");
  ck("one open hour → that one", offerPair(["15:00"]).join(",") === "15:00");
  ck("empty → empty", offerPair([]).length === 0);
  ck("input untouched", (() => { const t = ["09:00", "11:00", "13:00"]; offerPair(t); return t.join(",") === "09:00,11:00,13:00"; })());

  console.log("\n[2] STATIC — the hierarchy is gone");
  const sc = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8").replace(/\r\n/g, "\n");
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8").replace(/\r\n/g, "\n");
  const diag = readFileSync(join(process.cwd(), "src/app/api/ig-diag/route.ts"), "utf-8");
  ck("scheduler.ts: no splitDaySlotsByPriority / applySellerPriorityOrder / sellerFillStrict / SELLER_FILL_STRICT", !/splitDaySlotsByPriority|applySellerPriorityOrder|sellerFillStrict|SELLER_FILL_STRICT|SELLER_ID_(?:ALEXANDRE|DIEGO|CHRIS)/.test(sc));
  ck("scheduler.ts: no parenthesis text, no 'ONE TEAM MEMBER' bullet", !/open only if the client asks|ONE TEAM MEMBER'S DAY FILLS/.test(sc));
  ck("every sellers read is bare (5 sites; getPreferredSlots no longer reads on its own)", (sc.match(/const sellers = \(sellersData \?\? \[\]\) as Seller\[\];/g) ?? []).length === 5 && !/applySellerPriorityOrder\(/.test(sc), String((sc.match(/const sellers = \(sellersData \?\? \[\]\) as Seller\[\];/g) ?? []).length));
  ck("getRealAvailabilityContext lists openHoursForDay", /const slots = openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);/.test(sc) && /lines\.push\(`• \$\{displayDate\}: \$\{formatted\.join\(", "\)\}`\);/.test(sc));
  ck("getNextOpenSlots uses openHoursForDay", /const times = openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);\s*if \(times\.length > 0\) out\.push/.test(sc));
  ck("getAvailableSlots uses openHoursForDay; getPreferredSlots = getAvailableSlots", /return openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff\);/.test(sc) && /export async function getPreferredSlots\(dateStr: string\): Promise<string\[\]> \{\s*return getAvailableSlots\(dateStr\);\s*\}/.test(sc));
  ck("canned offers still read getPreferredSlots", /let slots = await getPreferredSlots\(dateStr\);/.test(sc) && /await getPreferredSlots\(requestedDate\)\)\.filter/.test(sc));
  ck("createBooking still books ANY free seller; the tie goes to the least-loaded, priority is never read or ordered by", /const seller = pickSellerForSlot\(sellers, bookings, req\.bookingDate, req\.bookingTime, daysOff\);/.test(sc) && /load\(a, true\) - load\(b, true\) \|\| load\(a, false\) - load\(b, false\)/.test(sc) && !/a\.priority - b\.priority/.test(sc) && !/\.order\("priority"/.test(sc) && !/id,name,priority,/.test(sc));
  ck("offerPair exported and used by the canned offers (next-day apology, recovery, slot-gone note)", /export function offerPair\(times: string\[\]\): string\[\]/.test(sc) && /joinTimes\(lang, offerPair\(nextDay\.times\)\)/.test(sc) && /offerPair\(first\.times\)\.map\(fmt12\)/.test(sc) && /offerPair\(next!\.times\)\.join\(" or "\)/.test(sc) && !/times\.slice\(0, 2\)/.test(sc));
  ck("ZIP-first note no longer says 'the earliest two'", !/the earliest two of the soonest day/.test(sc) && /naming its earliest and its latest open time/.test(sc));
  ck("SOONEST DAY FIRST bullet: 'no order between team members', no parenthesis hint", /SOONEST DAY FIRST \(owner's rule/.test(sc) && /EARLIEST and its LATEST open time/.test(sc) && !/EARLIEST two open times/.test(sc) && /no preferred hour and no order between team members \(owner rule 2026-10-15\)/.test(sc) && !/sits in the parenthesis/.test(sc));
  ck("ai.ts rule 33: no parenthesis sentence, 'the DAY fills' instead", !/inside a parenthesis as 'open only if the client asks for one of these'/.test(ai) && /no order between team members and no preferred hour \(owner rules 2026-09-30 and 2026-10-15\): the DAY fills, today before tomorrow/.test(ai) && !/earliest hours first/.test(ai) && /EARLIEST and LATEST open times/.test(ai) && !/its first two listed, 9am before 11am before 1pm/.test(ai));
  ck("ai.ts rule 16 (time of day): two times inside the client's window, earliest + latest when more", /offer two open times INSIDE that window on the soonest day that has them \(when the window holds more than two, its earliest and its latest\)/.test(ai));
  ck("dreaming.ts trava 17: no preferred hour, no installer order", /17\. NO PREFERRED HOUR AND NO INSTALLER ORDER \(owner rule 2026-10-15\)/.test(readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8")));
  ck("ig-diag reports the tie-break and the hour offer", /sellerTieBreak: "least-loaded", hourOffer: "earliest\+latest"/.test(diag));
  ck("no seller is named in the schedule bullet or rule 33", !/Alexandre|Diego|Chris/.test((/SOONEST DAY FIRST \(owner's rule[^\n]*/.exec(sc) ?? [""])[0]) && !/Alexandre|Diego|Chris/.test((/33\. EXACTLY TWO SLOTS RULE[^\n]*/.exec(ai) ?? [""])[0]));
  ck("ig-diag no longer reports SELLER_FILL_STRICT", !/SELLER_FILL_STRICT/.test(diag) && /sellerHierarchy: false/.test(diag));
  ck("env SELLER_FILL_STRICT is read nowhere in src", !/SELLER_FILL_STRICT/.test(sc + ai + diag));

  if (process.env.DET_ONLY === "1") return done();

  console.log("\n[3] LIVE DB (read-only) — real schedule text: no parenthesis, each line = every open hour");
  const avail = await getRealAvailabilityContext();
  const dayLines = avail.split("\n").filter((l) => l.startsWith("• "));
  console.log(dayLines.slice(0, 5).join("\n"));
  ck("schedule read", dayLines.length === 21, String(dayLines.length));
  ck("no parenthesis on any line, no hierarchy bullet", !/open only if the client asks|ONE TEAM MEMBER/.test(avail));
  let checked = 0;
  for (const line of dayLines.slice(1, 6)) { // skip today (same-day notice differs from getAvailableSlots)
    const date = (/\[(\d{4}-\d{2}-\d{2})\]/.exec(line) ?? [])[1];
    if (!date || /fully booked/.test(line)) continue;
    const listed = (line.split("]: ")[1] ?? "").split(", ").map((s) => s.trim()).filter(Boolean);
    const all = (await getAvailableSlots(date)).map(fmt12);
    const pref = (await getPreferredSlots(date)).map(fmt12);
    ck(`${date}: listed = every open hour, chronological (${all.join(",")})`, listed.join(",") === all.join(","), `${listed.join(",")} vs ${all.join(",")}`);
    ck(`${date}: getPreferredSlots = getAvailableSlots`, pref.join(",") === all.join(","), `${pref.join(",")} vs ${all.join(",")}`);
    checked++;
  }
  ck("at least one future day compared", checked >= 1, String(checked));

  console.log("\n[4] LIVE MODEL — Annabelle's day without the hierarchy: today '1pm, 5pm, 6pm, 7pm, 8pm' → offer 1pm + 8pm (earliest + latest, owner rule 2026-10-15)");
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayAt = (i: number) => { const d = new Date(et); d.setDate(d.getDate() + i); return d; };
  const lineHead = (d: Date) => `• ${d.toLocaleDateString("en-US", { weekday: "long" })}, ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} [${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}]`;
  // "today" only works as a line while it is early enough Eastern for 1pm to be plausible; otherwise use tomorrow as the first line.
  const useToday = et.getHours() < 10;
  const first = useToday ? 0 : 1;
  const wd = dayAt(first).toLocaleDateString("en-US", { weekday: "long" });
  const sched = [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    ...(useToday ? [] : [`${lineHead(dayAt(0))}: fully booked`]),
    `${lineHead(dayAt(first))}: 1pm, 5pm, 6pm, 7pm, 8pm`,
    `${lineHead(dayAt(first + 1))}: 9am, 11am, 1pm, 2pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm`,
    `${lineHead(dayAt(first + 2))}: 9am, 11am, 1pm, 2pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm`,
  ].join("\n") + avail.slice(avail.indexOf("\nIMPORTANT"));
  const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), sched].join("\n\n")}]`;
  const base: ChatMessage[] = [
    { role: "user", content: "I need a quote" },
    { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
    { role: "user", content: "I have dogs which one should I get" },
    { role: "assistant", content: "Vinyl is the way to go, scratch resistant and 100% waterproof at $5 per sqft with the floor and installation included. One area or the whole house?" },
    { role: "user", content: "whole house, about 1000 sqft" },
    { role: "assistant", content: "For 1,000 sqft I need to come measure in person to give you the best price, it's a free visit and I bring all the samples. What's the zip code of the property?" },
  ];
  for (let i = 1; i <= 2; i++) {
    const r = await getAIResponse([...base, { role: "user", content: `33029${sys}` }], null, null, null, false);
    const t = r.text; const c = clockTimes(t);
    console.log(`   offer #${i} →`, t.replace(/\s+/g, " ").slice(0, 240));
    ck(`offer #${i}: ${wd}'s earliest + latest (1pm, 8pm), never its first two`, c[0] === "1pm" && c[1] === "8pm", `${c.join(",")} | ${t}`);
    ck(`offer #${i}: no leak (team member / parenthesis / owner / fills)`, !/parenthes|team member|only if the client asks|fills before|owner|hierarch/i.test(t), t);
    ck(`offer #${i}: short (under 230 characters)`, t.replace(/\[[A-Z_]+(?::[\s\S]*?)?\]/g, "").trim().length <= 230, String(t.length));
  }
  done();
}
function done() {
  console.log(`\n=========== FILL-THE-DAY-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
