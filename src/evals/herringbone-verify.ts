// Herringbone price (owner rule 2026-10-03): herringbone is NEVER the $5 vinyl
// promo. It is $4 per sqft for the installation labor plus $7.50 per sqft for
// our herringbone material.
// History: Mina (IG 03/10) found the vinyl herringbone from Maria Gomez's job on
// our page, wrote "I love that herringbone" and got "Yes, that's our vinyl! $5
// per sqft, includes the floor, labor, and quarter round". Henry (IG, same day)
// got the same $5 for "Herringbone Design in the living room".
// [1] static: the prompt carries the rule. [2] deterministic: the backstop.
// [3] live: the real conversation and variations through getAIResponse.
// Run: npx tsx src/evals/herringbone-verify.ts   (LIVE=0 skips [3])
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
const ALL_INCLUDED = /includ\w*[^.!?]{0,40}(?:floor|material|labor|quarter)|(?:floor|material)[^.!?]{0,30}includ/i;

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

async function main() {
  // ── 1. STATIC ─────────────────────────────────────────────────────────────
  console.log("\n[1] Prompt source carries the herringbone rule");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system-prompt.ts has the HERRINGBONE PATTERN section", /## HERRINGBONE PATTERN/.test(promptSrc));
  ck("prompt: $4 labor", /herringbone[^\n]{0,200}\$4 per (?:sqft|square foot)[^\n]{0,60}labor/i.test(promptSrc) || /INSTALLATION LABOR: \$4 per square foot/.test(promptSrc));
  ck("prompt: $7.50 material", /\$7\.50 per (?:sqft|square foot)/.test(promptSrc));
  ck("prompt: never the $5 promo", /NEVER the \$5/i.test(promptSrc));
  ck("PRICING list has herringbone", /Herringbone install \(labor only\): \$4\/sqft/.test(promptSrc));
  const dreamSrc = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("Dreaming hard constraint 16 (herringbone)", /16\. HERRINGBONE IS NEVER THE \$5 PROMO/.test(dreamSrc));

  // ── 2. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[2] Backstop: detection + fix");
  ck("Mina → herringbone", clientWantsHerringbone(MINA) === "herringbone");
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

  ck("Mina's bad reply is mispriced", replyMispricesHerringbone(MINA_BAD));
  ck("'$5/sqft' form detected", replyMispricesHerringbone("Vinyl at $5/sqft includes the material."));
  ck("'$2 per square foot' detected", replyMispricesHerringbone("if you supply it we install it at $2 per square foot."));
  ck("'$3.20 per sqft' detected", replyMispricesHerringbone("Hardwood is $3.20 per sqft for the labor."));
  ck("'$2.20' carpet NOT detected", !replyMispricesHerringbone("Carpet is $2.20 per sqft for the labor."));
  ck("'$5,175' total NOT detected", !replyMispricesHerringbone("That comes to about $5,175."));
  ck("already right ($4 + $7.50 + $5 for planks) NOT touched", !replyMispricesHerringbone("Herringbone is $4 per sqft labor plus $7.50 material, and the regular planks are $5 per sqft all included."));
  ck("stairs $150 per step NOT detected", !replyMispricesHerringbone("Stairs are $150 per step."));

  const fixed = fixHerringbonePrice(MINA_BAD, "en", "herringbone");
  ck("Mina fixed: $4 + $7.50, no $5, no 'includes the floor'", FOUR.test(fixed) && SEVEN50.test(fixed) && !FIVE.test(fixed) && !ALL_INCLUDED.test(fixed), fixed);
  ck("Mina fixed keeps the opener and the scope question", /^Yes, that's our vinyl!/.test(fixed) && /One area or the whole house\?$/.test(fixed), fixed);
  console.log("     → " + fixed);
  const inline = fixHerringbonePrice("Our vinyl promo is $5 per sqft with everything included, is it one area or the whole house?", "en", "herringbone");
  ck("question riding on the price sentence survives", /\$4/.test(inline) && /Is it one area or the whole house\?$/.test(inline) && !FIVE.test(inline), inline);
  const es = fixHerringbonePrice("Sí, ese es nuestro vinyl! Son $5 por pie cuadrado con el piso, la instalación y el quarter round incluidos. Es un área o toda la casa?", "es", "herringbone");
  ck("ES fixed", /\$4 por sqft/.test(es) && /\$7\.50/.test(es) && !FIVE.test(es) && /toda la casa\?$/.test(es), es);
  const mixed = fixHerringbonePrice("Our luxury vinyl promo is $5 per sqft, flooring and labor included, and we plan the layout so it runs flush. What's the zip code of the property?", "en", "mixed");
  ck("mixed: herringbone $4 + $7.50 AND planks $5", FOUR.test(mixed) && SEVEN50.test(mixed) && FIVE.test(mixed) && /zip code/.test(mixed), mixed);
  const hw = fixHerringbonePrice("Yes, we install herringbone hardwood. Hardwood is $3.20 per sqft for the labor only. How many square feet?", "en", "herringbone");
  ck("$3.20 sentence replaced whole (decimal is not a sentence end)", !/3\.20|^20 per/.test(hw) && FOUR.test(hw) && /How many square feet\?$/.test(hw), hw);
  const tagged = fixHerringbonePrice("Our promo is $5 per sqft. [NOTIFY_OWNER]", "en", "herringbone");
  ck("tags survive the fix", /\[NOTIFY_OWNER\]/.test(tagged) && /\$7\.50/.test(tagged), tagged);
  ck("text without a wrong rate is untouched", fixHerringbonePrice("For that size I come measure in person. What day works?", "en") === "For that size I come measure in person. What day works?");

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
  const herringbonePriced = (r: string) => FOUR.test(r) && SEVEN50.test(r) && !FIVE.test(r) && !ALL_INCLUDED.test(r);
  const noWrongRate = (r: string) => !FIVE.test(r) && !/\$\s?2(?![\d,]|\.\d)\s*(?:per|\/|a)/i.test(r) && !/\$3\.20/.test(r);

  await live("Mina replay → $4 labor + $7.50 material, never $5", MINA, herringbonePriced);
  await live("direct ask 'how much for herringbone vinyl?'", [
    U("Hi, how much for herringbone vinyl?"),
  ], (r) => herringbonePriced(r));
  await live("laminate herringbone, client supplies → $4 labor, never $2", [
    U("Do you install herringbone? I already bought white oak laminate in herringbone"),
  ], (r) => FOUR.test(r) && noWrongRate(r));
  await live("ES 'cuánto cuesta el piso en espiga?'", [
    U("Hola, cuánto cuesta el piso en espiga (herringbone) de vinyl?"),
  ], (r) => herringbonePriced(r) && !/[¿¡]/.test(r));
  await live("herringbone 1,200 sqft → no total, visit", [
    U("I want herringbone vinyl for about 1200 sqft, how much would it be?"),
  ], (r) => !/\$\s?\d{1,3},\d{3}/.test(r) && !FIVE.test(r));

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
