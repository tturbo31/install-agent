// Verifies the 2026-09-19 fixes (owner's screenshots, Messenger):
//   1. Juan Carlos Beltran (fb_28467730842862629) answered the ad greeting with
//      "Para esa instalación ( a no ser que sea solo promocional) se debe retirar
//      el rodapiés anterior y Lugo colocar en nuevo sobre el piso" and got the
//      canned "Hola, trabajamos con piso vinílico de lujo, tile y hardwood… Cuál
//      te interesa?". No "?" and no question word, so questionBeyondOpener let it
//      through. The 14-day sweep (05–19/09, 1,227 first contacts) found ~160 first
//      messages with content that got a canned opener over it (call requests,
//      "Dame la dirección", "Does the price include staircase ?", "Necesito
//      alguien que instale losas", "trabajan en Orlando?…", "Refinishing"…).
//      Now openerCoversMessage: the canned type-ask answers a first message only
//      when every word in it is greeting / courtesy / generic "info, price,
//      quote" vocabulary; anything else goes to the model, and the prompt (rule
//      under OPENER + AD_REPLY_NOTE) makes the model answer THAT before the type.
//   2. Rosemene Lapierre (fb_28771580205779693) re-sent "What is the installation
//      process?" 31s after our answer and got silence: the repeated-message
//      intercept called it a "double-tap". 7 such silences in 14 days, 4 leads
//      never wrote again. A re-send AFTER our answer now gets a deterministic
//      re-answer (once), a re-send before/at our answer and a storm stay silent.
//   3. "What is included in the materials package?" joins AD_FAQ_INCLUSIONS, so a
//      burst of Meta buttons gets the combined answer whatever the tap order.
//   Sections: 1 DETERMINISTIC (no API). 2 LIVE MODEL (real victims answered).
// Set DET_ONLY=1 to run only the deterministic section.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, openerCoversMessage, isReanswerReply, cannedFaqReanswer, asksForACall, callNumberLine, ensureContactNumber, type ChatMessage } from "../lib/ai";
import {
  OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LANG_EN, OPENER_LANG_ES, OPENER_LANG_PT, OPENER_PROCESS_EN, OPENER_PROCESS_ES,
  OPENER_DISCOUNT_EN, OPENER_LOCATION_EN, OPENER_LOCATION_ES, WHAT_IS_INCLUDED_ASK_TYPE, AD_REPLY_NOTE, composeAdFaqOpener,
} from "../lib/system-prompt";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}

const AD = "\n\n[SYSTEM: TODAY: Saturday, September 19, 2026 [2026-09-19].\n\n" + AD_REPLY_NOTE + "]";
const WA = "\n\n[SYSTEM: TODAY: Saturday, September 19, 2026 [2026-09-19].\n\n[WHATSAPP CHANNEL: phone known.]]";
const S = (sec: number) => new Date(Date.now() - 3600000 + sec * 1000).toISOString();
const U = (c: string, at?: string): ChatMessage => ({ role: "user", content: c, at });
const A = (c: string, at?: string): ChatMessage => ({ role: "assistant", content: c, at });
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false);
const ALL_CANNED = [OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LANG_EN, OPENER_LANG_ES, OPENER_LANG_PT, OPENER_PROCESS_EN, OPENER_PROCESS_ES, OPENER_DISCOUNT_EN, OPENER_LOCATION_EN, OPENER_LOCATION_ES, WHAT_IS_INCLUDED_ASK_TYPE];
const JUAN_CARLOS = "Para esa instalación ( a no ser que sea solo promocional) se debe retirar el rodapiés anterior y Lugo colocar en nuevo sobre el piso";
const PROCESS_Q = "What is the installation process?";

async function main() {
  console.log("\n═══ 1. DETERMINISTIC ═══\n");

  console.log("[1a] openerCoversMessage: generic first messages keep the canned type-ask");
  const generic = [
    "Hi", "Hola", "Hiii", "Yess", "Hola buenas tardes", "hola 👋", "Hey guys", "Good morning", "Ok",
    "How much", "Price per sq ft?", "Hi! How much do you charge per sq ft", "Need a quote", "I need estimate",
    "Hi I’m interested", "Hi I’m interested in the flooring installation", "Hi I’m super interested in information for the floor",
    "Hello. I would like to see how I can get a quote for the flooring in my house", "Can we get a free quote. Thanks",
    "Hi good afternoon I would like to get a quote to get some flooring done in my house",
    "Quiero una cotización", "Hola el precio", "Me interesa, cuánto cuesta el pie cuadrado?", "Buenas, quisiera información sobre la promoción",
    "Gostaria de um orçamento", "Quanto custa?", "What is the material?", "What kind of floor is this?", "That's a great deal?",
    "[Client replied to our ad]", "👍",
    // explicit language requests keep the deterministic language opener
    "En español", "Hablas español", "No sé inglés, si puede tráeselo en español", "Solo ablo español", "Em português por favor", "In English please",
  ];
  for (const g of generic) ck(`covers: "${g}"`, openerCoversMessage(g), g);
  ck("covers: survives an appended [SYSTEM:] note", openerCoversMessage("Hola" + AD));

  console.log("\n[1b] openerCoversMessage: anything specific goes to the model (real victims 05–19/09)");
  const specific = [
    JUAN_CARLOS, "Call next week pls", "I would like to book a call", "Hi can I send you some pictures and you give me a quote",
    "Does the price include staircase ?", "Refinishing", "Need a quote for my hose to install railing. Thanks",
    "Necesito alguien que instale losas", "Hola 👋🏻 varias preguntas 1- trabajan en Orlando? 2- Cuánto cobran la instalación por pie cuadrado? Yo te go ya el piso de madera que será instalado",
    "Dame la dirección", "What would the price be for an apartment of 2000 ft ?", "Not now maybe at another time", "Venden en Miami",
    "B dias vivo en hialeah", "Send me your telephone number", "Hi, yes of course, give me more information about your work area",
    "Are you come for free estimate?", "The price included material and labor?", "What type of material is the one on this Ad?",
    "Español. Quiero saber si retiran el rodapié", "在哪里", "[voice message]", "[floor plan or photo]", "Hola y 750 cuánto costaría",
    "I have. I'm in FREEHOLD. I have 850 ft.². I have the materials just need the labor.", "Hi one bedroom room how much are u in florida",
  ];
  for (const s of specific) ck(`model reads: "${s.slice(0, 70)}"`, !openerCoversMessage(s), s);

  console.log("\n[1c] canned first-contact routes that must NOT change (zero tokens)");
  const cannedRoutes: Array<[string, ChatMessage[], string]> = [
    ["'Hi' + ad", [U("Hi" + AD)], OPENER_EN],
    ["'Hola' + ad", [U("Hola" + AD)], OPENER_ES],
    ["bare ad tag", [U("[Client replied to our ad]" + AD)], OPENER_EN],
    ["'How much per sqft?' (WhatsApp)", [U("How much per sqft?" + WA)], OPENER_EN],
    ["'Need a quote' + ad", [U("Need a quote" + AD)], OPENER_EN],
    ["'Quiero una cotización' + ad", [U("Quiero una cotización" + AD)], OPENER_ES],
    ["'What is the material?' + ad", [U("What is the material?" + AD)], OPENER_EN],
    ["'En español' + ad", [U("En español" + AD)], OPENER_LANG_ES],
    ["'Solo ablo español' + ad", [U("Solo ablo español" + AD)], OPENER_LANG_ES],
    ["installation-process button", [U(PROCESS_Q + AD)], OPENER_PROCESS_EN],
    ["'Where are you located?'", [U("Where are you located?" + AD)], OPENER_LOCATION_EN],
    ["materials-package button alone", [U("What is included in the materials package?" + AD)], WHAT_IS_INCLUDED_ASK_TYPE],
    ["materials-package button + ad tag last", [U("What is included in the materials package?"), U("[Client replied to our ad]" + AD)], WHAT_IS_INCLUDED_ASK_TYPE],
    ["3 buttons (discount + materials package + labor extra)", [U("Do you offer any discounts for larger spaces?"), U("What is included in the materials package?"), U("Is installation labor cost extra?" + AD)], composeAdFaqOpener(["discount", "inclusions"], "en") as string],
    ["2 buttons, materials package first (tap order no longer matters)", [U("What is included in the materials package?"), U("Do you offer any discounts for larger spaces?" + AD)], composeAdFaqOpener(["discount", "inclusions"], "en") as string],
  ];
  for (const [name, msgs, want] of cannedRoutes) {
    const r = await ai(msgs);
    ck(`${name} → canned, 0 tokens`, r.text === want && r.inputTokens === 0, r.text);
  }

  console.log("\n[1d] re-sent question AFTER our answer → answered (Rosemene), never silence");
  const rose = await ai([U(PROCESS_Q, S(0)), A(OPENER_PROCESS_EN, S(16)), U(PROCESS_Q, S(47))]);
  ck("Rosemene replay (31s after our answer) → deterministic re-answer, 0 tokens", rose.text !== "[REACT_ONLY]" && rose.inputTokens === 0, rose.text);
  ck("…says it is repeating and answers the process again", /here it is again/i.test(rose.text) && /furniture/i.test(rose.text), rose.text);
  ck("…moves to the free visit instead of re-asking the type", /free visit/i.test(rose.text) && !/tile, vinyl, or hardwood\?/i.test(rose.text), rose.text);
  ck("…is not a copy of our previous message", rose.text.trim() !== OPENER_PROCESS_EN.trim());
  const roseEs = await ai([U("Cómo es el proceso de instalación?", S(0)), A(OPENER_PROCESS_ES, S(15)), U("Cómo es el proceso de instalación?", S(60))]);
  ck("Spanish re-send → Spanish re-answer + visit, no ¿", /^Con gusto te lo repito:/.test(roseEs.text) && /muebles/i.test(roseEs.text) && /visita gratis/i.test(roseEs.text) && !/[¿¡]/.test(roseEs.text), roseEs.text);
  const incl = await ai([U("Is installation labor cost extra?", S(0)), A(WHAT_IS_INCLUDED_ASK_TYPE, S(15)), U("Is installation labor cost extra?", S(57))]);
  ck("inclusions button re-sent → inclusions re-answer", /here it is again/i.test(incl.text) && /labor only/i.test(incl.text) && incl.inputTokens === 0, incl.text);
  const pkg = await ai([U("What is included in the materials package?", S(0)), A(WHAT_IS_INCLUDED_ASK_TYPE, S(15)), U("What is included in the materials package?", S(50))]);
  ck("materials-package button re-sent → inclusions re-answer (was the model)", /here it is again/i.test(pkg.text) && /quarter round/i.test(pkg.text) && pkg.inputTokens === 0, pkg.text);
  const disc = await ai([U("Do you offer any discounts for larger spaces?", S(0)), A(OPENER_DISCOUNT_EN, S(15)), U("Do you offer any discounts for larger spaces?", S(40))]);
  ck("discount re-sent → re-answer, no extra visit push (visit already offered)", /here it is again/i.test(disc.text) && !/Want me to set up a free visit/i.test(disc.text), disc.text);

  console.log("\n[1e] what stays silent");
  const storm = await ai([U(PROCESS_Q, S(0)), A(OPENER_PROCESS_EN, S(16)), U(PROCESS_Q, S(47)), A(rose.text, S(60)), U(PROCESS_Q, S(80))]);
  ck("third send right after our re-answer → [REACT_ONLY] (storm cap)", storm.text === "[REACT_ONLY]", storm.text);
  const tap = await ai([U(PROCESS_Q, S(0)), A(OPENER_PROCESS_EN, S(16)), U(PROCESS_Q, S(17))]);
  ck("re-send landing with our reply (≤2s, not seen yet) → [REACT_ONLY] (double-tap)", tap.text === "[REACT_ONLY]", tap.text);
  const tag = await ai([U("[Client replied to our ad]", S(0)), A("Got your message! Could you type your question?", S(15)), U("[Client replied to our ad]", S(60))]);
  ck("contentless ad tap after our reply → [REACT_ONLY] (ad re-tap nudge owns these)", tag.text === "[REACT_ONLY]", tag.text);
  ck("isReanswerReply: FAQ lead-in / recap prefix", isReanswerReply("Sure thing, here it is again: We move…") && isReanswerReply("As I mentioned above: …") && !isReanswerReply(OPENER_PROCESS_EN));

  console.log("\n[1f] unchanged: re-send after the 15-min window / without timestamps");
  const later = await ai([U(PROCESS_Q, S(0)), A(OPENER_PROCESS_EN, S(16)), U(PROCESS_Q, S(7200))]);
  ck("2h later → re-answer with the type question (old path)", /here it is again/i.test(later.text) && /tile, vinyl, or hardwood\?/i.test(later.text), later.text);
  const noTs = await ai([U(PROCESS_Q), A(OPENER_PROCESS_EN), U(PROCESS_Q)]);
  ck("no timestamps → re-answer (never silence)", noTs.text !== "[REACT_ONLY]" && /furniture/i.test(noTs.text), noTs.text);
  ck("cannedFaqReanswer(quick) returns null for a non-FAQ text", cannedFaqReanswer("Can you come tomorrow morning?", [], { quick: true }) === null);

  console.log("\n[1g] first message asking for a CALL → the reply carries Ozzi's number");
  for (const c of ["Call next week pls", "I would like to book a call", "Please call me", "Can you give me a call tomorrow", "Llámame mañana", "Me pueden llamar?", "Prefiero una llamada", "Me liga amanhã"])
    ck(`asksForACall("${c}")`, asksForACall(c), c);
  for (const c of ["Please call me at (786) 216-8633", "Call me 786 319 0424", "Hi", "How much per sqft?", "What do you call this floor?", "I will call you tomorrow"])
    ck(`NOT asksForACall("${c}")`, !asksForACall(c), c);
  const typeOnly = "Sure thing! We work with tile, vinyl, and hardwood, each at a different rate. Which one are you looking to install?";
  const fixedCall = ensureContactNumber([U("Call next week pls" + AD)], typeOnly, "en");
  ck("type-only reply to 'Call next week pls' → Ozzi's number first, the question kept", fixedCall.startsWith(callNumberLine("en")) && /Which one are you looking to install\?$/.test(fixedCall) && !/Thing!/.test(fixedCall), fixedCall);
  ck("ES call request → Spanish number line", ensureContactNumber([U("Llámame mañana" + AD)], "Cuál te interesa, tile, vinil o hardwood?", "es").startsWith(callNumberLine("es")));
  ck("reply that already has the number → unchanged", ensureContactNumber([U("Call next week pls" + AD)], "Sure, call Ozzi at (561) 674-8334. Tile, vinyl or hardwood?", "en") === "Sure, call Ozzi at (561) 674-8334. Tile, vinyl or hardwood?");
  ck("call request MID-conversation → left to the model (unchanged)", ensureContactNumber([U("Hi"), A(OPENER_EN), U("call me before you come")], "Sure thing, see you then!", "en") === "Sure thing, see you then!");

  console.log("\n[1h] wiring");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const spSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("router gates the generic opener with openerCoversMessage(burst)", /const openerCovers = openerCoversMessage\(burst\);/.test(aiSrc) && /&& openerCovers &&/.test(aiSrc));
  ck("vinylProne leg gates with openerCoversMessage(firstBurst)", /openerCoversMessage\(firstBurst\)\) return openerMessage/.test(aiSrc));
  ck("repeated-message intercept answers a re-send after the reply", /cameAfterReply && hasClientWords && !isReanswerReply/.test(aiSrc));
  ck("first contact with content → the answer-it-first block is injected (with the client's language)", /dynamicSystem \+= "\\n\\n---\\n\\n" \+ firstMessageContentNote\(firstBurst\);/.test(aiSrc) && /LANGUAGE: the client wrote in SPANISH/.test(aiSrc));
  ck("the block is scoped: first contact, type unknown, not a referral flow, not a rejection", /!openerCoversMessage\(firstBurst\) && !mentionsRejection\(firstBurst\)/.test(aiSrc));
  ck("the main prompt's OPENER line is unchanged (a global rewrite shifted other flows' wording)", /If the client's first message asks something you CAN answer without knowing the type/.test(spSrc));
  ck("AD_REPLY_NOTE: never only the type question", /never only the type question/.test(AD_REPLY_NOTE));

  if (process.env.DET_ONLY === "1") return;

  console.log("\n═══ 2. LIVE MODEL — the real victims get an answer, not a canned line ═══\n");
  const live = async (name: string, msgs: ChatMessage[], test: (t: string) => boolean) => {
    const r = await ai(msgs);
    ck(`${name}`, !ALL_CANNED.includes(r.text) && r.inputTokens > 0 && test(r.text), r.text);
    return r.text;
  };
  // A per-sqft type rate before the client picked a type ($5 vinyl, $4.50 tile, $3.20 hardwood).
  // For a typed "what is included" question the model lists the three rates, each
  // labeled with its floor: accepted (never the vinyl $5 alone as THE price).
  const NO_TYPE_RATE = /\$\s?(?:5|4[.,]50|3[.,]20)(?![\d,])/;
  const es = (t: string) => /\b(?:el|la|los|las|de|que|para|por|es|te|tu|su|cu[aá]l|piso|estamos|trabajamos)\b/i.test(t) && !/\b(?:the|which|you|we)\b/i.test(t);
  await live("Juan Carlos: baseboards answered, in Spanish, as SEPARATE from the promo", [U(JUAN_CARLOS + AD)], (t) => es(t) && /rodap|z[oó]calo/i.test(t) && /aparte|separad|pie lineal/i.test(t) && !/queda incluid|ya (?:est[aá]|va) incluid|incluid[oa] en la promo/i.test(t));
  await live("staircase question answered", [U("Does the price include staircase ?" + AD)], (t) => /stair|step/i.test(t));
  await live("'Call next week pls' → Ozzi's number", [U("Call next week pls" + AD)], (t) => /674-8334/.test(t));
  await live("'I would like to book a call' → Ozzi's number", [U("I would like to book a call" + AD)], (t) => /674-8334/.test(t));
  await live("'Dame la dirección' → where we are, in Spanish", [U("Dame la dirección" + AD)], (t) => es(t) && /miami|florida/i.test(t));
  await live("pictures → yes, send them", [U("Hi can I send you some pictures and you give me a quote" + AD)], (t) => /send|picture|photo|go ahead/i.test(t));
  await live("'losas' = tile, priced, never asks the type (WhatsApp)", [U("Necesito alguien que instale losas" + WA)], (t) => /4[.,]50/.test(t) && !/tile, vin[iy]l o hardwood\?/i.test(t));
  await live("Orlando + hardwood named → out of area + hardwood", [U("Hola 👋🏻 varias preguntas 1- trabajan en Orlando? 2- Cuánto cobran la instalación por pie cuadrado? Yo te go ya el piso de madera que será instalado" + AD)], (t) => /orlando/i.test(t) && /3[.,]20/.test(t));
  await live("railing → declined (WhatsApp)", [U("Need a quote for my hose to install railing. Thanks" + WA)], (t) => /railing/i.test(t) && /\b(?:don['’]?t|not|aren['’]?t|isn['’]?t|only)\b/i.test(t));
  await live("refinishing → declined", [U("Refinishing" + AD)], (t) => /refinish/i.test(t) && /\b(?:don['’]?t|not|isn['’]?t|only)\b/i.test(t));
  await live("2000 ft apartment → visit, no total", [U("What would the price be for an apartment of 2000 ft ?" + AD)], (t) => /measure|visit|in person/i.test(t) && !/\$\s?\d{1,3},?\d{3}/.test(t) && !NO_TYPE_RATE.test(t));
  await live("'Venden en Miami' → yes, in Spanish", [U("Venden en Miami" + AD)], (t) => es(t) && /miami/i.test(t));
  await live("'free estimate?' → yes, free", [U("Are you come for free estimate?" + AD)], (t) => /free/i.test(t));
  await live("typed inclusions question → the real reason, not a bare type question", [U("The price included material and labor?" + AD)], (t) => /includ|cover/i.test(t) && /labor/i.test(t) && (!NO_TYPE_RATE.test(t) || (/tile/i.test(t) && /hardwood/i.test(t))));
  const notNow = await ai([U("Not now maybe at another time" + AD)]);
  ck("'Not now maybe at another time' → no pitch (silence or a short goodbye)", !ALL_CANNED.includes(notNow.text) && (/\[REACT_ONLY\]/.test(notNow.text) || !/\b(?:tile|vinyl|hardwood)\b/i.test(notNow.text)), notNow.text);
}

main()
  .then(() => {
    console.log(`\n=========== OPENER-CONTENT-VERIFY: ${pass} passed, ${fail} failed ===========`);
    if (fail) console.log("FAILED:", fails.join(" | "));
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
