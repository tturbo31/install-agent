// Verifies the MOBILE HOME / TRAILER policy (owner rules 2026-09-15 and
// 2026-10-31). 2026-10-31: "we DO install in mobile homes, the client calls
// Ozzi directly at (561) 674-8334; we only do mobile homes, not trailers".
//   - mobile home / manufactured home / double or single wide / casa móvil:
//     YES we do it, Ozzi's number, never a price, a visit, a slot, a details
//     ask or a [BOOK], and NEVER "we don't do mobile homes".
//   - trailer / RV / camper / casa rodante / traila: the polite decline.
// A bubble naming both is a mobile home. A client who says it is NOT one is a
// normal lead again; our own "mobile showroom" never counts.
//  1. DETERMINISTIC (no API): mobileHomeKind / isMobileHomeRequest (cues EN /
//     ES / PT, the exclusions: mobile showroom, negation, photo-analysis
//     bubble, bot text), mobileHomeStanding, mobileHomeLeak per kind, the
//     canned lines (EN / ES / PT: no ¿ ¡, no dash, no visit words, never flag
//     themselves), the CRITICAL notes, source wiring of the three webhooks +
//     brain + prompt.
//  2. LIVE MODEL: EN / ES / PT first messages for both kinds, mid-conversation
//     reveal after a slot offer, booking details while standing → no [BOOK],
//     insisting on a price, regressions: "mobile showroom?" is answered
//     normally, "a house, not a mobile home" stays a lead.
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isMobileHomeRequest, mobileHomeKind, mobileHomeStanding, mobileHomeLeak, mobileHomeReply, mobileHomeNote, TRAILER_NOTE, smallJobStanding, type ChatMessage } from "../lib/ai";
import { trailerDeclineMessage, mobileHomeOzziDirectMessage, mobileHomeOzziInsistMessage } from "../lib/scheduler";

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
const TRAILER_WORDS = /trailers?|traila|casa\s+rodante/i;
const OZZI_NUMBER = /\(?\s*561\s*\)?[\s.-]*674[\s.-]*8334/;
// "we don't do mobile homes" in any of the three languages.
const MOBILE_DECLINE = /(?:don'?t|do\s+not|can'?t|cannot|won'?t)\s+(?:do|work|install|take)\b[^.!?\n]{0,60}mobile\s*homes?|no\s+(?:hacemos|trabajamos|instalamos)\b[^.!?\n]{0,60}casas?\s+m[oó]vil|n[aã]o\s+(?:fazemos|trabalhamos|instalamos)\b[^.!?\n]{0,60}(?:mobile\s*homes?|casas?\s+m[oó]ve)|can'?t\s+take\s+on/i;

async function main() {
  console.log("\n[1] DETERMINISTIC — detector, kind, leak, canned lines, wiring");
  // mobile home cues
  for (const s of [
    "It's a mobile home, about 1200 sqft", "I have a manufactured home in Homestead", "double wide, 3 bedrooms",
    "Es una casa móvil de 900 pies", "es una casa movil", "É uma casa móvel", "It's a single-wide trailer",
    "mobile home in a trailer park", "do you guys do mobile homes?", "It's not a trailer, it's a mobile home",
  ]) ck(`mobile cue: ${JSON.stringify(s)}`, isMobileHomeRequest(s) && mobileHomeKind([U(s)]) === "mobile", s);
  // trailer cues
  for (const s of [
    "Vivo en un trailer park", "É um trailer, uns 800 sq ft", "casa rodante", "mi traila", "I live in an RV",
    "It's a travel trailer", "we have a camper", "trailer home, 600 sqft",
  ]) ck(`trailer cue: ${JSON.stringify(s)}`, isMobileHomeRequest(s) && mobileHomeKind([U(s)]) === "trailer", s);
  // exclusions
  for (const s of [
    "Do you have a mobile showroom?", "Do you have a showroom I can visit? mobile showroom is fine", "1200 sqft house in Miami",
    "It's not a mobile home, it's a house", "No es una casa móvil, es un apartamento", "Não é trailer, é casa mesmo",
    "[Floor plan analysis: This is a photo of a mobile home floor with old vinyl. Floor type: vinyl]",
    "[Client replied to our ad]", "How much for 1500 sqft vinyl?",
  ]) ck(`not a cue: ${JSON.stringify(s.slice(0, 60))}`, !isMobileHomeRequest(s) && mobileHomeKind([U(s)]) === null, s);
  // standing / kind across the conversation
  const h1 = [U("Hi, I have a mobile home in Homestead"), A("We work with vinyl, tile and hardwood, which one?"), U("Vinyl, about 1200 sqft"), A("Yes, we do mobile homes! Mobile home quotes and appointments are handled by Ozzi directly. You can reach him at (561) 674-8334."), U("Come on, just set it up here. John Smith, 123 Main St Homestead 33030, 305-555-1212, tomorrow 11am")];
  ck("kind: mobile home 4 bubbles earlier still stands at the details turn", mobileHomeKind(h1) === "mobile" && mobileHomeStanding(h1));
  ck("kind: bot text alone never counts", !mobileHomeStanding([A("Is it a mobile home or a house?"), U("A house")]));
  ck("kind: negation clears it", !mobileHomeStanding([U("I have a mobile home"), A("..."), U("Actually it's not a mobile home, it's a regular house")]));
  ck("kind: trailer then 'sorry, it's a mobile home' → mobile", mobileHomeKind([U("I have a trailer"), A("..."), U("sorry, I mean a mobile home, double wide")]) === "mobile");
  ck("kind: mobile home then 'it's actually an RV' → trailer", mobileHomeKind([U("mobile home"), A("..."), U("well it's actually an RV")]) === "trailer");
  ck("kind: photo-analysis bubble never counts", !mobileHomeStanding([U("[Floor plan analysis: exterior of a trailer home. Floor type: unknown]"), A("..."), U("1200 sqft vinyl")]));
  ck("kind: 'mobile showroom' question never counts", !mobileHomeStanding([U("Do you have a mobile showroom?"), A("Yes, we have a mobile showroom."), U("Great, 1500 sqft vinyl")]));
  // leak, both kinds
  const mob = [U("I have a mobile home, 1200 sqft, want vinyl")];
  const trl = [U("I live in a trailer, 600 sqft, want vinyl")];
  for (const [k, h] of [["mobile", mob], ["trailer", trl]] as const) {
    ck(`leak ${k}: [BOOK]`, mobileHomeLeak(h, "Perfect! [BOOK:{\"date\":\"2026-09-16\",\"time\":\"11:00\"}]"));
    ck(`leak ${k}: slot offer`, mobileHomeLeak(h, "I have Tuesday at 9am or 11am, which works better for you?"));
    ck(`leak ${k}: price`, mobileHomeLeak(h, "Our vinyl is $5 per sqft with everything included. You can reach Ozzi at (561) 674-8334."));
    ck(`leak ${k}: booking-details ask`, mobileHomeLeak(h, "Can I get your name, the property address, and the best phone number?"));
    ck(`leak ${k}: visit offer`, mobileHomeLeak(h, "For that size I need to come by and measure in person, the visit is free."));
  }
  ck("leak mobile: 'we don't do mobile homes' is a leak", mobileHomeLeak(mob, "Unfortunately we don't do installations in trailers or mobile homes, so this one we can't take on."));
  ck("leak mobile: first reply without Ozzi's number is a leak", mobileHomeLeak(mob, "Yes, we work on mobile homes! Vinyl is a great choice for them."));
  ck("no leak mobile: yes + Ozzi's number", !mobileHomeLeak(mob, "Yes, we do mobile homes! Ozzi handles those directly, you can reach him at (561) 674-8334."));
  ck("no leak mobile: number already sent, short follow-up without it", !mobileHomeLeak([...mob, A(mobileHomeOzziDirectMessage("en")), U("is the vinyl waterproof?")], "Yes, it's 100% waterproof!"));
  ck("no leak trailer: plain decline", !mobileHomeLeak(trl, "Unfortunately we don't do installations in trailers, so this one we can't take on."));
  ck("no leak: [BOOK] when not standing", !mobileHomeLeak([U("1500 sqft house, vinyl")], "Perfect! [BOOK:{}]"));
  ck("trailer under 400 sqft: the under-400 Ozzi flow steps aside (decline owns it)", smallJobStanding([U("I live in a travel trailer, about 300 sqft")]) === null && smallJobStanding([U("about 300 sqft, vinyl")]) === 300);
  // the deterministic reply per kind
  ck("reply trailer → decline", mobileHomeReply(trl, "en") === trailerDeclineMessage("en"));
  ck("reply mobile → Ozzi direct", mobileHomeReply(mob, "en") === mobileHomeOzziDirectMessage("en"));
  ck("reply mobile, number already sent → insist", mobileHomeReply([...mob, A(mobileHomeOzziDirectMessage("en")), U("just give me a rough price")], "en") === mobileHomeOzziInsistMessage("en"));
  for (const lang of ["en", "es", "pt"] as const) {
    const t = trailerDeclineMessage(lang);
    ck(`trailer decline ${lang}: never flags itself`, !mobileHomeLeak(trl, t), t);
    ck(`trailer decline ${lang}: names trailer, never mobile home`, TRAILER_WORDS.test(t) && !/mobile\s*home|casas?\s+m[oó]v/i.test(t), t);
    for (const [name, line] of [["ozzi direct", mobileHomeOzziDirectMessage(lang)], ["ozzi insist", mobileHomeOzziInsistMessage(lang)]] as const) {
      ck(`${name} ${lang}: never flags itself`, !mobileHomeLeak(mob, line), line);
      ck(`${name} ${lang}: carries Ozzi's number`, OZZI_NUMBER.test(line), line);
      ck(`${name} ${lang}: never says we don't do mobile homes`, !MOBILE_DECLINE.test(line), line);
      ck(`${name} ${lang}: no "?"`, !line.includes("?"), line);
    }
    for (const line of [t, mobileHomeOzziDirectMessage(lang), mobileHomeOzziInsistMessage(lang)]) {
      ck(`${lang}: no ¿ ¡ and no dash`, !/[¿¡—–]/.test(line), line);
      ck(`${lang}: no visit / details words`, !VISIT_WORDS.test(line) && !DETAILS_ASK.test(line), line);
    }
  }
  const mn = mobileHomeNote(false);
  ck("note mobile: yes + Ozzi's number, forbids [BOOK], price, slots and the decline", /YES we do mobile homes/.test(mn) && OZZI_NUMBER.test(mn) && /NEVER generate \[BOOK/.test(mn) && /NEVER give a price/.test(mn) && /NEVER offer time slots/.test(mn) && /NEVER say we don't do mobile homes/.test(mn));
  ck("note mobile: 'already gave the number' variant", /ALREADY gave the client Ozzi's number/.test(mobileHomeNote(true)));
  ck("note trailer: forbids [BOOK], price and visit, and says mobile homes are different", /NEVER generate \[BOOK/.test(TRAILER_NOTE) && /NEVER quote a price/.test(TRAILER_NOTE) && /NEVER offer time slots/.test(TRAILER_NOTE) && /MOBILE HOMES ARE DIFFERENT/.test(TRAILER_NOTE));
  // wiring
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
  for (const [tag, p] of [["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"], ["IG", "src/app/api/webhook/route.ts"]] as const) {
    const s = src(p);
    ck(`wiring ${tag}: [BOOK] blocked while standing`, /if \(mobileHomeStanding\(history\)\) \{[\s\S]{0,300}mobileHomeReply\(history, lang\)/.test(s));
    ck(`wiring ${tag}: post-model leak backstop`, /mobileHomeLeak\(history, safe(?:Response|AiText)\)\) \{[\s\S]{0,300}= mobileHomeReply\(history, lang\)/.test(s));
    ck(`wiring ${tag}: imports, no old decline left`, /mobileHomeStanding, mobileHomeLeak, mobileHomeReply, mobileHomeKind/.test(s) && !/mobileHomeDeclineMessage/.test(s));
  }
  const aiSrc = src("src/lib/ai.ts");
  ck("wiring brain: notes injected by kind", /const mhKind = mobileHomeKind\(messages\);[\s\S]{0,200}TRAILER_NOTE[\s\S]{0,300}mobileHomeNote\(smallJobReferralSent\(messages\)\)/.test(aiSrc));
  ck("wiring brain: post-model leak backstop", /if \(mobileHomeLeak\(messages, cleaned\)\) \{[\s\S]{0,400}cleaned = mobileHomeReply\(messages, usersLang\(\)\)/.test(aiSrc));
  ck("wiring brain: Port St. Lucie steps aside", /const mobileHomeOwns = mobileHomeStanding\(messages\);\s+if \(!mobileHomeOwns && portStLucieLeak/.test(aiSrc));
  ck("wiring brain: canned openers skipped on a first-message trailer / mobile home", /mobileHomeFirstMessage = isMobileHomeRequest\(burst\)/.test(aiSrc) && /!mobileHomeFirstMessage &&/.test(aiSrc));
  const prompt = src("src/lib/system-prompt.ts");
  ck("wiring prompt: section present, mobile homes = Ozzi, trailers = no", /## MOBILE HOMES VS TRAILERS/.test(prompt) && /MOBILE HOMES: WE DO THEM, OZZI HANDLES THEM DIRECTLY/.test(prompt) && /TRAILERS: WE DO NOT WORK IN THEM/.test(prompt) && !/## TRAILERS AND MOBILE HOMES/.test(prompt));

  ck("wiring dreaming: constraint 19 (never learn to decline a mobile home)", /19\. MOBILE HOMES YES \(OZZI DIRECT\), TRAILERS NO/.test(src("src/lib/dreaming.ts")));

  if (process.env.DET_ONLY) { done(); return; }

  console.log("\n[2] LIVE MODEL — mobile home = yes + Ozzi's number; trailer = decline; never a visit, price or [BOOK]");
  const clean = (r: string) => !/\$\s?\d/.test(r) && !/\[BOOK:/i.test(r) && !VISIT_WORDS.test(r) && !DETAILS_ASK.test(r);
  const isOzzi = (r: string) => clean(r) && OZZI_NUMBER.test(r) && !MOBILE_DECLINE.test(r);
  const isTrailerDecline = (r: string) => clean(r) && TRAILER_WORDS.test(r) && !OZZI_NUMBER.test(r);
  {
    const r = await ai([U("Hi, I have a mobile home in Homestead, about 1100 sqft, how much for vinyl?")]);
    ck("EN mobile home first message: yes + Ozzi's number, no price, no visit", isOzzi(r), r);
  }
  {
    const r = await ai([U("Hola, tengo una casa móvil de 900 pies, cuánto sale el vinyl?")]);
    ck("ES mobile home first message: Ozzi's number in Spanish, no ¿ ¡", isOzzi(r) && !/[¿¡]/.test(r) && /[áéíóúñ]|ozzi\s+directamente|puede|ll[aá]me/i.test(r), r);
  }
  {
    const r = await ai([U("Oi, eu tenho uma mobile home, uns 800 sq ft, vocês instalam vinil?")]);
    ck("PT mobile home first message: Ozzi's number", isOzzi(r), r);
  }
  {
    const r = await ai([U("do you guys do mobile homes?")]);
    ck("EN 'do you do mobile homes?': yes + Ozzi's number", isOzzi(r), r);
  }
  {
    const r = await ai([U("Hi, I live in a travel trailer, about 300 sqft, can you put vinyl in?")]);
    ck("EN trailer first message: decline, no Ozzi number", isTrailerDecline(r), r);
  }
  {
    const r = await ai([U("Oi, moro num trailer, uns 800 sq ft, vocês instalam vinil?")]);
    ck("PT trailer first message: decline", isTrailerDecline(r), r);
  }
  {
    const r = await ai([
      U("How much for 1500 sqft vinyl?"),
      A("Our vinyl promo is $5 per sqft and it includes the flooring, the installation and the quarter round. For 1,500 sqft I need to come measure in person, the visit is free. What's the zip code of the property?"),
      U("33030"),
      A("33030 is covered! I have tomorrow at 9am or 11am, which works better for you?"),
      U("11am works. It's a mobile home by the way, is that ok?"),
    ]);
    ck("mid-conversation mobile home after a slot offer: Ozzi's number, no details ask, no [BOOK]", isOzzi(r), r);
  }
  {
    const r = await ai(h1);
    ck("booking details while a mobile home stands: no [BOOK], Ozzi's number again", !/\[BOOK:/i.test(r) && OZZI_NUMBER.test(r) && !MOBILE_DECLINE.test(r), r);
  }
  {
    const r = await ai([U("I have a mobile home, 1000 sqft"), A(mobileHomeOzziDirectMessage("en")), U("I don't want to call, just give me a rough price per sqft")]);
    ck("insisting on a price for the mobile home: no price, number repeated", isOzzi(r), r);
  }
  {
    const r = await ai([U("Do you have a showroom? Or a mobile showroom I can see samples in?")]);
    ck("regression: 'mobile showroom' is answered normally (no trailer / mobile home line)", !/trailer|can't take|674/i.test(r) && /showroom/i.test(r), r);
  }
  {
    const r = await ai([U("It's a house, not a mobile home. 1500 sqft, vinyl over tile, how much?")]);
    ck("regression: 'a house, not a mobile home' stays a lead (no decline, no Ozzi line)", !/trailer|can't take|mobile homes|674/i.test(r), r);
  }
  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
