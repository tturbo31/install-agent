// Floor color = the website (owner rule 2026-10-03): whenever the client asks
// about the color of the floor, the reply carries https://ozzifloors.company so
// they can check the colors there.
// History: Ariadna (WA 30/09, quote of $5,700 already given) asked to see the
// vinyl colors and sent photos from our Facebook asking whether they were the
// same color; the quote follow-up brain treated color as "product details" and
// answered twice "the best is to reach Ozzi directly at (561) 674-8334".
// [1] static prompts. [2] deterministic detection + fix. [3] live: main brain
// and the quote follow-up brain (Ariadna's real messages).
// Run: npx tsx src/evals/color-site-verify.ts   (LIVE=0 skips [3])
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isFloorColorQuestion, withSiteForColor, isColorPhoneHandoffOnly, type ChatMessage } from "../lib/ai";
import { composeQuoteReply, buildQuoteCtxMarker, parseQuoteCtxMarker } from "../lib/quote-reply";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
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
const SITE = /https:\/\/ozzifloors\.company/;
const PHONE = /674.?8334/;

async function main() {
  // ── 1. STATIC ─────────────────────────────────────────────────────────────
  console.log("\n[1] Prompts carry the rule");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system prompt (2d) color → website", /\(2d\) ANY QUESTION ABOUT THE COLOR OF THE FLOOR/.test(sp));
  ck("AD FLOOR QUESTIONS points color to (2d)", /its COLOR \(or its name[^\n]{0,120}follow \(2d\)/.test(sp));
  const qr = readFileSync(join(process.cwd(), "src/lib/quote-reply.ts"), "utf-8");
  ck("quote brain rule 18 (colors → website)", /18\. COLORS ALWAYS GET OUR WEBSITE/.test(qr));
  ck("quote brain rule 11 no longer sends colors to Ozzi", /product details other than colors/.test(qr));

  // ── 2. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[2] Detection");
  const yes = [
    "Would you be able to send me sample of the vinyl flooring so I can see all the Colors you offer",
    "Do they look different color because of the lighting?",
    "Porfvaor enviar que colores tienen",
    "what color is the one from your page?",
    "Qué color es ese piso?",
    "qual a cor desse piso?",
    "vocês têm essa cor?",
    "Do you have it in gray tones?",
    "what colors you have",
  ];
  for (const t of yes) ck(`color question: "${t}"`, isFloorColorQuestion(t));
  const no = [
    "Same color different quality",
    "I like to maintain the color I have which is a light beige because the bathrooms have the same tile colors so I want everything to match. So I think tile?",
    "What color grout do you use?",
    "Can you paint the walls a different color?",
    "What color are the baseboards?",
    "This is more of the color that I'm aiming towards",
    "how much for 1200 sqft?",
    "[Floor plan analysis: vinyl plank flooring in a gray wood-look color]",
  ];
  for (const t of no) ck(`NOT a color question: "${t.slice(0, 60)}"`, !isFloorColorQuestion(t));

  console.log("\n[2b] Fix");
  const handoff = "For samples and color options, the best is to reach Ozzi directly at (561) 674-8334 and he can walk you through everything available.";
  ck("Ariadna's reply is a color-only phone handoff", isColorPhoneHandoffOnly(handoff));
  const f1 = withSiteForColor(handoff, "en");
  ck("handoff → website, no phone", SITE.test(f1) && !PHONE.test(f1), f1);
  console.log("     → " + f1);
  const f2 = withSiteForColor("I can't see which ad you came from on my side, but the floors we sell are luxury vinyl. Which one are you interested in?", "en");
  ck("site goes before the closing question", SITE.test(f2) && /Which one are you interested in\?$/.test(f2), f2);
  console.log("     → " + f2);
  const f3 = withSiteForColor("Claro, lo vemos en la visita. [NOTIFY_OWNER]", "es");
  ck("ES + tag kept", /ozzifloors\.company/.test(f3) && /colores/.test(f3) && /\[NOTIFY_OWNER\]$/.test(f3), f3);
  ck("[REACT_ONLY] stays untouched", withSiteForColor("[REACT_ONLY]", "en") === "[REACT_ONLY]");
  ck("reply already with the site stays untouched", withSiteForColor("See them at https://ozzifloors.company. One area or the whole house?") === "See them at https://ozzifloors.company. One area or the whole house?");
  const mixed = "Your quote total is $5,700. For samples and color options, the best is to reach Ozzi directly at (561) 674-8334.";
  ck("mixed reply is NOT color-only", !isColorPhoneHandoffOnly(mixed));
  const f4 = withSiteForColor(mixed, "en");
  ck("mixed: keeps the quote, swaps the color handoff for the site", /\$5,700/.test(f4) && SITE.test(f4) && !PHONE.test(f4), f4);

  if (process.env.LIVE === "0") return;

  // ── 3. LIVE ───────────────────────────────────────────────────────────────
  console.log("\n[3] Live");
  const runs = Number(process.env.RUNS || 2);
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const live = async (name: string, fn: () => Promise<string>, ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = await fn();
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };

  // Main brain
  await live("main: 'what colors do you have?' after vinyl price", () => ai([
    U("Hi, I'm interested in vinyl"),
    A("Our vinyl promo is $5 per sqft and that already includes the floor, the installation and the quarter round. Is it one area or the whole house?"),
    U("what colors do you have?"),
  ]), (r) => SITE.test(r));
  await live("main: 'what color is the floor from your page?'", () => ai([
    U("Hi"),
    A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("I saw a floor on your Instagram page, what color is that one?"),
  ]), (r) => SITE.test(r) && !PHONE.test(r));
  await live("main ES: 'qué colores tienen?'", () => ai([
    U("Hola, me interesa el vinyl"),
    A("Nuestra promo de vinyl es $5 por sqft e incluye el piso, la instalación y el quarter round. Es un área o toda la casa?"),
    U("qué colores tienen?"),
  ]), (r) => SITE.test(r) && !/[¿¡]/.test(r));

  // Quote follow-up brain, Ariadna's real messages.
  const marker = buildQuoteCtxMarker({ valor: 5700, parcela: 158, idioma: "en", url: "https://app.gethearth.com/partners/ozzifloors" });
  const ctx = parseQuoteCtxMarker(marker, new Date().toISOString())!;
  const hist = [
    { role: "assistant", content: "Hi Ariadna, your $5,700 quote does not have to be paid all at once. You can finance it for as low as $158 a month, and checking your options takes about 2 minutes with no impact to your credit score. Fill out the short application here: https://app.gethearth.com/partners/ozzifloors" + marker },
    { role: "assistant", content: "As soon as your application is approved, call or text Ozzi directly at (561) 674-8334 to finalize everything." },
  ];
  const q1 = "Would you be able to send me sample of the vinyl flooring so I can see all the Colors you offer";
  await live("quote: Ariadna asks for the colors → website, no handoff", async () => {
    const r = await composeQuoteReply({ ctx, history: [...hist, { role: "user", content: q1 }], clientText: q1 });
    return `${r.text} {notify=${r.notifyOwner}}`;
  }, (r) => SITE.test(r) && /notify=false/.test(r));
  const q2 = "Hi good afternoon I wanted to see if these both are the same ?\nDo they look different color because of the lighting?\nI got these both from your Facebook";
  await live("quote: 'same color? from your Facebook' → website", async () => {
    const r = await composeQuoteReply({ ctx, history: [...hist, { role: "user", content: q2 }], clientText: q2 });
    return `${r.text} {notify=${r.notifyOwner}}`;
  }, (r) => SITE.test(r));
  const q3 = "Can you lower the price to $5,000?";
  await live("quote REGRESSION: negotiation still goes to Ozzi (no site)", async () => {
    const r = await composeQuoteReply({ ctx, history: [...hist, { role: "user", content: q3 }], clientText: q3 });
    return `${r.text} {notify=${r.notifyOwner}}`;
  }, (r) => PHONE.test(r) && /notify=true/.test(r) && !SITE.test(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
