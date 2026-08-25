/**
 * REGRESSION GUARD for the 2026-08-03 English reasoning leak (Stacey Russo,
 * fb_38471520509114028 → conv ebf4f859). The REAL reply that shipped:
 *
 *   "Let me give you the correct number: the LVT promo for 400 sqft is $2,500
 *    (…), … Hmm, I need to apply the rules properly and not narrate my math.
 *    400 sqft of LVT, small job tier (200 to 400 sqft): 400 x $5 = $2,000,
 *    plus $500 small job add-on = $2,500. Demo: 400 x $1.50 = $600.
 *    Total = $3,100. For 400 sqft of LVT with the old floor taken up, that
 *    comes out to about $3,100 total, …"
 *
 * TWO violations in one bubble: (1) internal monologue narrated to the client
 * in ENGLISH (the old pattern list only caught "wait, let me…" phrasings),
 * (2) the STEP 2A small-job internals ($500 add-on, tier bands, "$5 x N"
 * arithmetic) — which the prompt forbids revealing — shipped to the client.
 *
 * ZERO API CALLS — stripReasoningLeak is a pure helper.
 * Run: npx tsx src/evals/reasoning-leak-aug03-verify.ts
 */
import { stripReasoningLeak } from "../lib/ai";
import { sanitizeOutbound } from "../lib/quote-followup";

let passed = 0, failed = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 160)}»`); }
}

const REAL_LEAK =
  "Let me give you the correct number: the LVT promo for 400 sqft is $2,500 (that covers the flooring, labor, and quarter round), and the old floor removal adds $1.50 per sqft, so $600 more, bringing the total to about $3,100. Hmm, I need to apply the rules properly and not narrate my math. 400 sqft of LVT, small job tier (200 to 400 sqft): 400 x $5 = $2,000, plus $500 small job add-on = $2,500. Demo: 400 x $1.50 = $600. Total = $3,100. For 400 sqft of LVT with the old floor taken up, that comes out to about $3,100 total, and that includes the flooring, installation, quarter round, and the demo, would you like to move forward?";

console.log("\n========== REASONING-LEAK AUG-03 VERIFY ==========");

console.log("\n[A] The real 2026-08-03 leaked reply is fully scrubbed");
const clean = stripReasoningLeak(REAL_LEAK);
ck("'Hmm, I need to apply the rules' removed", !/hmm/i.test(clean), clean);
ck("'narrate my math' removed", !/narrate/i.test(clean), clean);
ck("'small job tier/add-on' never reaches the client", !/small.?job\s+(tier|add.?on)/i.test(clean), clean);
ck("'plus $500' never reaches the client", !/plus\s+\$?500/i.test(clean), clean);
ck("no narrated arithmetic ('400 x $5 = $2,000')", !/\d\s*[x×]\s*\$?\s?\d[\d.,]*\s*=/i.test(clean), clean);
ck("no 'Total = $'", !/total\s*=/i.test(clean), clean);
ck("'Let me give you the correct number' opener removed", !/let me give you the correct/i.test(clean), clean);
ck("the client-facing total SURVIVES ($3,100)", /3,100/.test(clean), clean);
ck("the inclusions sentence survives", /flooring, installation, quarter round, and the demo/i.test(clean), clean);
ck("the closing question survives", /move forward\?/i.test(clean), clean);

console.log("\n[B] Sentence-level variants are each caught on their own");
for (const [label, leak] of [
  ["bare self-correction", "That would be $2,500. Hmm, I need to apply the rules properly here. It comes out to about $2,500."],
  ["tier label alone", "400 sqft falls in the small job tier so the total is $2,500. It comes out to about $2,500 for everything."],
  ["equation alone", "Quick math: 350 x $5 = $1,750, plus the add-on. That comes out to around $2,250 for the whole project."],
  ["total-equals alone", "Total = $1,500. It would be about $1,500 for the whole project, and that includes everything."],
] as const) {
  const out = stripReasoningLeak(leak);
  const stillLeaks = /small.?job\s+tier|\d\s*[x×]\s*\$|total\s*=|hmm/i.test(out);
  ck(`${label}: scrubbed, client total survives`, !stillLeaks && /\$\s?[12],[257]50|1,500|2,500/.test(out), out);
}

console.log("\n[B2] The SECOND real leak (2026-08-01, conv 810d2f45) is fully scrubbed");
const REAL_LEAK_2 =
  "The client sent their phone number but hasn't confirmed a specific day and time yet, and I still need their name and address. The \"following week\" from the week of Aug 5 would be the week of Aug 10. Now they sent their phone number. I should acknowledge the number and ask which time works, plus get their name and address. Perfect, got your number! Which time works for you on Monday the 10th, 9am or 11am, and can I get your name and the property address?";
const clean2 = stripReasoningLeak(REAL_LEAK_2);
ck("'The client sent their phone number…' removed", !/the client sent/i.test(clean2), clean2);
ck("'I still need their…' removed", !/i still need their/i.test(clean2), clean2);
ck("'Now they sent…' removed", !/now they sent/i.test(clean2), clean2);
ck("'I should acknowledge…' removed", !/i should acknowledge/i.test(clean2), clean2);
ck("week-of narration removed", !/would be the week of/i.test(clean2), clean2);
ck("the real client-facing reply survives", /got your number/i.test(clean2) && /monday the 10th/i.test(clean2), clean2);

console.log("\n[C] Legit client-facing replies pass through UNTOUCHED");
for (const legit of [
  "For 400 sqft of LVT with the old floor taken up, that comes out to about $3,100 total, and that includes the flooring, installation, quarter round, and the demo, would you like to move forward?",
  "It would be about $1,500 for the whole project.",
  "That comes out to around $2,250.",
  "Let me check what I have open. What day works best for you?",
  "Perfect, our tile promo is $4.50 per square foot for the installation labor.",
  "Stairs are $150 per step, and that includes the flooring material and the installation.",
  "Yes we do! At $2.20 per square foot for the labor, with you providing the carpet, that comes out to about $660 for 300 square feet.",
  "The old floor removal adds $1.50 per square foot, so about $600 more for your 400 square feet.",
  "I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.",
  "I still need a phone number to complete the booking, what's the best number to reach you?",
  "I still need the address before the visit to confirm the booking, so just send it over when you're ready.",
]) ck(`untouched: "${legit.slice(0, 56)}…"`, stripReasoningLeak(legit) === legit, stripReasoningLeak(legit));

// 3-day review 2026-08-25: three NEW leak shapes reached clients.
console.log("\n[3] leaks of 2026-08-23..25");
const leakFb = "The type is still unknown here, but 1,900 sqft is already a large lead so no DM price regardless. I need to propose the visit, but I also don't know if they want vinyl, tile, or hardwood. I'll acknowledge the size, note that LVP can go right over existing tile, and propose the free in-person visit without giving a dollar figure. For 1,900 sqft I need to come measure in person to give you the best price, and the visit is completely free.";
const cleanFb = stripReasoningLeak(leakFb);
ck("fb a9a3e8da: internal monologue removed", !/no DM price|type is still unknown|I need to propose|I'll acknowledge|large lead/i.test(cleanFb), cleanFb);
ck("fb a9a3e8da: the real answer survives", /For 1,900 sqft I need to come measure/.test(cleanFb), cleanFb);
const leakWa = "Of course, next week works perfectly! I have Monday August 31st at 9am or 1pm, or Sunday August 30th... let me give you the right ones: Monday the 31st at 9am or 1pm, and Sunday the 31st does not exist. What day next week works best for you?";
const cleanWa = stripReasoningLeak(leakWa);
ck("wa R0t4ld3: 'let me give you the right ones… does not exist' removed", !/right ones|does not exist/i.test(cleanWa), cleanWa);
const leakQuote = "Hi Angie, your quote of $2,320 does not have to be paid all at once. You can fill it out here: https://app.gerhearth.com/partners/ozzifloors. Any questions about the quote, just let me know. Wait, I need to copy the link exactly. Fill it out here: https://app.gethearth.com/partners/ozzifloors. Any questions about the quote, just reach out.";
const cleanQuote = sanitizeOutbound(leakQuote);
ck("quote follow-up: 'Wait, I need to copy the link exactly' removed", !/wait, i need/i.test(cleanQuote), cleanQuote);
ck("quote follow-up: no misspelled hearth link", !/gerhearth|gohearth/i.test(cleanQuote), cleanQuote);
ck("quote follow-up: canonical link appears exactly once", (cleanQuote.match(/app\.gethearth\.com\/partners\/ozzifloors/g) ?? []).length === 1, cleanQuote);
ck("sanitizeOutbound: 'gohearth' typo alone is canonicalized", sanitizeOutbound("Apply here: https://app.gohearth.com/partners/ozzifloors and let me know.").includes("https://app.gethearth.com/partners/ozzifloors"), sanitizeOutbound("Apply here: https://app.gohearth.com/partners/ozzifloors and let me know."));

console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
if (failed > 0) { console.log("FAILED:", fails.join(" | ")); process.exit(1); }
