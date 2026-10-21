// Offer-line guard (review of 20–21/10/2026). Re-reading 33 slot offers against
// the agenda at the moment of each one found two slips the prompt forbids:
//   • "Manana miercoles te queda mejor a las 9am o a las 8pm" (fb_28919223654397811,
//     20/10 21:16) while Wednesday's line ended at 5pm (the 8pm was Thursday's);
//   • "I have today at 2pm or 8pm tomorrow" (Jason Costello, IG 21/10 10:17)
//     while today's line still read "2pm, 3pm" and the client named no
//     preference: today's second hour hidden, the soonest day not filled first.
// Plus one price slip: "Tengo la loza" → "solo la instalacion a $2 por pie
// cuadrado" (tile labor is $4.50; $2 is the client-supplied laminate/vinyl rate).
//  1. DETERMINISTIC: offeredSlotsOf reads day + time pairs the way a client does.
//  2. DETERMINISTIC: offerLineDeviation flags only the three slips, never a
//     legitimate offer (client-named day, single-time day + next day, confirmations).
//  3. DETERMINISTIC: fixTileLaborRate.
//  4. STATIC: the three webhooks run the guard + retry, ig-diag reports the flags,
//     getAIResponse applies the tile labor backstop.
//  5. LIVE (LIVE=1): the rewrite note makes the model name only times on the line.
import { readFileSync } from "fs";
import { join } from "path";
import { offeredSlotsOf, getRealAvailabilityContext, getEasternDateContext } from "../lib/scheduler";
import { offerLineDeviation, clientStatedPreference } from "../lib/offer-line-guard";
import { fixTileLaborRate, getAIResponse, type ChatMessage } from "../lib/ai";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 400)}»`); }
}
const slots = (text: string, base: string) => offeredSlotsOf(text, base).map((s) => `${s.date} ${s.time}`).join(" | ");
const u = (content: string) => ({ role: "user", content });
const a = (content: string) => ({ role: "assistant", content });

// Tuesday 20/10/2026 at night: today has one hour left, Wednesday ends at 5pm, Thursday at 8pm.
const TUE = "2026-10-20";
const AVAIL_TUE = [
  "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
  "• Tuesday, October 20, 2026 [2026-10-20]: 4pm",
  "• Wednesday, October 21, 2026 [2026-10-21]: 9am, 1pm, 2pm, 3pm, 5pm",
  "• Thursday, October 22, 2026 [2026-10-22]: 9am, 11am, 1pm, 3pm, 4pm, 5pm, 6pm, 8pm",
  "• Friday, October 23, 2026 [2026-10-23]: 9am, 1pm, 8pm",
  "• Saturday, October 24, 2026 [2026-10-24]: fully booked",
  "• Sunday, October 25, 2026 [2026-10-25]: 9am, 7pm",
  "• Monday, October 26, 2026 [2026-10-26]: 9am, 4pm, 6pm",
  "",
  "IMPORTANT — read carefully before offering any time:",
  "- ONLY offer times listed above.",
].join("\n");
// Wednesday 21/10/2026 at 10:17: today's line "2pm, 3pm" (Jason's real morning).
const WED = "2026-10-21";
const AVAIL_WED = [
  "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
  "• Wednesday, October 21, 2026 [2026-10-21]: 2pm, 3pm",
  "• Thursday, October 22, 2026 [2026-10-22]: 11am, 1pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm",
  "• Friday, October 23, 2026 [2026-10-23]: 9am, 1pm, 3pm, 4pm, 5pm, 6pm, 7pm, 8pm",
  "• Saturday, October 24, 2026 [2026-10-24]: fully booked",
].join("\n");
const NO_PREF = [u("What is the installation process?"), a("Hi, we move the furniture, install the floor and leave everything clean, usually in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?"), u("Tile"), a("Tile installation is $4.50 per sqft for the labor. What's the zip code of the property?"), u("33033")];
const JASON = [u("Hi. I talked to you a couple months ago. Would like to see about you coming over to measure and give us an estimate"), a("Good to hear from you! The visit is free and I bring all the samples. What's the zip code of the property?"), u("33304")];

async function main() {
  console.log("\n[1] DETERMINISTIC — offeredSlotsOf: each time with the day it belongs to");
  ck("'today at 2pm or 8pm tomorrow' → 2pm today, 8pm tomorrow", slots("I have today at 2pm or 8pm tomorrow, which works better for you?", WED) === "2026-10-21 14:00 | 2026-10-22 20:00", slots("I have today at 2pm or 8pm tomorrow, which works better for you?", WED));
  ck("'Manana miercoles ... 9am o ... 8pm' → both Wednesday", slots("Cubrimos el 33033 sin problema. Manana miercoles te queda mejor a las 9am o a las 8pm, cual te viene bien?", TUE) === "2026-10-21 09:00 | 2026-10-21 20:00", slots("Manana miercoles te queda mejor a las 9am o a las 8pm", TUE));
  ck("'El miercoles tengo 9am o 5pm, el jueves 9am o 8pm' → two days", slots("El miercoles tengo 9am o 5pm, el jueves 9am o 8pm.", TUE) === "2026-10-21 09:00 | 2026-10-21 17:00 | 2026-10-22 09:00 | 2026-10-22 20:00", slots("El miercoles tengo 9am o 5pm, el jueves 9am o 8pm.", TUE));
  ck("'Saturday only has 5pm open, but Monday I have 4pm or 6pm'", slots("Saturday only has 5pm open, but Monday I have 4pm or 6pm, which works?", TUE) === "2026-10-24 17:00 | 2026-10-26 16:00 | 2026-10-26 18:00", slots("Saturday only has 5pm open, but Monday I have 4pm or 6pm, which works?", TUE));
  ck("'I'm holding that 1pm for you!' → nothing (no day)", slots("I'm holding that 1pm for you! Can I get the full property address?", TUE) === "");
  ck("'today at 4pm or 6pm' → today twice", slots("That zip is covered! I can come by today at 4pm or 6pm for the free visit.", TUE) === "2026-10-20 16:00 | 2026-10-20 18:00");
  ck("'Friday works, I have 1pm or 8pm.'", slots("Friday works, I have 1pm or 8pm. Which one do you want?", TUE) === "2026-10-23 13:00 | 2026-10-23 20:00");
  ck("'10am on Sunday isn't open, but I have 9am or 7pm that day' → the denied 10am is not offered", slots("10am on Sunday isn't open, but I have 9am or 7pm that day.", TUE) === "2026-10-25 09:00 | 2026-10-25 19:00", slots("10am on Sunday isn't open, but I have 9am or 7pm that day.", TUE));
  ck("'Today at 5pm works, or Thursday at 5pm or later'", slots("Today at 5pm works, or Thursday at 5pm or later if you prefer. Which one?", WED) === "2026-10-21 17:00 | 2026-10-22 17:00");
  ck("'Tomorrow at 9am or 7pm work for the free visit?'", slots("Yes, we do financing. Tomorrow at 9am or 7pm work for the free visit?", TUE) === "2026-10-21 09:00 | 2026-10-21 19:00");
  ck("'Amanhã tenho 9am ou 5pm' (PT)", slots("Amanhã tenho 9am ou 5pm, qual fica melhor?", TUE) === "2026-10-21 09:00 | 2026-10-21 17:00");

  console.log("\n[2] DETERMINISTIC — offerLineDeviation: the three slips, and nothing else");
  {
    const d = offerLineDeviation("Cubrimos el 33033 sin problema. Manana miercoles te queda mejor a las 9am o a las 8pm, cual te viene bien?", AVAIL_TUE, NO_PREF, TUE);
    ck("ES real case: 8pm is not on Wednesday's line → off-line", d?.kind === "off-line", JSON.stringify(d));
    ck("  note carries Wednesday's real line and its earliest + latest (9am or 5pm)", !!d && /9am, 1pm, 2pm, 3pm, 5pm/.test(d.note) && /9am or 5pm/.test(d.note) && /\[2026-10-21\]/.test(d.note), d?.note ?? "");
    ck("  note never names 8pm as an option", !!d && !/at 9am or 8pm|8pm \(/.test(d.note), d?.note ?? "");
  }
  {
    const d = offerLineDeviation("That's Fort Lauderdale, we cover that area. I have today at 2pm or 8pm tomorrow, which works better for you?", AVAIL_WED, JASON, WED);
    ck("Jason: today has 2pm, 3pm and the draft names one of them plus tomorrow → day-split", d?.kind === "day-split", JSON.stringify(d));
    ck("  note says today [2026-10-21] at 2pm or 3pm", !!d && /\[2026-10-21\] at 2pm or 3pm/.test(d.note), d?.note ?? "");
  }
  {
    const d = offerLineDeviation("We cover 33190, that's Miami. I've got Wednesday at 9am or 5pm for the free visit. Which works better?", AVAIL_TUE, NO_PREF, TUE);
    ck("today still has 4pm and the draft starts on Wednesday, no preference → day-skipped", d?.kind === "day-skipped", JSON.stringify(d));
    ck("  note: today at 4pm plus one time of Wednesday (its earliest, 9am)", !!d && /\[2026-10-20\] at 4pm plus one open time of Wednesday, October 21, 2026 \[2026-10-21\] \(its earliest, 9am\)/.test(d.note), d?.note ?? "");
  }
  ck("single-time today + one time of the next day ('today at 4pm or Wednesday at 9am') → fine", offerLineDeviation("33435 is Boynton Beach, we cover that. I've got today at 4pm or Wednesday at 9am, which works for you?", AVAIL_TUE, NO_PREF, TUE) === null, JSON.stringify(offerLineDeviation("I've got today at 4pm or Wednesday at 9am, which works for you?", AVAIL_TUE, NO_PREF, TUE)));
  ck("client asked for Friday, 'For Friday I've got 9am or 8pm' → fine", offerLineDeviation("We cover Homestead and Princeton, no problem. For Friday I've got 9am or 8pm, which works better for you?", AVAIL_TUE, [u("Do you have availability for this Friday?")], TUE) === null);
  ck("client said 'after 5': 'Today at 5pm works, or Thursday at 5pm or later' → fine", offerLineDeviation("Today at 5pm works, or Thursday at 5pm or later if you prefer. Which one?", [AVAIL_WED.replace("2pm, 3pm", "9am, 1pm, 2pm, 3pm, 5pm")].join("\n"), [u("33018"), a("That's Hialeah, covered. I have today at 9am or 5pm, which works better?"), u("After 5")], WED) === null);
  ck("client said 'después de las 5': 'Manana jueves tengo las 5pm o las 8pm' → fine", offerLineDeviation("Manana jueves tengo las 5pm o las 8pm, cual le viene mejor?", AVAIL_WED, [u("33183"), a("Hoy tengo las 2pm o las 3pm, cual le queda mejor?"), u("Para mi seria mejor después de las 5 porque trabajo hasta esa hora")], WED) === null);
  ck("client asked for 'an earlier time' (reschedule): Wednesday offer on Tuesday night → fine", offerLineDeviation("No problem, I can move it to an earlier time. Wednesday works well, I have 9am or 5pm, which one do you prefer?", AVAIL_TUE, [u("I will like to cancel it's too late reschedule for a earlier time")], TUE) === null);
  ck("soonest day's earliest + latest ('today at 9am or 5pm') → fine", offerLineDeviation("That's Hialeah, covered. I have today at 9am or 5pm, which works better?", AVAIL_WED.replace("2pm, 3pm", "9am, 1pm, 2pm, 3pm, 5pm"), [u("Need an estimate for entire house"), a("What's the zip code of the property?"), u("33018")], WED) === null);
  ck("any two times of the soonest day ('today at 2pm or 3pm') → fine", offerLineDeviation("Esa zona la cubrimos sin problema. Hoy tengo las 2pm o las 3pm, cual le queda mejor?", AVAIL_WED, NO_PREF, WED) === null);
  ck("a [BOOK] turn is never checked", offerLineDeviation("Perfect, see you then! [BOOK:{\"date\":\"2026-10-21\",\"time\":\"20:00\"}]", AVAIL_WED, NO_PREF, WED) === null);
  ck("the booking confirmation is never checked", offerLineDeviation("Appointment confirmed for Wednesday, October 21 at 5pm. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.", AVAIL_WED, NO_PREF, WED) === null);
  ck("the installation reminder is never checked", offerLineDeviation("Just a quick reminder, your flooring installation starts tomorrow, Thursday, October 22. Our installation team will arrive between 10am and 11am with the materials.", AVAIL_WED, NO_PREF, WED) === null);
  ck("a reply with no times is never checked", offerLineDeviation("For a whole house I need to measure in person to give you the best price, it's free and I bring samples. What's the zip code of the property?", AVAIL_WED, NO_PREF, WED) === null);
  ck("a time on a day beyond the lines we show is not judged", offerLineDeviation("I can do Monday November 2 at 9am or 5pm, which works?", AVAIL_TUE, NO_PREF, TUE) === null, JSON.stringify(offerLineDeviation("I can do Monday November 2 at 9am or 5pm, which works?", AVAIL_TUE, NO_PREF, TUE)));
  {
    const d = offerLineDeviation("Saturday I have 9am or 5pm, which works?", AVAIL_TUE, [u("Can you come this weekend?")], TUE);
    ck("a fully booked day offered → off-line, note sends to the next listed day", d?.kind === "off-line" && /fully booked/.test(d.note) && /next listed day/.test(d.note), JSON.stringify(d));
  }
  {
    const d = offerLineDeviation("Sunday I have 9am or 5pm, which works?", AVAIL_TUE, [u("Can you come this weekend?")], TUE);
    ck("client asked for the weekend, Sunday 5pm is not on the line → off-line but the note KEEPS Sunday", d?.kind === "off-line" && /keep Sunday, October 25, 2026 \[2026-10-25\]/.test(d.note) && /9am, 7pm/.test(d.note), JSON.stringify(d));
  }
  ck("clientStatedPreference: 'Friday (after 12pm) would be the soonest' → yes", clientStatedPreference([u("Let me see what my schedule is like. Friday (after 12pm) would be the soonest I could do an appt.")]));
  ck("clientStatedPreference: '33304' after 'coming over to measure' → no", !clientStatedPreference(JASON));
  ck("clientStatedPreference ignores the [Floor plan analysis] bracket", !clientStatedPreference([u("[Floor plan analysis: this image shows a kitchen measured Monday morning at 10am]"), u("33304")]));

  console.log("\n[3] DETERMINISTIC — fixTileLaborRate");
  const es = "Perfecto, entonces es solo la instalacion a $2 por pie cuadrado. Que dia te queda mejor, el miercoles 21 a las 9am o a las 5pm?";
  ck("'Tengo la loza' + '$2 por pie cuadrado' for the installation → $4.50", fixTileLaborRate(es, "Tengo la loza") === es.replace("$2 por", "$4.50 por"), fixTileLaborRate(es, "Tengo la loza"));
  const rem = "Si tienes la loza vieja hay que retirarla primero, eso tiene un costo adicional de $2 por pie cuadrado.";
  ck("removal sentence stays at $2", fixTileLaborRate(rem, "Eso es arrancada la loza bieja") === rem, fixTileLaborRate(rem, "Eso es arrancada la loza bieja"));
  const lam = "We don't sell laminate material, but if you supply it we install it at $2 per square foot.";
  ck("client has laminate → untouched", fixTileLaborRate(lam, "I have laminate already, just need install") === lam);
  ck("client has tile but wants vinyl over it → untouched", fixTileLaborRate("Install only is $2 per sqft.", "I have tile and want vinyl over it") === "Install only is $2 per sqft.");
  const en = "Great, the installation is $2 per sqft and I come measure for free. What's the zip code?";
  ck("'I bought the porcelain tile already' + '$2 per sqft' → $4.50", fixTileLaborRate(en, "I bought the porcelain tile already") === en.replace("$2 per", "$4.50 per"), fixTileLaborRate(en, "I bought the porcelain tile already"));
  const tagged = "Perfecto, la instalacion es $2 por pie cuadrado. [BOOK:{\"date\":\"2026-10-22\",\"time\":\"17:00\",\"name\":\"\"}]";
  ck("tag preserved", fixTileLaborRate(tagged, "Tengo las losas").includes("[BOOK:{") && /\$4\.50 por pie/.test(fixTileLaborRate(tagged, "Tengo las losas")), fixTileLaborRate(tagged, "Tengo las losas"));
  const mixed = "Tile removal is $2 per sqft on top of the $4.50 installation labor.";
  ck("removal + $4.50 labor in one sentence → untouched", fixTileLaborRate(mixed, "Tile. How about the existing tile removal?") === mixed);
  ck("no $2 at all → same string", fixTileLaborRate("Tile is $4.50 per sqft for the labor.", "tile") === "Tile is $4.50 per sqft for the labor.");

  console.log("\n[4] STATIC — wiring");
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
  for (const [tag, p] of [["WA", "src/app/api/wa-webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["IG", "src/app/api/webhook/route.ts"]] as const) {
    const s = src(p);
    ck(`${tag}: keeps the schedule text, runs the guard, retries once, re-checks the rewrite`, /scheduleText = availability;/.test(s) && /offerLineDeviation\((?:rawAiResponse|rawAiText), scheduleText, history\)/.test(s) && /retryForOfferLine\(messagesForAI, memoryContext, systemMemory, ownerCorrections, offerSlip\.note\)/.test(s) && /offerLineDeviation\(retryText, scheduleText, history\)/.test(s) && /OFFER_LINE_GUARD/.test(s));
  }
  ck("ig-diag reports offerLineGuard + tileLaborBackstop", /offerLineGuard: process\.env\.OFFER_LINE_GUARD !== "off"/.test(src("src/app/api/ig-diag/route.ts")) && /tileLaborBackstop/.test(src("src/app/api/ig-diag/route.ts")));
  ck("getAIResponse applies fixTileLaborRate on the client's burst", /fixTileLaborRate\(cleaned, currentClientBurstText\(messages\)\)/.test(src("src/lib/ai.ts")));

  if (process.env.LIVE !== "1") { console.log("\n[5] LIVE skipped (LIVE=1 to run)"); return done(); }
  console.log("\n[5] LIVE — the rewrite note makes the model name only times on the line");
  const avail = await getRealAvailabilityContext();
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayAt = (i: number) => { const d = new Date(et); d.setDate(d.getDate() + i); return d; };
  const ymdOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const lineHead = (d: Date) => `• ${d.toLocaleDateString("en-US", { weekday: "long" })}, ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} [${ymdOf(d)}]`;
  // "today" only works as a line while it is early enough Eastern; otherwise tomorrow is the first line.
  const useToday = et.getHours() < 10;
  const first = useToday ? 0 : 1;
  const todayStr = ymdOf(dayAt(0));
  const firstStr = ymdOf(dayAt(first));
  const sched = [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    ...(useToday ? [] : [`${lineHead(dayAt(0))}: fully booked`]),
    `${lineHead(dayAt(first))}: 2pm, 3pm`,
    `${lineHead(dayAt(first + 1))}: 9am, 1pm, 2pm, 3pm, 5pm`,
    `${lineHead(dayAt(first + 2))}: 9am, 11am, 1pm, 3pm, 4pm, 5pm, 6pm, 8pm`,
  ].join("\n") + avail.slice(avail.indexOf("\nIMPORTANT"));
  const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), sched].join("\n\n")}]`;
  const dayWord = (i: number) => (i === 0 ? "today" : i === 1 ? "tomorrow" : dayAt(i).toLocaleDateString("en-US", { weekday: "long" }));
  // (a) Jason: the draft hides the soonest day's second hour.
  {
    const base: ChatMessage[] = [...JASON.slice(0, -1).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: `33304${sys}` }];
    const draft = `That's Fort Lauderdale, we cover that area. I have ${dayWord(first)} at 2pm or 8pm ${dayWord(first + 2)}, which works better for you?`;
    const dev = offerLineDeviation(draft, sched, base, todayStr);
    ck("live (a): the synthetic Jason draft is flagged", dev !== null, JSON.stringify(dev));
    if (dev) {
      const last = base[base.length - 1];
      const r = await getAIResponse([...base.slice(0, -1), { ...last, content: last.content + "\n\n" + dev.note }], null, null, null, false);
      const t = r.text;
      console.log("   rewrite (a) →", t.replace(/\s+/g, " ").slice(0, 260));
      const got = offeredSlotsOf(t.replace(/\[[^\]]*\]/g, " "), todayStr).map((s) => `${s.date} ${s.time}`).sort().join(" | ");
      ck("live (a): rewrite names the soonest day at 2pm and 3pm, nothing else", got === `${firstStr} 14:00 | ${firstStr} 15:00`, `${got} | ${t}`);
      ck("live (a): rewrite passes the guard", offerLineDeviation(t, sched, base, todayStr) === null, JSON.stringify(offerLineDeviation(t, sched, base, todayStr)));
      ck("live (a): no note leak", !/offer check|schedule line|owner rule|rewrite/i.test(t), t);
    }
  }
  // (b) the Spanish case: 8pm named on a day whose line ends at 5pm.
  {
    const base: ChatMessage[] = [...NO_PREF.slice(0, -1).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: `33033${sys}` }];
    const wd = dayAt(first + 1).toLocaleDateString("es-ES", { weekday: "long" }).normalize("NFD").replace(/[̀-ͯ]/g, "");
    const draft = `Cubrimos el 33033 sin problema. El ${wd} te queda mejor a las 9am o a las 8pm, cual te viene bien?`;
    const dev = offerLineDeviation(draft, sched, [u("Hola, tengo la loza, 550 pies"), a("Cual es el codigo postal?"), u("33033")], todayStr);
    ck("live (b): the synthetic Spanish draft is flagged off-line", dev?.kind === "off-line", JSON.stringify(dev));
    if (dev) {
      const last = base[base.length - 1];
      const r = await getAIResponse([...base.slice(0, -1), { ...last, content: last.content + "\n\n" + dev.note }], null, null, null, false);
      const t = r.text;
      console.log("   rewrite (b) →", t.replace(/\s+/g, " ").slice(0, 260));
      ck("live (b): rewrite passes the guard", offerLineDeviation(t, sched, base, todayStr) === null, JSON.stringify(offerLineDeviation(t, sched, base, todayStr)));
      ck("live (b): rewrite names no 8pm", !/8\s?pm/i.test(t), t);
      ck("live (b): no note leak", !/offer check|schedule line|owner rule|rewrite/i.test(t), t);
    }
  }
  done();
}
function done() {
  console.log(`\n=========== OFFER-LINE-GUARD-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
