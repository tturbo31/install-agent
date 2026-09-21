/**
 * RESPOSTAS CURTAS E HUMANAS (pedido do dono 21/09/2026: "ela está com uma
 * conversão muito baixa… deixa ela mais humanizada e faça ela colocar as
 * respostas mais curtas, não ficar escrevendo textão").
 *
 * Medido em 14 dias de produção antes da mudança: 69% das 1ªs respostas eram
 * enlatadas e a mais enviada (298x) tinha 289 caracteres, 35% de resposta e
 * 2,7% de visita; nas respostas do modelo, 24% tinham 3+ frases e 27% passavam
 * de 220 caracteres mesmo com "NEVER 3 sentences" no prompt.
 *
 * Camadas verificadas aqui:
 *  1. Estático: prompt com o orçamento em caracteres DENTRO da regra 3 (nenhum
 *     bloco novo no fim do prompt: o A/B de 21/09 mostrou que isso muda o fluxo),
 *     a rede roda ANTES dos backstops, chave de emergência, trava 11 no Dreaming.
 *  2. Enlatados: tamanhos máximos, fatos que os guards leem preservados, rajada
 *     de botões em frases curtas, nudges do re-clique sem "reply with the word".
 *  3. Puro: visibleLength / needsTightening / tightenedIsSafe (aceita as
 *     reescritas boas do replay real, recusa cada classe de perda).
 *  4. AO VIVO (pula com DET_ONLY=1): o mesmo funil de sempre, agora curto, e
 *     com os fatos no lugar (preço com o que cobre, 2 horários, zip + telefone).
 *
 * Rodar: npx tsx src/evals/short-replies-verify.ts   (DET_ONLY=1 pula a parte 4)
 */
import { readFileSync } from "fs";
import { join } from "path";
function loadEnv() {
  try {
    const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

import { getEasternDateContext } from "../lib/scheduler";
import { getAIResponse, adRetapNudge, isAskingForBookingInfo, stripReasoningLeak, splitSlotOfferFromDetailsAsk, type ChatMessage } from "../lib/ai";
import {
  WHAT_IS_INCLUDED_ASK_TYPE, OPENER_EN, OPENER_ES, OPENER_PT, OPENER_PROCESS_EN, OPENER_PROCESS_ES, OPENER_DISCOUNT_EN, OPENER_DISCOUNT_ES,
  OPENER_LOCATION_EN, OPENER_LOCATION_ES, OPENER_LOCATION_PT, composeAdFaqOpener, SYSTEM_PROMPT,
} from "../lib/system-prompt";
import {
  visibleLength, needsTightening, tightenedIsSafe, tightenInstruction, clockTokens, dayTokens, dollarTokens, clientAskedPrice, freeAlreadySaid,
  REPLY_TARGET_CHARS, REPLY_TIGHTEN_OVER,
} from "../lib/reply-length";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` | ${(detail || "").replace(/\s+/g, " ").slice(0, 300)}` : ""}`); }
}
function done() {
  console.log(`\n=========== SHORT-REPLIES-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");
const safe = (o: string, r: string, opts: Parameters<typeof tightenedIsSafe>[2] = {}) => tightenedIsSafe(o, r, { asksForDetails: isAskingForBookingInfo, ...opts });
const why = (o: string, r: string, opts: Parameters<typeof tightenedIsSafe>[2] = {}) => { const v = safe(o, r, opts); return v.ok ? "ok" : v.reason; };

async function main() {
  // ───────────────────────────── 1. estático ─────────────────────────────
  console.log("[1] prompt, ordem da rede, Dreaming");
  const ai = src("src/lib/ai.ts");
  const dr = src("src/lib/dreaming.ts");
  ck("prompt estável: orçamento em caracteres (160 norma, 220 teto)", /Under 160 characters in total is the norm and 220 is the ceiling/.test(SYSTEM_PROMPT));
  ck("prompt estável: proíbe o período único cheio de vírgulas", /never one long sentence stuffed with commas/.test(SYSTEM_PROMPT));
  ck("prompt estável: proposta de visita em UMA frase curta, sem empilhar argumentos", /Propose the visit in ONE short sentence/.test(SYSTEM_PROMPT) && /Do not stack more selling points/.test(SYSTEM_PROMPT));
  ck("prompt estável: o exemplo de 3 frases da proposta de visita saiu", !/I bring the floor samples so you can pick right there\. When would work for you\?/.test(SYSTEM_PROMPT));
  // A/B de 21/09 (6 a 12 rodadas ao vivo por cenário, código antigo x novo): QUALQUER regra de tamanho nova no bloco
  // dinâmico (bloco detalhado no fim, bloco de 1 parágrafo só de estilo, 1 frase a mais na regra 3) encurtava as
  // respostas E mudava o FLUXO: o modelo perguntava o tipo em vez de dar o total de 480 sqft (0/6, 0/6, 15/18; antigo
  // 18/18). O orçamento mora só no prompt estável + exemplos curtos; o bloco dinâmico fica como sempre foi.
  ck("regra 3 dos FINAL REMINDERS intocada (nenhuma frase de tamanho nova no bloco dinâmico)", /3\. LENGTH RULE: Use 1 sentence when the message is complete with just the answer\. Use 2 sentences ONLY when you genuinely need both an answer AND a forward question\. Never 3 sentences\. NEVER use a standalone opener like/.test(ai));
  ck("nenhum bloco de tamanho pendurado DEPOIS dos FINAL REMINDERS", !/dynamicSystem \+= MESSAGE_LENGTH_NOTE/.test(ai) && !/MESSAGE LENGTH, THE LAST CHECK/.test(ai) && !/LENGTH_RULE_BUDGET\}/.test(ai));
  ck("o porquê está escrito no código (para ninguém repetir a tentativa)", /WHY THERE IS NO LENGTH RULE IN THE DYNAMIC BLOCK/.test(ai));
  ck("orçamento (160 / 220) no prompt estável bate com as constantes da rede", SYSTEM_PROMPT.includes("Under " + REPLY_TARGET_CHARS + " characters in total is the norm and " + REPLY_TIGHTEN_OVER + " is the ceiling"));
  ck("trava oferta + pedido de dados roda logo depois da rede, dentro do cérebro (vale para os 3 canais)", ai.indexOf("cleaned = splitSlotOfferFromDetailsAsk(cleaned, messages, usersLang());") > ai.indexOf("needsTightening(cleaned)") && ai.indexOf("cleaned = splitSlotOfferFromDetailsAsk(cleaned, messages, usersLang());") < ai.indexOf("cleaned = scrubForeignPhones(cleaned"));
  const iNet = ai.indexOf("needsTightening(cleaned)"), iLeak = ai.indexOf("cleaned = stripReasoningLeak(cleaned);"), iPhones = ai.indexOf("cleaned = scrubForeignPhones(cleaned"), iSmall = ai.indexOf("if (smallJobLeak(messages, cleaned))");
  ck("a rede roda depois do scrubber de raciocínio e ANTES de todos os backstops", iLeak > 0 && iNet > iLeak && iPhones > iNet && iSmall > iNet, `${iLeak} ${iNet} ${iPhones} ${iSmall}`);
  ck("chave de emergência REPLY_TIGHTEN=off", /process\.env\.REPLY_TIGHTEN !== "off"/.test(ai));
  ck("falha da reescrita nunca derruba a resposta (try/catch devolve null)", /short-reply rewrite failed, keeping the original/.test(ai));
  ck("reescrita usa o MESMO modelo e os mesmos blocos de sistema (cache)", /async function tightenLongReply[\s\S]{0,900}model: "claude-sonnet-4-6"[\s\S]{0,500}text: stableSystem[\s\S]{0,200}text: dynamicSystem/.test(ai));
  ck("Dreaming: trava 11 (respostas curtas, nunca empilhar argumentos)", /11\. REPLIES ARE SHORT TEXTS/.test(dr) && /NEVER recommend "stacking" selling points/.test(dr));
  ck("Dreaming: trava 12 (nunca recomendar SILÊNCIO para toque no anúncio / ação do cliente)", /12\. NEVER RECOMMEND SILENCE FOR A CLIENT ACTION/.test(dr) && /NEVER recommend stopping, staying silent, ignoring taps, or capping the replies/.test(dr));
  ck("Dreaming: teto de tokens não corta mais o arquivo no meio", /max_tokens: 3000/.test(dr) && /whole file must stay under 7,000 characters/.test(dr));

  // ───────────────────────────── 2. enlatados ─────────────────────────────
  console.log("\n[2] mensagens prontas: curtas, com os fatos que os guards leem");
  const canned: Array<[string, string, number]> = [
    ["WHAT_IS_INCLUDED_ASK_TYPE", WHAT_IS_INCLUDED_ASK_TYPE, 180], ["OPENER_EN", OPENER_EN, 130], ["OPENER_ES", OPENER_ES, 130], ["OPENER_PT", OPENER_PT, 130],
    ["OPENER_PROCESS_EN", OPENER_PROCESS_EN, 145], ["OPENER_PROCESS_ES", OPENER_PROCESS_ES, 145], ["OPENER_DISCOUNT_EN", OPENER_DISCOUNT_EN, 125], ["OPENER_DISCOUNT_ES", OPENER_DISCOUNT_ES, 125],
    ["OPENER_LOCATION_EN", OPENER_LOCATION_EN, 125], ["OPENER_LOCATION_ES", OPENER_LOCATION_ES, 140], ["OPENER_LOCATION_PT", OPENER_LOCATION_PT, 140],
  ];
  for (const [name, text, max] of canned) {
    ck(`${name}: ${text.length} <= ${max} caracteres`, text.length <= max, text);
    ck(`${name}: nomeia tile + hardwood (conta como o único type-ask), sem travessão, sem ¿¡, termina em ?`, /\btile\b/i.test(text) && /\bhardwood\b/i.test(text) && !/[—–]| - /.test(text) && !/[¿¡]/.test(text) && /\?\s*$/.test(text), text);
  }
  ck("inclusões: responde de verdade, com o quarter round ESCOPADO ao vinyl (tile/hardwood só mão de obra, cliente põe o material)", /\bvinyl\s+promo\b[^.]{0,80}\bquarter round\b/i.test(WHAT_IS_INCLUDED_ASK_TYPE) && /\btile\s+and\s+hardwood\b[^.]{0,60}\blabor\s+only\b/i.test(WHAT_IS_INCLUDED_ASK_TYPE) && /you supply the material/i.test(WHAT_IS_INCLUDED_ASK_TYPE));
  ck("inclusões: NENHUM preço antes de saber o tipo", !/\$/.test(WHAT_IS_INCLUDED_ASK_TYPE));
  ck("processo mantém furniture / muebles (o intercepto de repetição lê isso)", /furniture/i.test(OPENER_PROCESS_EN) && /muebles/i.test(OPENER_PROCESS_ES));
  ck("desconto mantém pricing / precio", /pricing/i.test(OPENER_DISCOUNT_EN) && /precio/i.test(OPENER_DISCOUNT_ES));
  ck("localização mantém Miami + Homestead a Jupiter", /Miami/.test(OPENER_LOCATION_EN) && /Homestead to Jupiter/.test(OPENER_LOCATION_EN));
  const two = composeAdFaqOpener(["discount", "inclusions"], "en") ?? "", three = composeAdFaqOpener(["process", "discount", "inclusions"], "en") ?? "", threeEs = composeAdFaqOpener(["process", "discount", "inclusions"], "es") ?? "";
  ck(`rajada de 2 botões: ${two.length} <= 225 (era 272)`, two.length > 0 && two.length <= 225, two);
  ck(`rajada de 3 botões: ${three.length} <= 340 (era 380+)`, three.length > 0 && three.length <= 340, three);
  const longest = (t: string) => Math.max(...t.split(/(?<=[.?!])\s+/).map((s) => s.length));
  ck("rajada em frases curtas (nenhuma passa de 130), não num período só", longest(three) <= 130 && longest(threeEs) <= 130, `${longest(three)} / ${longest(threeEs)}`);
  ck("rajada responde os 3 e pede o tipo no fim", /furniture/i.test(three) && /best pricing/i.test(three) && /vinyl promo already includes/i.test(three) && /tile, vinyl, or hardwood\?$/.test(three), three);
  ck("rajada ES sem ¿¡ e com os 3", !/[¿¡]/.test(threeEs) && /muebles/.test(threeEs) && /mejor precio/.test(threeEs) && /solo mano de obra/.test(threeEs), threeEs);
  const PH = "[Client replied to our ad]";
  const n1 = adRetapNudge([U(PH), A(OPENER_EN), U(PH)]) ?? "";
  ck(`nudge do re-clique: ${n1.length} <= 100, sem "reply with the word"`, n1.length > 0 && n1.length <= 100 && !/reply with the word|one word is all i need/i.test(n1), n1);
  const LEGACY = "Hi again! Just reply with the word tile, vinyl, or hardwood and I'll send you the current promotion for it. I'm here whenever you're ready.";
  let storm: ChatMessage[] = [U(PH), A(OPENER_EN)];
  for (let k = 0; k < 6; k++) storm = [...storm, U(PH), A(LEGACY)];
  ck("nudges ANTIGOS já enviados continuam contando para o teto (conversa em andamento não ganha +6)", adRetapNudge([...storm, U(PH)]) === null);

  // ───────────────────────────── 3. puro ─────────────────────────────
  console.log("\n[3] reply-length: o que conta, quando reescreve, o que a reescrita tem que preservar");
  ck("visibleLength ignora [BOOK:{…}], [NOTIFY_OWNER] e links", visibleLength('All set![BOOK:{"name":"","phone":"3055550142","address":"1 Main St, Miami FL 33101","date":"2026-09-25","time":"09:00","notes":"vinyl"}]') === 8 && visibleLength("See https://app.gethearth.com/partners/ozzifloors ok[NOTIFY_OWNER]") === "See ok".length);
  const LONG_VISIT = "For a whole townhouse at that size, I need to come measure in person to give you the best price. I bring all the floor samples so you can pick right there, and the visit is completely free. I have tomorrow Thursday at 9am or 1pm, which works better?";
  ck("needsTightening: 249 caracteres → sim", needsTightening(LONG_VISIT));
  ck("needsTightening: resposta normal (<= 220) → não", !needsTightening("For 1,600 sqft I need to measure in person to give you the best price, it's free and I bring samples. Thursday at 9am or 1pm?"));
  ck("needsTightening: NUNCA com [BOOK], [CANCEL_BOOKING] ou [REACT_ONLY]", !needsTightening(LONG_VISIT + '[BOOK:{"name":""}]') && !needsTightening(LONG_VISIT + "[CANCEL_BOOKING]") && !needsTightening("[REACT_ONLY]"));
  ck("tightenInstruction manda manter preço+cobertura, horários, telefone, link, tag, zip e UMA pergunta", /every dollar amount together with what it covers/.test(tightenInstruction(300)) && /every day and clock time/.test(tightenInstruction(300)) && /zip code/.test(tightenInstruction(300)) && /Output ONLY the rewritten message/.test(tightenInstruction(300)));
  ck("clockTokens: 9am / 11:30 am / 5 p.m. / a las 5 / noon", [...clockTokens("9am, 11:30 am o 5 p.m.")].sort().join() === "11:30a,5:00p,9:00a" && clockTokens("te queda a las 5?").has("5:00?") && clockTokens("noon").has("12:00p"));
  ck("clockTokens: '$165 a month' e 'as 2 rooms' NÃO são horários", clockTokens("around $165 a month").size === 0 && clockTokens("as 2 rooms").size === 0);
  ck("dayTokens EN/ES/PT com acento", [...dayTokens("sábado o miércoles, amanhã")].sort().join() === "sat,tomorrow,wed");
  ck("dollarTokens normaliza $1,200 / $4.50", [...dollarTokens("$1,200 or $4.50 per sqft")].sort().join() === "1200,4.50");

  // Reescritas REAIS aceitas no replay de 21/09.
  ck("aceita: proposta de visita curta com os MESMOS horários e 'free'", safe(LONG_VISIT, "For 1,600 sqft I need to come measure in person to give you the best price, free visit and I bring samples. Tomorrow Thursday I have 9am or 1pm, which works?").ok, why(LONG_VISIT, "For 1,600 sqft I need to come measure in person to give you the best price, free visit and I bring samples. Tomorrow Thursday I have 9am or 1pm, which works?"));
  const ES_O = "Tamarac está cubierto, sin problema. Para un apartamento completo necesito ir a medir en persona y así darte el mejor precio, la visita es gratis y llevo todas las muestras. Tengo hoy jueves a las 3pm o 5pm, cual te queda mejor?";
  ck("aceita: espanhol, mesmos horários e dia", safe(ES_O, "Tamarac está cubierto! Para el apartamento necesito medir en persona, la visita es gratis. Hoy jueves tengo a las 3pm o 5pm, cuál te queda mejor?").ok, why(ES_O, "Tamarac está cubierto! Para el apartamento necesito medir en persona, la visita es gratis. Hoy jueves tengo a las 3pm o 5pm, cuál te queda mejor?"));
  const RATES = "It depends on which floor you pick: our vinyl promo is $5 per square foot and already includes the material, the installation labor, and the quarter round, while tile and hardwood cover the installation labor only at $4.50 and $3.20 per square foot respectively, and you supply the material. Which one are you interested in, tile, vinyl, or hardwood?";
  ck("aceita: tabela de 3 tarifas com o tipo desconhecido pode perder os preços (regra: nenhum preço antes do tipo)", safe(RATES, "With vinyl it's all included, tile and hardwood are labor only and you supply the material. Which floor are you looking at?").ok, why(RATES, "With vinyl it's all included, tile and hardwood are labor only and you supply the material. Which floor are you looking at?"));
  ck("…mas se o cliente PERGUNTOU preço, ao menos um preço fica", !safe(RATES, "With vinyl it's all included, tile and hardwood are labor only and you supply the material. Which floor are you looking at?", { clientAskedPrice: true }).ok);

  // Cada classe de perda é recusada (a original segue como está).
  const bad: Array<[string, string, string]> = [
    ["horário trocado", LONG_VISIT, "For that size I measure in person, free, samples in hand. Tomorrow Thursday at 9am or 11am?"],
    ["horário sumiu", LONG_VISIT, "For that size I measure in person, it's free and I bring samples. Does tomorrow Thursday at 9am work?"],
    ["dia trocado", LONG_VISIT, "For that size I measure in person, free, samples in hand. Friday at 9am or 1pm, which works?"],
    ["1ª proposta perdeu o 'free'", LONG_VISIT, "For that size I need to measure in person to give you the best price. Tomorrow Thursday at 9am or 1pm, which works?"],
    ["pergunta sumiu", LONG_VISIT, "For that size I need to measure in person, it's free and I bring samples, tomorrow Thursday at 9am or 1pm."],
    ["não encurtou o bastante", LONG_VISIT, LONG_VISIT.replace("completely ", "")],
    ["fala da reescrita", LONG_VISIT, "Here's a shorter version: free visit tomorrow Thursday at 9am or 1pm, which works?"],
    ["inventou [BOOK]", LONG_VISIT, 'Free visit tomorrow Thursday at 9am or 1pm, which works?[BOOK:{"name":""}]'],
  ];
  for (const [label, o, r] of bad) ck(`recusa: ${label}`, !safe(o, r).ok, why(o, r));
  ck("'free' já dito antes na conversa → a 2ª proposta pode sair sem ele", safe(LONG_VISIT, "For that size I need to measure in person to give you the best price. Tomorrow Thursday at 9am or 1pm, which works?", { freeAlreadySaid: true }).ok);
  const TILE = "Good question on the tile. For tile our promotion is $4.50 per square foot for the installation labor only, and you supply the tile material yourself, so that part is on your side and we take care of the whole installation from start to finish. Are you planning to do just one area or the whole house?";
  ck("aceita: preço de tile curto COM o 'labor only'", safe(TILE, "Tile is $4.50 per sqft, labor only, you supply the tile. One area or the whole house?").ok, why(TILE, "Tile is $4.50 per sqft, labor only, you supply the tile. One area or the whole house?"));
  ck("recusa: preço de tile sem dizer que é só mão de obra", !safe(TILE, "Tile installation is $4.50 per sqft. One area or the whole house?").ok);
  ck("recusa: preço único sumiu", !safe(TILE, "For tile it's labor only and you supply the tile material. One area or the whole house?").ok);
  ck("recusa: preço que não estava no original", !safe(TILE, "Tile is $4 per sqft, labor only, you supply the tile. One area or the whole house?").ok);
  const VINYL = "That sounds like a great fit for our luxury vinyl, it is 100% waterproof with a stone composite core and it holds up really well in South Florida homes. Our promo is $5 per square foot and that already includes the flooring, the installation labor, and the quarter round. Is it just one area or the whole house?";
  ck("aceita: vinyl curto COM o que o preço inclui", safe(VINYL, "Our vinyl promo is $5 per sqft, and that includes the floor, the installation and the quarter round. One area or the whole house?").ok, why(VINYL, "Our vinyl promo is $5 per sqft, and that includes the floor, the installation and the quarter round. One area or the whole house?"));
  ck("recusa: $5 sem dizer o que inclui", !safe(VINYL, "Our luxury vinyl is $5 per sqft and 100% waterproof. One area or the whole house?").ok);
  const FIN = "Yes, we do financing! The application is online, takes about 2 minutes, and checking your options does not affect your credit score, and once you are approved you call or text Ozzi directly at (561) 674-8334 to finalize everything: https://app.gethearth.com/partners/ozzifloors Does that help with what you were planning?[NOTIFY_OWNER]";
  ck("aceita: financiamento curto com link, telefone e tag", safe(FIN, "Yes, we do financing, the application takes 2 minutes and doesn't affect your credit: https://app.gethearth.com/partners/ozzifloors Once approved, call Ozzi at (561) 674-8334. Does that help?[NOTIFY_OWNER]").ok, why(FIN, "Yes, we do financing, the application takes 2 minutes and doesn't affect your credit: https://app.gethearth.com/partners/ozzifloors Once approved, call Ozzi at (561) 674-8334. Does that help?[NOTIFY_OWNER]"));
  ck("recusa: link sumiu", !safe(FIN, "Yes, we do financing, the application is online and takes 2 minutes. Once approved, call Ozzi at (561) 674-8334. Does that help?[NOTIFY_OWNER]").ok);
  ck("recusa: telefone sumiu", !safe(FIN, "Yes, we do financing, 2 minutes online, no impact on your credit: https://app.gethearth.com/partners/ozzifloors Does that help?[NOTIFY_OWNER]").ok);
  ck("recusa: [NOTIFY_OWNER] sumiu", !safe(FIN, "Yes, we do financing, 2 minutes online: https://app.gethearth.com/partners/ozzifloors Once approved, call Ozzi at (561) 674-8334. Does that help?").ok);
  const DATA = "Perfect, Thursday at 9am works great on my side and I'm holding that time for you right now so nobody else takes it while we finish up the details for the visit. Can I get the full property address with the zip code and the best phone number to reach you at?";
  ck("aceita: pedido de dados curto com zip + telefone", safe(DATA, "Perfect, I'm holding Thursday at 9am for you. What's the full address with the zip code and the best phone number?").ok, why(DATA, "Perfect, I'm holding Thursday at 9am for you. What's the full address with the zip code and the best phone number?"));
  ck("recusa: pedido de dados perdeu o zip code", !safe(DATA, "Perfect, I'm holding Thursday at 9am for you. What's the address and the best phone number?").ok);
  const OUT = "Unfortunately Naples is on the Gulf side of Florida, and we only serve the Miami area, the east coast of South Florida from Homestead all the way up to Jupiter, so that one is outside of what we can cover. If you ever have a project over on the Miami side of the state, please reach out anytime and I'll be glad to help!";
  ck("aceita: recusa de área curta que continua sendo recusa", safe(OUT, "Unfortunately Naples is outside our area, we only serve the east coast from Homestead to Jupiter. If you ever have a project on the Miami side, reach out anytime!").ok, why(OUT, "Unfortunately Naples is outside our area, we only serve the east coast from Homestead to Jupiter. If you ever have a project on the Miami side, reach out anytime!"));
  ck("recusa: a recusa virou convite", !safe(OUT, "Naples is on the Gulf side. If you ever have a project on the Miami side, reach out anytime and I'll be glad to help you with it!").ok);
  ck("'aproximadamente' da METRAGEM não trava a reescrita (replay ab2dcacd)", safe("Lo que describes suena perfecto para nuestro vinil de lujo, es flexible, ligero y muy facil de instalar, nada que ver con materiales duros. Nuestra promo es $5 por pie cuadrado e incluye el piso, la instalacion y el quarter round, todo incluido. Cuantos pies cuadrados tiene el segundo piso aproximadamente?", "Suena como nuestro vinil de lujo, flexible y facil de instalar. La promo es $5 por pie cuadrado e incluye el piso, la instalacion y el quarter round. Cuantos pies cuadrados tiene el segundo piso?").ok);
  ck("'approximate' do PREÇO tem que ficar", !safe("I hear you, and since a visit really is not possible on your side I can give you a rough idea just this once: roughly $6,000 approximate for that size, not the final price, which depends on the exact measurements we take. I can still come by free to measure, Friday at 1pm or 2pm?", "About $6,000 for that size. I can come by free to measure, Friday at 1pm or 2pm?", { freeAlreadySaid: true }).ok);
  // Replay real af2eb7cc: o modelo discutiu com a nota da agenda em voz alta (737 caracteres).
  const LEAK = "I'm Ozzi's assistant, part of the OzziFloors team. Can I get the full property address with the zip code and the best phone number so we can lock in that Monday September 28 at 2pm visit? Monday September 28 has 9am, 11am, 1pm, 3pm, 5pm listed but NOT 2pm as an open slot (2pm is in parenthesis). And today is already September 21, so \"next week Monday\" is September 28. Can I get the full property address with the zip code and the best phone number? I'm holding that Monday the 28th at 2pm for you while we finalize. Hmm, but 2pm on Monday the 28th is in parenthesis (only if client asks). I'm Ozzi's assistant, part of the OzziFloors team. Can I get the full property address with the zip code and the best phone number for the visit?";
  const scrubbed = stripReasoningLeak(LEAK);
  ck("scrubber de raciocínio tira 'in parenthesis' / 'listed but NOT' / 'Hmm, but' (nota interna da agenda)", !/parenthes|listed but NOT|Hmm/i.test(scrubbed) && /zip code/.test(scrubbed), scrubbed);
  const FIXED = "I'm Ozzi's assistant on the OzziFloors team. Can I get the full address with the zip code and the best phone number to hold Monday at 2pm?";
  ck("rascunho descontrolado (> 400): a reescrita pode DESCARTAR horários listados…", safe(LEAK, FIXED, { freeAlreadySaid: true }).ok, why(LEAK, FIXED, { freeAlreadySaid: true }));
  ck("…mas nunca ACRESCENTAR um horário que não estava lá", !safe(LEAK, FIXED.replace("2pm", "4pm"), { freeAlreadySaid: true }).ok);
  const BOTH = "For ceramic we only do the installation labor at $4.50 per sqft, you supply the tile. For LVP our promo is $5 per sqft and that already includes the flooring, labor, and quarter round. At 1,200 sqft, I'd need to come measure to give you the best price on both. When you're back at the condo, does Thursday at 11am or 3pm work?";
  ck("'we only do the installation labor' NÃO é recusa (replay e1f42680)", safe(BOTH, "Ceramic is $4.50 per sqft labor only, you supply the tile, and LVP is $5 per sqft with the floor included. For 1,200 sqft I'd measure in person, does Thursday at 11am or 3pm work?", { freeAlreadySaid: true }).ok, why(BOTH, "Ceramic is $4.50 per sqft labor only, you supply the tile, and LVP is $5 per sqft with the floor included. For 1,200 sqft I'd measure in person, does Thursday at 11am or 3pm work?", { freeAlreadySaid: true }));
  // Trava "oferta de horários + pedido de dados na mesma mensagem" (regra 7), só enquanto o cliente não escolheu.
  const H = [U("Hi, I want luxury vinyl for my whole house, about 1200 sqft."), A("For that size I need to measure in person, it's free. When works for you?"), U("I'm flexible, any day and time works for me.")];
  const both = "Today at 5pm or 7pm works, what's the full property address with the zip code and the best phone number?";
  ck("oferta + pedido de dados, cliente ainda não escolheu → fica a oferta + 'which one'", splitSlotOfferFromDetailsAsk(both, H, "en") === "Today at 5pm or 7pm works, which one do you prefer?", splitSlotOfferFromDetailsAsk(both, H, "en"));
  ck("…em duas frases e com tag: a tag sobrevive", splitSlotOfferFromDetailsAsk("I have today at 5pm or 7pm. What's the full address with the zip code and the best number?[NOTIFY_OWNER]", H, "en") === "I have today at 5pm or 7pm, which one do you prefer?[NOTIFY_OWNER]");
  ck("…em espanhol, sem ¿", splitSlotOfferFromDetailsAsk("Hoy tengo a las 5pm o 7pm, me puedes dar la dirección completa con el código postal y tu teléfono?", H, "es") === "Hoy tengo a las 5pm o 7pm, cuál te queda mejor?");
  const pickedH = [...H, A("Today I have 5pm or 7pm, which works?"), U("7pm works")];
  const afterPick = "Perfect, I'm holding 7pm, or 5pm if you prefer. What's the full address with the zip code and the best phone number?";
  ck("cliente JÁ escolheu → o pedido de dados nunca é tocado", splitSlotOfferFromDetailsAsk(afterPick, pickedH, "en") === afterPick);
  ck("só a oferta / só o pedido (1 horário) / com [BOOK] → intactos", splitSlotOfferFromDetailsAsk("Today I have 5pm or 7pm, which works better?", H, "en") === "Today I have 5pm or 7pm, which works better?" && splitSlotOfferFromDetailsAsk("Perfect, 7pm it is. What's the full address with the zip code?", H, "en") === "Perfect, 7pm it is. What's the full address with the zip code?" && splitSlotOfferFromDetailsAsk(both + '[BOOK:{"name":""}]', H, "en") === both + '[BOOK:{"name":""}]');
  ck("clientAskedPrice lê só a rajada sem resposta", clientAskedPrice([U("hi"), A("Which one?"), U("vinyl"), U("how much is it?")]) && !clientAskedPrice([U("how much?"), A("$5 per sqft"), U("ok the whole house")]));
  ck("freeAlreadySaid lê as NOSSAS mensagens (EN/ES/PT)", freeAlreadySaid([A("La visita es gratis.")]) && freeAlreadySaid([A("A visita é gratuita.")]) && !freeAlreadySaid([U("is it free?")]));

  if (process.env.DET_ONLY === "1") { done(); return; }

  // ───────────────────────────── 4. ao vivo ─────────────────────────────
  console.log("\n[4] AO VIVO: o mesmo funil, agora curto, com os fatos no lugar");
  const d = new Date(Date.now() + 2 * 86400e3);
  const SLOT_DATE = d.toISOString().slice(0, 10);
  const SLOT_DAY = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const sys = (extra = "") => `\n\n[SYSTEM: ${getEasternDateContext()}\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• ${SLOT_DAY} [${SLOT_DATE}]: 09:00, 11:00, 13:00, 15:00${extra ? "\n\n" + extra : ""}]`;
  const ask = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const lens: number[] = [];
  const show = (tag: string, t: string) => { lens.push(visibleLength(t)); console.log(`   ${tag} (${visibleLength(t)}c) → ${t.replace(/\s+/g, " ").slice(0, 320)}`); };
  const CEIL = 240; // a rede dispara acima de 220; folga para uma reescrita recusada rara não virar flake

  const a = await ask([U("Hi"), A(OPENER_EN), U("vinyl" + sys())]);
  show("4a vinyl", a);
  ck("4a: diz $5 e o que inclui", /\$5/.test(a) && /includ/i.test(a), a);
  ck(`4a: <= ${CEIL} caracteres`, visibleLength(a) <= CEIL, a);

  const b = await ask([U("Hi"), A(OPENER_EN), U("vinyl"), A("Our vinyl promo is $5 per sqft, floor, installation and quarter round included. One area or the whole house?"), U("the whole house, about 1800 sqft" + sys())]);
  show("4b casa toda", b);
  ck("4b: propõe a visita com DOIS horários da agenda", clockTokens(b).size === 2 && [...clockTokens(b)].every((t) => ["9:00a", "11:00a", "1:00p", "3:00p"].includes(t)), b);
  ck("4b: diz que é grátis, sem total em dólar", /free/i.test(b) && !/\$\s?\d{3,}/.test(b), b);
  ck(`4b: <= ${CEIL} caracteres (era ~250 com 3 frases)`, visibleLength(b) <= CEIL, b);

  const c = await ask([U("the whole house, about 1800 sqft vinyl"), A(`For 1,800 sqft I need to measure in person to give you the best price, it's free and I bring the samples. ${SLOT_DAY} at 9am or 11am?`), U("11am works" + sys())]);
  show("4c escolheu horário", c);
  ck("4c: pede endereço com zip code + telefone, sem nome, sem [BOOK]", /address|direcci/i.test(c) && /zip/i.test(c) && /phone|number/i.test(c) && !/\bname\b/i.test(c) && !/\[BOOK/.test(c), c);
  ck("4c: <= 180 caracteres", visibleLength(c) <= 180, c);

  const dd = await ask([U("Hola"), A(OPENER_ES), U("vinyl, es toda la casa como 1500 pies" + sys())]);
  show("4d espanhol", dd);
  ck("4d: responde em espanhol, com 2 horários, sem ¿¡", /visita|medir|gratis/i.test(dd) && clockTokens(dd).size === 2 && !/[¿¡]/.test(dd), dd);
  ck(`4d: <= ${CEIL} caracteres`, visibleLength(dd) <= CEIL, dd);

  const e = await ask([U("Hi"), A(OPENER_EN), U("tile, about 450 sqft" + sys())]);
  show("4e tile 450", e);
  ck("4e: $2,025 e só mão de obra (curto não pode ser incompleto)", /2,?025/.test(e) && /labor|you (?:supply|provide|buy)|your own tile/i.test(e), e);
  ck(`4e: <= ${CEIL} caracteres`, visibleLength(e) <= CEIL, e);

  const f = await ask([U("Hi"), A(OPENER_EN), U("vinyl"), A("Our vinyl promo is $5 per sqft, floor, installation and quarter round included. One area or the whole house?"), U("is it waterproof? I have dogs" + sys())]);
  show("4f pergunta de produto", f);
  ck("4f: responde a pergunta (waterproof) sem recitar a promo de novo", /waterproof/i.test(f) && !/\$5/.test(f), f);
  ck("4f: <= 200 caracteres", visibleLength(f) <= 200, f);

  const g = await ask([U("Hi, do you remove the old carpet, how long does it take, and do you work weekends? It's vinyl for the whole house" + sys())]);
  show("4g três perguntas de uma vez", g);
  ck("4g: responde as três (remoção, prazo, fim de semana)", /carpet|remov/i.test(g) && /2 to 3 days|2-3 days|two to three/i.test(g) && /weekend|saturday|sunday/i.test(g), g);
  ck("4g: mesmo com 3 perguntas, <= 300 caracteres", visibleLength(g) <= 300, g);

  // Os dois cenários que o A/B de 21/09 pegou regredindo com a 1ª versão (bloco de tamanho no fim do prompt).
  const opn = "Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. One area or the whole house?";
  const h480 = await ask([U("hi"), A(opn), U("about 480 sqft one area")]);
  show("4h 480 sqft após o pacote de vinyl", h480);
  ck("4h: dá o total ($2,400), NÃO volta a perguntar o tipo", /2[,.]?400/.test(h480) && !/tile, vinyl,? or hardwood/i.test(h480), h480);
  let mergedAsk = 0;
  for (let k = 0; k < 3; k++) {
    const any = await ask([U("Hi, I want luxury vinyl for my whole house, about 1200 sqft."), A("For that size I need to measure in person to give you the best price, it's free and I bring the samples. When works for you?"), U("I'm flexible, any day and time works for me." + sys())]);
    if (k === 0) show("4i 'any day works'", any);
    if (isAskingForBookingInfo(any) || clockTokens(any).size < 2) mergedAsk++;
  }
  ck("4i: 'any day and time works' → 2 horários e NUNCA o pedido de endereço junto (3 rodadas)", mergedAsk === 0, String(mergedAsk));

  const sorted = [...lens].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)];
  ck(`mediana das respostas ao vivo: ${median} <= 190 caracteres (era 233 nas respostas com preço, 14 dias antes)`, median <= 190, lens.join(", "));
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
