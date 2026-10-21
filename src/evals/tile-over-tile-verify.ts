/**
 * TILE SOBRE TILE (Orlando Tito Dominguez, IG 958221304026862, 20/10/2026 23:06).
 *
 * Num lead de vinil o cliente perguntou "How about that tile over tile you guys
 * do" e o bot respondeu "Our luxury vinyl goes right over your existing tile, no
 * demo needed. The promo is $5 per sqft..."; o dono entrou na mão ("We can
 * install tile over tile for 4.50$/SQF", "First, we need to apply a primer...").
 * Regra do dono (21/10/2026): SIM, dá, desde que o tile existente esteja em boa
 * condição; massa niveladora + primer (proteção/aderência) e o tile novo por
 * cima; mas para saber de verdade precisamos olhar o espaço pessoalmente.
 *
 * Puro (sem modelo):
 *  1. isTileOverTileQuestion: EN/ES/PT reconhecem; "vinyl/cement/epoxy over tile"
 *     e "tile over concrete" não.
 *  2. fixTileOverTileReply: vinil/$5/negação viram a resposta do dono, a pergunta
 *     de continuidade fica, resposta certa fica igual, tags intactas.
 *  3. Prompt e reminder carregam a regra.
 * Ao vivo (LIVE=1): replay do caso real + ES + PT + 2 controles (vinil continua vinil).
 * Run: npx tsx src/evals/tile-over-tile-verify.ts   |   LIVE=1 npx tsx src/evals/tile-over-tile-verify.ts
 */
import { isTileOverTileQuestion, fixTileOverTileReply, replyAnswersTileOverTile, currentClientBurstText, getAIResponse, type ChatMessage } from "../lib/ai";
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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 400)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

const FIVE = /\$\s?5(?:\.00)?(?![\d,]|\.\d)/;
const VINYL_OVER = /\bvin(?:yl|il)\b[^.!?\n]*\b(?:over|sobre|encima|em cima|por cima)\b/i;
const REMOVE_FIRST = /\b(?:remove|removing|tear|rip)\b[^.!?\n]{0,30}\b(?:old|existing|current)\s+tiles?\b[^.!?\n]{0,25}\bfirst\b|\bquitar\b[^.!?\n]{0,30}\bprimero\b|\btirar\b[^.!?\n]{0,30}\bprimeiro\b/i;

console.log("\n━━ 1. isTileOverTileQuestion ━━");
for (const q of [
  "How about that tile over tile you guys do",
  "Beautiful. Is this tile over tile?",
  "Can you install tile on top of the existing tile?",
  "Do you do tile over tile or do you have to remove the old one?",
  "Can you put porcelain over my ceramic floor?",
  "new tile over old tile, is that possible?",
  "Can you lay tile without removing the old tile?",
  "I want ceramic tile over the existing one, 900 sqft",
  "tile-over-tile install, do you do that?",
  "Se puede poner cerámica sobre la cerámica que ya tengo?",
  "Instalan tile sobre tile?",
  "Ponen porcelanato encima de la cerámica vieja?",
  "Pueden poner tile sin quitar el piso?",
  "Vocês instalam porcelanato sobre o piso atual?",
  "Dá pra colocar cerâmica em cima da cerâmica velha?",
  "Colocam porcelanato sem tirar o piso antigo?",
  "How about that tile over tile you guys do\n\n[SYSTEM: REAL-TIME SCHEDULE …]",
]) ck(`pergunta: «${q.split("\n")[0]}»`, isTileOverTileQuestion(q), q);
for (const q of [
  "That vinyl over the tile",
  "Can vinyl go over tile?",
  "I have ceramic tile now, can vinyl go over tile?",
  "Cement over tile",
  "micro cement over tile",
  "How much for the epoxy over tile?",
  "Looks like cement over tile",
  "LVP over the existing tile?",
  "Can laminate go on top of my tile?",
  "Do you install tile over concrete?",
  "Se puede poner piso de vinyl sobre este piso?",
  "I want tile for the kitchen",
  "Do you remove the old tile?",
  "How much to remove the existing tile first?",
  "tile or vinyl, what's better?",
  "33323",
  "Is your vinyl waterproof?",
  "So doing this would be possible even if our tile right now has air pockets and makes noise in some spots?",
  "[Floor plan analysis: tile over tile layout, 3.00 x 10.00m]",
  "I have tile on the first floor and carpet upstairs",
]) ck(`não é: «${q}»`, !isTileOverTileQuestion(q), q);

console.log("\n━━ 1b. currentClientBurstText ━━");
const burst = currentClientBurstText([U("Need a quote"), A("Which one?"), U("That vinyl over the tile\n\n[SYSTEM: note]"), U("How about that tile over tile you guys do")]);
ck("rajada = só as bolhas depois da última resposta, sem [SYSTEM:]", burst === "That vinyl over the tile\nHow about that tile over tile you guys do", burst);

console.log("\n━━ 2. fixTileOverTileReply ━━");
const real = "Our luxury vinyl goes right over your existing tile, no demo needed. The promo is $5 per sqft with the floor, installation, and quarter round included. Wednesday the 21st?";
const fixedReal = fixTileOverTileReply(real, "en");
ck("caso real: vinil sobre tile some", !VINYL_OVER.test(fixedReal), fixedReal);
ck("caso real: $5 some", !FIVE.test(fixedReal), fixedReal);
ck("caso real: resposta do dono (condição + niveladora/primer + visita)", replyAnswersTileOverTile(fixedReal) && /leveling compound/.test(fixedReal) && /primer/.test(fixedReal) && /good condition/.test(fixedReal) && /free visit/.test(fixedReal), fixedReal);
ck("caso real: a pergunta de continuidade sobrevive no fim", /free visit\. Wednesday the 21st\?$/.test(fixedReal), fixedReal);

const denial = "Tile can't go over tile, we'd have to remove the existing tile first. What's the zip code of the property?";
const fixedDenial = fixTileOverTileReply(denial, "en");
ck("negação: some e vira a resposta do dono", !REMOVE_FIRST.test(fixedDenial) && !/can'?t go over/i.test(fixedDenial) && replyAnswersTileOverTile(fixedDenial), fixedDenial);
ck("negação: a pergunta do ZIP fica", /What's the zip code of the property\?$/.test(fixedDenial), fixedDenial);

const good = "Yes, we do tile over tile as long as the existing tile is in good condition: we apply a leveling compound and a bonding primer first, then install the new tile on top, and I confirm that when I check the floor at the free visit. For tile the promo is $4.50 per sqft labor only, you supply the tile, does 9am or 8pm tomorrow still work?";
ck("resposta certa fica igual", fixTileOverTileReply(good, "en") === good, fixTileOverTileReply(good, "en"));
const goodNoRemove = "Yes, tile over tile works when the existing tile is in good shape, you don't have to remove the old tile first: we level and prime it, then set the new tile, and I confirm it in person at the free visit. Does 9am or 8pm tomorrow still work?";
ck("'don't have to remove the old tile first' não é negação, fica igual", fixTileOverTileReply(goodNoRemove, "en") === goodNoRemove, fixTileOverTileReply(goodNoRemove, "en"));

const partial = "Yes, that works! Does 9am or 8pm tomorrow work?";
const fixedPartial = fixTileOverTileReply(partial, "en");
ck("'Yes, that works!' vira a resposta do dono e a pergunta fica", replyAnswersTileOverTile(fixedPartial) && !/that works!/.test(fixedPartial) && /Does 9am or 8pm tomorrow work\?$/.test(fixedPartial), fixedPartial);

const halfway = "Tile over tile works if the existing tile is in good shape, I confirm that at the visit. The tile promo is $4.50 per sqft labor only. What's the zip code?";
const fixedHalf = fixTileOverTileReply(halfway, "en");
ck("resposta incompleta (sem niveladora/primer): frase do tile vira a do dono, $4.50 e ZIP ficam", replyAnswersTileOverTile(fixedHalf) && /\$4\.50 per sqft labor only/.test(fixedHalf) && /What's the zip code\?$/.test(fixedHalf) && !/works if the existing/.test(fixedHalf), fixedHalf);

const tagged = 'Our luxury vinyl goes right over your existing tile. [NOTIFY_OWNER: client asked about tile over tile]';
const fixedTag = fixTileOverTileReply(tagged, "en");
ck("tag [NOTIFY_OWNER] intacta", fixedTag.includes("[NOTIFY_OWNER: client asked about tile over tile]") && replyAnswersTileOverTile(fixedTag) && !VINYL_OVER.test(fixedTag), fixedTag);

const es = "Nuestro vinyl va directo sobre la cerámica, la promo es $5 por pie cuadrado. Te funciona el jueves a las 5pm?";
const fixedEs = fixTileOverTileReply(es, "es");
ck("ES: vinil/$5 somem, resposta em espanhol, pergunta fica", !FIVE.test(fixedEs) && !VINYL_OVER.test(fixedEs) && /tile sobre tu cerámica actual/.test(fixedEs) && /buen estado/.test(fixedEs) && /niveladora/.test(fixedEs) && /visita gratis/.test(fixedEs) && /Te funciona el jueves a las 5pm\?$/.test(fixedEs), fixedEs);
ck("ES: sem ¿ ¡", !/[¿¡]/.test(fixedEs), fixedEs);
const pt = "O nosso vinil vai direto por cima da cerâmica, sem quebrar nada. Qual é o CEP do imóvel?";
const fixedPt = fixTileOverTileReply(pt, "pt");
ck("PT: vinil some, resposta em português, pergunta fica", !VINYL_OVER.test(fixedPt) && /tile por cima do piso atual/.test(fixedPt) && /boas condições/.test(fixedPt) && /niveladora/.test(fixedPt) && /visita grátis/.test(fixedPt) && /Qual é o CEP do imóvel\?$/.test(fixedPt), fixedPt);

ck("[REACT_ONLY] fica igual", fixTileOverTileReply("[REACT_ONLY]", "en") === "[REACT_ONLY]");
ck("vazio fica igual", fixTileOverTileReply("", "en") === "");

console.log("\n━━ 3. prompt ━━");
const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
ck("regra TILE OVER TILE (owner rule 2026-10-21) no prompt", /TILE OVER TILE \(owner rule 2026-10-21\)/.test(prompt));
ck("prompt: niveladora + primer + confirmado na visita", /leveling compound and a bonding primer/.test(prompt) && /confirmed at the free visit/.test(prompt));
ck("prompt: nunca o vinil / $5 para a pergunta de tile sobre tile", /NEVER answer a tile-over-tile question with "our luxury vinyl goes right over your existing tile" and NEVER quote the \$5 vinyl promo/.test(prompt));
ck("INSTALLATION DETAILS: linha de tile novo sobre tile", /New TILE over existing tile: yes, when the existing tile is in good condition/.test(prompt));
ck("reminder 41 em ai.ts", /\n41\. TILE OVER TILE \(owner rule 2026-10-21\)/.test(ai));
ck("nota dinâmica TILE_OVER_TILE_NOTE injetada", /dynamicSystem \+= "\\n\\n---\\n\\n" \+ TILE_OVER_TILE_NOTE;/.test(ai));
ck("encurtamento pulado na pergunta de tile sobre tile", /!tileOverTileBurst && needsTightening\(cleaned\)/.test(ai));

const ORLANDO: ChatMessage[] = [
  U("Need a quote"),
  A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
  U("That vinyl over the tile"),
  A("Our vinyl promo is $5 per sqft and it includes the flooring, installation, and quarter round. For the free quote, what's the zip code of the property?"),
  U("33323"),
  A("That's Sunrise, we cover that area. I can come measure in person for free and bring the samples. Does 9am or 8pm work tomorrow, Wednesday the 21st?"),
  U("How about that tile over tile you guys do"),
];

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 4. ao vivo ━━");
  const text = async (msgs: ChatMessage[]) => {
    const r = await getAIResponse(msgs, null, null, undefined, false);
    return typeof r === "string" ? r : ((r as { text?: string; response?: string }).text ?? (r as { response?: string }).response ?? JSON.stringify(r));
  };
  const okTot = (t: string) => replyAnswersTileOverTile(t) && !FIVE.test(t) && !VINYL_OVER.test(t) && !REMOVE_FIRST.test(t);
  try {
    const t = await text(ORLANDO);
    ck("caso real (Orlando): resposta do dono, sem vinil, sem $5, sem 'remove first'", okTot(t), t);
    console.log(`     ↳ ${t.replace(/\s+/g, " ")}`);
    if (!/\$4\.50/.test(t)) console.log("     (nota: sem o $4.50 nesta resposta; a regra de preço é do prompt, não da rede)");
  } catch (e) { ck("caso real: chamada", false, String(e)); }
  try {
    const t = await text([
      U("Hola, necesito presupuesto"),
      A("Hola, trabajamos con piso vinílico de lujo, tile y hardwood, y tenemos una promoción en cada uno. Cuál te interesa?"),
      U("Vinyl"),
      A("Nuestra promo de vinyl es $5 por pie cuadrado e incluye el piso, la instalación y el quarter round. Para el presupuesto gratis, cuál es el zip code de la propiedad?"),
      U("33176"),
      A("Eso es Miami, cubrimos esa zona. Puedo ir a medir gratis y llevar las muestras. Te funciona mañana jueves a las 9am o a las 5pm?"),
      U("Y ese tile sobre tile que ustedes hacen?"),
    ]);
    ck("ES: tile sobre tile = sí, buen estado, niveladora/primer, visita; sem $5, sem vinil", okTot(t) && !/[¿¡]/.test(t), t);
    console.log(`     ↳ ${t.replace(/\s+/g, " ")}`);
  } catch (e) { ck("ES: chamada", false, String(e)); }
  try {
    const t = await text([
      U("Oi, quero orçamento"),
      A("Olá, trabalhamos com piso vinílico de luxo, tile e hardwood, e temos uma promoção em cada um. Qual é a sua preferência?"),
      U("Vocês fazem porcelanato em cima do piso atual? Tenho uns 800 sqft de cerâmica"),
    ]);
    ck("PT: porcelanato sobre o piso atual = sim, boas condições, niveladora/primer, visita; sem vinil", okTot(t), t);
    console.log(`     ↳ ${t.replace(/\s+/g, " ")}`);
  } catch (e) { ck("PT: chamada", false, String(e)); }
  try {
    const t = await text(ORLANDO.slice(0, 3));
    ck("controle: 'That vinyl over the tile' continua lead de VINIL (sem a resposta do tile)", !replyAnswersTileOverTile(t) && /vin[yi]l/i.test(t) && !/leveling compound/i.test(t), t);
    console.log(`     ↳ ${t.replace(/\s+/g, " ")}`);
  } catch (e) { ck("controle vinil: chamada", false, String(e)); }
  try {
    const t = await text([
      U("Hi, interested in the promo"),
      A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
      U("The cement over tile one"),
    ]);
    ck("controle: 'cement over tile' continua a correção para o vinil (sem a resposta do tile)", !replyAnswersTileOverTile(t) && /vin[yi]l/i.test(t) && !/leveling compound/i.test(t), t);
    console.log(`     ↳ ${t.replace(/\s+/g, " ")}`);
  } catch (e) { ck("controle cimento: chamada", false, String(e)); }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
