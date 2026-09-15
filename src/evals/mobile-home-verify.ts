// Verifies the TRAILER / MOBILE HOME policy (owner rule 2026-09-15): we do NOT
// do any work in trailers, mobile homes, manufactured homes, RVs or campers,
// of any size and with any floor type. Never a price, never a visit or slot
// offer, never a booking-details ask, never [BOOK]. The client gets a polite
// decline in their language; a client who says it is NOT a trailer / mobile
// home is a normal lead again; our own "mobile showroom" never counts.
//  1. DETERMINISTIC (no API): isMobileHomeRequest (cues EN / ES / PT, the
//     exclusions: mobile showroom, negation, photo-analysis bubble, bot text),
//     mobileHomeStanding (stands until the client says it is not one),
//     mobileHomeLeak, the canned decline (EN / ES / PT: no ¿ ¡, no dash, no
//     visit words, never flags itself), the CRITICAL note, source wiring of
//     the three webhooks + brain + prompt.
//  2. LIVE MODEL: EN / ES / PT first messages, mid-conversation reveal after a
//     slot offer, booking details while standing → no [BOOK], regressions:
//     "mobile showroom?" is answered normally, "a house, not a mobile home"
//     stays a lead.
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isMobileHomeRequest, mobileHomeStanding, mobileHomeLeak, MOBILE_HOME_NOTE, type ChatMessage } from "../lib/ai";
import { mobileHomeDeclineMessage } from "../lib/scheduler";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 240)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

const VISIT_WORDS = /free\s+(?:visit|estimate)|come\s+(?:by|out|over)|in\s+person|which\s+(?:works|one|time)|what\s+time|visita|presencial|pessoalmente|cu[aá]l\s+te\s+queda|qual\s+funciona/i;
const DETAILS_ASK = /\b(?:name|address|phone|nombre|direcci[oó]n|tel[eé]fono|nome|endere[çc]o|telefone)\b.*\?/i;
const DECLINE_WORDS = /trailer|mobile\s+home|casas?\s+m[oó]vil|casa\s+m[oó]vel|mobile\s+homes/i;

async function main() {
  console.log("\n[1] DETERMINISTIC — detector, standing flag, leak, canned lines, wiring");
  // cues
  for (const s of [
    "It's a mobile home, about 1200 sqft", "I have a manufactured home in Homestead", "double wide, 3 bedrooms",
    "Es una casa móvil de 900 pies", "es una casa movil", "Vivo en un trailer park", "É um trailer, uns 800 sq ft",
    "casa rodante", "mi traila", "I live in an RV", "It's a single-wide trailer",
  ]) ck(`cue: ${JSON.stringify(s)}`, isMobileHomeRequest(s), s);
  // exclusions
  for (const s of [
    "Do you have a mobile showroom?", "Do you have a showroom I can visit? mobile showroom is fine", "1200 sqft house in Miami",
    "It's not a mobile home, it's a house", "No es una casa móvil, es un apartamento", "Não é trailer, é casa mesmo",
    "[Floor plan analysis: This is a photo of a mobile home floor with old vinyl. Floor type: vinyl]",
    "[Client replied to our ad]", "How much for 1500 sqft vinyl?",
  ]) ck(`not a cue: ${JSON.stringify(s.slice(0, 60))}`, !isMobileHomeRequest(s), s);
  // standing
  const h1 = [U("Hi, I have a mobile home in Homestead"), A("We work with vinyl, tile and hardwood, which one?"), U("Vinyl, about 1200 sqft"), A("Unfortunately we don't do installations in trailers or mobile homes, so this one we can't take on."), U("Come on, just take a look. John Smith, 123 Main St Homestead 33030, 305-555-1212, tomorrow 11am")];
  ck("standing: mention 4 bubbles earlier still stands at the details turn", mobileHomeStanding(h1));
  ck("standing: bot text alone never counts", !mobileHomeStanding([A("Is it a mobile home or a house?"), U("A house")]));
  ck("standing: negation clears it", !mobileHomeStanding([U("I have a mobile home"), A("..."), U("Actually it's not a mobile home, it's a regular house")]));
  ck("standing: photo-analysis bubble never counts", !mobileHomeStanding([U("[Floor plan analysis: exterior of a trailer home. Floor type: unknown]"), A("..."), U("1200 sqft vinyl")]));
  ck("standing: 'mobile showroom' question never counts", !mobileHomeStanding([U("Do you have a mobile showroom?"), A("Yes, we have a mobile showroom."), U("Great, 1500 sqft vinyl")]));
  // leak
  const std = [U("I have a mobile home, 1200 sqft, want vinyl")];
  ck("leak: [BOOK] while standing", mobileHomeLeak(std, "Perfect! [BOOK:{\"date\":\"2026-09-16\",\"time\":\"11:00\"}]"));
  ck("leak: slot offer while standing", mobileHomeLeak(std, "I have Tuesday at 9am or 11am, which works better for you?"));
  ck("leak: price while standing", mobileHomeLeak(std, "Our vinyl is $5 per sqft with everything included."));
  ck("leak: booking-details ask while standing", mobileHomeLeak(std, "Can I get your name, the property address, and the best phone number?"));
  ck("leak: visit offer while standing", mobileHomeLeak(std, "For that size I need to come by and measure in person, the visit is free."));
  ck("no leak: [BOOK] when not standing", !mobileHomeLeak([U("1500 sqft house, vinyl")], "Perfect! [BOOK:{}]"));
  for (const lang of ["en", "es", "pt"] as const) {
    const line = mobileHomeDeclineMessage(lang);
    ck(`decline ${lang}: never flags itself as a leak`, !mobileHomeLeak(std, line), line);
    ck(`decline ${lang}: no ¿ ¡ and no dash`, !/[¿¡—–]/.test(line), line);
    ck(`decline ${lang}: names trailer / mobile home`, DECLINE_WORDS.test(line), line);
    ck(`decline ${lang}: no visit / details words`, !VISIT_WORDS.test(line) && !DETAILS_ASK.test(line), line);
  }
  ck("note: forbids [BOOK], price and visit", /NEVER generate \[BOOK/.test(MOBILE_HOME_NOTE) && /NEVER quote a price/.test(MOBILE_HOME_NOTE) && /NEVER offer time slots/.test(MOBILE_HOME_NOTE));
  // wiring
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
  for (const [tag, p] of [["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"], ["IG", "src/app/api/webhook/route.ts"]] as const) {
    const s = src(p);
    ck(`wiring ${tag}: [BOOK] blocked while standing`, /if \(mobileHomeStanding\(history\)\) \{[\s\S]{0,300}mobileHomeDeclineMessage\(lang\)/.test(s));
    ck(`wiring ${tag}: post-model leak backstop`, /mobileHomeLeak\(history, safe(?:Response|AiText)\)/.test(s));
    ck(`wiring ${tag}: imports`, /mobileHomeStanding, mobileHomeLeak/.test(s) && /mobileHomeDeclineMessage/.test(s));
  }
  const aiSrc = src("src/lib/ai.ts");
  ck("wiring brain: CRITICAL note injected while standing", /if \(mobileHomeStanding\(messages\)\) \{[\s\S]{0,200}MOBILE_HOME_NOTE/.test(aiSrc));
  ck("wiring brain: post-model leak backstop", /if \(mobileHomeLeak\(messages, cleaned\)\)/.test(aiSrc));
  ck("wiring brain: canned openers skipped on a first-message trailer", /mobileHomeFirstMessage = isMobileHomeRequest\(burst\)/.test(aiSrc) && /!mobileHomeFirstMessage &&/.test(aiSrc));
  ck("wiring prompt: section present", /## TRAILERS AND MOBILE HOMES/.test(src("src/lib/system-prompt.ts")));

  if (process.env.DET_ONLY) { done(); return; }

  console.log("\n[2] LIVE MODEL — declines, no visit, no price, no [BOOK]");
  const isDecline = (r: string) => DECLINE_WORDS.test(r) && !/\$\s?\d/.test(r) && !/\[BOOK:/i.test(r) && !VISIT_WORDS.test(r) && !DETAILS_ASK.test(r);
  {
    const r = await ai([U("Hi, I have a mobile home in Homestead, about 1100 sqft, how much for vinyl?")]);
    ck("EN first message: decline, no price, no visit", isDecline(r), r);
  }
  {
    const r = await ai([U("Hola, tengo una casa móvil de 900 pies, cuánto sale el vinyl?")]);
    ck("ES first message: decline in Spanish, no ¿ ¡", isDecline(r) && !/[¿¡]/.test(r), r);
  }
  {
    const r = await ai([U("Oi, moro num trailer, uns 800 sq ft, vocês instalam vinil?")]);
    ck("PT first message: decline", isDecline(r), r);
  }
  {
    const r = await ai([
      U("How much for 1500 sqft vinyl?"),
      A("Our vinyl promo is $5 per sqft and it includes the flooring, the installation and the quarter round. For 1,500 sqft I need to come measure in person, the visit is free. What's the zip code of the property?"),
      U("33030"),
      A("33030 is covered! I have tomorrow at 9am or 11am, which works better for you?"),
      U("11am works. It's a mobile home by the way, is that ok?"),
    ]);
    ck("mid-conversation reveal after a slot offer: decline, no details ask, no [BOOK]", isDecline(r), r);
  }
  {
    const r = await ai(h1);
    ck("booking details while standing: no [BOOK], still the decline", !/\[BOOK:/i.test(r) && DECLINE_WORDS.test(r), r);
  }
  {
    const r = await ai([U("Do you have a showroom? Or a mobile showroom I can see samples in?")]);
    ck("regression: 'mobile showroom' is answered normally (no trailer decline)", !/trailer|can't take/i.test(r) && /showroom/i.test(r), r);
  }
  {
    const r = await ai([U("It's a house, not a mobile home. 1500 sqft, vinyl over tile, how much?")]);
    ck("regression: 'a house, not a mobile home' stays a lead (no decline)", !/trailer|can't take|mobile homes/i.test(r), r);
  }
  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
