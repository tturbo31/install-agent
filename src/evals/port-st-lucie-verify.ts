/**
 * PORT ST. LUCIE (regra do dono 26/09/2026): passamos a atender Port St. Lucie,
 * mas o orçamento lá é marcado pelo DONO, não pelo chat. Quando o cliente diz
 * que é de lá: aviso nos dois WhatsApps ([NOTIFY_OWNER]) + "o Ozzi, dono da
 * empresa, vai entrar em contato para combinar o orçamento" (+ pedido do melhor
 * número no IG/Messenger quando o cliente não deu). Nunca horário, visita,
 * preço, [BOOK] nem recusa ("fora da área", "north of Jupiter").
 *
 * Puro (sem modelo):
 *  1. isPortStLucieMention / portStLucieStanding: cidade em várias grafias, PSL,
 *     St. Lucie West/County, ZIPs 34952/34953/34983-34988; não dispara com
 *     Stuart, Fort Pierce, Jupiter, ZIP 33xxx, texto do bot, bracket de foto.
 *  2. portStLucieHandoffMessage / Ack: idiomas, pedido de telefone só quando
 *     askPhone, e a própria frase NÃO dispara os detectores de vazamento.
 *  3. portStLucieLeak: pega [BOOK], preço, horário, visita, pedido de endereço e
 *     recusa; deixa passar a handoff e respostas neutras; nada sem standing.
 *  4. portStLucieAskPhone / lastClientBubbleHasPhone.
 *  5. Estático: prompt, nota dinâmica, early return, 3 webhooks (guarda de
 *     [BOOK], rede de vazamento, sem redirect pro número, alerta no aviso),
 *     trava 14 do Dreaming.
 * Ao vivo (LIVE=1): 4 chamadas ao getAIResponse: 1º contato EN (IG, enlatado +
 *  tag), ES no WhatsApp (sem pedir número), turno seguinte com pergunta (modelo
 *  com a nota: sem horário, sem recusa), turno com o telefone (ack + tag).
 * Run: npx tsx src/evals/port-st-lucie-verify.ts   |   LIVE=1 npx tsx src/evals/port-st-lucie-verify.ts
 */
import {
  isPortStLucieMention, portStLucieStanding, portStLucieLeak, portStLucieAskPhone, lastClientBubbleHasPhone,
  isPortStLucieHandoff, portStLucieHandoffGiven, promisesOwnerContact, containsSchedulingOffer, isAskingForBookingInfo,
  getAIResponse, type ChatMessage,
} from "../lib/ai";
import { portStLucieHandoffMessage, portStLucieAckMessage } from "../lib/scheduler";
import { sentenceCount } from "../lib/reply-length";
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
const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";

console.log("\n━━ 1. isPortStLucieMention / portStLucieStanding ━━");
for (const t of [
  "Hi, I'm in Port St. Lucie, do you come up here?", "port st lucie", "Port Saint Lucie", "PortStLucie 34953", "I live in PSL",
  "St. Lucie West", "St Lucie County", "Estoy en Port Saint Lucie", "Moro em Port St Lucie", "1234 SW Bayshore Blvd, Port St. Lucie, FL 34984",
  "My zip is 34952", "34986", "address is 500 NW Peacock Blvd 34986", "Porto São Lúcio",
  "Port St. Lucie\n\n[SYSTEM: REAL-TIME SCHEDULE …]",
]) ck(`menção: «${t.split("\n")[0]}»`, isPortStLucieMention(t), t);
for (const t of [
  "I'm in Stuart", "Fort Pierce 34950", "Vero Beach", "Jupiter 33458", "Miami 33176", "Boca Raton", "1910 E Sunrise Blvd Fort Lauderdale 33304",
  "Do you serve Palm Beach?", "St. Louis", "Saint Augustine", "[Floor plan analysis: photo of a floor in Port St. Lucie]", "34950", "33952",
]) ck(`não menção: «${t}»`, !isPortStLucieMention(t), t);
ck("standing: só o cliente conta (bot falando de PSL não conta)", !portStLucieStanding([U("Hi"), A("We don't serve Port St. Lucie, only Homestead to Jupiter.")]) && portStLucieStanding([U("Hi"), A(OPENER), U("Vinyl, I'm in Port St Lucie")]));
ck("standing persiste depois de outras mensagens", portStLucieStanding([U("I'm in PSL"), A("x"), U("ok thanks")]));

console.log("\n━━ 2. mensagens ━━");
const hEnAsk = portStLucieHandoffMessage("en", true), hEn = portStLucieHandoffMessage("en", false);
const hEs = portStLucieHandoffMessage("es", true), hPt = portStLucieHandoffMessage("pt", true);
ck("EN: atende + Ozzi dono entra em contato + pede número", /Port St\. Lucie works/.test(hEnAsk) && /Ozzi, the owner, will reach out/.test(hEnAsk) && /best number/.test(hEnAsk) && /\?$/.test(hEnAsk), hEnAsk);
ck("EN sem askPhone: não pede número", !/number/.test(hEn) && /\.$/.test(hEn), hEn);
ck("ES: dueño + número, sem ¿", /dueño de la empresa/.test(hEs) && /mejor número/.test(hEs) && !/[¿¡]/.test(hEs), hEs);
ck("PT: dono + número", /dono da empresa/.test(hPt) && /melhor número/.test(hPt), hPt);
for (const [lang, m] of [["en", hEnAsk], ["en", hEn], ["es", hEs], ["pt", hPt], ["en", portStLucieAckMessage("en")], ["es", portStLucieAckMessage("es")], ["pt", portStLucieAckMessage("pt")]] as Array<[string, string]>) {
  ck(`${lang} «${m.slice(0, 30)}…»: não dispara oferta de horário/visita nem traço/emoji`, !containsSchedulingOffer(m) && !/[—–]/.test(m) && !/[\u{1F300}-\u{1FAFF}]/u.test(m), m);
  ck(`${lang} «${m.slice(0, 30)}…»: ≤ 2 frases, ≤ 220 chars`, sentenceCount(m) <= 2 && m.length <= 220, m);
}
ck("isPortStLucieHandoff reconhece as 3 línguas e não a recusa antiga", isPortStLucieHandoff(hEnAsk) && isPortStLucieHandoff(hEs) && isPortStLucieHandoff(hPt) && !isPortStLucieHandoff("I'm sorry, we only serve Homestead to Jupiter, so Port St. Lucie is outside our area."));
ck("portStLucieHandoffGiven olha só o assistant", portStLucieHandoffGiven([U("PSL"), A(hEnAsk)]) && !portStLucieHandoffGiven([U("PSL"), U(hEnAsk)]));
ck("a promessa 'Ozzi entra em contato' é reconhecida em PT (por isso o webhook pula o redirect)", promisesOwnerContact(hPt));

console.log("\n━━ 3. portStLucieLeak ━━");
const psl = [U("Hi, I'm in Port St. Lucie 34953, do you install vinyl?"), A(hEnAsk), U("ok")];
for (const r of [
  "For that size I need to measure in person, it's a free visit. Does Friday at 3pm or 8pm work?",
  "I have Tuesday at 9am or 11am, which works for you?",
  "Our vinyl promo is $5 per sqft with the floor and installation included.",
  "Can I get the full property address with the zip code and the best phone number?",
  "Perfect, see you then! [BOOK:{\"name\":\"\",\"phone\":\"7725550100\",\"address\":\"1 SW Bayshore Blvd, Port St. Lucie 34984\",\"date\":\"2026-09-28\",\"time\":\"3pm\"}]",
  "I'm sorry, we only serve the Miami area, from Homestead up to Jupiter, so we don't cover Port St. Lucie.",
  "Unfortunately Port St. Lucie is outside our service area.",
  "That's north of Jupiter, so we can't serve it.",
  "Lo siento, no cubrimos Port St. Lucie, solo de Homestead a Jupiter.",
  "Infelizmente não atendemos Port St. Lucie.",
]) ck(`vaza: «${r.slice(0, 60)}»`, portStLucieLeak(psl, r), r);
for (const r of [
  hEnAsk, hEn, hEs, hPt, portStLucieAckMessage("en"),
  "We install luxury vinyl plank, porcelain and ceramic tile, hardwood and carpet. Ozzi, the owner, will reach out to you directly to arrange the quote.",
  "Yes, our vinyl is 100% waterproof and goes right over existing tile.",
  "Perfect, got it. Ozzi will reach out to you shortly.[NOTIFY_OWNER]",
  // Pedir o telefone é parte do fluxo; "free estimate" atribuído ao Ozzi também.
  "Yes, 100% waterproof with a 20-year warranty. What's the best number for Ozzi to reach you?",
  "We install luxury vinyl, tile, hardwood and carpet. Ozzi will reach out to set up your free estimate!",
]) ck(`não vaza: «${r.slice(0, 60)}»`, !portStLucieLeak(psl, r), r);
ck("vaza: pedido de ENDEREÇO / zip continua vazamento", portStLucieLeak(psl, "What's the property address with the zip code?") && portStLucieLeak(psl, "Cuál es la dirección de la propiedad?"));
ck("vaza: visita oferecida pelo BOT (sem Ozzi na frase)", portStLucieLeak(psl, "I can come by for a free estimate this week, which day works?"));
ck("sem standing nada vaza", !portStLucieLeak([U("Hi, I'm in Miami"), A(OPENER), U("vinyl")], "I have Tuesday at 9am or 11am, which works for you?"));

console.log("\n━━ 4. telefone ━━");
ck("askPhone: IG sem telefone → sim", portStLucieAskPhone([U("I'm in PSL")]));
ck("askPhone: cliente já digitou o telefone → não", !portStLucieAskPhone([U("I'm in PSL, 772-555-0100")]));
ck("askPhone: WhatsApp (nota do canal) → não", !portStLucieAskPhone([U("I'm in PSL\n\n[SYSTEM: [WHATSAPP CHANNEL: You are chatting on WhatsApp…]]")]));
ck("lastClientBubbleHasPhone: só a última bolha do cliente", lastClientBubbleHasPhone([U("PSL"), A(hEnAsk), U("(772) 555-0100")]) && !lastClientBubbleHasPhone([U("PSL 7725550100"), A(hEnAsk), U("ok")]));

console.log("\n━━ 5. estático ━━");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
const base = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
const dream = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
// A/B de 26/09 na sentinela "480 sqft após o pacote" (N=12 cada): base do dia
// 3/12, parágrafo PSL completo no prompt estável 4/18, parágrafo MÍNIMO 6/12.
// O comportamento inteiro vive na nota dinâmica (só entra quando PSL vale) e
// nas camadas determinísticas; o prompt estável só tira PSL da lista de recusa.
ck("prompt base: Port St. Lucie é a exceção (dono marca o orçamento, nunca recusar/horário/BOOK), parágrafo mínimo", /The ONE exception is Port St\. Lucie \(owner rule 2026-09-26\): we serve it, but Ozzi, the owner, arranges the quote there himself/.test(base) && /never decline it, never offer times and never book it/.test(base) && !/we DO serve Port St\. Lucie now \(also spelled/.test(base));
ck("prompt base: Port St. Lucie saiu da lista de recusa e do exemplo do ZIP 34952", !/Port St\. Lucie \(also spelled Port Saint Lucie, Port St Lucie, Porto São Lúcio\), Stuart/.test(base) && !/e\.g\. 34952 = Port St\. Lucie\) is OUTSIDE/.test(base) && /except the Port St\. Lucie ZIPs/.test(base) && /Port St\. Lucie excepted/.test(base));
ck("prompt base: NENHUMA regra nova nos FINAL REMINDERS (a 41 de 24/09 derrubou o fluxo de 480 sqft)", !/41\. /.test(ai.slice(ai.indexOf("FINAL REMINDERS:"), ai.indexOf("FINAL REMINDERS:") + 60000).split("`;")[0]));
ck("ai.ts: early return com handoff + [NOTIFY_OWNER] antes dos enlatados", /if \(portStLucieStanding\(messages\)\) \{\s*if \(!portStLucieHandoffGiven\(messages\)\)[\s\S]{0,300}portStLucieHandoffMessage\(usersLang\(\), portStLucieAskPhone\(messages\)\) \+ "\[NOTIFY_OWNER\]"/.test(ai) && ai.indexOf("if (portStLucieStanding(messages)) {\n    if (!portStLucieHandoffGiven") < ai.indexOf("// Check hard-coded intercepts first"));
ck("ai.ts: telefone na última bolha → ack + [NOTIFY_OWNER]", /lastClientBubbleHasPhone\(messages\)[\s\S]{0,200}portStLucieAckMessage\(usersLang\(\)\) \+ "\[NOTIFY_OWNER\]"/.test(ai));
ck("ai.ts: nota dinâmica + rede de vazamento + guardas de referral", /dynamicSystem \+= "\\n\\n---\\n\\n" \+ PORT_ST_LUCIE_NOTE;/.test(ai) && /if \(portStLucieLeak\(messages, cleaned\)\)/.test(ai) && (ai.match(/!mobileHomeStanding\(messages\) && !portStLucieStanding\(messages\)/g) ?? []).length === 4);
for (const [f, tag, ask] of [["fb-webhook", "FB", "portStLucieAskPhone(history)"], ["wa-webhook", "WA", "false"], ["webhook", "IG", "portStLucieAskPhone(history)"]]) {
  const w = readFileSync(join(process.cwd(), `src/app/api/${f}/route.ts`), "utf-8").replace(/\r\n/g, "\n");
  ck(`${tag}: guarda de [BOOK] devolve a handoff (askPhone=${ask})`, w.includes(`if (portStLucieStanding(history)) {\n    console.warn("[${tag}] booking blocked — Port St. Lucie`) && w.includes(`return { response: portStLucieHandoffMessage(lang, ${ask}), booked: false };`));
  ck(`${tag}: rede de vazamento no webhook`, new RegExp(`if \\(!isBookingConfirmed && portStLucieLeak\\(history, safe(?:Response|AiText)\\)\\)`).test(w));
  ck(`${tag}: sem redirect pro número enquanto PSL vale`, w.includes("stripForbiddenTags(portStLucieStanding(history) ? afterNotify : redirectOwnerPromiseToPhone(afterNotify, lang))"));
  ck(`${tag}: aviso aos donos leva o alerta de PSL`, w.includes("portStLucieStanding(history) ? PORT_ST_LUCIE_ALERT : null") && /alert\?: string \| null\n\): Promise<string>/.test(w) && w.includes("alert: alert ?? null,"));
}
ck("Dreaming: trava 14 (nunca aprender a recusar Port St. Lucie)", /14\. PORT ST\. LUCIE IS SERVED, AND THE OWNER SETS UP THE QUOTE/.test(dream));
ck("aviso vai para os DOIS WhatsApps (OWNER_PHONES com 2 números)", /const OWNER_PHONES = \["15616748334", "556294554477"\];/.test(readFileSync(join(process.cwd(), "src/lib/whatsapp.ts"), "utf-8")));

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 6. ao vivo ━━");
  const get = async (msgs: ChatMessage[]) => { const r = await getAIResponse(msgs, null, null, undefined, false); return (r as { text?: string }).text ?? String(r); };
  try {
    const a = await get([U("Hi, I'm in Port St. Lucie, do you guys come up here? I need vinyl for the whole house")]);
    ck("1º contato IG EN: handoff enlatada + [NOTIFY_OWNER] + pede número", isPortStLucieHandoff(a) && /\[NOTIFY_OWNER\]/.test(a) && /best number/.test(a), a);
    const b = await get([U("Hola, estoy en Port Saint Lucie 34953, hacen pisos por acá?\n\n[SYSTEM: [WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (17725550100).]]")]);
    ck("WhatsApp ES: handoff em espanhol, sem pedir número, com tag", /dueño de la empresa/.test(b) && !/número/.test(b) && /\[NOTIFY_OWNER\]/.test(b), b);
    const c = await get([U("Hi, I'm in Port St. Lucie, do you guys come up here?"), A(portStLucieHandoffMessage("en", true)), U("Ok. What floors do you install and is the vinyl waterproof?")]);
    ck("turno seguinte (modelo com a nota): responde, sem horário/recusa/preço, sem mandar ligar pro Ozzi", !portStLucieLeak([U("Port St. Lucie")], c) && /waterproof|vinyl/i.test(c) && !/674[\s.-]?8334/.test(c) && !/\[BOOK:/.test(c), c);
    ck("turno seguinte: curta (≤ 220 chars)", c.replace(/\[[A-Z_]+\]/g, "").trim().length <= 220, c);
    const d = await get([U("Hi, I'm in Port St. Lucie, do you guys come up here?"), A(portStLucieHandoffMessage("en", true)), U("772-555-0100")]);
    ck("cliente manda o telefone: ack + [NOTIFY_OWNER]", /Ozzi, the owner, will reach out/.test(d) && /\[NOTIFY_OWNER\]/.test(d) && !isAskingForBookingInfo(d), d);
  } catch (e) { ck("chamadas ao vivo", false, String(e)); }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
