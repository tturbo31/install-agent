/**
 * UM IDIOMA POR CONVERSA (Lusniel, WhatsApp 14/10/2026).
 *
 * O cliente abriu com "Hola hablan español", recebeu o opener em espanhol e na
 * bolha seguinte (ainda sem o tipo de piso) perguntou, em espanhol sem acentos,
 * se o laminado do vídeo é resistente. A resposta saiu MISTURADA: "I'd go with
 * our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great
 * to heavy traffic. Que tan grande es el area que quieres cambiar?".
 *
 * Causa: usersLang() media o idioma nas bolhas do cliente COMO O MODELO AS VÊ,
 * ou seja, com a nota [SYSTEM: …] que o webhook cola na última (data, agenda,
 * nota do anúncio, canal WhatsApp, milhares de palavras em inglês). detectLang
 * dá um ponto por palavra: "Hola hablan español" (3) perdeu para a nota (price,
 * quote, address, want, tomorrow, available), usersLang() disse "en" e a rede do
 * vinil colou a frase enlatada em INGLÊS dentro da resposta em espanhol. E a
 * rede nem devia ter disparado: "vinyl de lujo con look de madera … aguanta
 * mejor" é a favor do vinil, a madeira ali é um LOOK.
 *
 * Puro (sem modelo):
 *  1. conversationLang: só o texto do cliente conta (nota [SYSTEM:], bolhas de
 *     análise de imagem e tags de anúncio fora); pedido explícito de idioma
 *     vence; cliente sem sinal nenhum mantém o idioma em que NÓS escrevemos;
 *     primeiro contato sem sinal = inglês.
 *  2. replyMixesLanguages: a resposta enviada é misturada; respostas puras em
 *     EN/ES/PT, com preço "$5 per sqft", com link, telefone e [BOOK] não são.
 *  3. Código: usersLang usa conversationLang; o showroom também; a rede final
 *     de resposta misturada existe com kill switch.
 * Ao vivo (LIVE=1): replay do 2º turno da Lusniel com a nota de produção (3x):
 *   resposta inteira em espanhol, nunca misturada, curta; e a rede
 *   rewriteInOneLanguage traduz a resposta misturada real mantendo a pergunta.
 * Run: npx tsx src/evals/language-consistency-verify.ts   |   LIVE=1 npx tsx src/evals/language-consistency-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { conversationLang, replyMixesLanguages, replyLanguageKinds, fixVinylRecommendation, replyRecommendsAgainstVinyl, rewriteInOneLanguage, getAIResponse, type ChatMessage } from "../lib/ai";
import { detectLang, getEasternDateContext, getRealAvailabilityContext } from "../lib/scheduler";
import { AD_REPLY_NOTE, OPENER_LANG_ES, OPENER_EN, OPENER_ES, OPENER_PT } from "../lib/system-prompt";
import { visibleLength, sentenceCount } from "../lib/reply-length";

function loadEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
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

// A nota que o wa-webhook cola na última bolha do cliente quando o tipo ainda é
// desconhecido: data + agenda + canal WhatsApp + nota do anúncio (tudo em inglês).
const WA_CHANNEL = "[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (17865233118). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using \"17865233118\" as the phone, with the name only if the client stated it and \"name\":\"\" otherwise.]";
const SCHEDULE_NOTE = "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• Thursday, October 15, 2026 [2026-10-15]: 1pm, 2pm, 3pm, 4pm\n• Friday, October 16, 2026 [2026-10-16]: 9am, 11am, 1pm\n\nIMPORTANT — read carefully before offering any time:\n- ONLY offer times listed above. Never mention a time shown as 'fully booked'.\n- When you name a weekday to the client (e.g. 'Friday' / 'viernes'), you MUST use the exact date in [brackets] shown on that SAME line.\n- NEVER offer a day without stating its available times: the client can only pick a time you actually showed.\n- Until the visit is actually confirmed, do NOT tell the client a time is 'locked in'. Say you are holding it while you collect their address and phone.";
const withNote = (text: string, parts: string[]) => `${text}\n\n[SYSTEM: ${parts.join("\n\n")}]`;
const LUSNIEL_MSG_2 = "En el video de arriba veo poniendo laminado pero nunca habias visto ese color y tan grande y me gusto bastante pero quiciera saber que tan resistente es";
const LUSNIEL_SHIPPED = "I'd go with our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great to heavy traffic. Que tan grande es el area que quieres cambiar?";
const lusniel = (noteParts: string[]): ChatMessage[] => [
  U("Hola hablan español"),
  A(OPENER_LANG_ES),
  U(withNote(LUSNIEL_MSG_2, noteParts)),
];
const PROD_NOTE = [getEasternDateContext(), SCHEDULE_NOTE, WA_CHANNEL, AD_REPLY_NOTE];

console.log("\n━━ 1. conversationLang ━━");
{
  const msgs = lusniel(PROD_NOTE);
  const raw = msgs.filter((m) => m.role === "user").map((m) => m.content).join(" ");
  console.log(`  (armadilha reproduzida: detectLang nas bolhas cruas com a nota = ${detectLang(raw)}; só o cliente = ${detectLang("Hola hablan español " + LUSNIEL_MSG_2)})`);
  ck("Lusniel: espanhol, com a nota de produção colada na última bolha", conversationLang(msgs) === "es", conversationLang(msgs));
  ck("Lusniel: espanhol, só com a nota do anúncio", conversationLang(lusniel([AD_REPLY_NOTE])) === "es");
  ck("Lusniel: espanhol, só com a nota do canal WhatsApp", conversationLang(lusniel([WA_CHANNEL])) === "es");
  ck("Lusniel: espanhol sem nota nenhuma", conversationLang(lusniel([])) === "es");
}
ck("pedido explícito de idioma vence (langSwitch en)", conversationLang(lusniel([]), "en") === "en");
ck("pedido explícito de idioma vence (langSwitch pt)", conversationLang([U("Hi"), A(OPENER_EN), U("No speak english, portugues")], "pt") === "pt");
ck("cliente PT com a nota em inglês = pt", conversationLang([U("Olá, vocês fazem piso vinílico? Gostaria de um orçamento"), A(OPENER_PT), U(withNote("Uns 900 sqft, a casa toda", PROD_NOTE))]) === "pt");
ck("cliente EN com a nota = en", conversationLang([U("Hi, how much is the vinyl?"), A(OPENER_EN), U(withNote("Vinyl, about 800 sqft", PROD_NOTE))]) === "en");
ck("cliente sem sinal nenhum ('Quw material de loza es ese') depois do nosso opener ES = es", conversationLang([U("Quw material de loza es ese"), A(OPENER_ES), U(withNote("Ok", PROD_NOTE))]) === "es");
ck("cliente sem sinal nenhum ('Ok') depois do nosso opener EN = en", conversationLang([U("Ok"), A(OPENER_EN), U(withNote("Ok", PROD_NOTE))]) === "en");
ck("primeiro contato sem sinal nenhum = en", conversationLang([U("Ok")]) === "en");
ck("bolha de análise de imagem (em inglês) não conta", conversationLang([U("Hola, quiero cambiar el piso"), A(OPENER_ES), U("[Image analysis: The photo shows a living room with old ceramic tile floor, the client wants to replace it with new flooring, approximately 400 square feet]"), U(withNote("Cuánto sale?", PROD_NOTE))]) === "es");
ck("tag de anúncio '[Client replied to our ad …]' não conta", conversationLang([U("[Client replied to our ad: Luxury vinyl flooring promotion, floor and installation included] Hola, me interesa"), A(OPENER_ES), U(withNote("Si, para la casa", PROD_NOTE))]) === "es");
ck("cliente que só falou inglês com nota = en (não vira ES pelas palavras 'viernes' da agenda)", conversationLang([U("Hello, I need a quote for my house"), A(OPENER_EN), U(withNote("Vinyl please", PROD_NOTE))]) === "en");

console.log("\n━━ 2. replyMixesLanguages ━━");
for (const r of [
  LUSNIEL_SHIPPED,
  "Yo iría con nuestro vinyl de lujo, es 100% impermeable y aguanta muy bien el tráfico pesado. How many square feet is the space?",
  "I'd go with our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great to heavy traffic. Quantos pés quadrados tem o espaço?",
  "We have a mobile showroom, I bring the samples to you on the free visit. Cuál es el código postal de la propiedad?",
  "Herringbone has its own price, it's $4 per sqft for the installation labor, and our herringbone material is $7.50 per sqft. Cuántos pies cuadrados tienes aproximadamente?",
]) ck(`misturada: «${r.slice(0, 70)}»`, replyMixesLanguages(r), [...replyLanguageKinds(r)].join(","));
for (const r of [
  "Yo iría con nuestro vinyl de lujo, es 100% impermeable, resistente a rayones y aguanta muy bien el tráfico pesado. Que tan grande es el area que quieres cambiar?",
  "Ese piso del video es nuestro vinyl de lujo, va directo sobre tus losas actuales sin demolición. Es 100% resistente al agua, 20 años de garantía y muy resistente al rayado. Cuántos pies cuadrados tienes aproximadamente?",
  "I'd go with our luxury vinyl, it's 100% waterproof, scratch resistant and holds up great to heavy traffic. How many square feet is the space?",
  "Perfect, see you then! [BOOK:{\"name\":\"\",\"phone\":\"7865233118\",\"address\":\"1910 E Sunrise Blvd, Fort Lauderdale 33304\",\"date\":\"2026-10-16\",\"time\":\"1pm\"}]",
  "La promo de vinyl es $5 per sqft con el piso, la instalación y el quarter round incluidos. Es una sola área o toda la casa?",
  "Puedes ver todos los colores en https://ozzifloors.company y en nuestro Instagram @ozzi.floors. Cuál es el zip code de la propiedad?",
  "Claro, puedes hablar con Ozzi directo al (561) 674-8334, él te confirma todo. [NOTIFY_OWNER]",
  OPENER_PT,
  OPENER_LANG_ES,
  OPENER_EN,
  "Olá! Trabalhamos com vinil de luxo, tile e hardwood. O vinil sai a $5 per sqft com o piso, a instalação e o quarter round. Quantos sqft tem a casa?",
  "Thursday at 1pm works! Can I get the full property address with the zip code? [NOTIFY_OWNER]",
  "Hi Maria, gracias! Our luxury vinyl is $5 per sqft with the floor, installation and quarter round included. One area or the whole house?",
]) ck(`não misturada: «${r.slice(0, 70)}»`, !replyMixesLanguages(r), [...replyLanguageKinds(r)].join(","));

console.log("\n━━ 3. a rede do vinil na conversa da Lusniel ━━");
{
  const msgs = lusniel(PROD_NOTE);
  const lang = conversationLang(msgs);
  const look = "Ese piso del video es nuestro vinyl de lujo con look de madera, es 100% resistente al agua y aguanta mejor que el laminado. Que tan grande es el area que quieres cambiar?";
  ck("'vinyl de lujo con look de madera … aguanta mejor' NÃO é recomendação contra o vinil", !replyRecommendsAgainstVinyl(look), look);
  ck("…e fica intacta", fixVinylRecommendation(look, lang) === look);
  const against = "Para tu caso el porcelanato aguanta más que el vinyl. Que tan grande es el area que quieres cambiar?";
  const fixed = fixVinylRecommendation(against, lang);
  ck("recomendação real contra o vinil vira a frase em ESPANHOL", /^Yo iría con nuestro vinyl de lujo/.test(fixed) && !/I'd go with/.test(fixed), fixed);
  ck("…sem misturar idiomas", !replyMixesLanguages(fixed), fixed);
}

console.log("\n━━ 4. código ━━");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
ck("usersLang usa conversationLang (texto do cliente, nunca a nota [SYSTEM:])", /const usersLang = \(\): "en" \| "es" \| "pt" => conversationLang\(messages, langSwitch\?\.target\);/.test(ai));
ck("nenhum detectLang sobre bolhas cruas do cliente em usersLang", !/usersLang = .*detectLang\(messages/.test(ai));
ck("showroom usa usersLang()", /fixShowroomDenial\(cleaned, usersLang\(\)\)/.test(ai));
ck("rede final de resposta misturada com kill switch LANG_MIX_REWRITE", /process\.env\.LANG_MIX_REWRITE !== "off" && replyMixesLanguages\(cleaned\)/.test(ai));
ck("a rede roda ANTES do backstop de language switch e do stripInvertedPunctuation", ai.indexOf("replyMixesLanguages(cleaned)") < ai.indexOf("const inLang = enforceLanguageSwitch(messages, cleaned, langSwitch);"));

const CORPORATE = /\b(?:in order to|at your earliest convenience|please be advised|do not hesitate|kindly|I would be happy to|feel free to)\b/i;
function short(text: string): { ok: boolean; why: string } {
  const vis = text.replace(/\[BOOK:\s*\{[\s\S]*?\}\]/g, " ").replace(/\[[A-Z][A-Z_]{2,}(?::[^\]]*)?\]/g, " ").replace(/\s+/g, " ").trim();
  const sentences = sentenceCount(text);
  const len = visibleLength(text);
  const why = `${sentences} frases, ${len} chars`;
  if (sentences === 3 && len <= 200) console.log(`  ⚠️ 3 frases curtas (${len} chars): «${vis.slice(0, 200)}»`);
  const okLen = len <= 220 && (sentences <= 2 || (sentences === 3 && len <= 200));
  return { ok: okLen && !CORPORATE.test(vis) && !/[—–]/.test(vis) && !/[\u{1F300}-\u{1FAFF}]/u.test(vis), why };
}

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 5. ao vivo: replay do 2º turno da Lusniel com a nota de produção (3x) ━━");
  const avail = await getRealAvailabilityContext({ history: [] });
  const msgs = lusniel([getEasternDateContext(), avail, WA_CHANNEL, AD_REPLY_NOTE]);
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await getAIResponse(msgs, null, null, undefined, false);
      const text = typeof r === "string" ? r : ((r as { text?: string }).text ?? JSON.stringify(r));
      const kinds = [...replyLanguageKinds(text)];
      ck(`replay ${i}: não mistura idiomas (${kinds.join(",") || "nada claro"})`, !replyMixesLanguages(text), text);
      ck(`replay ${i}: nenhuma frase em inglês`, !replyLanguageKinds(text).has("en"), text);
      ck(`replay ${i}: fala do vinil (o piso do vídeo é o nosso vinil)`, /vin(?:yl|il|[ií]lico)/i.test(text), text);
      const s = short(text);
      ck(`replay ${i}: curta e humana (${s.why})`, s.ok, text);
    } catch (e) { ck(`replay ${i}: chamada`, false, String(e)); }
  }
  console.log("\n━━ 6. ao vivo: rewriteInOneLanguage traduz a resposta misturada real ━━");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const stable = "You are the Ozzi Floors assistant chatting with a client on WhatsApp. Always reply in the client's language, in one or two short plain sentences, no dashes, no emojis, no inverted Spanish marks.";
  const base = lusniel([]);
  for (let i = 1; i <= 2; i++) {
    const out = await rewriteInOneLanguage(anthropic, stable, "Keep the same facts.", base, LUSNIEL_SHIPPED, "es");
    const text = out?.text ?? "";
    ck(`rewrite ${i}: devolveu uma reescrita`, !!out, "null");
    ck(`rewrite ${i}: inteira em espanhol, sem inglês`, !!out && !replyMixesLanguages(text) && !replyLanguageKinds(text).has("en"), text);
    ck(`rewrite ${i}: mantém a pergunta e fala do vinil`, /\?\s*$/.test(text) && /vinyl|vinil/i.test(text), text);
  }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
