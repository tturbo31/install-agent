// Verifies the BATHROOM → OZZI DIRECT policy (owner rule 2026-09-11, second
// part). Until today a bathroom remodel was "always the free visit". Now a
// bathroom project (remodel / renovation, shower / tub / vanity work, a
// bathroom quote ask, "do you (guys) do bathrooms (too)?") is NEVER quoted and
// NEVER booked through the chat: the bot confirms we do bathrooms and points
// the client to Ozzi directly at (561) 674-8334, for quotes and appointments.
//  1. DETERMINISTIC (no API): bathroomProjectSignal / bathroomProjectStanding
//     (cues EN / ES / PT, the off switches: 400+ sqft, whole house, another
//     room, LARGE PROJECT, a repair), mentionsBathroomProject, bathroomLeak,
//     bathroomReply, the canned lines (no ¿ ¡, no dashes but the phone one, do
//     not flag themselves as leaks), smallJobStanding defers to the bathroom
//     guard, source wiring of the three webhooks + brain + prompt.
//  2. LIVE MODEL: EN / PT / ES remodel questions, "gut and redo", mid-
//     conversation ask, showers, insist → holds the line, booking details while
//     standing → no [BOOK], unrelated question after the line → answered.
//  3. REGRESSIONS: flooring in a bathroom (150 sqft) → the Ozzi line (under-400
//     path, never a visit); a bathroom repair → still declined; 450 sqft tile
//     → still quoted by DM; whole house + bathroom → the visit for the floors
//     and Ozzi's line for the bathroom (never blocked).
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, bathroomProjectSignal, bathroomProjectStanding, mentionsBathroomProject, bathroomLeak, bathroomReply,
  smallJobStanding, smallJobLeak, smallJobReferralSent, containsSchedulingOffer, isAskingForBookingInfo, type ChatMessage,
} from "../lib/ai";
import { bathroomOzziDirectMessage, bathroomOzziInsistMessage, smallJobOzziDirectMessage, OZZI_DIRECT_PHONE } from "../lib/scheduler";
import { OPENER_EN } from "../lib/system-prompt";

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
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

// ── Predicates (EN / PT / ES) ───────────────────────────────────────────────
const OZZI_DIRECT = (t: string) => /\(?\s?561\s?\)?[\s.-]*674[\s.-]*8334/.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const HAS_BOOK = (t: string) => /\[BOOK:/i.test(t);
const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.!?\n]{0,25}\b(?:at\s+)?\d{1,2}\s*(?:am|pm)\b|\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(t);
const ASKS_DETAILS = (t: string) => /\b(?:address|phone|zip|direcci[oó]n|tel[eé]fono|endere[çc]o|telefone|cep|c[oó]digo\s+postal)\b/i.test(t) && /\?/.test(t);
const AFFIRMS = (t: string) =>
  /\b(yes|yeah|yep|absolutely|of course|sure|we do|we can|we handle|we offer|claro|s[ií]m?|com certeza|fazemos|podemos|oferecemos|hacemos)\b/i.test(t);
const DECLINES = (t: string) =>
  /\b(?:don'?t|do not|cannot|can'?t|won'?t)\s+(?:do|offer|handle)\s+(?:bathroom|remodel)|only\s+(?:do|offer|handle)\s+(?:flooring|floors)|too small|larger (?:projects|installations|jobs)|n[aã]o\s+fazemos|no\s+hacemos/i.test(t);
const DECLINES_REPAIR = (t: string) =>
  /installations?\s+only|only\s+(?:do|handle)\s+install|don'?t\s+do\s+(?:any\s+)?repair|do not do (?:any )?repair|only.*install|not something we/i.test(t);
const HOLDS_LINE = (t: string) => /not able|can'?t|cannot|unable|has to (?:come|go)|directly|no puedo|tiene que|directo|n[aã]o consigo|precisa/i.test(t);
const NO_INVERTED = (t: string) => !/[¿¡]/.test(t);
const NO_DASH = (t: string) => !/[—–]| - /.test(t);
const isCannedTypeAsk = (t: string) => /tile/i.test(t) && /vinyl/i.test(t) && /hardwood/i.test(t);

async function main() {
  console.log("\n================ BATHROOM → OZZI DIRECT (owner rule 2026-09-11) ================");

  // ── 1. bathroomProjectSignal: what counts ────────────────────────────────
  console.log("\n[1] bathroomProjectSignal — bathroom projects (true)");
  const positives = [
    "Hi, do you do bathroom remodeling?",
    "Do you guys remodel bathrooms or do you only do floors?",
    "I want to gut and redo my master bathroom completely",
    "Actually, do you also remodel bathrooms?",
    "Do you guys do bathrooms too?",
    "Can you do my bathroom?",
    "do u do bathrooms",
    "I'm looking to renovate the bathroom",
    "We want to update our guest bathroom",
    "bathroom remodel, about 60 sqft",
    "Do you do bathroom remodels? It's a small bathroom, about 60 sqft",
    "What do you charge for showers?",
    "How much for a tub to shower conversion?",
    "Can you tile my shower?",
    "I need a new walk in shower",
    "replace the vanity and the toilet",
    "shower walls and floor",
    "I want a new bathroom",
    "How much for a bathroom?",
    "Can I get a quote for my bathroom",
    "bathroom project, whole thing",
    "Oi, vocês fazem reforma de banheiro?",
    "Quero reformar meu banheiro",
    "Vocês fazem banheiro também?",
    "Preciso trocar o box do banheiro",
    "Hola, hacen remodelación de baño?",
    "quiero remodelar el baño, 50 pies cuadrados",
    "Hacen baños?",
    "Quiero renovar mi cuarto de baño",
    "Cambiar la bañera por una ducha",
    "[Client replied to our ad] do you do bathrooms?",
  ];
  for (const t of positives) ck(`"${t.slice(0, 64)}" → true`, bathroomProjectSignal(t));

  console.log("\n[1b] bathroomProjectSignal — NOT a bathroom project (false)");
  const negatives = [
    "I need vinyl flooring for my bathroom, it's about 150 square feet.",
    "Hi, I need new flooring for my bathroom, it's about 150 square feet.",
    "Do you do bathroom floors?",
    "tile in the bathroom floor",
    "I need tile installation for my bathroom, around 450 sqft",
    "Is this vinyl waterproof for a bathroom?",
    "Can we get away with vinyl in the bathroom?",
    "Does the vinyl work in a bathroom?",
    "I need a quote for my 2 bed 2 bath condo",
    "3 bedroom 2 bath house, about 1500 sqft",
    "900 sqft apartment, living room bedroom kitchen and closet, no bathroom",
    "The apartment is 750 including the bathroom",
    "Hi, interested in new floors",
    "I want luxury vinyl for a 450 sqft room, how much?",
    "Can you fix a few broken tiles in my bathroom?",
    "Tina here, I want to install vinyl in the living room",
    "Hi, can you send me photos of the tile?",
    "I saw your ad, my tiles are cracked and uneven, does the liquid floor go over them?",
    "[Floor plan analysis: Bedroom 3.00x3.00m, Bathroom 1.90x2.80m. Total: ~21sqm (~226sqft). SMALL PROJECT]",
    "What's included in the package?",
    "Is installation labor cost extra?",
  ];
  for (const t of negatives) ck(`"${t.slice(0, 64)}" → false`, !bathroomProjectSignal(t));

  // ── 1c. Standing: off switches ───────────────────────────────────────────
  console.log("\n[1c] bathroomProjectStanding — conversation level");
  const B = [u("Hi, do you do bathroom remodeling?")];
  ck("remodel question → stands", bathroomProjectStanding(B));
  ck("stands across turns (opener, then the ask)", bathroomProjectStanding([u("hi"), a(OPENER_EN), u("Actually, do you also remodel bathrooms?")]));
  ck("stands after our line + 'ok' (no off switch)", bathroomProjectStanding([...B, a(bathroomOzziDirectMessage("en")), u("ok thanks")]));
  ck("stands with a small size (60 sqft)", bathroomProjectStanding([u("Do you do bathroom remodels? It's a small bathroom, about 60 sqft")]));
  ck("OFF: 400+ sqft anywhere ('whole house 1500 sqft and a bathroom remodel')", !bathroomProjectStanding([u("I want vinyl for the whole house, about 1500 sqft, and I also want to remodel the bathroom")]));
  ck("OFF: whole-house signal", !bathroomProjectStanding([u("I want to redo the bathroom and do the whole apartment in vinyl")]));
  ck("OFF: another room named (kitchen)", !bathroomProjectStanding([u("bathroom remodel and new floors in the kitchen")]));
  ck("OFF: another room named earlier in the conversation", !bathroomProjectStanding([u("I need floors for my living room"), a("x"), u("do you guys do bathrooms too?")]));
  ck("OFF: LARGE PROJECT plan", !bathroomProjectStanding([u("do you do bathrooms?"), a("x"), u("[Floor plan analysis: Total: ~60m² (~645sqft). LARGE PROJECT\nFloor type: floor plan]")]));
  ck("OFF: a repair stands (bathroom, then damaged tiles to replace)", !bathroomProjectStanding([u("I want to do my bathroom please"), a("x"), u("These tiles are damaged so we would like to replace them, can you give me a quote")]));
  ck("Kenny: flooring lead (3 bedrooms) + 'do you guys do bathrooms too?' → NOT standing (his floors still book)", !bathroomProjectStanding([
    u("I want vinyl for my apartment, 3 bedrooms"), a("x"), u("Kenny Abbasi\n280 NE 34th St\nOakland Park, FL 33334"), u("561 723 2571"), u("Do you guys do bathrooms too?"),
  ]));
  ck("'cuarto de baño' is the bathroom, not another room", bathroomProjectStanding([u("Quiero renovar mi cuarto de baño")]));
  ck("address with 'unit' / 'apt' does NOT switch it off", bathroomProjectStanding([...B, a("x"), u("John Smith, 123 Main St Unit 5, Apt 2B, Miami FL 33132, 305-555-1234")]));
  ck("[SYSTEM:] note with '1500 sqft' does not switch it off", bathroomProjectStanding([u("do you do bathroom remodels?\n\n[SYSTEM: some note about 1500 sqft and the kitchen]")]));
  ck("mentionsBathroomProject('Do you do bathroom remodeling?') → true", mentionsBathroomProject("Do you do bathroom remodeling?"));
  ck("mentionsBathroomProject('Hi, interested in new floors') → false", !mentionsBathroomProject("Hi, interested in new floors"));

  console.log("\n[1d] smallJobStanding defers to the bathroom guard");
  ck("'bathroom remodel, about 60 sqft' → smallJobStanding null", smallJobStanding([u("bathroom remodel, about 60 sqft")]) === null);
  ck("'do you do bathrooms? 60 sqft' → smallJobStanding null", smallJobStanding([u("do you do bathrooms? it's 60 sqft")]) === null);
  ck("'vinyl for my bathroom, 150 sqft' → smallJobStanding 150 (flooring path)", smallJobStanding([u("I need vinyl flooring for my bathroom, it's about 150 square feet.")]) === 150);
  ck("'What do you charge for showers? 60 sqft' → small job null, bathroom stands", smallJobStanding([u("What do you charge for showers? about 60 sqft")]) === null && bathroomProjectStanding([u("What do you charge for showers? about 60 sqft")]));

  // ── 2. Canned messages ───────────────────────────────────────────────────
  console.log("\n[2] canned messages (EN/ES/PT)");
  for (const lang of ["en", "es", "pt"] as const) {
    const d = bathroomOzziDirectMessage(lang);
    const i = bathroomOzziInsistMessage(lang);
    ck(`${lang}: direct line carries the number`, d.includes(OZZI_DIRECT_PHONE) && OZZI_DIRECT(d), d);
    ck(`${lang}: insist line carries the number`, i.includes(OZZI_DIRECT_PHONE) && OZZI_DIRECT(i), i);
    ck(`${lang}: no price in either`, !HAS_PRICE(d) && !HAS_PRICE(i), d + i);
    ck(`${lang}: no ¿ ¡, no dashes, no '?'`, NO_INVERTED(d + i) && NO_DASH(d + i) && !/\?/.test(d + i), d + i);
    ck(`${lang}: neither reads as a scheduling offer / visit / details ask`, !containsSchedulingOffer(d) && !containsSchedulingOffer(i) && !PROPOSES_VISIT(d) && !PROPOSES_VISIT(i) && !isAskingForBookingInfo(d) && !isAskingForBookingInfo(i), d + i);
    ck(`${lang}: direct line says YES we do bathrooms / insist says it cannot here`, AFFIRMS(d) && !DECLINES(d) && HOLDS_LINE(i), d + i);
    ck(`${lang}: messages do not flag themselves as leaks`, !bathroomLeak(B, d) && !bathroomLeak([...B, a(d), u("just tell me")], i), d + i);
    ck(`${lang}: bathroom wording, not the under-400 line`, /bath|ba[ñn]o|banheiro/i.test(d) && !/400/.test(d), d);
  }

  // ── 3. bathroomLeak / bathroomReply ──────────────────────────────────────
  console.log("\n[3] leak detector + reply chooser");
  ck("referral not sent yet", !smallJobReferralSent(B));
  ck("leak: a price", bathroomLeak(B, "A bathroom remodel usually starts around $8,000."));
  ck("leak: a visit offer", bathroomLeak(B, "Yes, we do bathroom remodels! For a remodel I first need to check the space in person to give you an accurate quote, so let me set up a free visit. What day works best for you?"));
  ck("leak: slots", bathroomLeak(B, "I have Monday at 9am or 11am, which works for you?"));
  ck("leak: booking details ask", bathroomLeak(B, "Perfect, what's the full address with the zip code and the best phone number?"));
  ck("leak: [BOOK]", bathroomLeak(B, 'Perfect, see you then![BOOK:{"name":"A","phone":"3055551234","address":"1 Main St 33132","date":"2026-09-14","time":"09:00","notes":"bathroom remodel"}]'));
  ck("leak: first reply WITHOUT the number", bathroomLeak(B, "Yes, we do bathrooms too! Ozzi handles those personally, let me connect you."));
  ck("no leak: first reply WITH the number", !bathroomLeak(B, "Yes, we do bathrooms too! Bathroom quotes and appointments are handled by Ozzi directly. You can reach him at (561) 674-8334."));
  ck("no leak: number written differently", !bathroomLeak(B, "Ozzi handles bathrooms himself, give him a call at 561-674-8334."));
  const B2 = [...B, a(bathroomOzziDirectMessage("en")), u("Is your vinyl waterproof?")];
  ck("no leak: unrelated answer after the referral, no $", !bathroomLeak(B2, "Yes, our luxury vinyl is 100% waterproof with a 20-year warranty."));
  ck("leak: unrelated answer after the referral WITH a $", bathroomLeak(B2, "Yes, it's waterproof, and at $5 per square foot it includes the labor."));
  ck("not standing (whole house + bathroom): a visit offer is fine", !bathroomLeak([u("Vinyl for the whole house, 1500 sqft, and remodel the bathroom too")], "For that size I do a free in-person visit. What day works best for you?"));
  ck("not standing (repair): the repair decline owns the reply", !bathroomLeak([u("Can you fix a few broken tiles in my bathroom?")], "We don't do repairs, installations only."));
  ck("flooring 150 sqft in a bathroom: the small-job guard owns it (bathroomLeak false, smallJobLeak true)", !bathroomLeak([u("vinyl for my bathroom, 150 sqft")], "That's about $750.") && smallJobLeak([u("vinyl for my bathroom, 150 sqft")], "That's about $750."));
  ck("bathroomReply before referral → direct line", bathroomReply(B, "en") === bathroomOzziDirectMessage("en"));
  ck("bathroomReply after referral → insist line", bathroomReply([...B, a(bathroomOzziDirectMessage("en")), u("just give me a rough number")], "en") === bathroomOzziInsistMessage("en"));
  ck("bathroomReply after the SMALL-JOB referral → insist line too (number already given)", bathroomReply([u("300 sqft vinyl"), a(smallJobOzziDirectMessage("en")), u("and do you do bathrooms?")], "en") === bathroomOzziInsistMessage("en"));
  ck("bathroomReply ES/PT", bathroomReply(B, "es") === bathroomOzziDirectMessage("es") && bathroomReply(B, "pt") === bathroomOzziDirectMessage("pt"));

  // ── 4. Source wiring ─────────────────────────────────────────────────────
  console.log("\n[4] source wiring (3 webhooks, brain, prompt, dreaming)");
  const hooks: Array<[string, string]> = [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ];
  for (const [name, rel] of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: [BOOK] blocked while a bathroom project stands (before the under-400 guard)`, /if \(bathroomProjectStanding\(history\)\)[\s\S]{0,400}bathroomReply\(history, lang\)[\s\S]{0,600}if \(smallJobStanding\(history\) !== null\)/.test(src), rel);
    ck(`${name}: post-model backstop (price / visit / details → bathroom Ozzi line)`, /bathroomLeak\(history, (?:safeAiText|safeResponse)\)[\s\S]{0,300}bathroomReply\(history, lang\)/.test(src), rel);
  }
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  const dr = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("ai.ts: CRITICAL bathroom block injected while it stands", /bathroomNote\(smallJobReferralSent\(messages\)\)/.test(aiSrc));
  ck("ai.ts: backstop inside getAIResponse", /if \(bathroomLeak\(messages, cleaned\)\)[\s\S]{0,300}bathroomReply\(messages/.test(aiSrc));
  ck("ai.ts: first contact with a bathroom project skips the canned opener (2 gates + hardcoded)", (aiSrc.match(/!bathroomFirstMessage/g) ?? []).length === 2 && /!mentionsBathroomProject\(text\)/.test(aiSrc));
  ck("ai.ts: canned FAQ re-answer and hard-coded intercepts skipped while a bathroom stands", /faqReanswer && bathroomProjectStanding\(messages\)/.test(aiSrc) && /hardcoded && bathroomProjectStanding\(messages\)/.test(aiSrc));
  ck("ai.ts: rule 28 is the BATHROOM RULE (OZZI DIRECT)", /28\. BATHROOM RULE \(OZZI DIRECT/.test(aiSrc) && !/propose the FREE in-person visit exactly like a large lead/.test(aiSrc));
  ck("prompt: BATHROOM section is Ozzi direct, with the number", /## BATHROOM REMODELING AND ANY BATHROOM WORK: OZZI DIRECT/.test(sp) && /NEVER generate \[BOOK:\.\.\.\] for a bathroom/.test(sp));
  ck("prompt: old 'remodel = visit' wording gone", !/A bathroom remodel ALWAYS goes to the in-person visit/.test(sp) && !/generating \[BOOK:\.\.\.\] with a brief note like "bathroom remodel"/.test(sp));
  ck("prompt: single-bathroom flooring with no size → Ozzi direct", /FLOORING for a single bathroom and nothing else/.test(sp));
  ck("dreaming: constraint 6 (never recommend a visit for a bathroom project)", /6\. Bathroom remodels/.test(dr));

  if (process.env.DET_ONLY) {
    console.log(`\n================ RESULT (deterministic only): ${pass} passed, ${fail} failed ================`);
    if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
    return;
  }

  // ── 5. LIVE MODEL ────────────────────────────────────────────────────────
  console.log("\n[5] LIVE EN: 'Hi, do you do bathroom remodeling?' → yes + Ozzi's number, no visit, no price");
  const r1 = await ai([u("Hi, do you do bathroom remodeling?")]);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 260));
  ck("gives Ozzi's number", OZZI_DIRECT(r1), r1);
  ck("confirms we do bathrooms (does not decline)", AFFIRMS(r1) && !DECLINES(r1), r1);
  ck("no visit, no slots, no details ask, no [BOOK]", !PROPOSES_VISIT(r1) && !ASKS_DETAILS(r1) && !HAS_BOOK(r1), r1);
  ck("no price", !HAS_PRICE(r1), r1);
  ck("not the canned type-ask opener", !isCannedTypeAsk(r1), r1);

  console.log("\n[5b] LIVE EN: 'Do you guys remodel bathrooms or do you only do floors?'");
  const r2 = await ai([u("Do you guys remodel bathrooms or do you only do floors?")]);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 260));
  ck("number + no decline", OZZI_DIRECT(r2) && !DECLINES(r2), r2);
  ck("no visit, no price", !PROPOSES_VISIT(r2) && !HAS_PRICE(r2), r2);

  console.log("\n[5c] LIVE EN: 'I want to gut and redo my master bathroom completely'");
  const r3 = await ai([u("I want to gut and redo my master bathroom completely")]);
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 260));
  ck("number", OZZI_DIRECT(r3), r3);
  ck("no visit, no price, no details ask", !PROPOSES_VISIT(r3) && !HAS_PRICE(r3) && !ASKS_DETAILS(r3), r3);

  console.log("\n[5d] LIVE EN: asked mid-conversation after the opener");
  const r4 = await ai([u("hi"), a(OPENER_EN), u("Actually, do you also remodel bathrooms?")]);
  console.log("   →", r4.replace(/\s+/g, " ").slice(0, 260));
  ck("number mid-conversation", OZZI_DIRECT(r4), r4);
  ck("no visit", !PROPOSES_VISIT(r4), r4);

  console.log("\n[5e] LIVE PT: 'Oi, vocês fazem reforma de banheiro?'");
  const r5 = await ai([u("Oi, vocês fazem reforma de banheiro?")]);
  console.log("   →", r5.replace(/\s+/g, " ").slice(0, 260));
  ck("PT: número do Ozzi", OZZI_DIRECT(r5), r5);
  ck("PT: sem visita, sem preço", !PROPOSES_VISIT(r5) && !HAS_PRICE(r5), r5);
  ck("PT: em português", /\b(?:banheiro|orçamento|direto|Ozzi|você|ligar|falar)\b/i.test(r5), r5);

  console.log("\n[5f] LIVE ES: 'Hola, hacen remodelación de baño?' → no ¿ ¡");
  const r6 = await ai([u("Hola, hacen remodelación de baño?")]);
  console.log("   →", r6.replace(/\s+/g, " ").slice(0, 260));
  ck("ES: número", OZZI_DIRECT(r6), r6);
  ck("ES: sin visita, sin precio, sin ¿ ¡", !PROPOSES_VISIT(r6) && !HAS_PRICE(r6) && NO_INVERTED(r6), r6);

  console.log("\n[5g] LIVE EN: 'What do you charge for showers?' → Ozzi line, no price, no visit");
  const r7 = await ai([u("What do you charge for showers?")]);
  console.log("   →", r7.replace(/\s+/g, " ").slice(0, 260));
  ck("showers: number", OZZI_DIRECT(r7), r7);
  ck("showers: no price, no visit", !HAS_PRICE(r7) && !PROPOSES_VISIT(r7), r7);

  console.log("\n[5h] LIVE: client insists on a price / booking here → holds the line");
  const r8 = await ai([
    u("Hi, do you do bathroom remodeling?"),
    a(bathroomOzziDirectMessage("en")),
    u("Can't you just give me a rough number here? I don't want to call anyone"),
  ]);
  console.log("   →", r8.replace(/\s+/g, " ").slice(0, 260));
  ck("no price, not even approximate", !HAS_PRICE(r8), r8);
  ck("holds the line / number repeated", HOLDS_LINE(r8) || OZZI_DIRECT(r8), r8);
  ck("no visit offered instead", !PROPOSES_VISIT(r8), r8);

  console.log("\n[5i] LIVE: booking details arrive while a bathroom project stands → no [BOOK], Ozzi line");
  const r9 = await ai([
    u("Hi, do you do bathroom remodeling?"),
    a("Yes, we do bathroom remodels! For a remodel I first need to check the space in person, so let me set up a free visit. I have Monday at 9am or 11am, which works for you?"),
    u("Monday 9am. John Smith, 123 Main St Miami FL 33132, 305-555-1234"),
  ]);
  console.log("   →", r9.replace(/\s+/g, " ").slice(0, 260));
  ck("no [BOOK]", !HAS_BOOK(r9), r9);
  ck("Ozzi line instead", OZZI_DIRECT(r9), r9);

  console.log("\n[5j] LIVE: unrelated question after the line → answered, no price, no visit");
  const r10 = await ai([
    u("Hi, do you do bathroom remodeling?"),
    a(bathroomOzziDirectMessage("en")),
    u("Ok. Is your vinyl waterproof?"),
  ]);
  console.log("   →", r10.replace(/\s+/g, " ").slice(0, 260));
  ck("answers waterproof", /waterproof|water/i.test(r10), r10);
  ck("no price, no visit", !HAS_PRICE(r10) && !PROPOSES_VISIT(r10), r10);

  // ── 6. REGRESSIONS ───────────────────────────────────────────────────────
  console.log("\n[6a] REGRESSION: flooring for a bathroom, 150 sqft → Ozzi line (under-400 path), never a remodel visit");
  const g1 = await ai([u("I need vinyl flooring for my bathroom, it's about 150 square feet.")]);
  console.log("   →", g1.replace(/\s+/g, " ").slice(0, 200));
  ck("150 sqft: Ozzi's number, no price", OZZI_DIRECT(g1) && !HAS_PRICE(g1), g1);
  ck("150 sqft: no visit, not declined", !PROPOSES_VISIT(g1) && !DECLINES(g1), g1);

  console.log("\n[6b] REGRESSION: repair a few broken tiles in the bathroom → still declined (no visit, no price)");
  const g2 = await ai([u("Hi, can you repair a few broken tiles in my bathroom?")]);
  console.log("   →", g2.replace(/\s+/g, " ").slice(0, 200));
  ck("repair: declined", DECLINES_REPAIR(g2), g2);
  ck("repair: no visit, no price", !PROPOSES_VISIT(g2) && !HAS_PRICE(g2), g2);

  console.log("\n[6c] REGRESSION: tile installation for a bathroom, 450 sqft → still quoted by DM ($2,025)");
  const g3 = await ai([u("I need tile installation for my bathroom, around 450 sqft")]);
  console.log("   →", g3.replace(/\s+/g, " ").slice(0, 200));
  ck("450 sqft tile → $2,025 by DM, not the Ozzi line", /2[,.]?025/.test(g3) && !OZZI_DIRECT(g3), g3);

  console.log("\n[6d] REGRESSION: whole house 1500 sqft + bathroom remodel → the visit for the floors (never blocked) + Ozzi for the bathroom");
  const g4 = await ai([u("I want vinyl for the whole house, about 1500 sqft, and I also want to remodel the master bathroom")]);
  console.log("   →", g4.replace(/\s+/g, " ").slice(0, 260));
  ck("1500: proposes the visit (or asks what day)", PROPOSES_VISIT(g4) || /what day|which day|when works/i.test(g4), g4);
  ck("1500: no total", !/\$\s?\d{1,3},\d{3}|\$\s?\d{4,}/.test(g4), g4);
  ck("1500: the bathroom part goes to Ozzi (number given)", OZZI_DIRECT(g4), g4);

  console.log("\n[6e] REGRESSION: type-less first contact still gets the canned opener");
  const g5 = await ai([u("Hi, interested in new floors")]);
  console.log("   →", g5.replace(/\s+/g, " ").slice(0, 200));
  ck("canned type-ask opener", isCannedTypeAsk(g5) && !HAS_PRICE(g5), g5);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
