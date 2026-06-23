import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getAIResponse, isPureClosing, containsBookingInfo, type ChatMessage } from "../lib/ai";
import {
  detectLang,
  bookingSuccessMessage,
  bookingFailureHandoffMessage,
  getRealAvailabilityContext,
  getEasternDateContext,
  easternTodayStr,
  hasExistingBooking,
} from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 140)}»`); }
}
const ai = (msgs: ChatMessage[], booked = false) => getAIResponse(msgs, null, null, undefined, booked).then(r => r.text);
function withSys(msgs: ChatMessage[], note: string): ChatMessage[] {
  const c = msgs.map(m => ({ ...m })); c[c.length - 1].content += `\n\n[SYSTEM: ${note}]`; return c;
}

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const FRI_AVAIL = [
  "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
  "• Thursday, June 4, 2026 [2026-06-04]: 5pm",
  "• Friday, June 5, 2026 [2026-06-05]: 9am, 11am, 1pm, 3pm, 5pm, 7pm",
  "• Saturday, June 6, 2026 [2026-06-06]: 9am",
  "Copy the exact [YYYY-MM-DD] on the same line as the weekday.",
].join("\n");
const DCTX = "TODAY: Thursday, June 4, 2026 [2026-06-04]. TOMORROW: Friday, June 5 [2026-06-05]. Current time: 21:20 Eastern.";
// Today IS Friday, early afternoon — so "today at 7pm" is a real, future, open slot.
const DCTX_FRI = "TODAY: Friday, June 5, 2026 [2026-06-05]. TOMORROW: Saturday, June 6 [2026-06-06]. Current time: 13:16 Eastern.";
const FRI_AVAIL_TODAY = [
  "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
  "• Friday, June 5, 2026 [2026-06-05]: 3pm, 5pm, 7pm",
  "• Saturday, June 6, 2026 [2026-06-06]: 9am, 11am",
  "Copy the exact [YYYY-MM-DD] on the same line as the weekday.",
].join("\n");
const WA_NOTE = `[WHATSAPP CHANNEL: You already have the client's phone number (13053359498). Ask ONLY for the property address. Generate [BOOK:...] using "13053359498" as the phone.]`;

async function main() {
  // ═══ 1. DATE / TIMEZONE (the main complaint: "it said today was Saturday") ═══
  console.log("\n[1] DATE / TIMEZONE (Eastern)");
  const inst = new Date("2026-06-05T01:20:00Z"); // Thu Jun 4 9:20pm ET
  ck("bug instant: Eastern=Thu Jun4, UTC=Fri Jun5",
    new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York"}).format(inst)==="2026-06-04" && inst.toISOString().slice(0,10)==="2026-06-05");
  const ctx = getEasternDateContext();
  console.log("   ctx:", ctx);
  const tM = ctx.match(/TODAY: (\w+), \w+ \d+, \d+ \[(\d{4}-\d{2}-\d{2})\]/);
  const mM = ctx.match(/TOMORROW: (\w+), \w+ \d+ \[(\d{4}-\d{2}-\d{2})\]/);
  ck("getEasternDateContext TODAY = Eastern now", !!tM && tM[2] === easternTodayStr());
  if (tM && mM) {
    const dT = new Date(tM[2]+"T12:00:00Z"), dM = new Date(mM[2]+"T12:00:00Z");
    ck("TOMORROW = TODAY +1 day, labels correct", dM.getTime()-dT.getTime()===86400000 && tM[1]===DAYS[dT.getUTCDay()] && mM[1]===DAYS[dM.getUTCDay()]);
  }
  const tzAns = await ai([
    {role:"user",content:"How much for 900 square feet"},
    {role:"assistant",content:"At that size I measure in person, I have Thursday today at 3pm or 7pm, or Friday at 9am. What works?"},
    {role:"user",content:`Tomorrow works, where are you based?\n\n[SYSTEM: ${DCTX}\n\n${FRI_AVAIL}]`},
  ]);
  console.log("   AI:", tzAns.replace(/\s+/g," ").slice(0,160));
  ck("does NOT call tomorrow 'Saturday' (today=Thu)", !/saturday/i.test(tzAns), tzAns);

  // ═══ 2. BOOKING DATE INTEGRITY (false "slot taken") ═══
  console.log("\n[2] BOOKING DATE INTEGRITY");
  const bk = await ai(withSys([
    {role:"user",content:"Hola, quiero piso en toda la casa, como 1200 sqft"},
    {role:"assistant",content:"Para ese tamaño hago una visita gratis. Tengo este viernes a las 9am o a la 1pm, cuál prefieres?"},
    {role:"user",content:"Viernes a la 1pm"},
    {role:"assistant",content:"Perfecto, me das la dirección?"},
    {role:"user",content:"Ignacio, 355 East 20 St Hialeah FL 33010"},
  ], `${DCTX}\n\n${FRI_AVAIL}\n\n${WA_NOTE}`));
  const book = bk.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  console.log("   AI:", bk.replace(/\s+/g," ").slice(0,150));
  ck("books Friday 2026-06-05 (not 06-06)", !!book && /2026-06-05/.test(book[1]) && !/2026-06-06/.test(book[1]), book?.[1]||bk);
  ck("books time 13:00", !!book && /"time"\s*:\s*"13:00"/.test(book[1]), book?.[1]||"");

  // ═══ 3. LANGUAGE + honest failure + WhatsApp-only-address ═══
  console.log("\n[3] LANGUAGE / MESSAGES / WHATSAPP");
  ck("detectLang ES", detectLang("hola quiero un estimado para mi cocina")==="es");
  ck("detectLang EN", detectLang("hello i want a quote for my kitchen please")==="en");
  ck("success ES/EN localized", bookingSuccessMessage("es").includes("Cita confirmada") && bookingSuccessMessage("en").includes("Appointment confirmed"));
  ck("failure honest (no 'taken'/'ocupado')", !/taken|ocupad/i.test(bookingFailureHandoffMessage("es")) && /Ozzi/.test(bookingFailureHandoffMessage("es")));
  const waAsk = await ai(withSys([
    {role:"user",content:"toda la casa 1200 sqft"},
    {role:"assistant",content:"Hago visita gratis. Tengo viernes 9am o 1pm, cuál prefieres?"},
    {role:"user",content:"viernes 1pm"},
  ], `${DCTX}\n\n${FRI_AVAIL}\n\n${WA_NOTE}`));
  console.log("   AI:", waAsk.replace(/\s+/g," ").slice(0,140));
  ck("WhatsApp asks address, NOT phone", /direcci[oó]n|address/i.test(waAsk) && !/tel[eé]fono|n[uú]mero de tel|phone number/i.test(waAsk), waAsk);

  // ═══ 4. POST-BOOKING SILENCE + REACT-ONLY ═══
  console.log("\n[4] POST-BOOKING SILENCE + REACT-ONLY");
  ck("bookingConfirmed → empty", (await ai([{role:"assistant",content:"Cita confirmada."},{role:"user",content:"gracias!"}], true)).trim()==="");
  ck("isPureClosing('I will definitely call u tomorrow')", isPureClosing("I will definitely call u tomorrow"));
  ck("NOT closing: '...do u do screens'", !isPureClosing("ty so much do u do screens"));
  // Regression: "Ok thank you. <name> <address> <phone>" (77 chars) was wrongly
  // treated as a farewell, so the bot stayed silent and never booked the visit.
  const addrPhoneMsg = "Ok thank you. Randy Santos 11417 SW 251st ST Homestead, FL 33032 786-368-1800";
  ck("NOT closing: address+phone reply (was the silent-booking bug)", !isPureClosing(addrPhoneMsg), addrPhoneMsg);
  ck("NOT closing: short 'thanks <phone>'", !isPureClosing("thanks 786-368-1800"));
  // Regression (screenshot 2026-06-23, Briana Vitale): the bot asked "tile, vinyl,
  // or hardwood?" and the client answered "Thank you! Either vinyl or laminate".
  // Because the message opened with "Thank you!", isPureClosing wrongly returned
  // true and the webhook discarded the reply — the bot went silent on a hot lead
  // (and it repeated for a second client). A thanks that ALSO carries a real answer
  // (floor type, room/scope, "yes please") is NOT a closing and must be answered.
  ck("NOT closing: 'Thank you! Either vinyl or laminate' (the silence bug)", !isPureClosing("Thank you! Either vinyl or laminate"));
  ck("NOT closing: 'thanks, the whole house'", !isPureClosing("thanks, the whole house"));
  ck("NOT closing: 'Thank you, kitchen and living room'", !isPureClosing("Thank you, kitchen and living room"));
  ck("NOT closing: 'thanks, vinyl please'", !isPureClosing("thanks, vinyl please"));
  // Genuine closings MUST still be detected (no over-correction).
  ck("STILL closing: 'Thank you so much!'", isPureClosing("Thank you so much!"));
  ck("STILL closing: 'ok thanks'", isPureClosing("ok thanks"));
  ck("STILL closing: \"Thanks, I'll think about it.\"", isPureClosing("Thanks, I'll think about it."));
  ck("containsBookingInfo detects phone", containsBookingInfo("786-368-1800"));
  ck("containsBookingInfo detects street address", containsBookingInfo("11417 SW 251st St Homestead FL"));
  ck("containsBookingInfo: plain thanks → false", !containsBookingInfo("ok thank you so much"));
  const ro = await ai([
    {role:"assistant",content:"You can reach Ozzi at (561) 674-8334, or I have Friday at 9am open!"},
    {role:"user",content:"I will definitely call u tomorrow"},
  ]);
  ck("pure closing → [REACT_ONLY]", /\[REACT_ONLY\]/i.test(ro), ro);

  // Live reproduction of the exact screenshot conversation: after the bot asks the
  // flooring type, "Thank you! Either vinyl or laminate" is the client ANSWERING.
  // The AI must respond (about vinyl / next step) and must NOT emit [REACT_ONLY].
  const briana = await ai([
    {role:"user",content:"Hi we are moving into our house today and wondering if you could give us a floor installation quote. We are located in west Boca"},
    {role:"assistant",content:"Hi, welcome to your new home! Are you thinking of tile, vinyl, or hardwood flooring?"},
    {role:"user",content:"Thank you! Either vinyl or laminate"},
  ]);
  console.log("   AI:", briana.replace(/\s+/g," ").slice(0,170));
  ck("answers 'Thank you! Either vinyl or laminate' (not silenced)", briana.trim().length > 0 && !/\[REACT_ONLY\]/i.test(briana), briana);
  ck("reply mentions vinyl / scope / quote (engages the answer)", /vinyl|area|whole house|quote|waterproof|warranty/i.test(briana), briana);

  // Live: client confirms a slot then sends "ok thanks <name> <address> <phone>"
  // → must generate [BOOK:...] (the confirmation + calendar entry path), NOT a
  // bare thank-you reply or [REACT_ONLY].
  const bookFlow = await ai(withSys([
    {role:"user",content:"whole house, like 1500 sqft, can we meet today at 7pm for an official price?"},
    {role:"assistant",content:"Perfect, just send me your full address and phone and we'll lock it in for tonight at 7pm!"},
    {role:"user",content:"Ok thank you. Randy Santos 11417 SW 251st ST Homestead, FL 33032 786-368-1800"},
  ], `${DCTX_FRI}\n\n${FRI_AVAIL_TODAY}`));
  const bookTag = bookFlow.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  console.log("   AI:", bookFlow.replace(/\s+/g," ").slice(0,160));
  ck("address+phone reply → generates [BOOK:...]", !!bookTag, bookFlow);
  ck("books 7pm today (19:00, 2026-06-05)", !!bookTag && /"time"\s*:\s*"19:00"/.test(bookTag[1]) && /2026-06-05/.test(bookTag[1]), bookTag?.[1]||bookFlow);
  ck("not silenced as closing ([REACT_ONLY] absent)", !/\[REACT_ONLY\]/i.test(bookFlow), bookFlow);

  // ═══ 5. OPENER asks the flooring type (no vinyl assumption, no price) ═══
  console.log("\n[5] OPENER asks tile/vinyl/hardwood");
  const op = await ai([{role:"user",content:"Hi, interested in new floors"}]);
  console.log("   AI:", op.replace(/\s+/g," "));
  ck("asks which flooring type (tile/vinyl/hardwood)", /tile/i.test(op) && /vinyl/i.test(op) && /hardwood/i.test(op), op);
  ck("NO price quoted", !/\$\s?\d/.test(op), op);
  ck("does NOT assume the vinyl package (no quarter round)", !/quarter round/i.test(op), op);
  ck("opener ≤2 sentences", (op.replace(/\[.*?\]/g,"").match(/[.!?](\s|$)/g)??[]).length<=2, op);

  // ═══ 6. SMALL-JOB PRICING ≤400 (+$500 hidden), 401-499 plain, ≥500 visit ═══
  console.log("\n[6] SMALL-JOB PRICING");
  const opn = "Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. One area or the whole house?";
  const quote = (s:string)=> ai([{role:"user",content:"hi"},{role:"assistant",content:opn},{role:"user",content:s}]);
  const noLeak = (t:string)=> !/401|499|between|x\s?5|let me|add-?on|\btier\b|plus \$?500|right answer/i.test(t);
  const q200 = await quote("just one room, 200 sqft"); console.log("   200→", q200.replace(/\s+/g," ").slice(0,90));
  ck("200 sqft → $1,500 hidden surcharge, no leak", /1[,.]?500/.test(q200) && !/1[,.]?000/.test(q200) && noLeak(q200), q200);
  const q480 = await quote("about 480 sqft one area"); console.log("   480→", q480.replace(/\s+/g," ").slice(0,90));
  ck("480 sqft → $2,400 (no +500), no leak", /2[,.]?400/.test(q480) && !/2[,.]?900/.test(q480) && noLeak(q480), q480);
  const q600 = await quote("whole house ~600 sqft");
  ck("600 sqft → visit, no DM total", /visit|measure|in person/i.test(q600), q600);

  // ═══ 7. HOW IT WORKS ($5 incl floor+install, $2 install-only) ═══
  console.log("\n[7] HOW IT WORKS");
  const hiw = await ai([{role:"user",content:"how does your promotion work?"}]);
  console.log("   AI:", hiw.replace(/\s+/g," ").slice(0,160));
  ck("$5/sqft incl floor+install + $2 install-only", /\$\s?5/.test(hiw) && /install|labor/i.test(hiw) && /\$\s?2\b/.test(hiw), hiw);

  // ═══ 8. TILE MATERIAL (Floor & Decor, no vinyl pitch) ═══
  console.log("\n[8] TILE MATERIAL");
  const tile = await ai([{role:"user",content:"you guys offer tile that looks like wood?"}]);
  console.log("   AI:", tile.replace(/\s+/g," ").slice(0,160));
  ck("tile: don't sell material + Floor&Decor, no vinyl pitch", /floor ?& ?decor/i.test(tile) && /don'?t sell|do not sell/i.test(tile) && !/luxury vinyl|our vinyl|vinyl (plank|has|wood)/i.test(tile), tile);

  // ═══ 9. PRODUCT QUESTIONS (West Indies suitability, no dismiss) ═══
  console.log("\n[9] PRODUCT QUESTIONS / OUT-OF-AREA");
  const wi = await ai([
    {role:"assistant",content:"Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. One area or the whole house?"},
    {role:"user",content:"Hi. Just need to know if this can be used in the West Indies? Looking for the best flooring options."},
  ]);
  console.log("   AI:", wi.replace(/\s+/g," ").slice(0,170));
  ck("answers product (waterproof/humid/climate)", /waterproof|humid|tropical|moisture|stone composite|holds up|climate|20.?year/i.test(wi), wi);
  ck("does NOT dismiss with can't help", !/can'?t help|cannot help|would not be able to help/i.test(wi), wi);
  // (options-question redirect behavior is covered in [9b])

  // ═══ 9b. MATERIAL vs SEE: "what is it" → describe vinyl; "show me" → WhatsApp ═══
  console.log("\n[9b] MATERIAL → describe vinyl | SEE → WhatsApp redirect");
  const wa = (t: string) => /674[-\s]?8334/.test(t) && !/ozzifloors\.com|@ozzi\.floors/i.test(t);
  // "what flooring/material options" is a PRODUCT-TYPE question, send NO link.
  // Owner correction (2026-06-06) wanted the luxury-vinyl description; since the
  // multi-type direction (vinyl/tile/hardwood) the bot may instead list the types
  // and ask which. Accept EITHER, but never a link or color names.
  const o1 = await ai([{role:"user",content:"What flooring options do you have?"}]);
  console.log("   options:", o1.replace(/\s+/g," ").slice(0,120));
  const describesVinyl = /vinyl/i.test(o1) && /water\s?proof|resist|warranty|20.?year/i.test(o1);
  const listsTypes = /vinyl/i.test(o1) && /tile/i.test(o1) && /hardwood/i.test(o1);
  ck("'what flooring options' → describes vinyl OR lists types, NO link", (describesVinyl || listsTypes) && !/674[-\s]?8334|ozzifloors\.com|@ozzi\.floors/i.test(o1) && !/White Knight|Coastal Mist|Grey Shield|Espresso/i.test(o1), o1);
  const o2 = await ai([{role:"user",content:"Can you send me photos of your floors?"}]);
  ck("'send photos' → WhatsApp, no website", wa(o2), o2);
  const o3 = await ai([{role:"user",content:"do you have grey wood-look floors?"}]);
  ck("'do you have grey floors' → WhatsApp", wa(o3), o3);
  const o4 = await ai([{role:"user",content:"is your flooring waterproof?"}]);
  ck("capability question still ANSWERED (not WA redirect)", /waterproof|100%|stone|yes/i.test(o4) && !/674[-\s]?8334/.test(o4), o4);
  const o5 = await ai([{role:"user",content:"do you offer tile that looks like wood?"}]);
  ck("tile question → Floor & Decor (not WA redirect)", /floor ?& ?decor/i.test(o5) && !/674[-\s]?8334/.test(o5), o5);

  // ═══ 9c. SERVED-CLIENT detection (hasExistingBooking) ═══
  console.log("\n[9c] hasExistingBooking (already-served detection)");
  const known = await hasExistingBooking("2501821723612966"); // David (has a booking)
  const unknown = await hasExistingBooking("zzz_nonexistent_99999");
  ck("known booked igsid → true", known === true, String(known));
  ck("random igsid → false", unknown === false, String(unknown));

  // ═══ 10. AUTO-LEARNING (Dreaming) ═══
  console.log("\n[10] AUTO-LEARNING (system store)");
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const storeId = process.env.ANTHROPIC_SYSTEM_STORE_ID!;
    const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
    const f = page.data.find((m) => (m as { type: string }).type === "memory" && (m as { path?: string }).path === "/learnings.md");
    ck("learnings.md exists", !!f);
    if (f) {
      const mem = await anthropic.beta.memoryStores.memories.retrieve((f as { id: string }).id, { memory_store_id: storeId });
      const content = (mem as { content?: string }).content ?? "";
      const upd = content.split("\n").find((l) => l.startsWith("Updated:")) ?? "";
      console.log("   ", upd);
      ck("learnings updated in 2026 (fresh, not stale)", /2026/.test(upd), upd);
      ck("learnings reference conversions/closing", /convert|booking|closed|closing|appointment|CONVERTED/i.test(content));
    }
  } catch (e) { ck("auto-learning reachable", false, String(e)); }

  console.log(`\n════════════ RESULT: ${pass} passed, ${fail} failed ════════════`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
