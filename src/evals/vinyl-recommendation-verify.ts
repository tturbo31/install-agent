/**
 * RECOMENDAÇÃO = VINIL, casa ou comércio (caso Khushal Dua, Messenger 24/09/2026).
 *
 * O cliente tem um restaurante e disse "whatever you recommend". O bot respondeu
 * "For a restaurant I'd go with porcelain tile, it handles heavy foot traffic";
 * quando o cliente perguntou "Vinyl is not good for a restaurant?", dobrou a
 * aposta ("Vinyl can work but for a restaurant tile holds up better"). Regra do
 * dono: a recomendação é SEMPRE o nosso vinil, para casas e para comércio
 * (restaurante, loja, escritório, salão), nunca tile nem hardwood por cima dele.
 *
 * Puro (sem modelo):
 *  1. replyRecommendsAgainstVinyl: pega as duas replies reais e variantes EN/ES/PT;
 *     replies inocentes (preço do tile, vinil por cima do tile, carpete) passam.
 *  2. clientChoseTileOrHardwood: só a escolha explícita do cliente conta; pergunta,
 *     comparação e piso existente não contam.
 *  3. fixVinylRecommendation: a frase da recomendação vira vinil, a pergunta de
 *     continuidade e as tags ficam, reply certa fica igual.
 *  4. Prompt carrega a regra (seção WHAT WE RECOMMEND + reminder 41).
 * Ao vivo (LIVE=1): 6 chamadas (replay do caso real em 2 pontos, casa EN, loja ES,
 *   restaurante PT, comparação salão EN), cada uma conferindo vinil recomendado,
 *   nada de tile/hardwood por cima, e resposta CURTA e humana (≤2 frases, ≤220
 *   caracteres visíveis, sem frase corporativa, sem traço, sem emoji).
 * Run: npx tsx src/evals/vinyl-recommendation-verify.ts   |   LIVE=1 npx tsx src/evals/vinyl-recommendation-verify.ts
 */
import { replyRecommendsAgainstVinyl, clientChoseTileOrHardwood, fixVinylRecommendation, getAIResponse, type ChatMessage } from "../lib/ai";
import { visibleLength, sentenceCount } from "../lib/reply-length";
import { readFileSync } from "fs";
import { join } from "path";

function loadEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

const REAL_1 = "For a restaurant I'd go with porcelain tile, it handles heavy foot traffic and is easy to clean. How many square feet is the space?";
const REAL_2 = "Vinyl can work but for a restaurant tile holds up better to heavy foot traffic and is easier to clean, so I'd stick with that recommendation. I still need your phone number to hold the Friday 3pm visit!";

console.log("\n━━ 1. replyRecommendsAgainstVinyl ━━");
for (const r of [
  REAL_1, REAL_2,
  "For a busy salon I'd recommend porcelain tile, it's more durable. How big is the space?",
  "Honestly, tile is the better choice for a restaurant kitchen. What's the square footage?",
  "Vinyl isn't ideal for a restaurant, hardwood or tile would hold up better. How many sqft?",
  "For heavy foot traffic tile would be the smarter option. One area or the whole store?",
  "My recommendation would be porcelain for a commercial space. How many square feet?",
  "Para un restaurante te recomiendo porcelanato, aguanta más el tráfico. Cuántos pies cuadrados son?",
  "El vinyl puede funcionar, pero el porcelanato resiste mejor en un restaurante. Qué tamaño tiene el local?",
  "Para restaurante eu recomendo porcelanato, aguenta mais o tráfego. Quantos sqft tem o espaço?",
  "O vinil pode funcionar, mas o porcelanato resiste melhor num restaurante. Qual o tamanho?",
]) ck(`pega: «${r.slice(0, 60)}»`, replyRecommendsAgainstVinyl(r), r);
for (const r of [
  "I'd go with our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great to heavy traffic. How many square feet is the space?",
  "Vinyl is a great fit for a restaurant, it's 100% waterproof and handles heavy traffic no problem. Can I get the best phone number for the visit?",
  "For tile our promo is $4.50 per sqft for the labor only, you supply the tile. Is it one area or the whole house?",
  "Our luxury vinyl goes right over the existing tile, no demo needed. What's the approximate square footage?",
  "Yes, we install carpet, $2.20 per sqft labor only. One area or the whole house?",
  "We don't sell tile materials. We only do the installation. However, you can find wood-look tiles at stores like Floor & Decor.",
  "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?",
  "Perfect, see you then! [BOOK:{\"name\":\"\",\"phone\":\"6892863042\",\"address\":\"1910 E Sunrise Blvd, Fort Lauderdale 33304\",\"date\":\"2026-09-25\",\"time\":\"3pm\"}]",
  "Yo iría con nuestro vinyl de lujo, es 100% impermeable y aguanta muy bien el tráfico pesado. Cuántos pies cuadrados son?",
  "Eu iria com o nosso vinil de luxo, é 100% à prova d'água e aguenta muito bem tráfego pesado. Quantos sqft tem?",
]) ck(`não pega: «${r.slice(0, 60)}»`, !replyRecommendsAgainstVinyl(r), r);

console.log("\n━━ 2. clientChoseTileOrHardwood ━━");
const opener = A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?");
for (const [msgs, want, label] of [
  [[U("Hi"), opener, U("I have a restaurant i want to install in there\nWhatever you recommend")], null, "whatever you recommend"],
  [[U("Hi"), opener, U("Vinyl is not good for a restaurant?")], null, "vinyl is not good for a restaurant?"],
  [[U("Hi"), opener, U("Tile or vinyl, what's better for a store?")], null, "tile or vinyl?"],
  [[U("Hi"), opener, U("There is a tiles there right now, just need to install vinyl top of that")], null, "tile existente + vinil por cima"],
  [[U("Hi"), opener, U("I want to put vinyl over the old tile")], null, "vinyl over old tile"],
  [[U("Hi"), opener, U("Which one do you recommend, hardwood or tile?")], null, "hardwood or tile?"],
  [[U("Hi"), opener, U("Tile")], "tile", "«Tile» seco"],
  [[U("Hi"), opener, U("I want tile for the kitchen, about 450 sqft")], "tile", "I want tile"],
  [[U("Hi"), opener, U("Hardwood for the bedrooms")], "hardwood", "hardwood for the bedrooms"],
  [[U("Hi"), opener, U("Porcelanato para la sala")], "tile", "porcelanato ES"],
  [[U("Hi"), opener, U("Quiero madera para los cuartos")], "hardwood", "madera ES"],
  [[U("Hi"), opener, U("Tile\n\n[SYSTEM: REAL-TIME SCHEDULE …]")], "tile", "«Tile» com sufixo SYSTEM"],
] as Array<[ChatMessage[], "tile" | "hardwood" | null, string]>) {
  const got = clientChoseTileOrHardwood(msgs);
  ck(`${label} → ${want}`, got === want, `got ${got}`);
}

console.log("\n━━ 3. fixVinylRecommendation ━━");
const f1 = fixVinylRecommendation(REAL_1, "en");
ck("caso real 1: tile some, vinil entra", /luxury vinyl/i.test(f1) && !/porcelain|tile/i.test(f1), f1);
ck("caso real 1: pergunta de continuidade sobrevive", /How many square feet is the space\?$/.test(f1), f1);
ck("caso real 1: sem recomendação contra vinil", !replyRecommendsAgainstVinyl(f1), f1);
const f2 = fixVinylRecommendation(REAL_2, "en");
ck("caso real 2: 'vinyl can work but' vira SIM", /^Vinyl is a great fit/.test(f2) && !/tile|stick with/i.test(f2), f2);
ck("caso real 2: pedido do telefone sobrevive", /I still need your phone number to hold the Friday 3pm visit!$/.test(f2), f2);
ck("caso real 2: ≤2 frases", (f2.match(/[.!?](?:\s|$)/g) ?? []).length <= 2, f2);
const f3 = fixVinylRecommendation("Vinyl isn't ideal for a restaurant. Tile would be the better option, it's more durable. How many sqft is the space?", "en");
ck("duas frases contra vinil: uma vira vinil, a outra some", (f3.match(/vinyl/gi) ?? []).length >= 1 && !/tile/i.test(f3) && /How many sqft is the space\?$/.test(f3) && (f3.match(/[.!?](?:\s|$)/g) ?? []).length <= 2, f3);
const fEs = fixVinylRecommendation("Para un restaurante te recomiendo porcelanato, aguanta más. Cuántos pies cuadrados son?", "es");
ck("ES: vinyl de lujo + pergunta mantida + sem ¿", /vinyl de lujo/.test(fEs) && !/porcelanato/.test(fEs) && /Cuántos pies cuadrados son\?$/.test(fEs) && !/[¿¡]/.test(fEs), fEs);
const fPt = fixVinylRecommendation("Para restaurante eu recomendo porcelanato, aguenta mais o tráfego. Quantos sqft tem o espaço?", "pt");
ck("PT: vinil de luxo + pergunta mantida", /vinil de luxo/.test(fPt) && !/porcelanato/.test(fPt) && /Quantos sqft tem o espaço\?$/.test(fPt), fPt);
const good = "I'd go with our luxury vinyl, it's 100% waterproof and holds up great to heavy traffic. How many square feet is the space?";
ck("reply certa fica igual", fixVinylRecommendation(good, "en") === good);
const tagged = REAL_1 + " [NOTIFY_OWNER]";
const fTag = fixVinylRecommendation(tagged, "en");
ck("tag [NOTIFY_OWNER] intacta", /\[NOTIFY_OWNER\]$/.test(fTag) && /luxury vinyl/.test(fTag) && !/porcelain/.test(fTag), fTag);
for (const s of [f1, f2, fEs, fPt]) ck(`sem traço/emoji: «${s.slice(0, 40)}»`, !/[—–-]/.test(s.replace(/\d-\w/g, "")) && !/[\u{1F300}-\u{1FAFF}]/u.test(s), s);

console.log("\n━━ 4. prompt ━━");
const base = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
ck("seção WHAT WE RECOMMEND no prompt base", /## WHAT WE RECOMMEND: OUR LUXURY VINYL, HOMES AND BUSINESSES ALIKE/.test(base));
ck("prompt base proíbe tile/hardwood por cima do vinil", /NEVER recommend tile, porcelain, ceramic or hardwood over vinyl/.test(base));
ck("prompt base: 'whatever you recommend' = vinil, tipo conhecido", /"Whatever you recommend" means the client picked VINYL/.test(base));
// A/B de 24/09 no cenário sentinela "480 sqft após o pacote de vinyl" (tem que
// dar o total $2,400; base 3/3, histórico 18/18): a mesma regra como reminder 41
// no FIM dos FINAL REMINDERS deu 0/6; a regra 21 reescrita para "the answer is
// ALWAYS our luxury vinyl" deu 1/6 (3/6 e 2/6 nas variantes); a regra 21 ORIGINAL
// com a seção nova deu 5/6. Texto novo no fim do prompt faz o modelo re-checar
// "pergunte o tipo primeiro". A regra vive SÓ na seção do prompt base.
ck("NENHUMA regra 41 no fim dos FINAL REMINDERS (derrubou o fluxo de 480 sqft, 0/6)", !/41\. RECOMMENDATION/.test(ai));
ck("regra 21 fica ORIGINAL (reescrevê-la derrubou o fluxo de 480 sqft, 1/6)", /If they ask you to recommend something, give a brief direction based on their style and then invite them to browse for the exact look\./.test(ai) && !/see WHAT WE RECOMMEND in the base prompt/.test(ai));

const CORPORATE = /\b(?:in order to|at your earliest convenience|please be advised|do not hesitate|kindly|I would be happy to|feel free to)\b/i;
function short(text: string): { ok: boolean; why: string } {
  const vis = text.replace(/\[BOOK:\s*\{[\s\S]*?\}\]/g, " ").replace(/\[[A-Z][A-Z_]{2,}(?::[^\]]*)?\]/g, " ").replace(/\s+/g, " ").trim();
  const sentences = sentenceCount(text);
  const len = visibleLength(text);
  const why = `${sentences} frases, ${len} chars`;
  // A rede de frases reescreve 3+ frases UMA vez; quando o modelo devolve 3 frases
  // curtas (<= 200 chars) a reescrita mais curta é aceita mesmo assim, então isso
  // é aviso, não falha. Falha: > 220 chars, 4+ frases, ou 3 frases longas.
  if (sentences === 3 && len <= 200) console.log(`  ⚠️ 3 frases curtas (${len} chars): «${vis.slice(0, 200)}»`);
  const okLen = len <= 220 && (sentences <= 2 || (sentences === 3 && len <= 200));
  return { ok: okLen && !CORPORATE.test(vis) && !/[—–]/.test(vis) && !/[\u{1F300}-\u{1FAFF}]/u.test(vis), why };
}

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 5. ao vivo ━━");
  const processOpener = A("Hi, we move the furniture, install the floor and leave everything clean, usually in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?");
  const cases: Array<[string, ChatMessage[]]> = [
    ["caso real ponto 1 (restaurante, whatever you recommend)", [
      U("What is the installation process?"), processOpener,
      U("I have a restaurant i want to install in there\nWhatever you recommend"),
    ]],
    ["caso real ponto 2 (bot já tinha dito tile; cliente pergunta se vinil não serve)", [
      U("What is the installation process?"), processOpener,
      U("I have a restaurant i want to install in there\nWhatever you recommend"),
      A(REAL_1),
      U("Its around 1400 sqft"),
      A("For that size I need to measure in person to give you the right number, it's a free visit and I bring samples. Does Friday at 3pm or 8pm work?"),
      U("3pm to 5pm works"),
      A("Friday at 3pm works! Can I get the full property address with the zip code and the best phone number for the visit?"),
      U("Vinyl is not good for a restaurant?\n1910 e sunrise bvld Fort Lauderdale 33304"),
    ]],
    ["casa EN (what do you recommend)", [U("Hi, I'm redoing my whole house, about 1800 sqft. What do you recommend?")]],
    ["loja ES (qué me recomiendan)", [U("Hola, tengo una tienda de ropa de unos 900 pies cuadrados, qué piso me recomiendan?")]],
    ["restaurante PT (o que recomendam)", [U("Oi, tenho um restaurante de uns 1500 sqft, o que vocês recomendam?")]],
    ["salão EN (tile or vinyl better?)", [U("Hi"), processOpener, U("For a busy hair salon, is tile or vinyl better?")]],
  ];
  for (const [name, msgs] of cases) {
    try {
      const r = await getAIResponse(msgs, null, null, undefined, false);
      const text = typeof r === "string" ? r : ((r as { text?: string }).text ?? JSON.stringify(r));
      const backstopFired = /I'd go with our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great to heavy traffic\.|Vinyl is a great fit, it's 100% waterproof|Yo iría con nuestro vinyl de lujo|El vinyl es una excelente opción|Eu iria com o nosso vinil de luxo|O vinil é uma ótima opção/.test(text);
      ck(`${name}: recomenda vinil${backstopFired ? " (via backstop)" : ""}`, /\bvin(?:yl|il|[ií]lico)\b/i.test(text), text);
      ck(`${name}: nada de tile/porcelanato/hardwood por cima do vinil`, !replyRecommendsAgainstVinyl(text) && !/\b(?:i'?d|would)\s+(?:go|stick)\s+with\s+(?:porcelain|tile|hardwood)\b/i.test(text), text);
      ck(`${name}: não re-pergunta tile/vinyl/hardwood`, !/\b(?:tile|vinyl|hardwood),?\s+(?:vinyl|tile|hardwood),?\s+(?:or|o|ou)\s+(?:hardwood|tile|vinyl)\b/i.test(text), text);
      const s = short(text);
      ck(`${name}: curta e humana (${s.why})`, s.ok, text);
    } catch (e) { ck(`${name}: chamada`, false, String(e)); }
  }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
