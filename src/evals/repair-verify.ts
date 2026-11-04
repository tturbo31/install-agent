// Verifies the REPAIR FLOW (owner rule 2026-11-04, Sandy Bell IG case).
//  THE CHANGE: until 2026-11-04 a repair request got the flat decline ("we only
//  do full installations, not repairs of any kind", rule of 2026-08-25). The
//  owner read that reply to "Hi. I need some Stairs repaired and replace.
//  Laminate cracked. Is that something you could Do. 3 Steps. Inside" and
//  changed the rule: NEVER say we don't do repairs. Ask for a video or a
//  picture of the project + a description (his words); once the client sends
//  it, tell them Ozzi is going to check it and will get back to them, and alert
//  the team (Ozzi, Vinicius, Ruani) with the photo. Still never a visit, never
//  a price, never booking details, never a [BOOK] for a repair.
//
//  1. DETERMINISTIC (no API): isRepairRequest / repairRequestActive (unchanged
//     detectors, Priti + the two 2026-09-29 leaks), repairFlowReply (the
//     stages: ask → reminder → handoff + [NOTIFY_OWNER] → hold → silence),
//     repairAwaitingMedia (the photo forward), repairVisitOfferLeak (the old
//     decline, a visit, a price, a [BOOK] are all leaks now), and the owner-
//     promise exemption (the handoff line is NOT rewritten into his number and
//     does not force a second alert).
//  2. THROUGH THE BRAIN (no API: getAIResponse short-circuits while a repair
//     stands): Sandy, Priti, the fb match case, Lily, ES / PT, the photo turn.
//  3. REGRESSIONS (LIVE): cracked tiles under the "liquid" ad is still an
//     install lead; bathroom remodel is Ozzi direct; a whole-house install that
//     mentions cracked tiles still goes to the visit; a pivot to a new floor
//     after the ask resumes the normal flow.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, isRepairRequest, repairRequestActive, repairVisitOfferLeak, repairFlowReply, repairAwaitingMedia,
  isRepairFlowLine, isRepairPhotoAsk, isRepairHandoffReply, isRepairHoldReply, bubbleCarriesMedia,
  promisesOwnerContact, redirectOwnerPromiseToPhone, REPAIR_HANDOFF_ALERT, type ChatMessage,
} from "../lib/ai";
import { repairPhotoAskMessage, repairPhotoReminderMessage, repairHandoffMessage, repairHoldMessage } from "../lib/scheduler";

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
// The OLD decline, in any wording: must never come back.
const DECLINES_REPAIR = (t: string) =>
  /don'?t\s+do\s+(?:any\s+)?repairs?|do\s+not\s+do\s+(?:any\s+)?repairs?|no\s+repairs?|not\s+(?:able\s+to\s+|something\s+we\s+)?(?:do|offer|handle)\s+repairs?|only\s+(?:do|handle|offer)\s+(?:(?:full|new|complete|brand\s+new)\s+)*installations?|isn'?t\s+something\s+we\s+(?:do|take\s+on|handle|offer)|(?:don'?t|do\s+not)\s+(?:handle|take\s+on|offer)\s+(?:any\s+)?repairs?|installations?\s+only|no\s+hacemos\s+reparaci|hacemos\s+son\s+instalaciones|no\s+(?:cambios\s+ni\s+)?reparaciones|solo\s+instalaciones|no\s+(?:hacemos|realizamos)\s+(?:ning[uú]n\s+tipo\s+de\s+)?(?:reparaci|arreglo)|solo\s+(?:hacemos\s+)?instalaci|n[aã]o\s+faz(?:emos)?\s+(?:reparo|conserto)|n[aã]o\s+(?:fazemos|trabalhamos\s+com)\s+(?:nenhum\s+tipo\s+de\s+)?(?:reparo|conserto)|s[oó]\s+fazemos\s+instala|apenas\s+instala|somente\s+instala|500\s+(?:square|sq|pies|p[ée]s)/i.test(t);
const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works/i.test(t);
const ASKS_DETAILS = (t: string) => /\b(?:address|phone|zip|direcci[oó]n|tel[eé]fono|endere[çc]o|telefone)\b/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const HAS_BOOK = (t: string) => /\[BOOK:/i.test(t);
const HAS_NOTIFY = (t: string) => /\[NOTIFY_OWNER\]/.test(t);
const OVER_TILE = (t: string) => /\b(?:over|on\s+top\s+of)\b[^.!?\n]{0,40}\b(?:tile|tiles|floor)|goes\s+(?:right\s+)?over|cover(?:s|ed)?\b[^.!?\n]{0,30}\b(?:cracked|uneven)/i.test(t);
const ASKS_PHOTO = (t: string) => /\b(?:video|picture|photo|pic|foto|v[ií]deo|imagen)\b/i.test(t);
const OZZI_CHECKS = (t: string) => /\bozzi\b/i.test(t) && /get back|check|revisar|comunica|contacto|contato|verificar|retorna/i.test(t);
const CLEAN = (t: string) => !DECLINES_REPAIR(t) && !PROPOSES_VISIT(t) && !ASKS_DETAILS(t) && !HAS_PRICE(t) && !HAS_BOOK(t);

const ASK_EN = repairPhotoAskMessage("en");
const REMIND_EN = repairPhotoReminderMessage("en");
const HANDOFF_EN = repairHandoffMessage("en") + "[NOTIFY_OWNER]";
const HOLD_EN = repairHoldMessage("en");
const PHOTO = "[Floor plan analysis: This is a photo of existing flooring, not a floor plan. Laminate stair treads, three steps, with cracked and chipped edges on two of them. Floor type: laminate]";

// ── The Sandy Bell case (IG, 2026-11-04) ────────────────────────────────────
const SANDY_MSG = "Hi. I need some Stairs repaired and replace. Laminate cracked. Is that something you could Do. 3 Steps. Inside";

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

// ── The two 2026-09-29 leaks ────────────────────────────────────────────────
// Messenger fb_28104189355856705: repair declined on 09-27 (old rule), then on
// 09-29 three ad FAQ taps ("vinyl", "installation" clear the flag) and the
// typed message.
const FB_MATCH_HISTORY: ChatMessage[] = [
  u("Yes . I need a repair/replacement."),
  a("We only do full new installations, we don't do repairs of any kind. If you ever need a whole new floor put in, I'm happy to help!"),
  u("No just a repair . Can you recommend someone?"),
  a("Honestly, for repairs the best bet is to search for a local handyman or tile repair specialist on Google or Yelp in your area. Hope you find someone soon!"),
  u("I can't find the matching floor."),
  a("That's a tough one. For matching an existing floor, places like Floor & Decor or Tile Shop often carry a wide range of styles and can help you find something close."),
  u("Thank You ☺️"),
  u("What types of vinyl flooring do you offer?"),
  u("How long does the installation process take?"),
  u("Can I get a free quote for the installation?"),
  a("Waterproof, 20-year warranty, wood and marble finishes, installs in 2 to 3 days, and the quote is free. One area or the whole house?"),
  u("I want to replace a damaged wood floor. The floor goes throughout the whole house so I just want to find a match if possible and replace it"),
];
// IG Lily Antonijuan-Estevez, first message.
const LILY_MSG = "Good afternoon, I got some wood in the kitchen that needs to be replaced. I got boxes of the floor. Is this something you do? If so how much do you charge? Thank you Lily";

async function main() {
  console.log("\n================ REPAIR FLOW VERIFICATION (owner rule 2026-11-04) ================");

  // ── 1. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[1] isRepairRequest — positives");
  for (const s of [
    SANDY_MSG,
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
    "I want to replace a damaged wood floor. The floor goes throughout the whole house so I just want to find a match if possible and replace it",
    "Good afternoon, I got some wood in the kitchen that needs to be replaced. I got boxes of the floor. Is this something you do? If so how much do you charge? Thank you Lily",
    "Some planks got water damage, I have leftover boxes of the same floor, can you swap them?",
    "A few boards in the hallway need to be replaced, I still have 2 boxes from the original install",
    "Tengo unas tablas dañadas en la cocina, me quedaron cajas del mismo piso, las pueden cambiar?",
    "Tenho umas tábuas estragadas, sobraram caixas do mesmo piso, vocês trocam?",
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
    "I want to replace the whole floor with something that matches the kitchen tile",
    "Replace it all, the whole house is damaged, I want new hardwood that matches the stairs",
    "I have 3 boxes of vinyl left over, can you install them in the closet?",
    "I want the same floor as the kitchen in the two bedrooms, about 400 sqft",
    "Can you match the price I got from another company? 1200 sqft vinyl",
    "Hi. Yes I am getting estimates to repair drywall and paint first and then will reach out to schedule the flooring.",
    "We are fixing the roof this month, after that we want new floors in 3 bedrooms",
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
  ck("fb_28104189355856705 (2026-09-29): active again after the FAQ taps + 'find a match' message", repairRequestActive(FB_MATCH_HISTORY));
  ck("Lily (IG 2026-09-29): active on the first message", repairRequestActive([u(LILY_MSG)]));

  console.log("\n[1d] repairFlowReply — the stages (Sandy Bell, 2026-11-04)");
  const sandy: ChatMessage[] = [u(SANDY_MSG)];
  const r_ask = repairFlowReply(sandy, "en");
  ck("Sandy: first reply = the owner's photo/video + description ask", r_ask === ASK_EN, r_ask ?? "null");
  ck("the ask never declines, visits, prices or asks details", !!r_ask && CLEAN(r_ask) && ASKS_PHOTO(r_ask), r_ask ?? "");
  ck("ES ask", repairFlowReply([u("Hola, tengo unos azulejos rotos en la cocina, me los pueden cambiar?")], "es") === repairPhotoAskMessage("es"));
  ck("PT ask", repairFlowReply([u("Oi, tenho umas peças do piso quebradas, vocês consertam?")], "pt") === repairPhotoAskMessage("pt"));
  ck("no ¿ ¡ in the Spanish lines", ![repairPhotoAskMessage("es"), repairPhotoReminderMessage("es"), repairHandoffMessage("es"), repairHoldMessage("es")].some((s) => /[¿¡]/.test(s)));
  const afterAsk: ChatMessage[] = [...sandy, a(ASK_EN)];
  const r_photo = repairFlowReply([...afterAsk, u(PHOTO)], "en");
  ck("photo after the ask → handoff (Ozzi checks it and gets back) + [NOTIFY_OWNER]", r_photo === HANDOFF_EN, r_photo ?? "null");
  ck("the handoff line names Ozzi and the callback, nothing else", OZZI_CHECKS(HANDOFF_EN) && CLEAN(HANDOFF_EN), HANDOFF_EN);
  ck("video after the ask → handoff", repairFlowReply([...afterAsk, u("[video]")], "en") === HANDOFF_EN);
  ck("unreadable photo after the ask → handoff too", repairFlowReply([...afterAsk, u("[floor plan or photo]")], "en") === HANDOFF_EN);
  ck("photo + words in the same burst after the ask → handoff", repairFlowReply([...afterAsk, u(PHOTO), u("This is the worst step")], "en") === HANDOFF_EN);
  const r_text = repairFlowReply([...afterAsk, u("It's the three steps going up to the bedrooms, the laminate is cracked on the edges")], "en");
  ck("words only after the ask → one reminder for the picture", r_text === REMIND_EN, r_text ?? "null");
  ck("words again after the reminder → handoff (no loop)", repairFlowReply([...afterAsk, u("It's the three steps, cracked edges"), a(REMIND_EN), u("Just the edges really, how much would that be?")], "en") === HANDOFF_EN);
  ck("'I don't have a photo right now' after the ask → handoff", repairFlowReply([...afterAsk, u("I don't have a photo right now, it's 3 steps with cracked laminate")], "en") === HANDOFF_EN);
  ck("'ok one sec' after the ask → silence", repairFlowReply([...afterAsk, u("ok one sec")], "en") === "[REACT_ONLY]");
  ck("'Sure, sending it now' after the ask → silence", repairFlowReply([...afterAsk, u("Sure, sending it now")], "en") === "[REACT_ONLY]");
  ck("'Thank you!' after the ask → silence", repairFlowReply([...afterAsk, u("Thank you!")], "en") === "[REACT_ONLY]");
  ck("'No problem, sending the photo now' after the ask → silence (not a refusal)", repairFlowReply([...afterAsk, u("No problem, sending the photo now")], "en") === "[REACT_ONLY]");
  ck("'I can send a video tomorrow' after the ask → silence", repairFlowReply([...afterAsk, u("I can send a video tomorrow")], "en") === "[REACT_ONLY]");
  ck("'ok the stairs are broken' after the ask → an answer, not an ack → reminder", repairFlowReply([...afterAsk, u("ok the stairs are broken")], "en") === REMIND_EN);
  ck("'ok I want a quote' after the ask → not an ack → reminder", repairFlowReply([...afterAsk, u("ok I want a quote")], "en") === REMIND_EN);
  ck("ES 'ya te mando la foto' after the ask → silence", repairFlowReply([u("Hola, tengo unos azulejos rotos en la cocina, me los pueden cambiar?"), a(repairPhotoAskMessage("es")), u("ya te mando la foto")], "es") === "[REACT_ONLY]");
  ck("ES 'no tengo foto ahora, son 3 escalones' after the ask → handoff", repairFlowReply([u("Hola, tengo unos azulejos rotos en la cocina, me los pueden cambiar?"), a(repairPhotoAskMessage("es")), u("no tengo foto ahora, son 3 escalones rotos")], "es") === repairHandoffMessage("es") + "[NOTIFY_OWNER]");
  ck("PT 'não consigo mandar foto agora' after the ask → handoff", repairFlowReply([u("Oi, tenho umas peças do piso quebradas, vocês consertam?"), a(repairPhotoAskMessage("pt")), u("não consigo mandar foto agora, são 3 degraus")], "pt") === repairHandoffMessage("pt") + "[NOTIFY_OWNER]");
  ck("photo + description in the very first burst → straight to the handoff", repairFlowReply([u(PHOTO), u("Can you fix these cracked steps?")], "en") === HANDOFF_EN);
  const afterHandoff: ChatMessage[] = [...afterAsk, u(PHOTO), a(HANDOFF_EN)];
  ck("'Thank you!' after the handoff → silence", repairFlowReply([...afterHandoff, u("Thank you!")], "en") === "[REACT_ONLY]");
  ck("'ok' after the handoff → silence", repairFlowReply([...afterHandoff, u("ok")], "en") === "[REACT_ONLY]");
  const r_hold = repairFlowReply([...afterHandoff, u("How much do you think it will cost?")], "en");
  ck("a repair question after the handoff → the hold line once", r_hold === HOLD_EN, r_hold ?? "null");
  ck("the hold line is clean", CLEAN(HOLD_EN) && OZZI_CHECKS(HOLD_EN), HOLD_EN);
  ck("another question after the hold → silence", repairFlowReply([...afterHandoff, u("How much?"), a(HOLD_EN), u("Any idea when he will reply?")], "en") === "[REACT_ONLY]");
  ck("pivot to a whole new floor after the handoff → null (normal flow)", repairFlowReply([...afterHandoff, u("Actually I want to redo the whole floor with vinyl, about 1200 sqft")], "en") === null);
  ck("no repair in the history → null", repairFlowReply([u("Hi, I'm interested in the promotion")], "en") === null);
  ck("a second photo after the handoff → silence (the team has it)", repairFlowReply([...afterHandoff, u(PHOTO)], "en") === "[REACT_ONLY]");
  ck("a video after the handoff → silence too", repairFlowReply([...afterHandoff, u("[video]")], "en") === "[REACT_ONLY]");
  const esFlow: ChatMessage[] = [u("Hola, tengo unos azulejos rotos en la cocina, me los pueden cambiar?"), a(repairPhotoAskMessage("es")), u(PHOTO)];
  ck("ES: photo after the ask → ES handoff + tag", repairFlowReply(esFlow, "es") === repairHandoffMessage("es") + "[NOTIFY_OWNER]");
  const ptFlow: ChatMessage[] = [u("Oi, tenho umas peças do piso quebradas, vocês consertam?"), a(repairPhotoAskMessage("pt")), u("[video]")];
  ck("PT: video after the ask → PT handoff + tag", repairFlowReply(ptFlow, "pt") === repairHandoffMessage("pt") + "[NOTIFY_OWNER]");
  // The stage survives the duplicate-send recap prefix and a [SYSTEM:] suffix on the stored line.
  ck("stage read through a recap prefix on the stored ask", repairFlowReply([...sandy, a("Just to recap: " + ASK_EN), u(PHOTO)], "en") === HANDOFF_EN);
  ck("stage read through a [SYSTEM:] suffix on the stored handoff", repairFlowReply([...afterAsk, u(PHOTO), a(repairHandoffMessage("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]"), u("thanks")], "en") === "[REACT_ONLY]");

  console.log("\n[1e] the historical cases through repairFlowReply (never a [BOOK], never the decline)");
  for (const [name, h] of [["Priti, the repair message", PRITI_UP_TO_REPAIR], ["Priti, the booking-details turn", PRITI_UP_TO_BOOK], ["fb match case", FB_MATCH_HISTORY], ["Lily", [u(LILY_MSG)]]] as Array<[string, ChatMessage[]]>) {
    const r = repairFlowReply(h, "en");
    ck(`${name} → the photo ask`, r === ASK_EN, r ?? "null");
  }

  console.log("\n[1f] repairAwaitingMedia — when the webhooks forward the client's photo to the team");
  ck("before the ask → not awaiting", !repairAwaitingMedia(sandy));
  ck("after the ask → awaiting", repairAwaitingMedia(afterAsk));
  ck("after the reminder → still awaiting", repairAwaitingMedia([...afterAsk, u("It's 3 steps"), a(REMIND_EN)]));
  ck("after the handoff → not awaiting", !repairAwaitingMedia(afterHandoff));
  ck("no repair → not awaiting", !repairAwaitingMedia([u("Hi"), a(ASK_EN)]));

  console.log("\n[1g] repairVisitOfferLeak — the post-model backstop");
  const leakOffer = "Of course, for a tile replacement I need to come measure in person, so let me set up your free visit. I have Tuesday at 3pm or Wednesday at 11am, which works better?";
  const leakDetails = "Can I get your name, the full property address with the zip code, and the best phone number?";
  const leakBook = "Appointment confirmed. [BOOK:{\"date\":\"2026-08-25\",\"time\":\"15:00\",\"name\":\"Priti\"}]";
  const oldDecline = "At the moment we only do full installations, we don't do repairs of any kind. We work with projects over 500 square feet. If you ever need a new floor, I'm happy to help!";
  ck("visit offer after the repair message → leak", repairVisitOfferLeak(PRITI_UP_TO_REPAIR, leakOffer), leakOffer);
  ck("booking-details ask while repair stands → leak", repairVisitOfferLeak(PRITI_UP_TO_BOOK.slice(0, -4), leakDetails), leakDetails);
  ck("[BOOK] while repair stands → leak", repairVisitOfferLeak(PRITI_UP_TO_BOOK, leakBook), leakBook);
  ck("the OLD decline is a leak now (owner rule 2026-11-04)", repairVisitOfferLeak(PRITI_UP_TO_REPAIR, oldDecline), oldDecline);
  ck("Lily: 'Yes, we do! $3.20 per sqft' → leak", repairVisitOfferLeak([u(LILY_MSG)], "Yes, we do! Since you have the material, it's $3.20 per sqft for the labor. How many square feet is the kitchen?"));
  ck("fb match case: 'Perfect, we can do that! zip code?' → leak", repairVisitOfferLeak(FB_MATCH_HISTORY, "Perfect, we can do that! What's the zip code of the property?"));
  ck("the photo ask is NOT a leak", !repairVisitOfferLeak(PRITI_UP_TO_REPAIR, ASK_EN));
  ck("the reminder is NOT a leak", !repairVisitOfferLeak(afterAsk, REMIND_EN));
  ck("the handoff (+ tag) is NOT a leak", !repairVisitOfferLeak([...afterAsk, u(PHOTO)], HANDOFF_EN));
  ck("the hold line is NOT a leak", !repairVisitOfferLeak(afterHandoff, HOLD_EN));
  ck("[REACT_ONLY] is NOT a leak", !repairVisitOfferLeak(afterHandoff, "[REACT_ONLY]"));
  ck("same offer with NO repair in history → not a leak", !repairVisitOfferLeak(PRITI_UP_TO_REPAIR.slice(0, 1), leakOffer));
  ck("isRepairFlowLine / isRepairPhotoAsk / isRepairHandoffReply / isRepairHoldReply",
    isRepairFlowLine(ASK_EN) && isRepairPhotoAsk(REMIND_EN) && isRepairHandoffReply(HANDOFF_EN) && isRepairHoldReply(HOLD_EN) && !isRepairFlowLine(oldDecline) && !isRepairHandoffReply(ASK_EN));
  ck("bubbleCarriesMedia: analysis / placeholder / video / document yes, words no",
    bubbleCarriesMedia(PHOTO) && bubbleCarriesMedia("[floor plan or photo]") && bubbleCarriesMedia("[video]") && bubbleCarriesMedia("[document]") && !bubbleCarriesMedia(SANDY_MSG) && !bubbleCarriesMedia("[Client replied to our ad]"));

  console.log("\n[1h] owner-promise exemption — the handoff is the one promise that stays as written");
  for (const lang of ["en", "es", "pt"] as const) {
    const h = repairHandoffMessage(lang);
    const hold = repairHoldMessage(lang);
    ck(`${lang}: handoff is not rewritten into Ozzi's number`, redirectOwnerPromiseToPhone(h + "[NOTIFY_OWNER]", lang) === h + "[NOTIFY_OWNER]", redirectOwnerPromiseToPhone(h + "[NOTIFY_OWNER]", lang));
    ck(`${lang}: hold line is not rewritten`, redirectOwnerPromiseToPhone(hold, lang) === hold, redirectOwnerPromiseToPhone(hold, lang));
    ck(`${lang}: handoff / hold do not force a second alert (promisesOwnerContact false)`, !promisesOwnerContact(h) && !promisesOwnerContact(hold));
  }
  const plainPromise = "I'll pass this along to Ozzi and he will reach out to you shortly.";
  ck("a plain 'Ozzi will reach out' is STILL a promise (rewritten + forced alert)", promisesOwnerContact(plainPromise) && /674[\s.-]*8334/.test(redirectOwnerPromiseToPhone(plainPromise, "en")), redirectOwnerPromiseToPhone(plainPromise, "en"));
  ck("handoff + a plain promise in the same reply: only the plain one is rewritten",
    (() => { const out = redirectOwnerPromiseToPhone(repairHandoffMessage("en") + " Someone will call you tomorrow.", "en"); return out.startsWith(repairHandoffMessage("en")) && /674[\s.-]*8334/.test(out) && !/call you tomorrow/.test(out); })());
  ck("team alert names the repair and the three people", /REPARO/.test(REPAIR_HANDOFF_ALERT) && /Ozzi/.test(REPAIR_HANDOFF_ALERT) && /Ruani/.test(REPAIR_HANDOFF_ALERT) && /Vinicius/.test(REPAIR_HANDOFF_ALERT));

  // ── 2. THROUGH THE BRAIN (deterministic: getAIResponse short-circuits) ───
  console.log("\n[2] getAIResponse: Sandy Bell — the repair message itself");
  const r1 = await ai(sandy);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 220));
  ck("asks for the video / picture + description (the owner's line)", r1 === ASK_EN, r1);
  ck("never 'we don't do repairs', no visit, no price, no details", CLEAN(r1), r1);

  console.log("\n[2b] getAIResponse: Sandy sends the photo → handoff + [NOTIFY_OWNER]");
  const r2 = await ai([...afterAsk, u(PHOTO)]);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 220));
  ck("Ozzi is going to check it and will get back + tag", r2 === HANDOFF_EN && HAS_NOTIFY(r2), r2);

  console.log("\n[2c] getAIResponse: Priti replay — the repair message and the booking-details turn");
  const r3 = await ai(PRITI_UP_TO_REPAIR);
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 220));
  ck("Priti: the photo ask", r3 === ASK_EN, r3);
  const r4 = await ai(PRITI_UP_TO_BOOK);
  console.log("   →", r4.replace(/\s+/g, " ").slice(0, 220));
  ck("no [BOOK] for a repair even with name/address/phone in hand", !HAS_BOOK(r4) && r4 === ASK_EN, r4);

  console.log("\n[2d] getAIResponse ES / PT");
  const r5 = await ai([u("Hola buenas, tengo unos azulejos rotos en la cocina, me los pueden cambiar? Cuanto cobran?")]);
  console.log("   →", r5.replace(/\s+/g, " ").slice(0, 220));
  ck("ES: the photo ask in Spanish, no price", r5 === repairPhotoAskMessage("es") && !HAS_PRICE(r5), r5);
  const r6 = await ai([u("Oi, tudo bem? Tenho umas peças do piso quebradas na sala, vocês consertam?")]);
  console.log("   →", r6.replace(/\s+/g, " ").slice(0, 220));
  ck("PT: the photo ask in Portuguese", r6 === repairPhotoAskMessage("pt"), r6);

  console.log("\n[2e] getAIResponse mid-convo: type known, then a repair ask");
  const r7 = await ai([
    u("Hi, do you install tile?"),
    a("Yes, we install tile! Tile installation is $4.50 per square foot for the labor and you provide the material. What area are you looking to do?"),
    u("It's just a few tiles in the hallway that cracked, can you replace those?"),
  ]);
  console.log("   →", r7.replace(/\s+/g, " ").slice(0, 220));
  ck("the photo ask, no visit, no decline", r7 === ASK_EN, r7);

  console.log("\n[2f] getAIResponse: fb_28104189355856705 replay — 'find a match and replace it' after the FAQ taps");
  const r8 = await ai(FB_MATCH_HISTORY);
  console.log("   →", r8.replace(/\s+/g, " ").slice(0, 220));
  ck("the photo ask (no 'we can do that', no zip, no price, no visit, no decline)", r8 === ASK_EN, r8);

  console.log("\n[2g] getAIResponse: Lily replay — 'some wood needs to be replaced, I got boxes of the floor'");
  const r9 = await ai([u(LILY_MSG)]);
  console.log("   →", r9.replace(/\s+/g, " ").slice(0, 220));
  ck("the photo ask (no 'yes we do', no labor rate, no sqft ask, no Ozzi number)", r9 === ASK_EN, r9);

  console.log("\n[2h] getAIResponse: after the handoff, 'thank you' is silence");
  const r10 = await ai([...afterHandoff, u("Thank you so much!")]);
  ck("[REACT_ONLY]", r10 === "[REACT_ONLY]", r10);

  // ── 3. REGRESSIONS (LIVE) ─────────────────────────────────────────────────
  console.log("\n[3] REGRESSION (LIVE): cracked tiles under the liquid ad → vinyl OVER tile, not the repair flow");
  const g1 = await ai([u("I saw your ad, my tiles are cracked and uneven, does the liquid floor go over them?\n\n[SYSTEM: [AD REPLY: lead replied to our vinyl promotion ad]]")]);
  console.log("   →", g1.replace(/\s+/g, " ").slice(0, 220));
  ck("not the photo ask, not a decline", g1 !== ASK_EN && !DECLINES_REPAIR(g1), g1);
  ck("says it goes over / covers the cracked tile", OVER_TILE(g1), g1);

  console.log("\n[3b] REGRESSION (LIVE): bathroom remodel is Ozzi direct, not the repair flow");
  const g2 = await ai([u("Hi, do you do bathroom remodeling?")]);
  console.log("   →", g2.replace(/\s+/g, " ").slice(0, 220));
  ck("not the photo ask, points to Ozzi's line", g2 !== ASK_EN && /\(?\s?561\s?\)?[\s.-]*674[\s.-]*8334/.test(g2), g2);
  ck("no visit (bathroom = Ozzi direct)", !PROPOSES_VISIT(g2), g2);

  console.log("\n[3c] REGRESSION (LIVE): whole-house install that mentions cracked tiles → visit");
  const g3 = await ai([u("Hi, I want new floors for the whole house, about 1500 sqft, some of the tiles are cracked")]);
  console.log("   →", g3.replace(/\s+/g, " ").slice(0, 220));
  ck("not the photo ask, not a decline", g3 !== ASK_EN && !DECLINES_REPAIR(g3), g3);
  ck("proposes the visit (large lead)", PROPOSES_VISIT(g3), g3);

  console.log("\n[3d] REGRESSION (LIVE): photo asked, then the client pivots to a new floor → normal flow resumes");
  const g4 = await ai([
    u("Can you fix a few broken tiles in my kitchen?"),
    a(ASK_EN),
    u("Ok. What if I redo the whole kitchen floor with your vinyl? It's about 300 sqft"),
  ]);
  console.log("   →", g4.replace(/\s+/g, " ").slice(0, 220));
  ck("does NOT repeat the photo ask and never declines", g4 !== ASK_EN && !isRepairPhotoAsk(g4) && !DECLINES_REPAIR(g4), g4);
  // 300 sqft is under 400: the next step is Ozzi's direct line (owner rule 2026-09-11)
  ck("engages the vinyl job (Ozzi direct line for 300 sqft, or price / next step)", /674[\s.-]*8334/.test(g4) || HAS_PRICE(g4) || /vinyl|promotion|\$5|per square foot/i.test(g4), g4);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
