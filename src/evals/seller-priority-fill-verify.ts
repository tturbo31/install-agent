// Owner rule 2026-09-17: "lotar a agenda de UM vendedor antes do próximo, ordem
// estrita; lotar o dia mais próximo de todos os vendedores, nenhum dia picado".
// ORDER since 2026-09-29 (owner): Diego → Alexandre → Chris (it was
// Alexandre → Diego → Chris from 17/09 to 29/09). The order lives in
// sellers.priority of the Ozzi Plataforma; the bot's platform user cannot UPDATE
// that table (RLS), so applySellerPriorityOrder (scheduler.ts) swaps Diego and
// Alexandre after every read while the table still holds the 17/09 snapshot
// (Alexandre 1, Diego 2). Any other order set by the owner in the platform wins.
// The schedule the model reads used to be a seller-less union of every open
// hour, so with the first seller's 9am taken it still listed 9am (Chris's) and
// the next client landed on Chris while the first seller had hours open. Now:
//  • splitDaySlotsByPriority (STRICT order): a seller's hours are only OFFERED
//    once every seller in front of him has no open hour left that day, whatever
//    the hour grids; they stay bookable and are shown in a parenthesis "open
//    only if the client asks for one of these". Single exception: the seller in
//    front has ONE hour left → the offer is topped up with the next seller's
//    earliest hour, same day.
//  • getRealAvailabilityContext / getNextOpenSlots / getPreferredSlots (the
//    canned offers) all use it; createBooking still books ANY free seller
//    (pickSellerForSlot, lowest priority number first) so an asked-for hour
//    is never refused.
//  1. DETERMINISTIC (no API, no DB): the split with the real grids, and the
//     priority override itself.
//  2. STATIC: wiring (every sellers read goes through the override) + the
//     instruction bullet + rule 33.
//  3. LIVE DB (read-only): effective order Diego → Alexandre → Chris; the real
//     schedule text is consistent with the split (preferred ∪ parenthesis =
//     every open hour, chronological).
//  4. LIVE MODEL: offers only the listed hours, never a parenthesis hour; a
//     client asking for a parenthesis hour is accepted.
// Set DET_ONLY=1 to skip 3 and 4.
import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { splitDaySlotsByPriority, applySellerPriorityOrder, getRealAvailabilityContext, getAvailableSlots, getPreferredSlots, getEasternDateContext, slotsForWeekday, type Seller, type BookingRow } from "../lib/scheduler";

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

// The real grids (scheduler DB): Diego Mon-Fri 2/4/6/8pm + Sunday 9..7pm;
// Alexandre Mon-Sat 9/11/1/3/5; Chris Sun-Fri 9/11/1/3/5/7pm.
// Priorities as they are EFFECTIVE since 2026-09-29: Diego 1, Alexandre 2, Chris 3.
const D: Seller = { id: "D", name: "Diego", priority: 1, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["14:00", "16:00", "18:00", "20:00"], weekday_time_slots: { "0": ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] }, active: true };
const A: Seller = { id: "A", name: "Alexandre", priority: 2, enabled_weekdays: [1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00"], weekday_time_slots: null, active: true };
const C: Seller = { id: "C", name: "Chris", priority: 3, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], weekday_time_slots: null, active: true };
const SELLERS = [C, A, D]; // deliberately unsorted
const bk = (seller_id: string, booking_date: string, booking_time: string): BookingRow => ({ seller_id, booking_date, booking_time });
const THU = "2026-09-17"; // weekday 4
const SUN = "2026-09-20"; // weekday 0
const SAT = "2026-09-19"; // weekday 6
const noOff = new Set<string>();
// Real ids in the scheduler DB (the override is keyed by id, never by name).
const ID_A = "8aa8842e-c903-42b3-aa11-28252024713f";
const ID_D = "c6fcb045-b914-4bd1-8d2d-bb7f49e90ff4";
const ID_C = "35f950e6-c1dd-4742-b77f-5071dbc3508b";
const j = (r: { preferred: string[]; onRequest: string[] }) => `${r.preferred.join(",")} | ${r.onRequest.join(",")}`;

async function main() {
  console.log("\n[1] DETERMINISTIC — splitDaySlotsByPriority, strict order Diego → Alexandre → Chris");
  const FULL_D = ["14:00", "16:00", "18:00", "20:00"].map((t) => bk("D", THU, t));
  const FULL_A = ["09:00", "11:00", "13:00", "15:00", "17:00"].map((t) => bk("A", THU, t));
  const FULL_C = ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].map((t) => bk("C", THU, t));
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [], noOff);
    ck("empty weekday: offered = Diego's day only (2pm, 4pm, 6pm, 8pm)", r.preferred.join(",") === "14:00,16:00,18:00,20:00", j(r));
    ck("empty weekday: Alexandre's 9am..5pm and Chris's 7pm wait in the parenthesis", r.onRequest.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("D", THU, "14:00")], noOff);
    ck("Diego's 2pm taken: offer = his 4pm, 6pm, 8pm only (no Alexandre, no Chris)", r.preferred.join(",") === "16:00,18:00,20:00", j(r));
    ck("…2pm (nobody else has it) is gone, everything else waits in the parenthesis", !r.onRequest.includes("14:00") && r.onRequest.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_D.slice(0, 3), noOff);
    ck("Diego has ONE hour left (8pm): offer = 8pm + Alexandre's earliest (9am), same day", r.preferred.join(",") === "09:00,20:00", j(r));
    ck("…the rest of Alexandre's day and Chris's 7pm stay in the parenthesis", r.onRequest.join(",") === "11:00,13:00,15:00,17:00,19:00", j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_D, noOff);
    ck("Diego FULL: Alexandre's day is offered (9am, 11am, 1pm, 3pm, 5pm), Chris still waits (7pm)", r.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00" && r.onRequest.join(",") === "19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_D, bk("A", THU, "09:00")], noOff);
    ck("Diego full, Alexandre's 9am taken: 9am (Chris) is NOT offered, goes to the parenthesis", !r2.preferred.includes("09:00") && r2.onRequest.includes("09:00"), j(r2));
    ck("…and the offer is Alexandre's 11am, 1pm, 3pm, 5pm only", r2.preferred.join(",") === "11:00,13:00,15:00,17:00" && r2.onRequest.join(",") === "09:00,19:00", j(r2));
    const r3 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_D, ...FULL_A.slice(0, 4)], noOff);
    ck("Diego full, Alexandre has ONE hour left (5pm): offer = Chris's 9am + 5pm, same day", r3.preferred.join(",") === "09:00,17:00" && r3.onRequest.join(",") === "11:00,13:00,15:00,19:00", j(r3));
    const r4 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_D, ...FULL_A], noOff);
    ck("Diego AND Alexandre full: Chris's whole day opens (9am first), nothing on request", r4.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r4.onRequest.length === 0, j(r4));
    const r5 = splitDaySlotsByPriority(SELLERS, THU, 4, [...FULL_D, ...FULL_A, ...FULL_C], noOff);
    ck("everyone full: nothing offered, nothing on request", r5.preferred.length === 0 && r5.onRequest.length === 0, j(r5));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [], new Set<string>([`D|${THU}`]));
    ck("Diego on a day off: Alexandre's day is offered, Chris waits", r.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00" && r.onRequest.join(",") === "19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [], new Set<string>([`D|${THU}`, `A|${THU}`]));
    ck("Diego and Alexandre off: Chris's day is offered normally", r2.preferred.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && r2.onRequest.length === 0, j(r2));
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
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_D, noOff, "12:30");
    ck("today, notice at 12:30: Diego full → Alexandre's 1pm, 3pm, 5pm offered, Chris's 7pm on request", r.preferred.join(",") === "13:00,15:00,17:00" && r.onRequest.join(",") === "19:00", j(r));
    const r2 = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("D", THU, "14:00")], noOff, "12:30");
    ck("today, notice at 12:30, Diego still has 4pm/6pm/8pm: offer = those; everything else on request", r2.preferred.join(",") === "16:00,18:00,20:00" && r2.onRequest.join(",") === "13:00,15:00,17:00,19:00", j(r2));
    const r3 = splitDaySlotsByPriority(SELLERS, THU, 4, FULL_D.slice(0, 3), noOff, "12:30");
    ck("today, notice at 12:30, Diego has only 8pm: offer = 1pm (Alexandre) + 8pm", r3.preferred.join(",") === "13:00,20:00" && r3.onRequest.join(",") === "15:00,17:00,19:00", j(r3));
  }
  {
    const D2: Seller = { ...D, id: "D2", name: "Twin", priority: 1 };
    const r = splitDaySlotsByPriority([D, D2, A], THU, 4, [bk("D", THU, "14:00")], noOff);
    ck("equal priorities never hold each other back (twin's 2pm still offered)", r.preferred.includes("14:00"), j(r));
  }
  {
    const r = splitDaySlotsByPriority([{ ...D, active: false }, A], THU, 4, [], noOff);
    ck("inactive higher-priority seller does not hold anyone back", r.preferred.includes("09:00") && r.onRequest.length === 0, j(r));
  }
  {
    const r = splitDaySlotsByPriority(SELLERS, THU, 4, [bk("A", THU, "09:00")], noOff);
    ck("preferred and on-request never overlap", r.preferred.every((t) => !r.onRequest.includes(t)));
    ck("preferred ∪ on-request = every open hour of the day", [...r.preferred, ...r.onRequest].sort().join(",") === "09:00,11:00,13:00,14:00,15:00,16:00,17:00,18:00,19:00,20:00", j(r));
    ck("slotsForWeekday still the only grid source (Diego Sunday override)", slotsForWeekday(D, 0).join(",") === "09:00,11:00,13:00,15:00,17:00,19:00" && slotsForWeekday(D, 4).join(",") === "14:00,16:00,18:00,20:00");
  }

  console.log("\n[1b] DETERMINISTIC — applySellerPriorityOrder (platform still Alexandre 1 / Diego 2 → Diego 1 / Alexandre 2)");
  {
    const snap = [{ id: ID_A, name: "Alexandre", priority: 1 }, { id: ID_D, name: "Diego", priority: 2 }, { id: ID_C, name: "Chris", priority: 3 }];
    const r = applySellerPriorityOrder(snap);
    ck("17/09 snapshot → Diego 1, Alexandre 2, Chris 3, sorted", r.map((s) => `${s.name}=${s.priority}`).join(",") === "Diego=1,Alexandre=2,Chris=3", JSON.stringify(r));
    ck("input rows are not mutated", snap[0].priority === 1 && snap[1].priority === 2 && snap[0].name === "Alexandre");
    const already = [{ id: ID_D, name: "Diego", priority: 1 }, { id: ID_A, name: "Alexandre", priority: 2 }, { id: ID_C, name: "Chris", priority: 3 }];
    ck("platform already Diego-first → untouched (no-op, same array)", applySellerPriorityOrder(already) === already);
    const other = [{ id: ID_A, name: "Alexandre", priority: 1 }, { id: ID_C, name: "Chris", priority: 2 }, { id: ID_D, name: "Diego", priority: 3 }];
    ck("any other order set by the owner in the platform wins (untouched)", applySellerPriorityOrder(other) === other);
    ck("Alexandre inactive/missing → untouched", applySellerPriorityOrder(snap.filter((s) => s.id !== ID_A)).map((s) => s.name).join(",") === "Diego,Chris");
    ck("Diego inactive/missing → untouched", applySellerPriorityOrder(snap.filter((s) => s.id !== ID_D)).map((s) => s.name).join(",") === "Alexandre,Chris");
    const four = [...snap, { id: "new-seller", name: "Novo", priority: 4 }];
    ck("a 4th seller keeps its own priority and place", applySellerPriorityOrder(four).map((s) => `${s.name}=${s.priority}`).join(",") === "Diego=1,Alexandre=2,Chris=3,Novo=4");
    ck("keyed by id, not by name (a renamed row still swaps)", applySellerPriorityOrder(snap.map((s) => ({ ...s, name: s.name.toUpperCase() }))).map((s) => s.name).join(",") === "DIEGO,ALEXANDRE,CHRIS");
    const real = applySellerPriorityOrder([{ ...A, id: ID_A, priority: 1 }, { ...D, id: ID_D, priority: 2 }, { ...C, id: ID_C, priority: 3 }]);
    const split = splitDaySlotsByPriority(real, THU, 4, [], noOff);
    ck("end to end: rows as the platform returns them today → the split offers Diego's day first", split.preferred.join(",") === "14:00,16:00,18:00,20:00" && split.onRequest.join(",") === "09:00,11:00,13:00,15:00,17:00,19:00", j(split));
  }

  console.log("\n[2] STATIC — wiring");
  const sc = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8").replace(/\r\n/g, "\n");
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8").replace(/\r\n/g, "\n");
  ck("every sellers read goes through applySellerPriorityOrder (6 sites, none bare)", (sc.match(/const sellers = applySellerPriorityOrder\(\(sellersData \?\? \[\]\) as Seller\[\]\);/g) ?? []).length === 6 && !/const sellers = \(sellersData \?\? \[\]\) as Seller\[\];/.test(sc), String((sc.match(/const sellers = applySellerPriorityOrder/g) ?? []).length));
  ck("override keyed by the real ids and only on the 17/09 snapshot (any other platform order wins)", /SELLER_ID_ALEXANDRE = "8aa8842e-c903-42b3-aa11-28252024713f"/.test(sc) && /SELLER_ID_DIEGO = "c6fcb045-b914-4bd1-8d2d-bb7f49e90ff4"/.test(sc) && /alexandre\.priority !== 1 \|\| diego\.priority !== 2\) return sellers;/.test(sc));
  ck("getRealAvailabilityContext uses splitDaySlotsByPriority and prints the parenthesis", /const \{ preferred, onRequest \} = splitDaySlotsByPriority\(sellers, dateStr, weekday, bookings, daysOff, notBefore\);\s*const slots = preferred;/.test(sc) && /open only if the client asks for one of these: " \+ onRequest\.map\(fmt12\)/.test(sc) && /\$\{onRequestNote\}`\);/.test(sc));
  ck("getNextOpenSlots uses the split (preferred first)", /const times = preferred\.length > 0 \? preferred : onRequest;\s*if \(times\.length > 0\) out\.push/.test(sc));
  ck("getPreferredSlots exists and the canned offers use it", /export async function getPreferredSlots\(dateStr: string\)/.test(sc) && /let slots = await getPreferredSlots\(dateStr\);/.test(sc) && /await getPreferredSlots\(requestedDate\)\)\.filter/.test(sc));
  ck("createBooking still books ANY free seller (pickSellerForSlot over all sellers, lowest priority first)", /const seller = pickSellerForSlot\(sellers, bookings, req\.bookingDate, req\.bookingTime, daysOff\);/.test(sc) && /\.sort\(\(a, b\) => a\.priority - b\.priority\);\s*return candidates\[0\] \?\? null;/.test(sc));
  ck("schedule bullet: parenthesis hours never offered, accepted when asked", /ONE TEAM MEMBER'S DAY FILLS BEFORE THE NEXT ONE'S \(owner's rule 2026-09-17\)/.test(sc) && /If the client, on their own, asks for one of those parenthesis times, it IS open: accept it and book it normally/.test(sc));
  ck("SOONEST DAY FIRST bullet still there", /SOONEST DAY FIRST \(owner's rule/.test(sc) && /EARLIEST two open times/.test(sc));
  ck("ai.ts rule 33 knows the parenthesis hours are not offered", /inside a parenthesis as 'open only if the client asks for one of these' are NOT offered by you/.test(ai));
  ck("no seller is named in the schedule bullet or rule 33 (order comes from priority only)", !/Alexandre|Diego|Chris/.test((/ONE TEAM MEMBER'S DAY FILLS[^\n]*/.exec(sc) ?? [""])[0]) && !/Alexandre|Diego|Chris/.test((/33\. EXACTLY TWO SLOTS RULE[^\n]*/.exec(ai) ?? [""])[0]));

  if (process.env.DET_ONLY === "1") return done();

  console.log("\n[3] LIVE DB (read-only) — effective seller order + real schedule text vs the split");
  {
    // Same read-only credentials as scheduler.ts (bot user; it cannot UPDATE sellers).
    const db = createClient(
      "https://wtyezgfzzetfrhoaqemt.supabase.co",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4",
      { auth: { persistSession: false } }
    );
    const { error } = await db.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });
    ck("scheduler DB login (read-only)", !error, error?.message ?? "");
    const { data } = await db.from("sellers").select("id,name,priority,active").eq("active", true).order("priority", { ascending: true });
    const raw = (data ?? []) as Array<{ id: string; name: string; priority: number; active: boolean }>;
    console.log("   platform priorities:", raw.map((s) => `${s.name}=${s.priority}`).join(", "));
    const eff = applySellerPriorityOrder(raw);
    console.log("   effective order    :", eff.map((s) => `${s.name}=${s.priority}`).join(", "));
    ck("effective order is Diego → Alexandre → Chris", eff.map((s) => s.name).join(" → ") === "Diego → Alexandre → Chris", eff.map((s) => s.name).join(" → "));
    const platformDiegoFirst = raw.find((s) => s.id === ID_D)?.priority === 1;
    console.log(platformDiegoFirst ? "   (platform already holds Diego first — applySellerPriorityOrder is a no-op and can be removed)" : "   (platform still holds Alexandre first — override active until the owner updates the platform)");
  }
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
  // Synthetic schedule shaped like a real weekday line under the new order:
  // Diego's 2/4/6/8pm listed, Alexandre's and Chris's hours in the parenthesis.
  // Dates are built from today (Eastern) so the model's date context matches.
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayAt = (i: number) => { const d = new Date(et); d.setDate(d.getDate() + i); return d; };
  const lineHead = (d: Date) => `• ${d.toLocaleDateString("en-US", { weekday: "long" })}, ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} [${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}]`;
  const wd1 = dayAt(1).toLocaleDateString("en-US", { weekday: "long" });
  const sched = [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    `${lineHead(dayAt(0))}: fully booked`,
    `${lineHead(dayAt(1))}: 2pm, 4pm, 6pm, 8pm (open only if the client asks for one of these: 9am, 11am, 1pm, 3pm, 5pm, 7pm)`,
    `${lineHead(dayAt(2))}: 9am, 11am, 1pm, 3pm, 5pm`,
    `${lineHead(dayAt(3))}: 9am, 11am, 1pm, 3pm, 5pm, 7pm`,
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
    // tomorrow's offer must start with its first two listed hours (2pm, 4pm) and never name a parenthesis hour for that day.
    const dayClause = (new RegExp(`(?:${wd1}|tomorrow)[^.!?\\n]*`, "i").exec(t) ?? [""])[0];
    ck(`offer #${i}: ${wd1}'s first two listed hours (2pm, 4pm) come first, never ${wd1} 9am/11am/1pm/3pm/5pm/7pm`, c[0] === "2pm" && c[1] === "4pm" && !/\b(?:9\s*am|11\s*am|1\s*pm|3\s*pm|5\s*pm|7\s*pm)\b/i.test(dayClause), `${c.join(",")} | ${t}`);
    ck(`offer #${i}: no leak of the rule (parenthesis / team member / fills)`, !/parenthes|team member|only if the client asks|fills before|owner/i.test(t), t);
  }
  {
    const r = await getAIResponse([...base, { role: "user", content: `Can you come ${wd1} at 11am? That's the only time I can do.${sys}` }], null, null, null, false);
    const t = r.text;
    console.log("   asks 11am →", t.replace(/\s+/g, " ").slice(0, 240));
    ck(`client asks for a parenthesis hour (${wd1} 11am): accepted, never 'not available'`, /11\s*am/i.test(t) && !/not\s+(?:open|available)|isn'?t\s+(?:open|available|on)|no longer|fully booked|don'?t have 11/i.test(t), t);
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
