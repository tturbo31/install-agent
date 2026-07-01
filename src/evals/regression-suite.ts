/**
 * CONSOLIDATED REGRESSION SUITE — one test covering every bug fixed this round,
 * labeled by the error it guards against. The 3 channels (WhatsApp, Messenger,
 * Instagram) share one brain (getAIResponse) + identical webhook structure
 * (asserted by platform-parity), so a brain assertion here covers all 3, and the
 * webhook-level guards are checked statically across all 3 route files.
 *
 * Run: npx tsx src/evals/regression-suite.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse,
  detectAdFlooringType,
  adFlooringTypeNote,
  isBareGreeting,
  openerMessage,
  containsBookingInfo,
  isAskingForBookingInfo,
  isPureClosingBurst,
  type ChatMessage,
} from "../lib/ai";
import {
  WHAT_IS_INCLUDED_RESPONSE,
  WHAT_IS_INCLUDED_TILE_RESPONSE,
  WHAT_IS_INCLUDED_ASK_TYPE,
  AD_REPLY_NOTE,
  OPENER_EN,
  OPENER_ES,
  OPENER_PT,
} from "../lib/system-prompt";
import { getEasternDateContext, easternTodayStr } from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`    ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`    ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 150)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

const ROUTES: Record<string, string> = {
  WhatsApp: readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8"),
  Messenger: readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8"),
  Instagram: readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8"),
};
const eachChannel = (label: string, test: (src: string) => boolean) => {
  for (const [ch, src] of Object.entries(ROUTES)) ck(`${label} [${ch}]`, test(src));
};

const today = easternTodayStr();
const waBook = (extra: string) => `\n\n[SYSTEM: ${getEasternDateContext()}\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• TODAY [${today}]: 5pm, 7pm\n\n[WHATSAPP CHANNEL: You ALREADY have the client's phone number (13055551234). Ask ONLY for the property address. Once you have a confirmed day/time and the address, generate [BOOK:...] using "13055551234" as the phone.]${extra ? "\n\n" + extra : ""}]`;
const BOOKS = (t: string) => /\[BOOK:/i.test(t);

async function main() {
  console.log("\n================= CONSOLIDATED REGRESSION SUITE (all fixed errors) =================");

  // ── ERROR 1: WhatsApp visit not booked / bot re-asks for an address already sent
  console.log("\n[ERROR 1] WhatsApp: slot + address → BOOK (no redundant re-ask)");
  const r1 = await ai([
    { role: "user", content: "What do you charge for showers?" },
    { role: "assistant", content: "Shower work is a bathroom remodel, I do a free in-person visit. What day works?" },
    { role: "user", content: "Anyday, sooner the better" },
    { role: "assistant", content: "I have today at 5pm or 7pm. What's your address and which time works?" },
    { role: "user", content: "5pm today" },
    { role: "user", content: "113 NW 11th St Ft Lauderdale FL 33311" + waBook("") },
  ]);
  ck("books the visit", BOOKS(r1), r1);
  ck("does not re-ask for the address", !(/\baddress\b/i.test(r1) && /\?/.test(r1)) || BOOKS(r1), r1);
  ck("booking-info turn bypasses the 5s rate limit", { x: containsBookingInfo("113 NW 11th St Ft Lauderdale FL 33311") }.x === true);
  eachChannel("rate-limit bypass for booking-info", (s) => /containsBookingInfo\(rawText\)/.test(s) && /&& !carriesBookingInfo\) return;/.test(s));
  eachChannel("grace window before redundant booking-info re-ask", (s) => s.includes("isAskingForBookingInfo") && s.includes("discarding redundant re-ask"));

  // ── ERROR 2: tile ad answered with the vinyl "everything included" line
  console.log("\n[ERROR 2] Tile ad → labor only, NOT the vinyl included package");
  const note = (type: "tile" | "vinyl") => `\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\n${adFlooringTypeNote(type)}]`;
  const r2 = await ai([{ role: "user", content: "What is included in the material package?" + note("tile") }]);
  ck("tile: labor-only answer", r2.includes(WHAT_IS_INCLUDED_TILE_RESPONSE), r2);
  ck("tile: never claims flooring/quarter round are included", !/quarter round/i.test(r2) && !/includes the flooring/i.test(r2), r2);
  const r2b = await ai([{ role: "user", content: "What is included?" + note("vinyl") }]);
  ck("vinyl ad: keeps the $5 material-included answer", r2b.includes(WHAT_IS_INCLUDED_RESPONSE), r2b);

  // ── ERROR 3: unknown-type ad lead wrongly told the $5 vinyl package
  console.log("\n[ERROR 3] Unknown ad type → ask the type, NEVER assume vinyl");
  const r3 = await ai([{ role: "user", content: "What is included in the material package?\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\n" + AD_REPLY_NOTE + "]" }]);
  ck("asks the type (tile/vinyl/hardwood)", /tile/i.test(r3) && /vinyl/i.test(r3) && /hardwood/i.test(r3), r3);
  ck("uses the ASK_TYPE safety response", r3.includes(WHAT_IS_INCLUDED_ASK_TYPE), r3);
  ck("never claims the vinyl inclusions", !/quarter round/i.test(r3), r3);

  // ── ERROR 4: vinyl flow broken by ad-type false positives
  console.log("\n[ERROR 4] Vinyl flow not broken by detector false positives");
  ck("'Real Wood Look LVP' → vinyl (not hardwood)", detectAdFlooringType("Real Wood Look LVP") === "vinyl");
  ck("'Tile-Look Vinyl' → vinyl (not tile)", detectAdFlooringType("Tile-Look Vinyl") === "vinyl");
  ck("'Stone-Look Luxury Vinyl' → vinyl", detectAdFlooringType("Stone-Look Luxury Vinyl") === "vinyl");
  ck("genuine 'Edge Tile Promo' → tile", detectAdFlooringType("Edge Tile Promo") === "tile");
  ck("'Wood Look Tile' → tile (genuine tile material)", detectAdFlooringType("Wood Look Tile") === "tile");

  // ── ERROR 5: WhatsApp first-contact greeting got no reply
  console.log("\n[ERROR 5] First-contact greeting → opener (was silent)");
  const NOTE = waBook("");
  ck("'Ola' → Spanish opener", (await ai([{ role: "user", content: "Ola" + NOTE }])) === OPENER_ES, "Ola");
  ck("'Hola' → Spanish opener", (await ai([{ role: "user", content: "Hola" + NOTE }])) === OPENER_ES, "Hola");
  ck("'Hi' → English opener", (await ai([{ role: "user", content: "Hi" + NOTE }])) === OPENER_EN, "Hi");
  ck("'Olá' → Portuguese opener", openerMessage("Olá") === OPENER_PT);
  ck("opener names promotion + all 3 types", [OPENER_EN, OPENER_ES, OPENER_PT].every(o => /promo/i.test(o) && /tile/i.test(o) && /hardwood/i.test(o)));
  ck("substantive first msg is NOT hijacked by the opener", !isBareGreeting("How much for vinyl per sqft?"));

  // ── ERROR 6: conversations stuck silent forever in mode="human"
  console.log("\n[ERROR 6] No automatic permanent pause (mode=human only on deliberate takeover)");
  eachChannel("no automatic mode:\"human\" in the webhook", (s) => !s.includes('mode: "human"'));
  eachChannel("failed booking still hands off + notifies owner", (s) => s.includes("bookingFailureHandoffMessage") && s.includes("[NOTIFY_OWNER]"));
  eachChannel("AI outage still sends a holding reply + notifies", (s) => s.includes("aiOutageHandoffMessage") && s.includes("notifyOwners"));
  eachChannel("still honors a DELIBERATE owner pause (mode === human)", (s) => /mode === "human"/.test(s));

  // ── ERROR 7: in-area lead wrongly treated as out of area
  console.log("\n[ERROR 7] Service area: in-area cities served, out-of-area declined");
  const inArea = await ai([{ role: "user", content: "Do you serve Miramar?" }]);
  ck("Miramar (Broward) → served, not declined", /yes|serve|cover|absolutely|of course|we do/i.test(inArea) && !/don'?t (?:serve|cover)|do not (?:serve|cover)|outside/i.test(inArea), inArea);
  const inArea2 = await ai([{ role: "user", content: "I'm in Greenacres, do you come out here?" }]);
  ck("Greenacres (Palm Beach) → served", !/don'?t (?:serve|cover)|do not (?:serve|cover)|outside (?:our|the)/i.test(inArea2), inArea2);
  const outArea = await ai([{ role: "user", content: "Do you serve Naples?" }]);
  ck("Naples (Gulf coast) → politely declined", /don'?t (?:serve|cover)|do not (?:serve|cover)|only serve|outside|don'?t cover/i.test(outArea), outArea);

  // ── ERROR 8: trailing "thanks!" silenced an earlier un-answered question
  // The 10s debounce folds rapid client bubbles into one turn; only the LAST
  // bubble's handler replies. Judging the trailing "thanks!" alone as a pure
  // closing discarded the model's answer to the real earlier question → silence
  // on all 3 channels. isPureClosingBurst judges the WHOLE un-answered burst.
  console.log("\n[ERROR 8] Trailing thanks must NOT silence an earlier un-answered question");
  ck("question + trailing 'thanks!' (no reply yet) → NOT a closing (must answer)",
    isPureClosingBurst([
      { role: "user", content: "How much do you charge per sqft for 300 sqft?" },
      { role: "user", content: "Thank you!" },
    ]) === false);
  ck("standalone 'thanks!' after the bot already answered → IS a closing (stay silent)",
    isPureClosingBurst([
      { role: "user", content: "How much for 300 sqft?" },
      { role: "assistant", content: "For 300 sqft of vinyl it comes to about $2,000." },
      { role: "user", content: "Thank you so much!" },
    ]) === true);
  ck("question + trailing 'ok thanks' burst → NOT a closing (must answer)",
    isPureClosingBurst([
      { role: "user", content: "Do you install over existing tile?" },
      { role: "user", content: "ok thanks" },
    ]) === false);
  ck("address bubble then 'thanks' → NOT a closing (booking info must not be dropped)",
    isPureClosingBurst([
      { role: "user", content: "5pm today" },
      { role: "user", content: "113 NW 11th St Ft Lauderdale FL 33311" },
      { role: "user", content: "thanks!" },
    ]) === false);
  ck("latest is a real question (not a closing) → NOT a closing",
    isPureClosingBurst([
      { role: "assistant", content: "Happy to help!" },
      { role: "user", content: "do you do stairs?" },
    ]) === false);
  eachChannel("uses burst-aware pure-closing (isPureClosingBurst(history))",
    (s) => s.includes("isPureClosingBurst(history)"));

  // ── ERROR 9: WhatsApp pitched the vinyl $5 promo to a TILE-ad lead
  // The WA webhook had NO ad handling (IG/FB did), so a Click-to-WhatsApp tile-ad
  // lead got the vinyl package. ALL 3 channels must now detect the ad's flooring
  // type and, until it is known, ask first (AD_REPLY_NOTE) instead of assuming
  // vinyl. The brain behavior is covered by ERROR 2/3; here we assert the WEBHOOK
  // wiring exists in every channel (parity).
  console.log("\n[ERROR 9] All 3 channels detect ad type & ask first (never assume vinyl)");
  eachChannel("injects ad flooring-type detection",
    (s) => s.includes("detectAdFlooringType") && s.includes("adFlooringTypeNote"));
  eachChannel("falls back to ASK-the-type note when type unknown",
    (s) => s.includes("AD_REPLY_NOTE"));
  eachChannel("best-effort ad creative auto-detect (fetch + vision)",
    (s) => s.includes("fetchAdCreative") && s.includes("classifyAdCreativeType"));
  ck("WhatsApp parses Click-to-WhatsApp ad referral",
    ROUTES.WhatsApp.includes("extractWaAdReferral"));
  ck("WhatsApp scans the raw payload for the ad's flooring type",
    ROUTES.WhatsApp.includes("collectStrings"));
  ck("WhatsApp caps the type question (no infinite ask-the-type loop)",
    /typeAskCount/.test(ROUTES.WhatsApp) && ROUTES.WhatsApp.includes("STOP ASKING"));

  // ── ERROR 10: client SAID the type ("laminated floor") but the bot still
  // asked "tile, vinyl, or hardwood?" and looped the opener. Root cause: the
  // vinyl/laminate token regexes matched only the bare stem "laminate" (\b failed
  // on "laminated"/"laminates"), so detectAdFlooringType returned null, the
  // deterministic first-contact opener fired, and the LLM never saw the message.
  // This is the exact screenshot: "I need to put laminated floor in my garage.
  // Its 20x19 around 400 sq feet total. Can you please let me know how much..."
  console.log("\n[ERROR 10] Client says 'laminated floor' → recognized as vinyl, NOT the type-ask loop");
  // Detection (deterministic — the true root-cause guard):
  ck("'laminated floor' → vinyl (was MISS: bot re-asked the type)", detectAdFlooringType("I need to put laminated floor in my garage") === "vinyl");
  ck("'laminate flooring' → vinyl", detectAdFlooringType("laminate flooring") === "vinyl");
  ck("'laminates' → vinyl", detectAdFlooringType("laminates") === "vinyl");
  ck("'piso laminado' (PT) still → vinyl", detectAdFlooringType("piso laminado") === "vinyl");
  ck("'pisos laminados' (PT plural) → vinyl", detectAdFlooringType("quero pisos laminados") === "vinyl");
  // Same bug CLASS (audit findings): plurals, the 'vynil' misspelling, LVT, and
  // engineered/solid-wood shorthands must also be recognized, never re-asked.
  ck("plural 'porcelains' → tile", detectAdFlooringType("I'm interested in porcelains") === "tile");
  ck("plural 'ceramics' → tile", detectAdFlooringType("do you do ceramics") === "tile");
  ck("plural 'hardwoods' → hardwood", detectAdFlooringType("I want hardwoods") === "hardwood");
  ck("plural 'vinyls' → vinyl", detectAdFlooringType("do you do vinyls?") === "vinyl");
  ck("misspelling 'vynil' → vinyl", detectAdFlooringType("I want vynil floors") === "vinyl");
  ck("'LVT' → vinyl", detectAdFlooringType("Do you install LVT?") === "vinyl");
  ck("'engineered flooring' → hardwood", detectAdFlooringType("engineered flooring for the first floor") === "hardwood");
  ck("'solid wood floors' → hardwood", detectAdFlooringType("solid wood floors in the bedrooms") === "hardwood");
  // Guards: ambiguous "wood look" and multi-type stay null (bot asks, never mis-pins).
  ck("bare 'wood floors' still → null (ambiguous, ask)", detectAdFlooringType("I want wood floors") === null);
  ck("'real wood look' still → null", detectAdFlooringType("real wood look") === null);
  ck("'tile or vinyl' still → null (ambiguous)", detectAdFlooringType("deciding between tile and vinyl") === null);
  // End-to-end, exact screenshot message on WhatsApp, NO type note injected —
  // proving the internal conversationFlooringType now catches "laminated" so the
  // deterministic opener does NOT hijack and the brain handles it as vinyl.
  const JESSICA = "Hi! I need to put laminated floor in my garage. Its 20x19 around 400 sq feet total. Can you please let me know how much the instal would be";
  const r10 = await ai([{ role: "user", content: JESSICA + waBook("") }]);
  console.log("   →", r10.replace(/\s+/g, " ").slice(0, 180));
  ck("does NOT send the bare 3-type opener", r10 !== OPENER_EN && r10 !== OPENER_ES && r10 !== OPENER_PT, r10);
  ck("does NOT re-ask 'tile, vinyl, or hardwood?' (type already stated)", !(/\btile\b/i.test(r10) && /\bvinyl\b/i.test(r10) && /\bhardwood\b/i.test(r10)), r10);
  ck("recognizes the job (quotes a price or engages vinyl, not a canned question)", /\$\s?\d|vinyl|laminate|quote|estimate/i.test(r10), r10);
  // And with the vinyl type note the webhook now injects (detection returns vinyl),
  // the bot commits to vinyl terms and never loops the type question.
  const r10b = await ai([{ role: "user", content: JESSICA + waBook(adFlooringTypeNote("vinyl")) }]);
  console.log("   →", r10b.replace(/\s+/g, " ").slice(0, 180));
  ck("vinyl note: never re-asks the flooring type", !(/\btile\b/i.test(r10b) && /\bhardwood\b/i.test(r10b)), r10b);

  console.log(`\n================= REGRESSION SUITE: ${pass} passed, ${fail} failed =================`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
