// Herringbone price (owner rule 2026-10-03, prices corrected by the owner on
// 2026-10-28): herringbone is NEVER the $5 vinyl promo. Its own promo is $7.50
// per sqft and that ALREADY INCLUDES our luxury vinyl herringbone floor (wood
// finish), the installation and the quarter round; $4 per sqft is the labor
// only (the client supplies the material).
// History: Mina (IG 03/10) found the vinyl herringbone from Maria Gomez's job on
// our page, wrote "I love that herringbone" and got "Yes, that's our vinyl! $5
// per sqft, includes the floor, labor, and quarter round". Henry (IG, same day)
// got the same $5 for "Herringbone Design in the living room". From 03/10 to
// 28/10 the rule was read as "$4 labor + $7.50 material on top" ($11.50): on
// 28/10 fb_28151851617823353 (850 sqft, came from a herringbone ad) got
// "Herringbone is $7.50 per sqft for the material and $4 per sqft for the labor"
// and the owner corrected it by hand.
// [1] static: the prompt carries the rule. [2] deterministic: the backstop.
// [3] live: the real conversations and variations through getAIResponse.
// Run: npx tsx src/evals/herringbone-verify.ts   (LIVE=0 skips [3], RUNS=n)
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, clientWantsHerringbone, replyMispricesHerringbone, fixHerringbonePrice, type ChatMessage } from "../lib/ai";

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
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

const FIVE = /\$\s?5(?:\.00)?(?![\d,]|\.\d)/;
const FOUR = /\$\s?4(?:\.00)?(?![\d,]|\.\d)/;
const SEVEN50 = /\$\s?7\.50?(?!\d)/;
const ELEVEN50 = /\$\s?11\.50?(?!\d)|11\.50/;
// The promo wording: the $7.50 comes with "included"/"incluido(s)"/"incluído(s)".
const INCLUDED = /includ|inclu[ií]d/i;
// The old framing: $7.50 sold as the material price on top of the labor.
const MATERIAL_FRAMING = /\$\s?7\.50?[^.!?\n]{0,40}?(?:for|of)\s+(?:the\s+|our\s+)?(?:herringbone\s+)?material|material\s+(?:is|at)\s+\$\s?7\.50?|on\s+top|plus\s+\$\s?7\.50?|\$\s?4(?![\d,]|\.\d)\s+labor\s+plus/i;

// Mina, IG 2026-10-03, verbatim up to the bad reply.
const MINA: ChatMessage[] = [
  U("Do you offer any discounts or promotions?"),
  A("Yes, larger spaces get our best pricing, and the estimate is free. Are you thinking tile, vinyl, or hardwood?"),
  U("Is this flooring something you supplied or the customer supplied? Is this available for stairs as well?"),
  U("[Client replied to our ad]"),
  A("Vinyl at $5/sqft includes the material, tile and hardwood are labor only. Stairs are $150 per step, material and installation included. Which type are you thinking?"),
  U("Is the one I sent from your page vinyl?"),
  A("I can't tell which ad you saw from my side, but the floors we sell are our own luxury vinyl, available in a wood finish or a stone/marble finish. Which type were you asking about, tile, vinyl, or hardwood?"),
  U("I sent it at 5:46pm"),
  A("The photo didn't come through on my side. We sell luxury vinyl in wood or marble finish, which one interests you?"),
  U("I found it on your page, it says vinyl for Maria Gomez in Miramar"),
  U("I love that herringbone"),
];
const MINA_BAD = "Yes, that's our vinyl! $5 per sqft, includes the floor, labor, and quarter round. One area or the whole house?";

// fb_28151851617823353, Messenger 2026-10-28, verbatim up to the bad reply.
const CURIOUS: ChatMessage[] = [
  U("What type of materials are included?"),
  A("Hi, our vinyl promo includes the floor, the installation and the quarter round, tile and hardwood are labor only, you supply the material. Which one are you interested in?"),
  U("I am remodeling 2 baths right now , so need to wait on floors .  But I have about 850 sq ft .  How much would materials cost for a herringbone pattern like in your ad ?"),
];
const CURIOUS_BAD = "Herringbone is $7.50 per sqft for the material and $4 per sqft for the labor. What's the zip code of the property?";
// The canned lines that ran from 03/10 to 28/10 (now wrong).
const OLD_EN = "Herringbone has its own price, it's $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft. Is it one area or the whole house?";
const OLD_ES = "El herringbone tiene su propio precio, son $4 por sqft de mano de obra de instalación, y nuestro material herringbone es $7.50 por sqft. Es un área o toda la casa?";
const OLD_PT = "O herringbone tem preço próprio, são $4 por sqft da mão de obra de instalação, e o nosso material herringbone é $7.50 por sqft. É uma área só ou a casa toda?";

const rightFraming = (r: string) => SEVEN50.test(r) && FOUR.test(r) && !FIVE.test(r) && !ELEVEN50.test(r) && !MATERIAL_FRAMING.test(r) && INCLUDED.test(r);

async function main() {
  // ── 1. STATIC ─────────────────────────────────────────────────────────────
  console.log("\n[1] Prompt source carries the corrected rule");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system-prompt.ts has the HERRINGBONE PATTERN section", /## HERRINGBONE PATTERN/.test(promptSrc));
  ck("prompt: $7.50 promo ALREADY INCLUDES floor + installation + quarter round", /\$7\.50 per square foot, and that price ALREADY INCLUDES our luxury vinyl herringbone floor[^\n]{0,80}installation labor and the quarter round/.test(promptSrc));
  ck("prompt: $4 labor only when the client supplies the material", /LABOR ONLY \(the client supplies the herringbone material\): \$4 per square foot/.test(promptSrc));
  ck("prompt: never the $5 promo", /NEVER the \$5/i.test(promptSrc));
  ck("prompt: $7.50 is never a material price", /\$7\.50 is NEVER a material price/.test(promptSrc));
  ck("PRICING list: herringbone promo $7.50 all included, install only $4", /Herringbone promo \(our luxury vinyl herringbone floor \+ installation \+ quarter round, all included\): \$7\.50\/sqft\. Herringbone install only \(client supplies the material\): \$4\/sqft/.test(promptSrc));
  ck("prompt: 450 sqft with our floor = $3,375, no $5,175 anywhere", /450 x 7\.50 = about \$3,375/.test(promptSrc) && !/5,175|11\.50 per square foot in total|on top of the labor/.test(promptSrc));
  ck("prompt: herringbone ads ($4,000 / $7,600) are ours", /\$4,000 without materials \/ \$7,600 with materials/.test(promptSrc));
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("ai.ts rules 18/19/32 carry the corrected prices", /herringbone sqft x \$7\.50 with our herringbone floor/.test(aiSrc) && /\$7\.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included; \$4 per sqft labor only/.test(aiSrc) && /Our HERRINGBONE ads show "\$4,000 for 1000 sq ft without materials"/.test(aiSrc) && !/sqft x \$11\.50|\$7\.50 per sqft for our herringbone material/.test(aiSrc));
  const dreamSrc = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("Dreaming hard constraint 16 (herringbone) + pricing line corrected", /16\. HERRINGBONE IS NEVER THE \$5 PROMO/.test(dreamSrc) && /Herringbone: \$7\.50\/sqft with our luxury vinyl herringbone floor/.test(dreamSrc) && !/\$4\/sqft labor \+ \$7\.50\/sqft our herringbone material/.test(dreamSrc));

  // ── 2. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[2] Backstop: detection + fix");
  ck("Mina → herringbone", clientWantsHerringbone(MINA) === "herringbone");
  ck("28/10 client ('herringbone pattern like in your ad') → herringbone", clientWantsHerringbone(CURIOUS) === "herringbone");
  ck("Henry 'Herringbone Design in the living room and wide plank in kitchen' → mixed", clientWantsHerringbone([U("[Client replied to our ad]"), U("Herringbone Design in the living room and wide plank in kitchen and bedroom")]) === "mixed");
  ck("'hearing bone and laminate' (misspelling) → herringbone", clientWantsHerringbone([U("Do you have hearing bone and laminate? If so, what is the price range")]) === "herringbone");
  ck("'herring bone' / 'herringbon' / 'harringbone'", ["I want herring bone", "herringbon floor please", "harringbone vinyl"].every(t => clientWantsHerringbone([U(t)]) === "herringbone"));
  ck("ES 'piso en espiga' / PT 'espinha de peixe'", clientWantsHerringbone([U("quiero piso en espiga")]) === "herringbone" && clientWantsHerringbone([U("quero espinha de peixe na sala")]) === "herringbone");
  ck("'herringbone vinyl planks' is ONE floor (not mixed)", clientWantsHerringbone([U("I want herringbone vinyl planks")]) === "herringbone");
  ck("'not herringbone, just regular' → null", clientWantsHerringbone([U("I like herringbone"), U("actually not herringbone, just regular planks")]) === null);
  ck("tile herringbone → null (tile rules)", clientWantsHerringbone([U("24x48 porcelain tile in herringbone, 800 sqft")]) === null);
  ck("no herringbone anywhere → null", clientWantsHerringbone([U("I want vinyl for the whole house"), U("how much?")]) === null);
  ck("assistant-only mention does not count", clientWantsHerringbone([U("hi"), A("We completed this project in herringbone"), U("how much?")]) === null);
  ck("photo analysis bracket alone does not count", clientWantsHerringbone([U("[Floor plan analysis: herringbone-pattern hardwood flooring]")]) === null);

  console.log("  — wrong rates ($5 / $2 / $3.20) still caught");
  ck("Mina's bad reply is mispriced", replyMispricesHerringbone(MINA_BAD));
  ck("'$5/sqft' form detected", replyMispricesHerringbone("Vinyl at $5/sqft includes the material."));
  ck("'$2 per square foot' detected", replyMispricesHerringbone("if you supply it we install it at $2 per square foot."));
  ck("'$3.20 per sqft' detected", replyMispricesHerringbone("Hardwood is $3.20 per sqft for the labor."));
  ck("'$2.20' carpet NOT detected", !replyMispricesHerringbone("Carpet is $2.20 per sqft for the labor."));
  ck("'$3,375' total NOT detected", !replyMispricesHerringbone("That comes to about $3,375."));
  ck("stairs $150 per step NOT detected", !replyMispricesHerringbone("Stairs are $150 per step."));

  console.log("  — the 03/10→28/10 framing ($7.50 as material on top of $4) is now caught");
  ck("28/10 reply '$7.50 for the material and $4 for the labor' is mispriced", replyMispricesHerringbone(CURIOUS_BAD));
  ck("old EN canned ('our herringbone material is $7.50') is mispriced", replyMispricesHerringbone(OLD_EN));
  ck("old ES canned ('nuestro material herringbone es $7.50') is mispriced", replyMispricesHerringbone(OLD_ES));
  ck("old PT canned ('o nosso material herringbone é $7.50') is mispriced", replyMispricesHerringbone(OLD_PT));
  ck("'$4 labor plus $7.50 material' is mispriced", replyMispricesHerringbone("Herringbone is $4 per sqft labor plus $7.50 per sqft material. How many square feet?"));
  ck("'$11.50 per sqft in total' is mispriced", replyMispricesHerringbone("With our material that is $11.50 per sqft in total."));
  ck("'$7.50 per sqft on top of the labor' is mispriced", replyMispricesHerringbone("The material is our luxury vinyl herringbone at $7.50 per sqft on top of the labor."));
  ck("'$4 por sqft de mano de obra más $7.50' is mispriced", replyMispricesHerringbone("Son $4 por sqft de mano de obra más $7.50 por sqft del material."));
  ck("'material costs $7.50 per sqft' is mispriced", replyMispricesHerringbone("Labor is $4 per sqft and the material costs $7.50 per sqft."));

  console.log("  — the corrected wording is left alone");
  ck("'$7.50 ... included, or $4 labor only' NOT mispriced", !replyMispricesHerringbone("Herringbone has its own promo: $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if you supply the material. What's the zip code of the property?"));
  ck("'$7.50 includes the material, the installation and the quarter round' NOT mispriced", !replyMispricesHerringbone("The $7.50 per sqft includes the material, the installation and the quarter round. Labor only is $4 per sqft."));
  ck("'$7.50 with materials included, plus we bring samples' NOT mispriced", !replyMispricesHerringbone("Herringbone is $7.50 per sqft with materials included, plus we bring samples to the free visit. Labor only is $4 per sqft."));
  ck("ES '$7.50 con el material incluido, o $4 solo mano de obra' NOT mispriced", !replyMispricesHerringbone("El herringbone es $7.50 por sqft con el material, la instalación y el quarter round incluidos, o $4 por sqft solo mano de obra."));
  ck("mixed right ($7.50 all included, $4 labor, $5 for the planks) NOT touched", !replyMispricesHerringbone("Herringbone is $7.50 per sqft all included or $4 per sqft labor only, and the regular planks are $5 per sqft all included."));
  ck("'$4 per sqft labor only, and $7.50 with our floor included' (reversed order) NOT mispriced", !replyMispricesHerringbone("Herringbone is $4 per sqft labor only if you supply the material, and $7.50 per sqft with our floor, installation and quarter round included."));

  const curious = fixHerringbonePrice(CURIOUS_BAD, "en", "herringbone");
  ck("28/10 reply fixed: $7.50 all included + $4 labor only, no material framing, zip question kept", rightFraming(curious) && /What's the zip code of the property\?$/.test(curious), curious);
  console.log("     → " + curious);
  const fixed = fixHerringbonePrice(MINA_BAD, "en", "herringbone");
  ck("Mina fixed: $7.50 + $4, no $5, promo wording", rightFraming(fixed), fixed);
  ck("Mina fixed keeps the opener and the scope question", /^Yes, that's our vinyl!/.test(fixed) && /One area or the whole house\?$/.test(fixed), fixed);
  console.log("     → " + fixed);
  const oldEn = fixHerringbonePrice(OLD_EN, "en", "herringbone");
  ck("old EN canned fixed, scope question kept", rightFraming(oldEn) && /Is it one area or the whole house\?$/.test(oldEn), oldEn);
  const oldEs = fixHerringbonePrice(OLD_ES, "es", "herringbone");
  ck("old ES canned fixed (incluidos, sin ¿¡)", SEVEN50.test(oldEs) && FOUR.test(oldEs) && /incluidos/.test(oldEs) && !/material herringbone es/.test(oldEs) && !/[¿¡]/.test(oldEs) && /toda la casa\?$/.test(oldEs), oldEs);
  const oldPt = fixHerringbonePrice(OLD_PT, "pt", "herringbone");
  ck("old PT canned fixed (incluídos)", SEVEN50.test(oldPt) && FOUR.test(oldPt) && /incluídos/.test(oldPt) && !/material herringbone é/.test(oldPt) && /casa toda\?$/.test(oldPt), oldPt);
  const inline = fixHerringbonePrice("Our vinyl promo is $5 per sqft with everything included, is it one area or the whole house?", "en", "herringbone");
  ck("question riding on the price sentence survives", rightFraming(inline) && /Is it one area or the whole house\?$/.test(inline), inline);
  const es = fixHerringbonePrice("Sí, ese es nuestro vinyl! Son $5 por pie cuadrado con el piso, la instalación y el quarter round incluidos. Es un área o toda la casa?", "es", "herringbone");
  ck("ES fixed", /\$7\.50 por sqft/.test(es) && FOUR.test(es) && !FIVE.test(es) && /toda la casa\?$/.test(es), es);
  const mixed = fixHerringbonePrice("Our luxury vinyl promo is $5 per sqft, flooring and labor included, and we plan the layout so it runs flush. What's the zip code of the property?", "en", "mixed");
  ck("mixed: herringbone $7.50 + $4 AND planks $5", SEVEN50.test(mixed) && FOUR.test(mixed) && FIVE.test(mixed) && !MATERIAL_FRAMING.test(mixed) && /zip code/.test(mixed), mixed);
  const hw = fixHerringbonePrice("Yes, we install herringbone hardwood. Hardwood is $3.20 per sqft for the labor only. How many square feet?", "en", "herringbone");
  ck("$3.20 sentence replaced whole (decimal is not a sentence end)", !/3\.20|^20 per/.test(hw) && rightFraming(hw) && /How many square feet\?$/.test(hw), hw);
  const total = fixHerringbonePrice("Herringbone is $4 per sqft labor plus $7.50 per sqft material, so 450 sqft with our material is about $5,175.", "en", "herringbone");
  ck("'$4 labor plus $7.50 material ... $5,175' sentence replaced whole", rightFraming(total) && !/5,175/.test(total), total);
  const tagged = fixHerringbonePrice("Our promo is $5 per sqft. [NOTIFY_OWNER]", "en", "herringbone");
  ck("tags survive the fix", /\[NOTIFY_OWNER\]/.test(tagged) && SEVEN50.test(tagged), tagged);
  ck("text without a wrong rate is untouched", fixHerringbonePrice("For that size I come measure in person. What day works?", "en") === "For that size I come measure in person. What day works?");
  const right = "Herringbone has its own promo: $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if you supply the material. What's the zip code?";
  ck("the corrected wording is untouched by the fixer", fixHerringbonePrice(right, "en") === right);

  if (process.env.LIVE === "0") return;

  // ── 3. LIVE ───────────────────────────────────────────────────────────────
  console.log("\n[3] Live (getAIResponse)");
  const runs = Number(process.env.RUNS || 3);
  const live = async (name: string, msgs: ChatMessage[], ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = await ai(msgs);
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };
  const herringbonePriced = (r: string) => rightFraming(r) && !replyMispricesHerringbone(r);
  const noWrongRate = (r: string) => !FIVE.test(r) && !/\$\s?2(?![\d,]|\.\d)\s*(?:per|\/|a)/i.test(r) && !/\$3\.20/.test(r) && !MATERIAL_FRAMING.test(r) && !ELEVEN50.test(r);

  // The client asked the price WITH materials: the $7.50 all-included line is the
  // answer, the $4 labor-only figure is welcome but not required here.
  await live("28/10 replay (850 sqft, 'how much would materials cost for a herringbone pattern like in your ad?') → $7.50 all included, never '$7.50 material', no total", CURIOUS, (r) => SEVEN50.test(r) && INCLUDED.test(r) && !FIVE.test(r) && !ELEVEN50.test(r) && !MATERIAL_FRAMING.test(r) && !replyMispricesHerringbone(r) && !/\$\s?\d{1,3},\d{3}/.test(r));
  await live("Mina replay → $7.50 all included / $4 labor only, never $5", MINA, herringbonePriced);
  await live("direct ask 'how much for herringbone vinyl?'", [
    U("Hi, how much for herringbone vinyl?"),
  ], herringbonePriced);
  await live("laminate herringbone, client supplies → $4 labor, never $2, never '$7.50 material'", [
    U("Do you install herringbone? I already bought white oak laminate in herringbone"),
  ], (r) => FOUR.test(r) && noWrongRate(r));
  await live("ES 'cuánto cuesta el piso en espiga?'", [
    U("Hola, cuánto cuesta el piso en espiga (herringbone) de vinyl?"),
  ], (r) => herringbonePriced(r) && !/[¿¡]/.test(r));
  await live("herringbone 1,200 sqft → no total, visit", [
    U("I want herringbone vinyl for about 1200 sqft, how much would it be?"),
  ], (r) => !/\$\s?\d{1,3},\d{3}/.test(r) && !FIVE.test(r) && !MATERIAL_FRAMING.test(r));
  await live("450 sqft with our herringbone floor → 450 x 7.50 = $3,375, never $5,175", [
    U("I want your herringbone vinyl, your floor, it's 450 sqft. How much total?"),
  ], (r) => /3,?375/.test(r) && !/5,?175/.test(r) && !ELEVEN50.test(r));

  // Regression: plain vinyl is still the $5 promo.
  await live("REGRESSION plain vinyl → still $5 with everything included", [
    U("Hi! How much is your flooring?"),
    A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("vinyl"),
  ], (r) => FIVE.test(r) && !SEVEN50.test(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
