// Verifies the PROJECTS UNDER 400 SQFT policy (owner rule 2026-09-11):
//  A job under 400 square feet is never sold and never scheduled through the
//  chat. Until today the bot priced anything under 500 sqft by DM (200 to 400:
//  sqft x $5 + $500, 401 to 499: plain $5) and declined under 200. Now:
//   - client states a size under 400 sqft (any type) → NO price, NO rate, NO
//     visit, NO slots, NO name/address/phone ask, NO [BOOK], NO "we don't take
//     it": the reply points the client to Ozzi directly at (561) 674-8334.
//   - client insists on a number here → "not able to give a quote for that
//     size through here, it has to come from Ozzi", number repeated, no figure.
//   - 400 to 499 sqft → still quoted by DM (clean multiplication, no add-on).
//   - 500+ → still the free visit.
//
//  1. DETERMINISTIC (no API): smallJobStanding (units, ranges, dims, metric,
//     sums, corrections, whole-house pivot, remodel, floor-plan analysis),
//     mentionsSmallSqft, smallJobReferralSent, smallJobLeak, smallJobReply,
//     the canned messages (no ¿ ¡, no dashes but the phone one, do not flag
//     themselves as leaks), source wiring of the three webhooks + prompt.
//  2. LIVE MODEL: 300 sqft vinyl → Ozzi line; insist → holds the line; ES / PT;
//     ad reply + tile 300 → Ozzi line; carpet 300 → yes + Ozzi line; booking
//     details while standing → no [BOOK]; unrelated question after the line →
//     answered without a price.
//  3. REGRESSIONS: 450 / 480 sqft → DM quote; 600 sqft → visit; canned opener
//     still fires for a type-less first contact; pivot to whole house 1500
//     sqft → visit; bathroom remodel → visit, not the Ozzi line.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, smallJobStanding, mentionsSmallSqft, smallJobReferralSent, smallJobLeak, smallJobReply,
  containsSchedulingOffer, isAskingForBookingInfo, type ChatMessage,
} from "../lib/ai";
import { smallJobOzziDirectMessage, smallJobOzziInsistMessage, OZZI_DIRECT_PHONE } from "../lib/scheduler";
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

const OZZI_DIRECT = (t: string) => /\(?\s?561\s?\)?[\s.-]*674[\s.-]*8334/.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const HAS_BOOK = (t: string) => /\[BOOK:/i.test(t);
const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.!?\n]{0,25}\b(?:at\s+)?\d{1,2}\s*(?:am|pm)\b|\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(t);
const ASKS_DETAILS = (t: string) => /\b(?:address|phone|zip|direcci[oó]n|tel[eé]fono|endere[çc]o|telefone|cep|c[oó]digo\s+postal)\b/i.test(t) && /\?/.test(t);
const DECLINES = (t: string) => /don'?t take|do not take|too small|we only (?:do|work|focus|take)|larger (?:projects|installations|jobs)|focus on larger|not something we/i.test(t);
const HOLDS_LINE = (t: string) => /not able|can'?t|cannot|unable|has to come|comes? from ozzi|directly|no puedo|tiene que venir|directo|n[aã]o consigo|precisa vir/i.test(t);
const NO_INVERTED = (t: string) => !/[¿¡]/.test(t);
const NO_DASH = (t: string) => !/[—–]| - /.test(t);
const isCannedTypeAsk = (t: string) => /tile/i.test(t) && /vinyl/i.test(t) && /hardwood/i.test(t);

async function main() {
  console.log("\n================ SMALL JOB (UNDER 400 SQFT) → OZZI DIRECT ================");

  // ── 1. smallJobStanding: what counts as "under 400" ──────────────────────
  console.log("\n[1] smallJobStanding — sizes that STAND (under 400)");
  const standing: Array<[string, number]> = [
    ["I need vinyl for my bedroom, about 300 sqft", 300],
    ["It's 250 square feet", 250],
    ["under 400 sq ft", 399],
    ["less than 300 sqft", 299],
    ["150 sq. ft. bathroom", 150],
    ["maybe 380sf", 380],
    ["just one room, 200 sqft", 200],
    ["Hi, I need new flooring for my bathroom, it's about 150 square feet.", 150],
    ["just a small closet, maybe 100 sqft of vinyl", 100],
    ["300 to 350 sqft", 350],
    ["300-350 square feet", 350],
    ["30 metros cuadrados", 323],
    ["unos 200 pies cuadrados", 200],
    ["uns 180 pés quadrados", 180],
    ["35 m2", 377],
    ["12x20 ft room", 240],
    ["12' x 20'", 240],
    ["my kitchen is 12x14", 168],
    ["the living room is 15 by 20 feet", 300],
    ["3x4 m", 129],
    ["[Client replied to our ad] 300 sqft", 300],
    ["Vinyl, it's about 200 sqft", 200],
    ["I want luxury vinyl for a 250 sqft room, how much?", 250],
    ["Do you install carpet? About 300 sqft", 300],
    ["[Floor plan analysis: Sala 3.00x3.00m, Cozinha 1.90x3.00m. Total: ~15m² (~160sqft). SMALL PROJECT\nFloor type: floor plan]", 160],
  ];
  for (const [text, want] of standing) {
    const got = smallJobStanding([u(text)]);
    ck(`"${text.slice(0, 60)}" → ${want}`, got !== null && Math.abs(got - want) <= 2, String(got));
  }

  console.log("\n[1b] smallJobStanding — NOT standing (null)");
  const notStanding: string[] = [
    "500 sqft", "about 450 sqft", "400 sqft", "1,200 sqft", "1.200 sqft", "1200 square feet", "2500sf",
    "over 300 sqft", "more than 350 square feet", "at least 300 sqft",
    "300-450 sqft", "300 to 500 sqft",
    "40 m2", "50 metros cuadrados", "38 m2",
    "bedroom 150 sqft and living room 300 sqft",
    "the bathroom is 60 sqft and the whole house is 1500 sqft",
    "I have 1200 sqft of tile",
    "$1,500 budget", "my zip is 33132", "2 bedrooms", "call me at 305-555-1234", "apt 305",
    "I want 12x24 tile in the kitchen", "24x24 porcelain", "12x12 tiles",
    "12x20", "20 x 30",
    "Hi! I need to put laminated floor in my garage. Its 20x19 around 400 sq feet total. Can you please let me know how much the instal would be",
    "bathroom remodel, about 60 sqft", "quiero remodelar el baño, 50 pies cuadrados",
    "[Floor plan analysis: Total: ~60m² (~645sqft). LARGE PROJECT\nFloor type: floor plan]",
    "Hi, interested in new floors", "one bedroom", "hola, cuanto cobran?",
    "16 steps", "just the stairs",
  ];
  for (const text of notStanding) ck(`"${text.slice(0, 60)}" → null`, smallJobStanding([u(text)]) === null, String(smallJobStanding([u(text)])));

  console.log("\n[1c] smallJobStanding — conversation level");
  ck("300 sqft, then 'actually the whole house' → null", smallJobStanding([u("300 sqft"), a("x"), u("actually I want the whole house done")]) === null);
  ck("300 sqft, then 'sorry I meant 1300' → null", smallJobStanding([u("300 sqft"), a("x"), u("sorry I meant 1300 sqft")]) === null);
  ck("300 sqft, then 'and the kitchen too, 250 sqft' → stands (250, latest message)", smallJobStanding([u("300 sqft"), a("x"), u("and the kitchen too, 250 sqft")]) === 250);
  ck("1500 sqft, then 'the bedroom is 200 sqft' → null (400+ anywhere wins)", smallJobStanding([u("1500 sqft"), a("x"), u("the bedroom is 200 sqft")]) === null);
  ck("300 sqft, then 'is it waterproof?' → still stands", smallJobStanding([u("300 sqft"), a("x"), u("is it waterproof?")]) === 300);
  ck("300 sqft, then [SYSTEM:] note appended → still stands", smallJobStanding([u("300 sqft\n\n[SYSTEM: some note about 1500 sqft]")]) === 300);
  ck("opener, then '250 sqft' answer → stands", smallJobStanding([u("Hi, interested in new floors"), a(OPENER_EN), u("Vinyl, about 250 sqft")]) === 250);
  ck("mentionsSmallSqft('about 300 sqft') → true", mentionsSmallSqft("about 300 sqft"));
  ck("mentionsSmallSqft('about 450 sqft') → false", !mentionsSmallSqft("about 450 sqft"));
  ck("mentionsSmallSqft('Hi, how much per sqft?') → false", !mentionsSmallSqft("Hi, how much per sqft?"));

  // ── 2. Canned messages ───────────────────────────────────────────────────
  console.log("\n[2] canned messages (EN/ES/PT)");
  for (const lang of ["en", "es", "pt"] as const) {
    const d = smallJobOzziDirectMessage(lang);
    const i = smallJobOzziInsistMessage(lang);
    ck(`${lang}: direct line carries the number`, d.includes(OZZI_DIRECT_PHONE) && OZZI_DIRECT(d), d);
    ck(`${lang}: insist line carries the number`, i.includes(OZZI_DIRECT_PHONE) && OZZI_DIRECT(i), i);
    ck(`${lang}: no price in either`, !HAS_PRICE(d) && !HAS_PRICE(i), d + i);
    ck(`${lang}: no ¿ ¡, no dashes, no '?'`, NO_INVERTED(d + i) && NO_DASH(d + i) && !/\?/.test(d + i), d + i);
    ck(`${lang}: neither reads as a scheduling offer / visit / details ask`, !containsSchedulingOffer(d) && !containsSchedulingOffer(i) && !PROPOSES_VISIT(d) && !PROPOSES_VISIT(i) && !isAskingForBookingInfo(d) && !isAskingForBookingInfo(i), d + i);
    ck(`${lang}: says under 400 / insist says it cannot quote here`, /400/.test(d) && HOLDS_LINE(i), d + i);
    ck(`${lang}: messages do not flag themselves as leaks`, !smallJobLeak([u("300 sqft")], d) && !smallJobLeak([u("300 sqft"), a(d), u("just tell me")], i), d + i);
  }
  ck("OZZI_DIRECT_PHONE is (561) 674-8334", OZZI_DIRECT_PHONE === "(561) 674-8334");

  // ── 3. smallJobReferralSent / smallJobLeak / smallJobReply ───────────────
  console.log("\n[3] leak detector + reply chooser");
  const H = [u("I need vinyl for my bedroom, about 300 sqft. How much?")];
  ck("referral not sent yet", !smallJobReferralSent(H));
  ck("referral sent after the canned line", smallJobReferralSent([...H, a(smallJobOzziDirectMessage("en"))]));
  ck("referral sent after the model's own wording", smallJobReferralSent([...H, a("Ozzi handles projects that size himself, you can reach him at 561-674-8334.")]));
  ck("WhatsApp photo redirect is NOT the referral", !smallJobReferralSent([...H, a("For that, the best is to message our team directly on WhatsApp at (561) 674-8334 and we'll help you find the right floor!")]));
  ck("leak: a total", smallJobLeak(H, "That comes out to about $2,000 for the whole project."));
  ck("leak: a per-sqft rate", smallJobLeak(H, "Our vinyl promo is $5 per square foot, flooring and labor included."));
  ck("leak: a visit offer", smallJobLeak(H, "I can come by and measure, the visit is free. What day works best for you?"));
  ck("leak: slots", smallJobLeak(H, "I have Monday at 9am or 11am, which works for you?"));
  ck("leak: booking details ask", smallJobLeak(H, "Perfect, what's the full address with the zip code and the best phone number?"));
  ck("leak: [BOOK]", smallJobLeak(H, 'Perfect, see you then![BOOK:{"name":"A","phone":"3055551234","address":"1 Main St 33132","date":"2026-09-14","time":"09:00","notes":"300 sqft vinyl"}]'));
  ck("leak: first reply WITHOUT the number", smallJobLeak(H, "For that size Ozzi handles it personally, let me connect you."));
  ck("no leak: first reply WITH the number", !smallJobLeak(H, "For a project under 400 square feet the best is to speak with Ozzi directly, he checks the details and gives you the quote himself. You can call him at (561) 674-8334."));
  ck("no leak: reply with the number written differently", !smallJobLeak(H, "Ozzi handles that size himself, give him a call at 561-674-8334 and he'll get you the number."));
  const H2 = [...H, a(smallJobOzziDirectMessage("en")), u("Is it waterproof?")];
  ck("no leak: unrelated answer after the referral, no $", !smallJobLeak(H2, "Yes, our luxury vinyl is 100% waterproof with a 20-year warranty, and Ozzi can go over the options with you when you call."));
  ck("leak: unrelated answer after the referral WITH a $", smallJobLeak(H2, "Yes, it's waterproof, and at $5 per square foot it includes the labor."));
  ck("not standing (450 sqft): a price is fine", !smallJobLeak([u("about 450 sqft of vinyl")], "That comes out to about $2,250."));
  ck("not standing (600 sqft): a visit offer is fine", !smallJobLeak([u("about 600 sqft of vinyl")], "For that size I do a free in-person visit. What day works best for you?"));
  ck("epoxy 300 sqft: the unsupported-floor decline owns the reply (no small-job leak)", !smallJobLeak([u("I want epoxy for my garage, 300 sqft")], "That's not something we do, we don't work with epoxy floors."));
  ck("smallJobReply before referral → direct line", smallJobReply(H, "en") === smallJobOzziDirectMessage("en"));
  ck("smallJobReply after referral → insist line", smallJobReply([...H, a(smallJobOzziDirectMessage("en")), u("just tell me the price")], "en") === smallJobOzziInsistMessage("en"));
  ck("smallJobReply ES/PT", smallJobReply(H, "es") === smallJobOzziDirectMessage("es") && smallJobReply(H, "pt") === smallJobOzziDirectMessage("pt"));

  // ── 4. Source wiring ─────────────────────────────────────────────────────
  console.log("\n[4] source wiring (3 webhooks, brain, prompt)");
  const hooks: Array<[string, string]> = [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ];
  for (const [name, rel] of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: [BOOK] blocked while a size under 400 stands`, /if \(smallJobStanding\(history\) !== null\)[\s\S]{0,400}smallJobReply\(history, lang\)/.test(src), rel);
    ck(`${name}: post-model backstop (price / visit / details → Ozzi line)`, /smallJobLeak\(history, (?:safeAiText|safeResponse)\)[\s\S]{0,300}smallJobReply\(history, lang\)/.test(src), rel);
  }
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("ai.ts: CRITICAL block injected while the size stands", /smallJobNote\(sj, smallJobReferralSent\(messages\)\)/.test(aiSrc));
  ck("ai.ts: backstop inside getAIResponse", /if \(smallJobLeak\(messages, cleaned\)\)[\s\S]{0,300}smallJobReply\(messages/.test(aiSrc));
  ck("ai.ts: first contact with a small size skips the canned opener (2 gates + hardcoded)", (aiSrc.match(/!smallFirstMessage/g) ?? []).length === 2 && /!mentionsSmallSqft\(text\)/.test(aiSrc));
  ck("ai.ts: rule 18 is the UNDER 400 SQFT rule", /18\. UNDER 400 SQFT RULE \(OZZI DIRECT/.test(aiSrc) && !/\+\$500/.test(aiSrc.split("FINAL REMINDERS")[1] ?? ""));
  ck("prompt: PROJECTS UNDER 400 SQFT section with the number", /## PROJECTS UNDER 400 SQFT/.test(sp) && /\(561\) 674-8334/.test(sp));
  ck("prompt: old tiers gone (no +$500, no under-200 decline)", !/\+ \$500/.test(sp) && !/UNDER 200 sqft: WE DO NOT TAKE THESE JOBS/.test(sp) && !/401 to 499 sqft: plain/.test(sp));
  ck("prompt: 400 to 499 still quoted by DM", /400 to 499 sqft: close directly by DM/.test(sp));
  ck("prompt: carpet under 400 → Ozzi line", /Under 400 sqft: NO total, NO visit, do not even repeat the rate: Ozzi direct/.test(sp));
  ck("ai.ts: canned FAQ re-answer and hard-coded intercepts skipped while a small size stands", /faqReanswer && smallJobStanding\(messages\) !== null/.test(aiSrc) && /hardcoded && smallJobStanding\(messages\) !== null/.test(aiSrc));

  // ── 5. LIVE MODEL ────────────────────────────────────────────────────────
  console.log("\n[5] LIVE: 'vinyl for my bedroom, about 300 sqft. How much?' → Ozzi line, no price, no visit, no decline");
  const r1 = await ai([u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?")]);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 260));
  ck("gives Ozzi's number", OZZI_DIRECT(r1), r1);
  ck("no price / rate", !HAS_PRICE(r1), r1);
  ck("no visit, no slots, no details ask, no [BOOK]", !PROPOSES_VISIT(r1) && !ASKS_DETAILS(r1) && !HAS_BOOK(r1), r1);
  ck("does not decline the job", !DECLINES(r1), r1);
  ck("not the canned type-ask opener", !isCannedTypeAsk(r1), r1);

  console.log("\n[5b] LIVE: client insists → holds the line, number repeated, still no figure");
  const r2 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"),
    a(smallJobOzziDirectMessage("en")),
    u("Can't you just give me a rough price here? I don't want to call anyone"),
  ]);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 260));
  ck("no price / rate, not even approximate", !HAS_PRICE(r2), r2);
  ck("number repeated", OZZI_DIRECT(r2), r2);
  ck("says it cannot quote here / has to come from Ozzi", HOLDS_LINE(r2), r2);
  ck("no visit offered instead", !PROPOSES_VISIT(r2), r2);

  console.log("\n[5c] LIVE: insists AGAIN → still nothing");
  const r3 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"),
    a(smallJobOzziDirectMessage("en")),
    u("Can't you just give me a rough price here? I don't want to call anyone"),
    a(smallJobOzziInsistMessage("en")),
    u("Come on, just the price per square foot then"),
  ]);
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 260));
  ck("no price / rate on the second insist", !HAS_PRICE(r3), r3);
  ck("still points to Ozzi", OZZI_DIRECT(r3) || HOLDS_LINE(r3), r3);

  console.log("\n[5d] LIVE: ES 'cuanto cobran por 250 pies cuadrados de vinyl?' → Ozzi line in Spanish, no ¿ ¡");
  const r4 = await ai([u("Hola, cuanto cobran por 250 pies cuadrados de vinyl?")]);
  console.log("   →", r4.replace(/\s+/g, " ").slice(0, 260));
  ck("ES: number", OZZI_DIRECT(r4), r4);
  ck("ES: no price", !HAS_PRICE(r4), r4);
  ck("ES: in Spanish, no inverted marks", /\b(?:para|con|puede|directo|directamente|Ozzi)\b/i.test(r4) && NO_INVERTED(r4), r4);

  console.log("\n[5e] LIVE: PT 'quanto fica 200 pés quadrados de vinil?' → Ozzi line in Portuguese");
  const r5 = await ai([u("Oi, quanto fica 200 pés quadrados de vinil?")]);
  console.log("   →", r5.replace(/\s+/g, " ").slice(0, 260));
  ck("PT: number", OZZI_DIRECT(r5), r5);
  ck("PT: no price", !HAS_PRICE(r5), r5);

  console.log("\n[5f] LIVE: ad reply, tile, 300 sqft → Ozzi line, no $4.50 total");
  const r6 = await ai([
    u("[Client replied to our ad]"),
    a(OPENER_EN),
    u("Tile, about 300 sqft"),
  ]);
  console.log("   →", r6.replace(/\s+/g, " ").slice(0, 260));
  ck("tile 300: number", OZZI_DIRECT(r6), r6);
  ck("tile 300: no price (no $1,350, no $4.50)", !HAS_PRICE(r6), r6);
  ck("tile 300: no visit", !PROPOSES_VISIT(r6), r6);

  console.log("\n[5g] LIVE: carpet 300 sqft → still YES to carpet + Ozzi line, no $660");
  const r7 = await ai([u("Do you install carpet? It's about 300 square feet, 2 bedrooms.")]);
  console.log("   →", r7.replace(/\s+/g, " ").slice(0, 260));
  ck("carpet 300: number", OZZI_DIRECT(r7), r7);
  ck("carpet 300: no price", !HAS_PRICE(r7), r7);
  ck("carpet 300: does NOT deny carpet", !/\b(?:don'?t|do\s+not|cannot|can'?t|won'?t)\b[^.!?\n]{0,40}carpet/i.test(r7), r7);

  console.log("\n[5h] LIVE: booking details arrive while a 300 sqft size stands → no [BOOK], Ozzi line");
  const r8 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft"),
    a("For that I can come by and measure, I have Monday at 9am or 11am, which works for you?"),
    u("Monday 9am. John Smith, 123 Main St Miami FL 33132, 305-555-1234"),
  ]);
  console.log("   →", r8.replace(/\s+/g, " ").slice(0, 260));
  ck("no [BOOK]", !HAS_BOOK(r8), r8);
  ck("Ozzi line instead", OZZI_DIRECT(r8), r8);
  ck("no price", !HAS_PRICE(r8), r8);

  console.log("\n[5i] LIVE: unrelated question after the line → answered, no price");
  const r9 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"),
    a(smallJobOzziDirectMessage("en")),
    u("Ok. Is the vinyl waterproof?"),
  ]);
  console.log("   →", r9.replace(/\s+/g, " ").slice(0, 260));
  ck("answers waterproof", /waterproof|water/i.test(r9), r9);
  ck("no price, no visit", !HAS_PRICE(r9) && !PROPOSES_VISIT(r9), r9);

  console.log("\n[5j] LIVE: photos request after the line → canned see-options intercept skipped, no free-visit pitch, no price");
  const r10 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"),
    a(smallJobOzziDirectMessage("en")),
    u("Can you send me some photos of your floors?"),
  ]);
  console.log("   →", r10.replace(/\s+/g, " ").slice(0, 260));
  ck("no free-visit pitch, no slots", !PROPOSES_VISIT(r10), r10);
  ck("no price", !HAS_PRICE(r10), r10);
  // The model's own photo answer (rule 10b: website / samples, or the WhatsApp
  // redirect to the same number) is fine; the INSIST line would be a non-sequitur.
  ck("answers the photo ask (website / samples / WhatsApp redirect) instead of the insist line", /ozzifloors\.com|samples?|photos?|pictures?|whatsapp|674[\s.-]*8334/i.test(r10) && !/not able to give you a quote/i.test(r10), r10);

  // ── 6. REGRESSIONS ───────────────────────────────────────────────────────
  console.log("\n[6a] REGRESSION: 450 sqft vinyl → $2,250 by DM, not the Ozzi line");
  const g1 = await ai([u("I want luxury vinyl for a 450 sqft room, how much?")]);
  console.log("   →", g1.replace(/\s+/g, " ").slice(0, 200));
  ck("450: quotes $2,250", /2[,.]?250/.test(g1), g1);
  ck("450: no Ozzi line, no visit", !OZZI_DIRECT(g1) && !PROPOSES_VISIT(g1), g1);

  console.log("\n[6b] REGRESSION: 480 sqft → $2,400 by DM");
  const g2 = await ai([u("hi"), a(OPENER_EN), u("Vinyl, about 480 sqft, one area")]);
  console.log("   →", g2.replace(/\s+/g, " ").slice(0, 200));
  ck("480: quotes $2,400", /2[,.]?400/.test(g2), g2);
  ck("480: no Ozzi line", !OZZI_DIRECT(g2), g2);

  console.log("\n[6c] REGRESSION: 600 sqft → visit, no total");
  const g3 = await ai([u("I need vinyl for the whole apartment, about 600 sqft")]);
  console.log("   →", g3.replace(/\s+/g, " ").slice(0, 200));
  ck("600: proposes the visit", PROPOSES_VISIT(g3), g3);
  ck("600: no $1,000+ total, no Ozzi line", !/\$\s?\d{1,3},\d{3}|\$\s?\d{4,}/.test(g3) && !OZZI_DIRECT(g3), g3);

  console.log("\n[6d] REGRESSION: type-less first contact still gets the canned opener");
  const g4 = await ai([u("Hi, interested in new floors")]);
  console.log("   →", g4.replace(/\s+/g, " ").slice(0, 200));
  ck("canned type-ask opener", isCannedTypeAsk(g4) && !HAS_PRICE(g4), g4);

  console.log("\n[6e] REGRESSION: 300 sqft → Ozzi line → 'actually the whole house, 1500 sqft' → visit");
  const g5 = await ai([
    u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"),
    a(smallJobOzziDirectMessage("en")),
    u("Actually I want to do the whole house, it's about 1500 sqft"),
  ]);
  console.log("   →", g5.replace(/\s+/g, " ").slice(0, 200));
  ck("1500: proposes the visit (or asks what day)", PROPOSES_VISIT(g5) || /what day|which day|when works/i.test(g5), g5);
  ck("1500: no total", !/\$\s?\d{1,3},\d{3}|\$\s?\d{4,}/.test(g5), g5);

  console.log("\n[6f] REGRESSION: bathroom remodel → visit, never the Ozzi line for being small");
  const g6 = await ai([u("Do you do bathroom remodels? It's a small bathroom, about 60 sqft")]);
  console.log("   →", g6.replace(/\s+/g, " ").slice(0, 200));
  ck("remodel: proposes the visit", PROPOSES_VISIT(g6), g6);
  ck("remodel: no Ozzi line, no price", !OZZI_DIRECT(g6) && !HAS_PRICE(g6), g6);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
