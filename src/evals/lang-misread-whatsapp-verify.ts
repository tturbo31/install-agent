// Verifies the two 2026-09-17 owner cases never happen again:
//  A. Stela Cunha (FB): first message "Me envi seu WhatsApp aí eu te chamo"
//     (PT: "send me your WhatsApp and I'll message you") got the canned ENGLISH
//     type-ask. Now: a request for our WhatsApp / number / contact in any
//     language routes to the model (firstMessageNeedsReading via
//     asksForOurContact), the PT function words pin Portuguese (openerLang /
//     detectLang), and the reply is guaranteed to carry (561) 674-8334
//     (ensureContactNumber).
//  B. Leticia Ahumada (FB): after our English process answer she wrote "No,
//     speak English" (broken English for "I don't speak English"); the comma
//     made requestedLang read it as a request FOR English and the model replied
//     "Already in English!" in English. Now: NO_ENGLISH_* patterns → es,
//     languageSwitchRequest decides the target with the context (English from
//     us → they do not speak English; Spanish from us → they want English),
//     the model gets a CRITICAL language-switch note, and a reply in the wrong
//     language or an "already in English" is replaced (enforceLanguageSwitch).
//  1. DETERMINISTIC (no API) — detectors, context decisions, backstops, wiring.
//  2. LIVE MODEL — both real turns replayed twice + variants + regressions.
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, requestedLang, openerLang, firstMessageNeedsReading, asksForOurContact, languageSwitchRequest,
  languageSwitchNote, languageSwitchFallback, enforceLanguageSwitch, ensureContactNumber, contactNumberLine, type ChatMessage,
} from "../lib/ai";
import { detectLang } from "../lib/scheduler";
import { OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LANG_EN, OPENER_LANG_ES, OPENER_LANG_PT, OPENER_PROCESS_EN, AD_REPLY_NOTE } from "../lib/system-prompt";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 260)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false);
const NUM = /674[\s.-]?8334/;
const AD = "\n\n[Client replied to our ad]";
const AD_SYS = "\n\n[SYSTEM: " + AD_REPLY_NOTE + "]";
const ALL_CANNED = [OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LANG_EN, OPENER_LANG_ES, OPENER_LANG_PT];
const SNARK = /already\s+(?:in|speaking|writing)\s+(?:in\s+)?english|this\s+is\s+(?:already\s+)?english|in\s+english\s+already/i;
const EN_WORDS = /\b(?:the|we|you|your|which|what|our|and|for|with|are|is|that|this|can|will|have|does|it|from|would|here|there|thanks|works|floors?|furniture)\b/gi;
const looksEnglish = (t: string) => !/[ñãõçáéíóúêàô]/.test(t) && (t.match(EN_WORDS) || []).length >= 2;
// Spanish markers: any accent/ñ or a common word of the bot's Spanish ("Nuestro WhatsApp es…, por ahí
// puedes escribirnos… estas buscando instalar tile, vinyl o madera?" is Spanish with none of the
// narrower words, and failed a first version of this list).
const ES_MARK = /[ñáéíóú]|\b(?:español|espanol|gusto|cu[aá]l|piso|muebles|interesa|instalamos|movemos|atiendo|claro|hola|tenemos|te\s+queda|dime|nuestro|nuestra|puedes|escribir\w*|cu[eé]ntame|buscando|instalar|madera|vinil|est[aá]s|quieras|cuando|ah[ií]|para|con|que|qu[eé])\b/i;
const PT_MARK = /[ãõç]|\b(?:você|voce|vc|nosso|nossa|prefere|interessa|piso|qual|pode|aqui|pelo|por\s+lá|te\s+atendo|trabalhamos|instalamos|obrigad[oa])\b/i;
const ES_ONLY = /\b(?:nuestro|nuestra|puedes|escribirle|vinílico\s+de\s+lujo|tenemos|cuál|atiendo|interesa)\b/i;

// The two real turns, exactly as production fed them to the brain.
const STELA: ChatMessage[] = [U("Me envi seu WhatsApp aí eu te chamo" + AD_SYS)];
const LETICIA: ChatMessage[] = [
  U("What is the installation process?"),
  A("We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?"),
  U("No, speak English" + AD_SYS),
];
const EN_BOT = A("We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?");
const ES_BOT = A("Movemos los muebles, instalamos el piso, colocamos el quarter round y dejamos todo limpio. Cual te interesa, tile, vinil o hardwood?");

async function main() {
  console.log("\n[1] DETERMINISTIC — 'no speak English' family → es (context-free)");
  const es = ["No, speak English", "No speak English", "no english", "No English", "I no speak english", "me no english", "my english is not good", "little english", "English no", "Sorry no English", "I speak Spanish", "I don't speak English", "No hablo ingles", "no me hablen en ingles", "No, English. Spanish"];
  for (const p of es) ck(`requestedLang("${p}") = es`, requestedLang(p) === "es", String(requestedLang(p)));
  const en = ["Speak English please", "English please", "In English please", "I don't speak Spanish", "No, I speak English", "No hablo español, solo inglés"];
  for (const p of en) ck(`requestedLang("${p}") = en`, requestedLang(p) === "en", String(requestedLang(p)));
  for (const p of ["Nao falo ingles", "Não falo inglês", "Em português por favor"]) ck(`requestedLang("${p}") = pt`, requestedLang(p) === "pt", String(requestedLang(p)));
  for (const p of ["Spanish tile", "Hi", "How much per sqft?", "Me envi seu WhatsApp aí eu te chamo", "no thanks", "No, not now"]) ck(`requestedLang("${p}") = null`, requestedLang(p) === null, String(requestedLang(p)));

  console.log("\n[1b] DETERMINISTIC — languageSwitchRequest reads the context");
  const sw = (h: ChatMessage[]) => JSON.stringify(languageSwitchRequest(h));
  ck("Leticia: EN from us + 'No, speak English' → es / no-english", sw(LETICIA) === JSON.stringify({ target: "es", reason: "no-english" }), sw(LETICIA));
  ck("EN from us + 'no english' → es", sw([U("hi"), EN_BOT, U("no english")]) === JSON.stringify({ target: "es", reason: "no-english" }), sw([U("hi"), EN_BOT, U("no english")]));
  ck("EN from us + 'Speak English please' → en (no snark, just English)", sw([U("hi"), EN_BOT, U("Speak English please")]) === JSON.stringify({ target: "en", reason: "request" }), sw([U("hi"), EN_BOT, U("Speak English please")]));
  ck("EN from us + 'No, I speak English' → en", sw([U("hi"), EN_BOT, U("No, I speak English")]) === JSON.stringify({ target: "en", reason: "request" }), sw([U("hi"), EN_BOT, U("No, I speak English")]));
  ck("ES from us + 'No, speak English' → en (they want English)", sw([U("hola"), ES_BOT, U("No, speak English")]) === JSON.stringify({ target: "en", reason: "request" }), sw([U("hola"), ES_BOT, U("No, speak English")]));
  ck("ES from us + 'No, English please' → en", sw([U("hola"), ES_BOT, U("No, English please")]) === JSON.stringify({ target: "en", reason: "request" }), sw([U("hola"), ES_BOT, U("No, English please")]));
  ck("ES from us + 'I don't speak Spanish' → en", sw([U("hola"), ES_BOT, U("I don't speak Spanish")]) === JSON.stringify({ target: "en", reason: "request" }), sw([U("hola"), ES_BOT, U("I don't speak Spanish")]));
  ck("ES from us + bare 'no english' → stays es", sw([U("hola"), ES_BOT, U("no english")]) === JSON.stringify({ target: "es", reason: "no-english" }), sw([U("hola"), ES_BOT, U("no english")]));
  ck("ES from us + 'I don't speak English' → es", sw([U("hola"), ES_BOT, U("I don't speak English")]) === JSON.stringify({ target: "es", reason: "no-english" }), sw([U("hola"), ES_BOT, U("I don't speak English")]));
  ck("PT earlier + EN from us + 'no english' → pt", sw([U("Oi, quero orçamento pra minha casa"), EN_BOT, U("no english")]) === JSON.stringify({ target: "pt", reason: "no-english" }), sw([U("Oi, quero orçamento pra minha casa"), EN_BOT, U("no english")]));
  ck("first contact (Meta's greeting is English) + 'No, speak English' → es", sw([U("No, speak English")]) === JSON.stringify({ target: "es", reason: "no-english" }), sw([U("No, speak English")]));
  ck("EN from us + 'Não falo inglês' → pt / no-english", sw([U("hi"), EN_BOT, U("Não falo inglês")]) === JSON.stringify({ target: "pt", reason: "no-english" }), sw([U("hi"), EN_BOT, U("Não falo inglês")]));
  ck("EN from us + 'en español por favor' → es / request", sw([U("hi"), EN_BOT, U("en español por favor")]) === JSON.stringify({ target: "es", reason: "request" }), sw([U("hi"), EN_BOT, U("en español por favor")]));
  ck("'ok thanks' → null", languageSwitchRequest([U("hi"), EN_BOT, U("ok thanks")]) === null);
  ck("'do you have Spanish tile?' → null", languageSwitchRequest([U("hi"), EN_BOT, U("do you have Spanish tile?")]) === null);
  ck("'Me envi seu WhatsApp aí eu te chamo' → null (not a language statement)", languageSwitchRequest(STELA) === null);
  ck("burst: 'No' + 'speak English' (two bubbles) after EN → es", sw([U("hi"), EN_BOT, U("No"), U("speak English")]) === JSON.stringify({ target: "es", reason: "no-english" }), sw([U("hi"), EN_BOT, U("No"), U("speak English")]));

  console.log("\n[1c] DETERMINISTIC — enforceLanguageSwitch / fallback / note");
  const toEs = { target: "es" as const, reason: "no-english" as const };
  const snark = "Already in English! We move all the furniture, install the floors, add the quarter round, and clean up before we leave. Which flooring are you thinking about, tile, vinyl, or hardwood?";
  ck("'Already in English!' reply → replaced by the ES language-confirming opener", enforceLanguageSwitch(LETICIA, snark, toEs) === OPENER_LANG_ES, enforceLanguageSwitch(LETICIA, snark, toEs));
  const plainEn = "We move all the furniture and install the floors. Which flooring are you thinking about, tile, vinyl, or hardwood?";
  ck("plain English reply with target es → replaced", enforceLanguageSwitch(LETICIA, plainEn, toEs) === OPENER_LANG_ES, enforceLanguageSwitch(LETICIA, plainEn, toEs));
  const goodEs = "Claro, con gusto te atiendo en español. Movemos los muebles, instalamos el piso, colocamos el quarter round y dejamos todo limpio, cual te interesa, tile, vinil o hardwood?";
  ck("Spanish reply with target es → untouched", enforceLanguageSwitch(LETICIA, goodEs, toEs) === goodEs);
  const goodEsNoAccents = "Claro, con gusto te atiendo en espanol. Movemos los muebles, instalamos el piso y dejamos todo limpio, cual te interesa, tile, vinil o hardwood?";
  ck("Spanish reply WITHOUT accents with target es → untouched", enforceLanguageSwitch(LETICIA, goodEsNoAccents, toEs) === goodEsNoAccents);
  const toEn = { target: "en" as const, reason: "request" as const };
  ck("Spanish reply with target en → replaced by the EN language opener", enforceLanguageSwitch([U("hola"), ES_BOT, U("No, speak English")], "Claro, con gusto te atiendo en español, cual te interesa?", toEn) === OPENER_LANG_EN);
  ck("English reply with target en → untouched", enforceLanguageSwitch([U("hola"), ES_BOT, U("No, speak English")], "Of course, English works. We move all the furniture and install the floors, which flooring are you thinking about?", toEn).startsWith("Of course, English works. We move"));
  ck("[REACT_ONLY] / [BOOK] never touched", enforceLanguageSwitch(LETICIA, "[REACT_ONLY]", toEs) === "[REACT_ONLY]" && enforceLanguageSwitch(LETICIA, "Perfect, see you then! [BOOK:{\"x\":1}]", toEs).includes("[BOOK:"));
  const typeKnown: ChatMessage[] = [U("I need vinyl for 1500 sqft"), A("Our vinyl promo is $5 per sqft, I have tomorrow at 9am or 11am, which works better?"), U("no english")];
  const fb = languageSwitchFallback(typeKnown, toEs);
  ck("fallback with the type already known does not re-ask the type", !/tile y hardwood/.test(fb) && /español/.test(fb), fb);
  for (const t of ["es", "pt", "en"] as const) {
    const f = languageSwitchFallback(LETICIA, { target: t, reason: "no-english" });
    ck(`fallback ${t}: no ¿ ¡ / dash / emoji`, !/[¿¡—–]/.test(f) && !/[\u{1F300}-\u{1FAFF}]/u.test(f), f);
    const n = languageSwitchNote({ target: t, reason: t === "en" ? "request" : "no-english" });
    ck(`note ${t}: forbids "Already in English" and restates the previous question`, /Already in English/.test(n) && /restate/i.test(n) && /tile, vinyl or hardwood/.test(n), n.slice(0, 120));
  }

  console.log("\n[1d] DETERMINISTIC — WhatsApp / number request on first contact (Stela)");
  const stelaTxt = "Me envi seu WhatsApp aí eu te chamo";
  ck("Stela: firstMessageNeedsReading", firstMessageNeedsReading(stelaTxt + AD));
  ck("Stela: asksForOurContact", asksForOurContact(stelaTxt));
  ck("Stela: openerLang = pt", openerLang(stelaTxt) === "pt", openerLang(stelaTxt));
  ck("Stela: detectLang = pt", detectLang(stelaTxt) === "pt", detectLang(stelaTxt));
  const contactAsks = ["Manda seu whatsapp", "Pasame tu whatsapp", "Send me your whatsapp", "Cual es tu whatsapp", "Tienen whatsapp?", "Qual o seu número?", "Me passa seu número", "Can I call you?", "What's your number", "Yo te llamo, cual es tu numero?", "Do you have WhatsApp?", "Prefiero por whatsapp", "seu contato por favor", "Me da tu telefono"];
  for (const p of contactAsks) ck(`asks for our contact + needs reading: "${p}"`, asksForOurContact(p) && firstMessageNeedsReading(p + AD), `${asksForOurContact(p)} / ${firstMessageNeedsReading(p + AD)}`);
  for (const p of ["My whatsapp is 305 555 1234", "786-619-7511 call me", "Mi numero es 7865396038"]) ck(`gives own number, NOT a request for ours: "${p}"`, !asksForOurContact(p), String(asksForOurContact(p)));
  for (const p of ["Hi", "How much per sqft?", "I need vinyl for my living room", "What is the installation process?", "Hola, quiero un estimado para 800 pies", "Where are you located?", "Do you offer any discounts for larger spaces?"]) ck(`NOT a contact request / still canned-eligible: "${p}"`, !asksForOurContact(p) && !firstMessageNeedsReading(p), `${asksForOurContact(p)} / ${firstMessageNeedsReading(p)}`);
  for (const [p, want] of [["Me passa seu número", "pt"], ["Eu quero orçamento pra sala", "pt"], ["Tá bom, me manda o preço", "pt"], ["Cuanto cuesta el piso?", "es"], ["How much for 500 sqft?", "en"]] as const) ck(`openerLang("${p}") = ${want}`, openerLang(p) === want, openerLang(p));
  for (const [p, want] of [["Me envia seu WhatsApp ai eu te chamo", "pt"], ["Qual o seu número?", "pt"], ["Cual es tu whatsapp", "en"], ["Hola, cuanto cuesta el piso para mi casa?", "es"]] as const) ck(`detectLang("${p}") = ${want}`, detectLang(p) === want, detectLang(p));
  const noNum = ensureContactNumber(STELA, "Claro! Trabalhamos com vinil de luxo, tile e hardwood, qual te interessa?", "pt");
  ck("reply without the number → PT WhatsApp line prepended, model's 'Claro!' dropped", NUM.test(noNum) && noNum.startsWith("Claro, nosso WhatsApp é o (561) 674-8334") && !/Claro!/.test(noNum) && /qual te interessa\?$/.test(noNum), noNum);
  const hasNum = "Claro, nosso WhatsApp é (561) 674-8334. Qual piso te interessa?";
  ck("reply already carrying the number → untouched", ensureContactNumber(STELA, hasNum, "pt") === hasNum);
  ck("no contact request → untouched", ensureContactNumber([U("Hi, how much per sqft?")], "It depends on the floor type, which one?", "en") === "It depends on the floor type, which one?");
  for (const t of ["es", "pt", "en"] as const) ck(`contactNumberLine ${t}: number, no ¿ ¡ / dash`, NUM.test(contactNumberLine(t)) && !/[¿¡—–]/.test(contactNumberLine(t)), contactNumberLine(t));
  ck("WhatsApp-channel style 'my number' burst never triggers", !asksForOurContact("Perfect, 33131. My number is 305 555 1234"));

  console.log("\n[1e] STATIC — wiring in the three files + Dreaming constraints");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const spSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  const drSrc = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("getAIResponse computes langSwitch before the hardcoded intercepts and skips them on a switch", /const langSwitch = languageSwitchRequest\(messages\);/.test(aiSrc) && /const hardcoded = langSwitch \? null : checkHardcodedResponse\(messages\);/.test(aiSrc));
  ck("getAIResponse injects languageSwitchNote and enforces the language after the model", /languageSwitchNote\(langSwitch\)/.test(aiSrc) && /enforceLanguageSwitch\(messages, cleaned, langSwitch\)/.test(aiSrc));
  ck("getAIResponse guarantees the number on a contact request", /ensureContactNumber\(messages, cleaned, usersLang\(\)\)/.test(aiSrc));
  ck("referral replies use the switch target (usersLang)", (aiSrc.match(/usersLang\(\)/g) || []).length >= 8);
  ck("firstMessageNeedsReading consults asksForOurContact", /asksForOurContact\(t\)\s*\n\s*\);/.test(aiSrc.replace(/\r\n/g, "\n")));
  ck("FINAL REMINDERS rule 11 covers WhatsApp in the client's language", /11\. If the client asks for a phone number, our WhatsApp or a contact/.test(aiSrc));
  ck("SYSTEM_PROMPT LANGUAGE rule: broken-English 'no English' = does not speak English, never 'Already in English'", /BROKEN-ENGLISH "NO ENGLISH"/.test(spSrc) && /NEVER reply "Already in English"/.test(spSrc));
  ck("SYSTEM_PROMPT OWNER CONTACT covers 'me envia seu WhatsApp'", /OWNER CONTACT: If the client asks for a phone number, our WhatsApp/.test(spSrc));
  ck("AD_REPLY_NOTE: WhatsApp/number request → the number FIRST, then the type", /give \(561\) 674-8334 FIRST, in their language, and ask the type after it/.test(spSrc));
  ck("Dreaming hard constraint 9 (no speak English) and 10 (WhatsApp request)", /9\. "NO SPEAK ENGLISH" MEANS THE CLIENT DOES NOT SPEAK ENGLISH/.test(drSrc) && /10\. A REQUEST FOR OUR WHATSAPP OR PHONE NUMBER/.test(drSrc));

  if (process.env.DET_ONLY === "1") return done();

  console.log("\n[2] LIVE — Stela's real turn ×2: Portuguese, the number, no canned opener");
  for (let i = 1; i <= 2; i++) {
    const r = await ai(STELA);
    const t = r.text;
    ck(`Stela #${i}: not a canned opener, model was called`, !ALL_CANNED.includes(t) && r.inputTokens > 0, t);
    ck(`Stela #${i}: carries (561) 674-8334`, NUM.test(t), t);
    ck(`Stela #${i}: Portuguese (not Spanish, not English)`, PT_MARK.test(t) && !ES_ONLY.test(t) && !looksEnglish(t), t);
    ck(`Stela #${i}: no ¿ ¡ / dash / emoji`, !/[¿¡—–]/.test(t) && !/[\u{1F300}-\u{1FAFF}]/u.test(t), t);
  }

  console.log("\n[2b] LIVE — Leticia's real turn ×2: Spanish, never 'Already in English'");
  for (let i = 1; i <= 2; i++) {
    const r = await ai(LETICIA);
    const t = r.text;
    ck(`Leticia #${i}: no 'Already in English' / no comment on her English`, !SNARK.test(t) && !/your english/i.test(t), t);
    ck(`Leticia #${i}: reply in Spanish`, ES_MARK.test(t) && !looksEnglish(t), t);
    ck(`Leticia #${i}: keeps the thread (asks the type or restates the process) in Spanish`, /\b(?:tile|vinil|vinyl|hardwood|muebles|instalamos|piso)\b/i.test(t), t);
    ck(`Leticia #${i}: no ¿ ¡ / dash`, !/[¿¡—–]/.test(t), t);
  }

  console.log("\n[2c] LIVE — variants");
  {
    const r = await ai([U("Cual es tu whatsapp" + AD_SYS)]);
    ck("'Cual es tu whatsapp' + ad → Spanish + number, not canned", NUM.test(r.text) && ES_MARK.test(r.text) && !looksEnglish(r.text) && !ALL_CANNED.includes(r.text), r.text);
  }
  {
    const r = await ai([U("Send me your WhatsApp" + AD_SYS)]);
    ck("'Send me your WhatsApp' + ad → English + number, not canned", NUM.test(r.text) && !ALL_CANNED.includes(r.text) && !/[ñãõç]/.test(r.text), r.text);
  }
  {
    const r = await ai([U("hola"), ES_BOT, U("No, speak English" + AD_SYS)]);
    ck("ES from us + 'No, speak English' → English reply (they want English)", !/[ñ¿¡]/.test(r.text) && !ES_ONLY.test(r.text) && /\b(?:english|tile|vinyl|hardwood|furniture|floors?)\b/i.test(r.text), r.text);
  }
  {
    const r = await ai([U("hola"), ES_BOT, U("I don't speak Spanish" + AD_SYS)]);
    ck("ES from us + 'I don't speak Spanish' → English reply", !/[ñ¿¡]/.test(r.text) && !ES_ONLY.test(r.text), r.text);
  }
  {
    const r = await ai([U("hi"), EN_BOT, U("Não falo inglês" + AD_SYS)]);
    ck("EN from us + 'Não falo inglês' → Portuguese reply", PT_MARK.test(r.text) && !looksEnglish(r.text) && !ES_ONLY.test(r.text), r.text);
  }
  {
    const r = await ai([U("hi"), EN_BOT, U("no english" + AD_SYS)]);
    ck("EN from us + 'no english' → Spanish reply, no snark", ES_MARK.test(r.text) && !looksEnglish(r.text) && !SNARK.test(r.text), r.text);
  }

  console.log("\n[2d] LIVE — first contact: deterministic language openers + regressions");
  for (const [q, want, label] of [
    ["No, speak English", OPENER_LANG_ES, "ES language opener"], ["No english", OPENER_LANG_ES, "ES language opener"], ["No speak English", OPENER_LANG_ES, "ES language opener"],
    ["In English please", OPENER_LANG_EN, "EN language opener"], ["Hablas español", OPENER_LANG_ES, "ES language opener"],
    ["Hi", OPENER_EN, "plain EN opener"], ["Hola", OPENER_ES, "plain ES opener"], ["How much per sqft?", OPENER_EN, "plain EN opener"],
    ["What is the installation process?", OPENER_PROCESS_EN, "process opener"],
  ] as const) {
    const r = await ai([U(q + AD)]);
    ck(`"${q}" + ad → ${label} (deterministic)`, r.text === want && r.inputTokens === 0, r.text);
  }
  {
    // "Do you speak Spanish?" carries a "?" so questionBeyondOpener sends it to
    // the model (pre-existing routing): the reply must simply be in Spanish.
    const r = await ai([U("Do you speak Spanish?" + AD)]);
    ck("'Do you speak Spanish?' + ad → Spanish reply (canned or model), never English", (r.text === OPENER_LANG_ES) || (ES_MARK.test(r.text) && !looksEnglish(r.text)), r.text);
  }
  {
    const r = await ai([U("Hi, how much for 500 sqft?" + AD)]);
    ck("'Hi, how much for 500 sqft?' + ad → model (large lead), English", r.inputTokens > 0 && !ALL_CANNED.includes(r.text) && !NUM.test(r.text), r.text);
  }
  done();
}

function done() {
  console.log(`\n=========== LANG-MISREAD-WHATSAPP-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
