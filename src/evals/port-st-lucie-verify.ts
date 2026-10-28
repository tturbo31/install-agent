/**
 * PORT ST. LUCIE (regra do dono 26/09/2026, REESCRITA em 28/10/2026).
 * 26/09: atendemos Port St. Lucie, mas o chat nunca agendava: "o Ozzi, dono da
 * empresa, vai entrar em contato" + aviso nos WhatsApps.
 * 28/10 (caso Jesus Rivera, Messenger fb_38098546056458916: "1500 S/F??? in
 * Port St Lucie." recebeu o "Ozzi will reach out" e o dono assumiu na mão):
 * a METRAGEM decide.
 *   - 1.000 sq ft ou mais (ou a casa toda) → visita marcada pelo chat, SÓ no
 *     primeiro horário da manhã (antes das 10h) ou a partir das 17h, nunca no
 *     meio do dia (agenda filtrada + trava do [BOOK] nos 3 webhooks).
 *   - abaixo de 1.000 → número do Ozzi, o cliente liga (sem preço/visita/horário).
 *   - sem metragem → pergunta a metragem (2 perguntas sem número → número do Ozzi).
 *
 * Puro (sem modelo):
 *  1. isPortStLucieMention / portStLucieStanding (inalterados).
 *  2. portStLucieSize / portStLucieMode: S/F, sg ft, número solto respondendo a
 *     nossa pergunta, casa toda, telefone e endereço não são metragem, limite 1.000.
 *  3. isSizeAsk.
 *  4. Mensagens enlatadas: idiomas, sem ¿¡ nem travessão, sem promessa de
 *     contato, o redirect de 14/09 não mexe nelas, não disparam o próprio vazamento.
 *  5. portStLucieLeak / portStLucieReply / portStLucieEnsureSizeAsk por modo.
 *  6. portStLucieHourAllowed (9am e 17h+ sim; 10h-16h não).
 *  7. Nota dinâmica por modo.
 *  8. Estático: ai.ts, scheduler.ts, 3 webhooks, prompt, Dreaming.
 * Agenda real, SÓ LEITURA (SCHED=1 ou LIVE=1): a agenda filtrada só tem 9am / 17h+
 *  e é subconjunto da normal; getNextOpenSlots e portStLucieHoursMessage idem.
 * Ao vivo (LIVE=1): caso Jesus (visita com horário de PSL), 875 sq ft (número
 *  do Ozzi), 1º contato EN/ES (pergunta a metragem), pedido de 1pm (recusa o
 *  meio do dia), insistência no preço abaixo de 1.000, pergunta sem metragem.
 * Run: npx tsx src/evals/port-st-lucie-verify.ts   |   LIVE=1 npx tsx src/evals/port-st-lucie-verify.ts
 */
import {
  isPortStLucieMention, portStLucieStanding, portStLucieLeak, portStLucieMode, portStLucieSize, portStLucieReply,
  portStLucieEnsureSizeAsk, portStLucieNote, portStLucieReferral, portStLucieIntroGiven, portStLucieCallSent, isSizeAsk,
  isPortStLucieHandoff, promisesOwnerContact, redirectOwnerPromiseToPhone, containsSchedulingOffer, isAskingForBookingInfo,
  smallJobStanding, getAIResponse, type ChatMessage,
} from "../lib/ai";
import {
  portStLucieSizeAskMessage, portStLucieCallOzziMessage, portStLucieCallOzziInsistMessage, portStLucieVisitMessage,
  portStLucieHourAllowed, portStLucieHoursMessage, getRealAvailabilityContext, getNextOpenSlots, getEasternDateContext, scheduleLinesOf,
} from "../lib/scheduler";
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
const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const AD_GREETING = "Hi Jesus! Need flooring installation? We offer expert services like the one you see here.";
const SIZE_ASK_EN = portStLucieSizeAskMessage("en", true);
const OLD_HANDOFF = "Port St. Lucie works, we're just starting to serve that area. Ozzi, the owner, will reach out to you directly to arrange your quote, what's the best number to reach you?";
const ZIP_ASK_875 = "For 875 sqft I need to measure in person to give you the best price, the visit is free and I bring all the samples. What's the zip code of the property?";
const OZZI_NUM = /\(?561\)?[\s.-]*674[\s.-]*8334/;
const clockHours = (t: string) => [...(t || "").matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)].map((m) => `${m[1]}${m[2] ? ":" + m[2] : ""}${m[3].toLowerCase()}`);

console.log("\n━━ 1. menção (inalterada) ━━");
for (const t of [
  "Hi, I'm in Port St. Lucie, do you come up here?", "port st lucie", "Port Saint Lucie", "PortStLucie 34953", "I live in PSL",
  "St. Lucie West", "St Lucie County", "Estoy en Port Saint Lucie", "Moro em Port St Lucie", "1234 SW Bayshore Blvd, Port St. Lucie, FL 34984",
  "34952", "my zip is 34986", "1500 S/F??? in Port St Lucie.",
]) ck(`menção: «${t}»`, isPortStLucieMention(t), t);
for (const t of ["I'm in Stuart", "Fort Pierce", "Jupiter 33458", "Do you serve Palm Beach?", "St. Louis", "34950", "33952"]) ck(`não menção: «${t}»`, !isPortStLucieMention(t), t);
ck("standing: só o cliente conta", !portStLucieStanding([U("Hi"), A("We don't serve Port St. Lucie.")]) && portStLucieStanding([U("Hi"), A(OPENER), U("Vinyl, I'm in Port St Lucie")]));

console.log("\n━━ 2. metragem e modo ━━");
const PSL = U("Hi, I'm in Port St. Lucie");
const mode = (h: ChatMessage[]) => portStLucieMode(h);
const cases: Array<[string, ChatMessage[], ReturnType<typeof portStLucieMode>, number | null]> = [
  ["Jesus: «1500 S/F??? in Port St Lucie.» → visita", [A(AD_GREETING), U("1500 S/F??? in Port St Lucie.")], "visit", 1500],
  ["«875 sg ft» + ZIP 34952 → número do Ozzi", [U("Upstairs. 875 sg ft which includes the 10% extra"), A(ZIP_ASK_875), U("34952")], "call_ozzi", 875],
  ["«about 1100sqft» + 34952 → visita", [U("Front area about 1100sqft not over"), A("For that size I need to measure in person, the visit is free. What's the zip code of the property?"), U("34952")], "visit", 1100],
  ["só a cidade → pergunta a metragem", [PSL], "ask_size", null],
  ["«1,600» respondendo a pergunta → visita", [PSL, A(SIZE_ASK_EN), U("1,600")], "visit", 1600],
  ["«about 800» respondendo → número do Ozzi", [PSL, A(SIZE_ASK_EN), U("about 800")], "call_ozzi", 800],
  ["«1700 the whole house» → visita", [PSL, A(SIZE_ASK_EN), U("1700 the whole house")], "visit", 1700],
  ["«1.500» (pt/es) → visita", [U("Moro em Port St Lucie"), A(portStLucieSizeAskMessage("pt")), U("1.500")], "visit", 1500],
  ["«1000 sqft» exato → visita (limite inclusivo)", [U("PSL, 1000 sqft of vinyl")], "visit", 1000],
  ["«999 sq ft» → número do Ozzi", [U("PSL, 999 sq ft of vinyl")], "call_ozzi", 999],
  ["«over 1000 sq ft» → visita", [U("Port St Lucie, over 1000 sq ft")], "visit", 1000],
  ["«under 1000 sqft» → número do Ozzi", [U("Port St Lucie, under 1000 sqft")], "call_ozzi", 999],
  ["«1500 sq» (sem ft) → visita", [U("Port St Lucie 1500 sq")], "visit", 1500],
  ["«1.200 pés quadrados» → visita", [U("Moro em Port St Lucie, são 1.200 pés quadrados")], "visit", 1200],
  ["«90 metros cuadrados» → número do Ozzi", [U("Estoy en Port Saint Lucie, son 90 metros cuadrados")], "call_ozzi", 969],
  ["«12x14 kitchen» → número do Ozzi", [U("I'm in PSL, my kitchen is 12x14")], "call_ozzi", 168],
  ["telefone respondendo a pergunta NÃO é metragem", [PSL, A(SIZE_ASK_EN), U("772 304 4977")], "ask_size", null],
  ["endereço respondendo a pergunta NÃO é metragem", [PSL, A(SIZE_ASK_EN), U("9824 sw isabelline dr Port St. Lucie")], "ask_size", null],
  ["hora respondendo NÃO é metragem", [PSL, A(SIZE_ASK_EN), U("call me after 1000am")], "ask_size", null],
  ["número solto SEM a nossa pergunta não conta", [PSL, A("Which one are you interested in?"), U("1500")], "ask_size", null],
  ["«the whole house» sem número → visita", [PSL, A(SIZE_ASK_EN), U("the whole house")], "visit", null],
  ["«casa toda» → visita", [U("Moro em Port St Lucie, quero piso na casa toda")], "visit", null],
  ["800 e depois «whole house» → visita", [U("PSL, 800 sqft"), A("x"), U("actually the whole house")], "visit", 800],
  ["whole house e depois «800 sqft» → número do Ozzi", [U("PSL, whole house"), A("x"), U("it's 800 sqft total")], "call_ozzi", 800],
  ["duas perguntas sem número → número do Ozzi", [PSL, A(SIZE_ASK_EN), U("not sure"), A("No problem, about how many square feet would you say?"), U("idk")], "call_ozzi", null],
  ["sem Port St. Lucie → null", [U("I'm in Miami, 1500 sqft")], null, 1500],
];
for (const [name, h, want, sq] of cases) {
  const got = mode(h);
  const size = portStLucieSize(h);
  ck(name, got === want && (sq === null ? true : size.sqft === sq), `mode=${got} sqft=${size.sqft} whole=${size.wholeHome}`);
}
ck("referral = ask_size/call_ozzi; visita não", portStLucieReferral([PSL]) && portStLucieReferral([U("PSL, 875 sqft")]) && !portStLucieReferral([U("PSL, 1500 sqft")]) && !portStLucieReferral([U("Miami 875 sqft")]));
ck("S/F e sg ft também valem fora de PSL (smallJobStanding lê «300 S/F»)", smallJobStanding([U("300 S/F of vinyl")]) === 300 && smallJobStanding([U("350 sg ft")]) === 350);

console.log("\n━━ 3. isSizeAsk ━━");
for (const t of [SIZE_ASK_EN, portStLucieSizeAskMessage("es"), portStLucieSizeAskMessage("pt"), portStLucieSizeAskMessage("en", false), "Hi Tina how are you? How many square feet are in the space you need the installation?", "Got it. What's the size, roughly how many sq ft?"]) ck(`pergunta: «${t.slice(0, 60)}»`, isSizeAsk(t), t);
for (const t of [ZIP_ASK_875, "For 1,500 sqft the visit is free. What day works best?", OPENER, "About 1,000 square feet is a nice size."]) ck(`não pergunta: «${t.slice(0, 60)}»`, !isSizeAsk(t), t);

console.log("\n━━ 4. mensagens enlatadas ━━");
const msgs: Array<[string, string]> = [];
for (const l of ["en", "es", "pt"] as const) {
  msgs.push([`size ${l}`, portStLucieSizeAskMessage(l, true)], [`size-nointro ${l}`, portStLucieSizeAskMessage(l, false)]);
  msgs.push([`call ${l}`, portStLucieCallOzziMessage(l, 875, true)], [`call-nosize ${l}`, portStLucieCallOzziMessage(l, null, false)], [`insist ${l}`, portStLucieCallOzziInsistMessage(l)]);
  msgs.push([`visit ${l}`, portStLucieVisitMessage(l, true, false)], [`visit-zip ${l}`, portStLucieVisitMessage(l, false, true)]);
}
for (const [n, m] of msgs) {
  ck(`${n}: sem ¿¡, sem travessão, sem promessa de contato, redirect não mexe`, !/[¿¡—–]/.test(m) && !promisesOwnerContact(m) && redirectOwnerPromiseToPhone(m, n.endsWith("es") ? "es" : n.endsWith("pt") ? "pt" : "en") === m, m);
}
for (const l of ["en", "es", "pt"] as const) {
  const c = portStLucieCallOzziMessage(l, 875, true);
  ck(`call ${l}: tem o número, sem «?», sem horário, sem pedido de dados`, OZZI_NUM.test(c) && !c.includes("?") && !containsSchedulingOffer(c) && !isAskingForBookingInfo(c), c);
  ck(`size ${l}: é pergunta de metragem e não pede dados`, isSizeAsk(portStLucieSizeAskMessage(l)) && !isAskingForBookingInfo(portStLucieSizeAskMessage(l)), portStLucieSizeAskMessage(l));
}
ck("intro só quando ainda não falamos de PSL (handoff antigo conta)", portStLucieSizeAskMessage("en", true).startsWith("Port St. Lucie works") && !portStLucieSizeAskMessage("en", false).includes("Port St. Lucie") && portStLucieIntroGiven([PSL, A(OLD_HANDOFF)]) && !portStLucieIntroGiven([PSL]));

console.log("\n━━ 5. vazamento / resposta por modo ━━");
const askH = [PSL, A(SIZE_ASK_EN), U("ok")];
for (const r of [
  "I have Tuesday at 9am or 5pm, which works for you?",
  "Perfect, see you then! [BOOK:{\"name\":\"\",\"phone\":\"7725550100\",\"address\":\"1 SW Bayshore Blvd, Port St. Lucie 34984\",\"date\":\"2026-10-30\",\"time\":\"5pm\"}]",
  "What's the property address with the zip code?",
  "I'm sorry, we don't cover Port St. Lucie, only Homestead to Jupiter.",
  "I can come by for a free estimate this week.",
]) ck(`ask_size vaza: «${r.slice(0, 55)}»`, portStLucieLeak(askH, r), r);
for (const r of [SIZE_ASK_EN, "Yes, it's 100% waterproof. About how many square feet is the project?", "Our vinyl promo is $5 per sq ft with the floor, install and quarter round. About how many square feet is it?"]) ck(`ask_size ok: «${r.slice(0, 55)}»`, !portStLucieLeak(askH, r), r);
const callH = [U("Upstairs. 875 sg ft"), A(ZIP_ASK_875), U("34952")];
for (const r of ["For 875 sqft the visit is free, what day works?", "That would be about $4,375.", "Sounds good, Ozzi handles that one.", "What's your full address and phone?", "We don't serve that area."]) ck(`call_ozzi vaza: «${r.slice(0, 55)}»`, portStLucieLeak(callH, r), r);
ck("call_ozzi ok: a enlatada", !portStLucieLeak(callH, portStLucieCallOzziMessage("en", 875, false)));
const callSentH = [...callH, A(portStLucieCallOzziMessage("en", 875, true)), U("can't you just tell me the price?")];
ck("call_ozzi depois do número: resposta curta sem número não vaza, preço vaza", !portStLucieLeak(callSentH, "I'm not able to set that one up through here.") && portStLucieLeak(callSentH, "It's around $5 per sq ft."));
const visitH = [A(AD_GREETING), U("1500 S/F??? in Port St Lucie.")];
ck("visit: horário, [BOOK] e visita NÃO vazam; recusa vaza", !portStLucieLeak(visitH, "For 1,500 sq ft the visit is free, I have tomorrow at 9am or 7pm, which works?") && !portStLucieLeak(visitH, "Perfect! [BOOK:{\"date\":\"2026-10-30\",\"time\":\"5pm\"}]") && portStLucieLeak(visitH, "Sorry, Port St. Lucie is outside our service area."));
ck("sem PSL nada vaza", !portStLucieLeak([U("Hi, I'm in Miami"), A(OPENER), U("vinyl")], "I have Tuesday at 9am or 11am, which works for you?"));
ck("reply ask_size = pergunta (com intro na 1ª vez)", portStLucieReply([PSL], "en") === portStLucieSizeAskMessage("en", true));
ck("reply call_ozzi = número; depois de enviado = insistência", portStLucieReply(callH, "en") === portStLucieCallOzziMessage("en", 875, true) && portStLucieReply(callSentH, "en") === portStLucieCallOzziInsistMessage("en"));
ck("reply call_ozzi sem intro quando o handoff antigo já falou de PSL", portStLucieReply([U("I'm in PSL"), A(OLD_HANDOFF), U("it's 700 sqft")], "en") === portStLucieCallOzziMessage("en", 700, false));
ck("reply visit: pede o ZIP se não veio; ZIP dado → dia", /zip code/.test(portStLucieReply(visitH, "en")) && /What day works/.test(portStLucieReply([U("1500 sqft, Port St Lucie 34953")], "en")));
ck("callSent lê o número em mensagem nossa (não o do WhatsApp das fotos)", portStLucieCallSent(callSentH) && !portStLucieCallSent([A("Send the photos to our WhatsApp (561) 674-8334")]));
ck("ensureSizeAsk: ask_size sem pergunta → acrescenta", portStLucieEnsureSizeAsk(askH, "Yes, it's 100% waterproof.", "en") === "Yes, it's 100% waterproof. " + portStLucieSizeAskMessage("en", false));
ck("ensureSizeAsk: já pergunta / tag / outro modo → intacto", portStLucieEnsureSizeAsk(askH, "Is it the whole house?", "en") === "Is it the whole house?" && portStLucieEnsureSizeAsk(askH, "Sure.[NOTIFY_OWNER]", "en") === "Sure.[NOTIFY_OWNER]" && portStLucieEnsureSizeAsk(visitH, "Great.", "en") === "Great.");

console.log("\n━━ 6. horário permitido em PSL ━━");
for (const t of ["8:00", "9:00", "09:00", "9am", "9:30am", "17:00", "5pm", "18:00", "19:00", "7pm", "20:00"]) ck(`permitido: ${t}`, portStLucieHourAllowed(t));
for (const t of ["10:00", "11:00", "11am", "13:00", "1pm", "14:00", "15:00", "3pm", "16:00", "16:30", "", "tomorrow"]) ck(`meio do dia / inválido: «${t}»`, !portStLucieHourAllowed(t));

console.log("\n━━ 7. nota por modo ━━");
const nAsk = portStLucieNote([PSL]) ?? "", nCall = portStLucieNote(callH) ?? "", nVisit = portStLucieNote(visitH) ?? "";
ck("nota ask_size: pergunta a metragem, sem horário/endereço/BOOK", /NOT given the size/.test(nAsk) && /how many square feet/.test(nAsk) && /do NOT ask for the address/.test(nAsk));
ck("nota call_ozzi: 875, número, nunca preço/visita/BOOK, insistência", /about 875 square feet, UNDER 1,000/.test(nCall) && /\(561\) 674-8334/.test(nCall) && /NEVER give a price/.test(nCall) && /not able to set that one up through here/.test(nCall));
ck("nota visit: 1500, fluxo normal, horário de PSL (manhã cedo / 17h+), nunca mandar pro Ozzi", /about 1500 square feet, so it is a VISIT/.test(nVisit) && /first time of the morning or in the late afternoon \(5pm or later\)/.test(nVisit) && /Do NOT send the client to Ozzi's number/.test(nVisit));
ck("todas: nunca recusar e nunca prometer que o Ozzi entra em contato", [nAsk, nCall, nVisit].every((n) => /NEVER say we don't cover it/.test(n) && /NEVER say that Ozzi will reach out/.test(n)));
ck("sem PSL → sem nota", portStLucieNote([U("Miami 1500 sqft")]) === null);

console.log("\n━━ 8. estático ━━");
const rd = (p: string) => readFileSync(join(process.cwd(), p), "utf-8").replace(/\r\n/g, "\n");
const ai = rd("src/lib/ai.ts"), sc = rd("src/lib/scheduler.ts"), base = rd("src/lib/system-prompt.ts"), dream = rd("src/lib/dreaming.ts");
ck("ai.ts: early return pergunta a metragem / manda o número, antes dos enlatados", /const pslMode = portStLucieMode\(messages\);\n  if \(pslMode === "ask_size" && !messages\.some\(\(m\) => m\.role === "assistant" && isSizeAsk\(m\.content\)\)\)/.test(ai) && /if \(pslMode === "call_ozzi" && !portStLucieCallSent\(messages\)\)/.test(ai) && ai.indexOf("const pslMode = portStLucieMode(messages);") < ai.indexOf("// Check hard-coded intercepts first"));
ck("ai.ts: nada de [NOTIFY_OWNER] nem handoff antigo no fluxo", !/portStLucieHandoffMessage|portStLucieAckMessage|PORT_ST_LUCIE_NOTE/.test(ai));
ck("ai.ts: 1º contato de PSL sem opener enlatado", /const pslFirstMessage = portStLucieStanding\(messages\);/.test(ai) && (ai.match(/!carpetFirstMessage && !pslFirstMessage && !rejectionish/g) ?? []).length === 2);
ck("ai.ts: enlatados pulam no modo referral + nota por modo + rede de vazamento + pergunta acrescentada", /\} else if \(hardcoded && portStLucieReferral\(messages\)\) \{/.test(ai) && /const pslNote = portStLucieNote\(messages\);/.test(ai) && /if \(portStLucieLeak\(messages, cleaned\)\) \{[\s\S]{0,300}cleaned = portStLucieReply\(messages, usersLang\(\)\);[\s\S]{0,200}portStLucieEnsureSizeAsk\(messages, cleaned, usersLang\(\)\)/.test(ai));
ck("ai.ts: as 5 guardas de referral leem portStLucieReferral (visita de PSL = lead normal)", (ai.match(/!portStLucieReferral\(messages\)/g) ?? []).length === 5 && !/!portStLucieStanding\(messages\)/.test(ai));
ck("ai.ts: S/F e sg ft no SQ_UNIT, no detectLargeLeadSqft e no mentionsLargeSqft", /\|s\\s\*\\\/\\s\*f\(\?:t\)\?\\b\|sg\\\.\?\\s\*\(\?:ft\|feet\)\\b\|sq\\b\(\?!\\\.\?\\s\*m\)`;/.test(ai) && /square\\s\+feet\?\|s\\s\*\\\/\\s\*f\\b\|sg\\\.\?\\s\*ft\)\/i\);/.test(ai) && /\|sf\\b\|s\\s\*\\\/\\s\*f\\b\|sg\\\.\?\\s\*ft\|sqft\|/.test(ai));
ck("scheduler: filtro de horário nas duas listas da agenda + aviso no topo", /const pslOnly = \(s: string\[\]\) => \(opts\?\.portStLucie \? s\.filter\(portStLucieHourAllowed\) : s\);/.test(sc) && /const slots = pslOnly\(openHoursForDay\(sellers, dateStr, weekday, bookings, daysOff, notBefore\)\);/.test(sc) && /const slots = pslOnly\(openHoursForDay\(sellers, d, weekday, r\.bookings, r\.daysOff, undefined\)\);/.test(sc) && /PORT ST\. LUCIE CLIENT \(owner rule 2026-10-28\)/.test(sc));
ck("scheduler: getNextOpenSlots / slotConflictRecoveryMessage / needTimeChoiceMessage aceitam o filtro", /maxDays = 21,\n  opts\?: \{ portStLucie\?: boolean \}/.test(sc) && /const open = await getNextOpenSlots\(21, opts\);/.test(sc) && /if \(opts\?\.portStLucie && !portStLucieHourAllowed\(s\)\) return false;/.test(sc) && /export async function needTimeChoiceMessage\(lang: Lang, dateStr: string, opts\?: \{ portStLucie\?: boolean \}\)/.test(sc));
for (const [f, tag, v] of [["fb-webhook", "FB", "safeResponse"], ["wa-webhook", "WA", "safeResponse"], ["webhook", "IG", "safeAiText"]]) {
  const w = rd(`src/app/api/${f}/route.ts`);
  ck(`${tag}: guarda do [BOOK] por modo (fora da visita = linha do modo)`, w.includes(`const pslMode = portStLucieMode(history);\n  if (pslMode && pslMode !== "visit") {\n    console.warn("[${tag}] booking blocked — Port St. Lucie (" + pslMode + "); sending the mode's line");\n    return { response: portStLucieReply(history, lang), booked: false };\n  }\n  const pslHours = pslMode === "visit";`));
  ck(`${tag}: [BOOK] no meio do dia em PSL bloqueado e reofertado`, w.includes(`if (pslHours && bookingData.time && !portStLucieHourAllowed(bookingData.time)) {`) && w.includes("return { response: await portStLucieHoursMessage(lang, bookingData.date, bookingData.time), booked: false };"));
  ck(`${tag}: reofertas enlatadas com o filtro (3 needTimeChoice + recovery)`, (w.match(/needTimeChoiceMessage\([^)]*\{ portStLucie: pslHours \}\)/g) ?? []).length === 3 && w.includes("slotConflictRecoveryMessage(lang, bookingData.date, history, bookingData.time, { portStLucie: pslHours })") && !/needTimeChoiceMessage\(lang, (?:bookingData\.date|pm\.promisedDate \?\? bookingData\.date)\)/.test(w));
  ck(`${tag}: agenda do modelo filtrada`, w.includes("await getRealAvailabilityContext({ history, portStLucie: portStLucieStanding(history) })"));
  ck(`${tag}: rede de vazamento devolve a linha do modo`, w.includes(`if (!isBookingConfirmed && portStLucieLeak(history, ${v})) {`) && w.includes(`${v} = portStLucieReply(history, lang);`));
  ck(`${tag}: redirect de 14/09 vale em PSL de novo; alerta mantido`, w.includes("stripForbiddenTags(redirectOwnerPromiseToPhone(afterNotify, lang))") && !w.includes("portStLucieStanding(history) ? afterNotify") && w.includes("portStLucieStanding(history) ? PORT_ST_LUCIE_ALERT : null") && !/portStLucieHandoffMessage|portStLucieAskPhone/.test(w));
  ck(`${tag}: LARGE LEAD ALERT ("propose the visit") fica fora enquanto PSL é referral`, w.includes("if (detectedSqft && !portStLucieReferral(history)) {"));
}
ck("prompt base: PSL é exceção, a nota decide; saiu da lista «Outside corridor»", /The ONE exception is Port St\. Lucie \(owner rule 2026-09-26, sizes 2026-10-28\): we serve it and never decline it/.test(base) && /Outside corridor \(Stuart, Fort Pierce, Vero Beach, Orlando, Tampa, Jacksonville, etc\.; Port St\. Lucie is served, see above\)/.test(base) && !/never offer times and never book it/.test(base));
ck("Dreaming: trava 14 com a metragem e o horário", /14\. PORT ST\. LUCIE IS SERVED AND THE SIZE DECIDES/.test(dream) && /ONLY at the first time of the morning or in the late afternoon \(5pm or later\)/.test(dream) && !/tells them Ozzi, the owner, will reach out to arrange the quote, adds \[NOTIFY_OWNER\]/.test(dream));

async function sched() {
  if (process.env.SCHED !== "1" && process.env.LIVE !== "1") { console.log("\n(agenda real pulada; SCHED=1 ou LIVE=1 para rodar, só leitura)"); return; }
  console.log("\n━━ 9. agenda real (SÓ LEITURA) ━━");
  try {
    const normal = await getRealAvailabilityContext();
    const psl = await getRealAvailabilityContext({ portStLucie: true });
    const nl = scheduleLinesOf(normal), pl = scheduleLinesOf(psl);
    ck("agenda PSL lida e com o aviso no topo", pl.length >= 21 && /PORT ST\. LUCIE CLIENT/.test(psl), psl.slice(0, 300));
    const allTimes = pl.flatMap((l) => l.times);
    ck(`agenda PSL: só 9am / 17h+ (${allTimes.length} horários)`, allTimes.length > 0 && allTimes.every((t) => portStLucieHourAllowed(t)), allTimes.filter((t) => !portStLucieHourAllowed(t)).join(","));
    ck("agenda PSL ⊆ agenda normal, e normal ∩ permitido = PSL (dia a dia)", pl.every((l) => {
      const n = nl.find((x) => x.date === l.date);
      const want = (n?.times ?? []).filter((t) => portStLucieHourAllowed(t));
      return !!n && l.times.join(",") === want.join(",");
    }));
    ck("agenda normal sem filtro continua com o meio do dia", nl.flatMap((l) => l.times).some((t) => !portStLucieHourAllowed(t)) && !/PORT ST\. LUCIE CLIENT/.test(normal));
    const open = await getNextOpenSlots(21, { portStLucie: true });
    ck("getNextOpenSlots(PSL): só horários permitidos", open.length > 0 && open.every((d) => d.times.every((t) => portStLucieHourAllowed(t))));
    for (const l of ["en", "es", "pt"] as const) {
      const m = await portStLucieHoursMessage(l, open[0]?.dateStr, "13:00");
      const hrs = clockHours(m);
      console.log(`   hours ${l}: ${m}`);
      ck(`portStLucieHoursMessage ${l}: explica e oferece só 9am / 17h+`, hrs.length > 0 && hrs.every((h) => portStLucieHourAllowed(h)) && /Port St\. Lucie/.test(m) && !/[¿¡—–]/.test(m), m);
    }
  } catch (e) { ck("agenda real (só leitura)", false, String(e)); }
}

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 10. ao vivo ━━");
  const withSched = async (msgs: ChatMessage[]): Promise<ChatMessage[]> => {
    const avail = await getRealAvailabilityContext({ history: msgs, portStLucie: portStLucieStanding(msgs) });
    const out = msgs.slice();
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, content: last.content + `\n\n[SYSTEM: ${getEasternDateContext()}\n\n${avail}]` };
    return out;
  };
  const get = async (msgs: ChatMessage[]) => { const r = await getAIResponse(await withSched(msgs), null, null, undefined, false); return (r as { text?: string }).text ?? String(r); };
  const declines = (t: string) => /outside (?:of )?our|don'?t (?:currently )?(?:serve|cover|service)|north of jupiter|fuera de|no (?:cubrimos|atendemos)/i.test(t);
  try {
    const a = await get([A(AD_GREETING), U("1500 S/F??? in Port St Lucie.")]);
    console.log("   Jesus:", a.replace(/\s+/g, " "));
    const ha = clockHours(a);
    ck("Jesus (1500 S/F em PSL): visita, sem recusa, sem número do Ozzi, sem «reach out», horários só 9am / 17h+", !declines(a) && !OZZI_NUM.test(a) && !promisesOwnerContact(a) && !/\[BOOK:/.test(a) && ha.every((h) => portStLucieHourAllowed(h)) && (ha.length > 0 || /zip|address|visit/i.test(a)), a);

    const b = await get([U("Upstairs. 875 sg ft which includes the 10% extra"), A(ZIP_ASK_875), U("34952")]);
    console.log("   875:", b.replace(/\s+/g, " "));
    ck("875 sq ft + 34952: número do Ozzi, sem horário, sem preço, sem «?»", OZZI_NUM.test(b) && !containsSchedulingOffer(b) && !/\$\s?\d/.test(b) && !b.includes("?") && !declines(b), b);

    const c = await get([U("Hi, I'm in Port St. Lucie, do you guys come up here?")]);
    console.log("   1º EN:", c.replace(/\s+/g, " "));
    ck("1º contato EN: atende PSL e pergunta a metragem", c === portStLucieSizeAskMessage("en", true), c);

    const d = await get([U("Hola, estoy en Port Saint Lucie 34953, hacen pisos por acá?")]);
    console.log("   1º ES:", d.replace(/\s+/g, " "));
    ck("1º contato ES: pergunta a metragem em espanhol", d === portStLucieSizeAskMessage("es", true), d);

    const offer = "Port St. Lucie works! For 1,400 sq ft the visit is free and I bring all the samples. I have tomorrow at 9am or 7pm, which works better for you?";
    const e = await get([U("I'm in Port St Lucie, 1,400 sq ft of vinyl"), A(offer), U("Can you do 1pm instead?")]);
    console.log("   1pm:", e.replace(/\s+/g, " "));
    const he = clockHours(e).filter((h) => h !== "1pm");
    ck("pede 1pm em PSL: não aceita o meio do dia, explica e oferece 9am / 17h+, sem [BOOK]", !/\[BOOK:/.test(e) && !/\b(?:1pm|1 pm)\b[^.?!]{0,30}\b(?:works|is yours|confirmed|holding|perfect)/i.test(e) && he.every((h) => portStLucieHourAllowed(h)) && /morning|afternoon|evening/i.test(e), e);

    const f = await get([U("Upstairs. 875 sg ft which includes the 10% extra"), A(ZIP_ASK_875), U("34952"), A(portStLucieCallOzziMessage("en", 875, true)), U("Can't you just give me a price here? I don't want to call")]);
    console.log("   insiste:", f.replace(/\s+/g, " "));
    ck("abaixo de 1.000 e insiste: sem preço, sem visita, repete o número", !/\$\s?\d/.test(f) && !containsSchedulingOffer(f) && OZZI_NUM.test(f) && !/\[BOOK:/.test(f), f);

    const g = await get([U("Hi, I'm in Port St. Lucie"), A(portStLucieSizeAskMessage("en", true)), U("Is the vinyl waterproof?")]);
    console.log("   sem metragem:", g.replace(/\s+/g, " "));
    ck("sem metragem + pergunta: responde, pergunta a metragem, sem horário nem endereço", /waterproof|yes/i.test(g) && isSizeAsk(g) && !containsSchedulingOffer(g) && !/\[BOOK:/.test(g) && !declines(g), g);
  } catch (e) { ck("chamadas ao vivo", false, String(e)); }
}

sched().then(live).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
