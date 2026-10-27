/**
 * AD PRICE CONTEXT (owner rule 2026-10-27, caso Jason, Messenger).
 *
 * Every active engagement ad shows TWO prices in its body ("1000 sq.ft. FOR JUST
 * $2,350 ❌ materials" / "1000 sq.ft. ONLY $5,100 ✅ with materials") and most
 * greetings quote the $2,350 ("starting at $2,350"). Jason tapped "What type of
 * materials are included?" right under that greeting and got the canned "our
 * vinyl promo includes the floor, the installation and the quarter round", so he
 * believed the $2,350 covered everything; the seller found out at the house.
 * Owner: read what the ad (the first message) promised, say the $2,350 is the
 * installation only and that the $5 per sq ft promo is the one that includes the
 * labor, the luxury vinyl floor and the quarter round.
 *
 * This eval proves:
 *  1. DETECTION: detectAdPriceTier reads the two-price ad from its body, from
 *     its greeting and from the client quoting the numbers; silent on herringbone
 *     ads, ad names, sizes and other figures.
 *  2. CANNED PATHS: the first-contact FAQ button, the "what's included"
 *     intercept (type unknown / vinyl / tile), the multi-tap opener and the FAQ
 *     re-answer all state the contrast when the tier is known, and are UNCHANGED
 *     when it is not.
 *  3. TEXTS + WIRING: the note, rule 32 and the first-message note carry the
 *     rule; the three webhooks read the persisted ad id, the creative (body +
 *     greeting) and inject the note.
 *  4. LIVE: with the note injected, the model corrects "so the $2,350 covers the
 *     vinyl, right?" (EN and ES) and handles Jason's real second turn.
 *
 * Run: npx tsx src/evals/ad-price-tier-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse,
  detectAdPriceTier,
  conversationAdPriceTier,
  adPriceTierNote,
  adFlooringTypeNote,
  cannedFaqReanswer,
  fixTwoTierPromoWording,
  type ChatMessage,
} from "../lib/ai";
import {
  WHAT_IS_INCLUDED_ASK_TYPE,
  WHAT_IS_INCLUDED_TWO_TIER_ASK,
  WHAT_IS_INCLUDED_TWO_TIER_VINYL_RESPONSE,
  WHAT_IS_INCLUDED_TILE_RESPONSE,
  AD_REPLY_NOTE,
  AD_PRICE_TIER_NOTE,
  OPENER_EN,
  composeAdFaqOpener,
} from "../lib/system-prompt";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 260)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);

// ── Real texts (Graph API, 27/10/2026) ───────────────────────────────────────
const AD_BODY = "✨ 1000 sq.ft. FOR JUST $2,350 ❌ materials\n✨ 1000 sq.ft. ONLY $5,100 ✅ with materials";
const GREET_STARTING = "Hi {{user_first_name}}! Need flooring installation? We offer expert services for 1000 sq.ft. starting at $2,350.";
const GREET_LABOR = "Hi {{user_first_name}}! Need flooring installation? We offer great deals like $2,350 for 1000 sq.ft. labor only!";
const GREET_5100 = "Hi {{user_first_name}}! Need flooring installed? We can help with 1000 sq.ft. for $5100 with materials!";
const GREET_NO_PRICE = "Hi {{user_first_name}}! Need help with flooring? We offer expert installation services like the one you see here.";
const HERRINGBONE_BODY = "✨ 1000 sq.ft. FOR JUST $4000 ❌ materials ✨ 1000 sq.ft. ONLY $7600 ✅ with materials";
const CREATIVE_TEXT = `New Engagement Ad7 | 📩 Free Quote | Serving South Florida 2026-09-29-1b6e | 📩 Free Quote | Serving South Florida | ${AD_BODY} | ${GREET_STARTING}`;

const FAQ = "What type of materials are included?";
const sys = (...extra: string[]) => `\n\n[SYSTEM: TODAY: Tuesday, October 27, 2026 [2026-10-27].\n\n${extra.join("\n\n")}]`;
const TIER = adPriceTierNote();

// "$5 per sq ft" (or "$5/sqft", "$5 por sq ft", "$5 por pie"), never only the "$5,100" line.
const SAYS_FIVE_PER_SQFT = (t: string) => /\$\s?5(?:\.00)?\s*(?:per|por|a|al|\/)\s*(?:sq|square|pie|p[eé]|sqft)/i.test(t);
const SAYS_CONTRAST = (t: string) =>
  /installation only|labor only|install only|installation alone|just the installation|only the installation|only covers the installation|covers the installation|supply the floor|provide the floor|you supply|you provide|without the (?:floor|material|vinyl)|does(?:n't| not) include|not include|no material/i.test(t) &&
  SAYS_FIVE_PER_SQFT(t);
const CLAIMS_2350_INCLUDES = (t: string) => /2,?350[^.]{0,80}\b(?:includes?|covers?|comes with)\b[^.]{0,40}\b(?:vinyl|floor|quarter|material|everything)/i.test(t);

async function main() {
  console.log("\n==================== AD PRICE CONTEXT (two-price ad) VERIFICATION ====================");

  // ── 1. Detection ──────────────────────────────────────────────────────────
  console.log("\n[1] detectAdPriceTier");
  ck("creative text (name + title + body + greeting) → two_tier", detectAdPriceTier(CREATIVE_TEXT) === "two_tier");
  ck("ad body alone → two_tier", detectAdPriceTier(AD_BODY) === "two_tier");
  ck("greeting 'starting at $2,350' → two_tier", detectAdPriceTier(GREET_STARTING) === "two_tier");
  ck("greeting '$2,350 for 1000 sq.ft. labor only!' → two_tier", detectAdPriceTier(GREET_LABOR) === "two_tier");
  ck("greeting '1000 sq.ft. for $5100 with materials' → two_tier", detectAdPriceTier(GREET_5100) === "two_tier");
  ck("greeting without a price → null", detectAdPriceTier(GREET_NO_PRICE) === null);
  ck("ad name 'New Engagement Ad7' → null", detectAdPriceTier("New Engagement Ad7") === null);
  ck("herringbone ad ($4000/$7600 body, even with the $2,350 greeting) → null", detectAdPriceTier("Ad Harringbone 01 - Copy", HERRINGBONE_BODY, GREET_LABOR) === null);
  ck("client 'the ad says $2,350 for 1000 sqft' → two_tier", detectAdPriceTier("the ad says $2,350 for 1000 sqft") === "two_tier");
  ck("client 'I saw 2350 for 1000 sq ft' → two_tier", detectAdPriceTier("I saw 2350 for 1000 sq ft in your ad") === "two_tier");
  ck("client 'Is labor cost also $4,500?' → null", detectAdPriceTier("Is labor cost also $4,500?") === null);
  ck("client 'Vinyl, I have 775 SF over plywood' → null", detectAdPriceTier("Vinyl, I have 775 SF over plywood on the 2nd floor. Can you do stairs as well?") === null);
  ck("tile ad text '1000 sq.ft. TILE INSTALLATION $4,500' → null", detectAdPriceTier("1000 sq.ft. TILE INSTALLATION $4,500") === null);
  ck("empty signals → null", detectAdPriceTier(null, undefined, "") === null);

  console.log("\n[2] conversationAdPriceTier");
  ck("marker in the last message → two_tier", conversationAdPriceTier([{ role: "user", content: FAQ + sys(AD_REPLY_NOTE, TIER) }]) === "two_tier");
  ck("client quoted the ad price two bubbles earlier → two_tier", conversationAdPriceTier([
    { role: "user", content: "I saw your ad, 2350 for 1000 sq ft" }, { role: "assistant", content: OPENER_EN }, { role: "user", content: "what's included?" },
  ]) === "two_tier");
  ck("plain 'Hi' → null", conversationAdPriceTier([{ role: "user", content: "Hi" + sys(AD_REPLY_NOTE) }]) === null);

  // ── 2. Canned paths (no model call) ───────────────────────────────────────
  console.log("\n[3] first contact, FAQ button");
  let r = await ai([{ role: "user", content: FAQ + sys(AD_REPLY_NOTE, TIER) }]);
  ck("two-price ad + 'What type of materials are included?' → two-tier line (Jason's first turn)", r === WHAT_IS_INCLUDED_TWO_TIER_ASK, r);
  r = await ai([{ role: "user", content: FAQ + sys(AD_REPLY_NOTE) }]);
  ck("no tier note → the ask-type line stays exactly as before", r === WHAT_IS_INCLUDED_ASK_TYPE, r);
  r = await ai([{ role: "user", content: "What is included in the materials package?" + sys(AD_REPLY_NOTE, TIER) }]);
  ck("'What is included in the materials package?' + tier → two-tier line", r === WHAT_IS_INCLUDED_TWO_TIER_ASK, r);
  r = await ai([{ role: "user", content: "Is installation labor cost extra?" + sys(AD_REPLY_NOTE, TIER) }]);
  ck("'Is installation labor cost extra?' + tier → two-tier line", r === WHAT_IS_INCLUDED_TWO_TIER_ASK, r);
  r = await ai([{ role: "user", content: `What is the installation process?\n${FAQ}` + sys(AD_REPLY_NOTE, TIER) }]);
  ck("multi-tap (process + inclusions) + tier → combined answer carries the $2,350 / $5 per sq ft contrast + type ask",
    /\$2,350/.test(r) && /\$5 per sq ft/.test(r) && /tile, vinyl, or hardwood/.test(r) && /furniture/.test(r), r);

  console.log("\n[4] intercept with a known type");
  r = await ai([{ role: "user", content: FAQ + sys(adFlooringTypeNote("tile"), TIER) }]);
  ck("TILE ad + tier note → tile labor-only answer (tile still wins)", r === WHAT_IS_INCLUDED_TILE_RESPONSE, r);
  r = await ai([{ role: "user", content: "Is labor included?" + sys(adFlooringTypeNote("vinyl"), TIER) }]);
  ck("VINYL known + tier, size unknown → two-tier vinyl response", r === WHAT_IS_INCLUDED_TWO_TIER_VINYL_RESPONSE, r);
  r = await ai([{ role: "user", content: "Hi" + sys(AD_REPLY_NOTE) }, { role: "assistant", content: OPENER_EN }, { role: "user", content: "Is labor included?" + sys(AD_REPLY_NOTE, TIER) }]);
  ck("mid-conversation, type unknown + tier → two-tier line", r === WHAT_IS_INCLUDED_TWO_TIER_ASK, r);

  console.log("\n[5] FAQ re-answer and combined opener");
  const retap: ChatMessage[] = [{ role: "user", content: FAQ }, { role: "assistant", content: WHAT_IS_INCLUDED_TWO_TIER_ASK }, { role: "user", content: FAQ + sys(AD_REPLY_NOTE, TIER) }];
  const re = cannedFaqReanswer(FAQ, retap) ?? "";
  ck("re-tapped inclusions button + tier → re-answer states the contrast", /\$2,350/.test(re) && /\$5 per sq ft/.test(re), re);
  const reQuick = cannedFaqReanswer(FAQ, retap, { quick: true }) ?? "";
  ck("quick re-answer + tier → same contrast", /\$2,350/.test(reQuick) && /\$5 per sq ft/.test(reQuick), reQuick);
  const rePlain = cannedFaqReanswer(FAQ, [{ role: "user", content: FAQ }, { role: "assistant", content: WHAT_IS_INCLUDED_ASK_TYPE }, { role: "user", content: FAQ + sys(AD_REPLY_NOTE) }]) ?? "";
  ck("re-answer without tier → unchanged wording", /vinyl promo includes the floor/.test(rePlain), rePlain);
  const combined = composeAdFaqOpener(["process", "inclusions"], "en", { twoTier: true }) ?? "";
  ck("composeAdFaqOpener twoTier → $2,350 install-only / $5 per sq ft clause", /\$2,350/.test(combined) && /\$5 per sq ft/.test(combined), combined);
  const combinedEs = composeAdFaqOpener(["discount", "inclusions"], "es", { twoTier: true }) ?? "";
  ck("composeAdFaqOpener twoTier ES → contraste em espanhol", /\$2,350/.test(combinedEs) && /\$5 por sq ft/.test(combinedEs), combinedEs);
  const plain = composeAdFaqOpener(["process", "inclusions"], "en") ?? "";
  ck("composeAdFaqOpener without twoTier → unchanged", /vinyl promo includes the floor/.test(plain), plain);

  // ── 3. Texts + wiring ─────────────────────────────────────────────────────
  console.log("\n[6] note, rules and wiring");
  ck("AD_PRICE_TIER_NOTE carries the marker and the facts",
    AD_PRICE_TIER_NOTE.startsWith("[AD_PRICE_TIER: two_tier]") && /INSTALLATION ONLY/.test(AD_PRICE_TIER_NOTE) && /\$5 per square foot/.test(AD_PRICE_TIER_NOTE) && /luxury vinyl floor/.test(AD_PRICE_TIER_NOTE) && /quarter round/.test(AD_PRICE_TIER_NOTE));
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("rule 32 names the two ad figures as ours", /Our own ads show exactly two figures/.test(aiSrc));
  ck("first-message note has the AD PRICE CONTEXT exception", /EXCEPTION, AD PRICE CONTEXT/.test(aiSrc));
  const spSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("WHAT IS INCLUDED prompt section has the AD PRICE CONTEXT exception", /AD PRICE CONTEXT EXCEPTION/.test(spSrc));
  for (const [name, path] of [["Messenger", "src/app/api/fb-webhook/route.ts"], ["Instagram", "src/app/api/webhook/route.ts"], ["WhatsApp", "src/app/api/wa-webhook/route.ts"]] as const) {
    const src = readFileSync(join(process.cwd(), path), "utf-8");
    ck(`${name}: persisted ad id on any turn + creative text + tier note`, /adIdPersistidoDaConversa\(/.test(src) && /adCreative\?\.text/.test(src) && /systemParts\.push\(adPriceTierNote\(\)\)/.test(src) && /detectAdPriceTier\(/.test(src));
  }
  const fbLib = readFileSync(join(process.cwd(), "src/lib/facebook.ts"), "utf-8");
  ck("fetchAdCreative reads the greeting (page_welcome_message) and caches per ad", /page_welcome_message/.test(fbLib) && /adCreativeCache/.test(fbLib));
  const funilSrc = readFileSync(join(process.cwd(), "src/lib/funil.ts"), "utf-8");
  ck("funil exports adIdPersistidoDaConversa", /export async function adIdPersistidoDaConversa/.test(funilSrc));

  console.log("\n[6b] fixTwoTierPromoWording backstop");
  let fx = fixTwoTierPromoWording("The $2,350 is installation only, no floor and no quarter round. The $5,100 includes the vinyl, installation and quarter round.");
  ck("'$5,100 includes...' → '$5 per sq ft ($5,100 for 1000 sq ft) includes...'", /\$5 per sq ft \(\$5,100 for 1000 sq ft\) includes/.test(fx), fx);
  fx = fixTwoTierPromoWording("Our full promo is $5 per sq ft, the $5,100 line of the ad.");
  ck("reply that already says $5 per sq ft → unchanged", fx === "Our full promo is $5 per sq ft, the $5,100 line of the ad.", fx);
  fx = fixTwoTierPromoWording("The $5,100 for 1000 sq ft covers the vinyl floor, the installation and the quarter round.");
  ck("'$5,100 for 1000 sq ft covers' → no duplicated '1000 sq ft'", /\$5 per sq ft \(\$5,100 for 1000 sq ft\) covers/.test(fx) && !/1000 sq ft for 1000/.test(fx), fx);
  fx = fixTwoTierPromoWording("El paquete de $5,100 incluye el piso vinilico, la instalacion y el quarter round.", "es");
  ck("ES '$5,100 incluye' → '$5 por sq ft ($5,100 por 1000 sq ft)'", /\$5 por sq ft \(\$5,100 por 1000 sq ft\) incluye/.test(fx), fx);
  fx = fixTwoTierPromoWording("Yes we do stairs! For 775 sqft I need to measure in person.");
  ck("reply without $5,100 → unchanged", fx === "Yes we do stairs! For 775 sqft I need to measure in person.", fx);
  ck("ai.ts hooks the backstop in the reply pipeline", /two-price ad backstop/.test(aiSrc) && /fixTwoTierPromoWording\(cleaned, usersLang\(\)\)/.test(aiSrc));

  // ── 4. LIVE ───────────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("\n[7] LIVE skipped (no ANTHROPIC_API_KEY)");
  } else {
    console.log("\n[7] LIVE: the model with the note injected");
    const base: ChatMessage[] = [{ role: "user", content: FAQ }, { role: "assistant", content: WHAT_IS_INCLUDED_TWO_TIER_ASK }];
    const runs = 3;
    let okEn = 0, okEs = 0, okJason = 0;
    const samples: string[] = [];
    for (let i = 0; i < runs; i++) {
      const en = await ai([...base, { role: "user", content: "So the $2,350 covers the vinyl, the quarter round and the installation, right?" + sys(AD_REPLY_NOTE, TIER) }]);
      if (SAYS_CONTRAST(en) && !CLAIMS_2350_INCLUDES(en) && !/mismatch|vary by flooring type|\$2 per/i.test(en)) okEn++; else samples.push("EN: " + en);
      const es = await ai([...base, { role: "user", content: "Entonces los $2,350 ya incluyen el piso vinilico y el quarter round?" + sys(AD_REPLY_NOTE, TIER) }]);
      if (/solo la instalaci|solo instalaci|solo mano de obra|mano de obra|t[uú] pones|no incluye|sin el piso|sin material|sin el material/i.test(es) && SAYS_FIVE_PER_SQFT(es) && !CLAIMS_2350_INCLUDES(es)) okEs++; else samples.push("ES: " + es);
      const jason = await ai([...base, { role: "user", content: "Vinyl, I have 775 SF over plywood on the 2nd floor. Can you do stairs as well?" + sys(TIER, "[LARGE LEAD ALERT: Client stated 775 sqft which is >= 500. This is a LARGE LEAD. You MUST propose the free in-person visit. Do NOT give any price or dollar amount for the floor, do NOT compute a total. Ask for the zip code if you do not have it.]") }]);
      if (/stairs|steps/i.test(jason) && /visit|measure|zip|in person|come by|swing by|stop by/i.test(jason) && !CLAIMS_2350_INCLUDES(jason)) okJason++; else samples.push("JASON: " + jason);
    }
    ck(`EN "so the $2,350 covers the vinyl, right?" → installation only + $5 promo (${okEn}/${runs})`, okEn === runs, samples.filter((s) => s.startsWith("EN")).join(" || "));
    ck(`ES "los $2,350 ya incluyen el piso?" → solo instalacion + $5 (${okEs}/${runs})`, okEs === runs, samples.filter((s) => s.startsWith("ES")).join(" || "));
    ck(`Jason's real 2nd turn (vinyl, 775 sqft, stairs) → stairs yes + visit, no $2,350-includes claim (${okJason}/${runs})`, okJason === runs, samples.filter((s) => s.startsWith("JASON")).join(" || "));
    console.log("  sample EN:", (await ai([...base, { role: "user", content: "So the $2,350 covers the vinyl, the quarter round and the installation, right?" + sys(AD_REPLY_NOTE, TIER) }])).replace(/\s+/g, " "));
  }

  console.log(`\n==================== RESULT: ${pass} passed, ${fail} failed ====================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
