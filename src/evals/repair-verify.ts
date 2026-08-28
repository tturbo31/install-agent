// Verifies the NO-REPAIRS policy (owner rule 2026-08-25, Priti Budhrani case):
//  THE BUG: "These tiles are damaged so we would like to replace them would you
//  be able to give me a quote please" (IG, 2026-08-24) was treated as a tile
//  INSTALLATION lead — two slots offered, name/address/phone collected, real
//  [BOOK] written. We do NOT do repairs of ANY kind: a repair request gets the
//  polite decline and NEVER a visit.
//
//  1. DETERMINISTIC (no API): isRepairRequest / repairRequestActive /
//     repairVisitOfferLeak — the layer the three webhooks use to block [BOOK]
//     and visit offers. Includes the exact Priti history.
//  2. LIVE MODEL: the prompt + injected CRITICAL block make the model decline
//     (EN / ES / PT), with no visit, no price, no booking-details ask.
//  3. REGRESSIONS: cracked tiles under the "liquid" ad (vinyl over tile) is
//     still an install lead; bathroom remodel still confirms + visit; a whole-
//     house install that mentions cracked tiles still goes to the visit.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isRepairRequest, repairRequestActive, repairVisitOfferLeak, type ChatMessage } from "../lib/ai";
import { repairDeclineMessage } from "../lib/scheduler";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 220)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

// ── Predicates (EN / ES / PT) ───────────────────────────────────────────────
const DECLINES_REPAIR = (t: string) =>
  /don'?t\s+do\s+(?:any\s+)?repairs?|do\s+not\s+do\s+(?:any\s+)?repairs?|no\s+repairs?|not\s+(?:able\s+to\s+|something\s+we\s+)?(?:do|offer|handle)\s+repairs?|only\s+(?:do|handle|offer)\s+(?:(?:full|new|complete|brand\s+new)\s+)*installations?|isn'?t\s+something\s+we\s+(?:do|take\s+on|handle|offer)|(?:don'?t|do\s+not)\s+(?:handle|take\s+on|offer)\s+(?:any\s+)?repairs?|installations?\s+only|no\s+hacemos\s+reparaci|hacemos\s+son\s+instalaciones|no\s+(?:cambios\s+ni\s+)?reparaciones|solo\s+instalaciones|no\s+(?:hacemos|realizamos)\s+(?:ning[uú]n\s+tipo\s+de\s+)?(?:reparaci|arreglo)|solo\s+(?:hacemos\s+)?instalaci|n[aã]o\s+faz(?:emos)?\s+(?:reparo|conserto)|n[aã]o\s+(?:fazemos|trabalhamos\s+com)\s+(?:nenhum\s+tipo\s+de\s+)?(?:reparo|conserto)|s[oó]\s+fazemos\s+instala|apenas\s+instala|somente\s+instala/i.test(t);
const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works/i.test(t);
const ASKS_DETAILS = (t: string) => /\b(?:address|phone|zip|direcci[oó]n|tel[eé]fono|endere[çc]o|telefone)\b/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const HAS_BOOK = (t: string) => /\[BOOK:/i.test(t);
const OVER_TILE = (t: string) => /\b(?:over|on\s+top\s+of)\b[^.!?\n]{0,40}\b(?:tile|tiles|floor)|goes\s+(?:right\s+)?over|cover(?:s|ed)?\b[^.!?\n]{0,30}\b(?:cracked|uneven)/i.test(t);
const AFFIRMS = (t: string) => /\b(yes|yeah|absolutely|of course|we do|we can|we handle|claro|s[ií]m?|fazemos|hacemos)\b/i.test(t);

// ── The exact Priti history (IG 803bc8f2, 2026-08-02 → 08-24) ──────────────
const PRITI_UP_TO_REPAIR: ChatMessage[] = [
  u("Hey how are you I want to do this for bathroom please we have worked together before in SLs"),
  a("Great to hear from you, welcome back! For a bathroom remodel I need to check the space in person to put together an accurate quote, so let me set up a free visit. I have Wednesday August 5th at 3pm or 5pm, which works better for you?"),
  u("Hey thank you yup that works! 3pm sounds good"),
  a("I'm sorry, that 3pm on Wednesday filled up since I offered it, the only slot left on Wednesday is 5pm. Can I get your name, the full property address with the zip code, and the best phone number so I can hold that for you?"),
  u("Hey how are you so sorry didn't get back to you about that will confirm a slot when ready 🙏🏽"),
  u("[Floor plan analysis: This is **not a floor plan** — it's a photo of a **neon sign** mounted on a marble or stone wall tile backdrop. No floor plan dimensions, room labels, or measurements are visible.]"),
  u("[Floor plan analysis: # Image Analysis\n\nThis is **NOT a floor plan** — it's a **photo of existing flooring**.\n\n- Light beige/cream porcelain tile with natural stone veining\n- Excellent condition, very clean\n\n**Note:** No dimensions or room labels are visible.]"),
  a("No worries at all, just reach out whenever you're ready and we'll get you set up!"),
  u("These tiles are damaged so we would like to replace them would you be able to give me a quote please"),
];
const PRITI_UP_TO_BOOK: ChatMessage[] = [
  ...PRITI_UP_TO_REPAIR,
  a("Of course, for a tile replacement at that size I need to come measure in person to give you the right number, so let me set up your free visit. I have Tuesday the 25th at 3pm or Wednesday the 26th at 11am, which works better?"),
  u("Tomorrow 3pm works"),
  u("Do you have an estimate of the cost?"),
  a("Tuesday at 3pm works great, I'm holding that slot for you while I grab your details, can I get your name, the full property address with the zip code, and the best phone number? For the cost, tile installation is $4.50 per square foot for the labor and you provide the tile material, but the exact total depends on the measurements we take at the visit."),
  u("Ok great thanks"),
  a("No problem, just send me your name, the full property address with the zip code, and your phone number when you're ready and I'll lock in that Tuesday 3pm for you!"),
  u("Priti Budhrani \n\n801 S Miami Ave 33130 SLS LUX \n9177702915"),
  u("[Client replied to our ad]"),
];

async function main() {
  console.log("\n================ NO-REPAIRS VERIFICATION ================");

  // ── 1. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[1] isRepairRequest — positives");
  for (const s of [
    "These tiles are damaged so we would like to replace them would you be able to give me a quote please",
    "Do you do repairs?",
    "Can you fix a few broken tiles in my kitchen?",
    "I have 3 cracked tiles that need to be replaced",
    "Some of the planks are lifting, can you fix them?",
    "Need someone to regrout my bathroom floor",
    "Hola, tengo unos azulejos rotos en la cocina, me los pueden cambiar?",
    "Necesito reparar el piso de la sala, se despegaron unas losas",
    "Oi, tenho umas peças do piso quebradas, vocês consertam?",
    "Preciso de um reparo no piso, algumas placas soltaram",
    "One of the tiles is broken, how much to replace it?",
  ]) ck(`repair: "${s.slice(0, 60)}"`, isRepairRequest(s), s);

  console.log("\n[1b] isRepairRequest — negatives (must stay install / other flows)");
  for (const s of [
    "I saw your ad, my tiles are cracked and uneven, does the liquid floor go over them?",
    "I want new floors for the whole house, about 1500 sqft, some of the tiles are cracked",
    "Can we fix a time for the visit? Tuesday works",
    "Is it a fixed price per square foot?",
    "Do you do bathroom remodeling?",
    "vinyl for my bathroom, 150 sqft",
    "Podemos arreglar una cita para el martes?",
    "My tiles are cracked, I want vinyl instead",
    "Replace all my floors with hardwood, 3 bedrooms",
    "Hi, I'm interested in the promotion",
    "[Floor plan analysis: photo of existing flooring with cracked, broken tiles that need repair]",
    "[Client replied to our ad]",
    "Priti Budhrani \n\n801 S Miami Ave 33130 SLS LUX \n9177702915",
  ]) ck(`not repair: "${s.slice(0, 60)}"`, !isRepairRequest(s), s);

  console.log("\n[1c] repairRequestActive — the exact Priti history");
  ck("active right after the repair message", repairRequestActive(PRITI_UP_TO_REPAIR));
  ck("STILL active at the name/address/phone turn (the [BOOK] turn)", repairRequestActive(PRITI_UP_TO_BOOK));
  ck("clears when the client pivots to a whole new floor",
    !repairRequestActive([...PRITI_UP_TO_BOOK, u("Actually we want to redo the whole floor with new vinyl, about 900 sqft")]));
  ck("not active on a plain bathroom-remodel history", !repairRequestActive(PRITI_UP_TO_REPAIR.slice(0, 5)));

  console.log("\n[1d] repairVisitOfferLeak — the post-model backstop");
  const leakOffer = "Of course, for a tile replacement I need to come measure in person, so let me set up your free visit. I have Tuesday at 3pm or Wednesday at 11am, which works better?";
  const leakDetails = "Can I get your name, the full property address with the zip code, and the best phone number?";
  const leakBook = "Appointment confirmed. [BOOK:{\"date\":\"2026-08-25\",\"time\":\"15:00\",\"name\":\"Priti\"}]";
  const decline = repairDeclineMessage("en");
  ck("visit offer after the repair message → leak", repairVisitOfferLeak(PRITI_UP_TO_REPAIR, leakOffer), leakOffer);
  ck("booking-details ask while repair stands → leak", repairVisitOfferLeak(PRITI_UP_TO_BOOK.slice(0, -4), leakDetails), leakDetails);
  ck("[BOOK] while repair stands → leak", repairVisitOfferLeak(PRITI_UP_TO_BOOK, leakBook), leakBook);
  ck("the decline itself is NOT a leak", !repairVisitOfferLeak(PRITI_UP_TO_REPAIR, decline), decline);
  ck("same offer with NO repair in history → not a leak", !repairVisitOfferLeak(PRITI_UP_TO_REPAIR.slice(0, 1), leakOffer), leakOffer);
  ck("decline message ES mentions no repairs", /no hacemos reparaciones/i.test(repairDeclineMessage("es")));
  ck("decline message PT mentions no repairs", /não fazemos reparos/i.test(repairDeclineMessage("pt")));

  // ── 2. LIVE MODEL ─────────────────────────────────────────────────────────
  console.log("\n[2] LIVE: Priti replay — the repair message itself");
  const r1 = await ai(PRITI_UP_TO_REPAIR);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 220));
  ck("declines the repair", DECLINES_REPAIR(r1), r1);
  ck("does NOT propose a visit", !PROPOSES_VISIT(r1), r1);
  ck("does NOT quote a price", !HAS_PRICE(r1), r1);
  ck("does NOT ask for address/phone", !ASKS_DETAILS(r1), r1);

  console.log("\n[2b] LIVE: Priti replay — the booking-details turn (model must not [BOOK])");
  const r2 = await ai(PRITI_UP_TO_BOOK);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 220));
  ck("no [BOOK] for a repair even with name/address/phone in hand", !HAS_BOOK(r2), r2);
  ck("declines (or at least does not confirm a visit)", DECLINES_REPAIR(r2) || !/confirmed|locked in|see you/i.test(r2), r2);

  console.log("\n[2c] LIVE ES: \"tengo unos azulejos rotos, me los pueden cambiar?\"");
  const r3 = await ai([u("Hola buenas, tengo unos azulejos rotos en la cocina, me los pueden cambiar? Cuanto cobran?")]);
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 220));
  ck("declines in Spanish", DECLINES_REPAIR(r3) && /\b(?:no|solo|instalaci)/i.test(r3), r3);
  ck("no visit, no price, no details ask", !PROPOSES_VISIT(r3) && !HAS_PRICE(r3) && !ASKS_DETAILS(r3), r3);

  console.log("\n[2d] LIVE PT: \"tenho umas peças do piso quebradas, vocês consertam?\"");
  const r4 = await ai([u("Oi, tudo bem? Tenho umas peças do piso quebradas na sala, vocês consertam?")]);
  console.log("   →", r4.replace(/\s+/g, " ").slice(0, 220));
  ck("declines in Portuguese", DECLINES_REPAIR(r4), r4);
  ck("no visit, no price, no details ask", !PROPOSES_VISIT(r4) && !HAS_PRICE(r4) && !ASKS_DETAILS(r4), r4);

  console.log("\n[2e] LIVE EN mid-convo: type known, then a repair ask");
  const r5 = await ai([
    u("Hi, do you install tile?"),
    a("Yes, we install tile! Tile installation is $4.50 per square foot for the labor and you provide the material. What area are you looking to do?"),
    u("It's just a few tiles in the hallway that cracked, can you replace those?"),
  ]);
  console.log("   →", r5.replace(/\s+/g, " ").slice(0, 220));
  ck("declines the few-tiles replacement", DECLINES_REPAIR(r5), r5);
  ck("no visit offered", !PROPOSES_VISIT(r5), r5);

  // ── 3. REGRESSIONS ────────────────────────────────────────────────────────
  console.log("\n[3] REGRESSION: cracked tiles under the liquid ad → vinyl OVER tile, not a decline");
  const r6 = await ai([u("I saw your ad, my tiles are cracked and uneven, does the liquid floor go over them?\n\n[SYSTEM: [AD REPLY: lead replied to our vinyl promotion ad]]")]);
  console.log("   →", r6.replace(/\s+/g, " ").slice(0, 220));
  ck("does NOT decline as a repair", !DECLINES_REPAIR(r6), r6);
  ck("says it goes over / covers the cracked tile", OVER_TILE(r6), r6);

  console.log("\n[3b] REGRESSION: bathroom remodel still confirms + visit");
  const r7 = await ai([u("Hi, do you do bathroom remodeling?")]);
  console.log("   →", r7.replace(/\s+/g, " ").slice(0, 220));
  ck("confirms YES", AFFIRMS(r7) && !DECLINES_REPAIR(r7), r7);
  ck("proposes the visit", PROPOSES_VISIT(r7), r7);

  console.log("\n[3c] REGRESSION: whole-house install that mentions cracked tiles → visit");
  const r8 = await ai([u("Hi, I want new floors for the whole house, about 1500 sqft, some of the tiles are cracked")]);
  console.log("   →", r8.replace(/\s+/g, " ").slice(0, 220));
  ck("does NOT decline as a repair", !DECLINES_REPAIR(r8), r8);
  ck("proposes the visit (large lead)", PROPOSES_VISIT(r8), r8);

  console.log("\n[3d] REGRESSION: repair declined, then the client pivots to a new floor → normal flow resumes");
  const r9 = await ai([
    u("Can you fix a few broken tiles in my kitchen?"),
    a(repairDeclineMessage("en")),
    u("Ok. What if I redo the whole kitchen floor with your vinyl? It's about 300 sqft"),
  ]);
  console.log("   →", r9.replace(/\s+/g, " ").slice(0, 220));
  ck("does NOT repeat the repair decline", !DECLINES_REPAIR(r9), r9);
  ck("engages the vinyl job (price or next step)", HAS_PRICE(r9) || /vinyl|promotion|\$5|per square foot/i.test(r9), r9);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
