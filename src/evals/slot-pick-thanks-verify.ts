/**
 * Escolha de horário embrulhada num "obrigado" — caso @lovehyppos (IG, 03/10/2026).
 *
 *  13:04  bot: "Tuesday at 5pm or 6pm works, which one do you prefer?"
 *  13:16  cliente: "6 works perfect, thank you"
 *  (8 minutos de silêncio; às 13:24 o dono digitou à mão "Perfect to confirm
 *   the visit, please send me your address and phone number" → [Treino] + IA pausada)
 *
 * Causa: isPureClosing("6 works perfect, thank you") = true — "6" sem am/pm,
 * "works"/"perfect" não são token de substância, "thank you" casa CLOSING_PATTERNS
 * — e isPureClosingBurst descartou a resposta do modelo nos 3 webhooks. O mesmo
 * texto já era lido como escolha do 6pm por clientConfirmedSlot (a guarda do [BOOK]).
 *
 * Fix: acceptsOpenSlotOffer (ai.ts) — oferta nossa com horário(s) + resposta que
 * nomeia uma hora ofertada ou aceita ("works", "sounds good", "yes", "the first
 * one", "me funciona") = resposta à oferta, nunca despedida. Usado em
 * isPureClosingBurst e no portão de remarcação dos 3 webhooks (cliente agendado
 * respondendo "6 works, thanks" a uma oferta de remarcação caía no caminho mudo).
 *
 *  A. DETERMINÍSTICO: o caso real + variantes que NÃO podem silenciar + os
 *     fechamentos que DEVEM continuar silenciando (regra do dono 26/08).
 *  B. ESTÁTICO: os 3 webhooks usam acceptsOpenSlotOffer no portão de remarcação.
 *  C. AO VIVO (modelo, nada gravado): o turno "6 works perfect, thank you" gera
 *     resposta enviável (pede endereço/telefone) e o turno do endereço gera o
 *     [BOOK] da terça 18:00 que passa nas guardas.
 * DET_ONLY=1 pula C.
 * Rodar: npx tsx src/evals/slot-pick-thanks-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isPureClosing, isPureClosingBurst, isAckClosingBurst, acceptsOpenSlotOffer, forcedBookRetryReason, retryForBookTag, type ChatMessage } from "../lib/ai";
import { clientConfirmedSlot, dayOnlyPickNeedsTime, bookedTimeSeenInConversation, reconcileBookingWeekday, bookingEpisodeHistory, easternTodayStr, getEasternDateContext } from "../lib/scheduler";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); process.env[m[1]] = v; }
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 360)}»`); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wdOf = (s: string) => new Date(s + "T12:00:00Z").getUTCDay();
const display = (s: string) => { const d = new Date(s + "T12:00:00Z"); return `${DAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

// A terça seguinte (o eval roda em qualquer dia; nunca "hoje").
const today = easternTodayStr();
let tue = addDays(today, 1);
while (wdOf(tue) !== 2) tue = addDays(tue, 1);
const mon = addDays(tue, -1) > today ? addDays(tue, -1) : addDays(tue, 6);
const wed = addDays(tue, 1);
const monLabel = `Monday ${MONTH_NAMES[new Date(mon + "T12:00:00Z").getUTCMonth()]} ${ordinal(new Date(mon + "T12:00:00Z").getUTCDate())}`;

// A conversa real (texto exato, apóstrofo curvo incluso).
const OFFER = "Tuesday at 5pm or 6pm works, which one do you prefer?";
const PICK = "6 works perfect, thank you";
const REAL: ChatMessage[] = [
  U("Hi for 2500 sq ft home how much would the charge be for tile?"),
  U("[Client replied to our ad]"),
  A("For tile at that size I need to measure in person to give you the right number, it's a free visit and I bring everything needed to get you the best price on the spot. What's the zip code of the property?"),
  U("33182"),
  A(`That zip is covered! I can come out ${monLabel} at 3pm or 5pm, which works better for you?`),
  U("I can’t do Monday, unfortunately i have work and then school, do you have availability on Tuesday or Wednesday."),
  A("Tuesday I have 9am or 11am, Wednesday I have 9am or 1pm, which day and time works best?"),
  U("It would have to be in the afternoon like at 5."),
  A(OFFER),
  U(PICK),
];
const ADDRESS = "431 Nw 136 Ave Miami Fl 33182, 3053382441, Joanne Espinosa";

async function main() {
  console.log("\n[A] DETERMINÍSTICO — o caso real");
  {
    ck("isPureClosing(texto sozinho) segue true (sem contexto não dá para saber)", isPureClosing(PICK));
    ck("isPureClosingBurst(histórico real) = false → a resposta do modelo é enviada", !isPureClosingBurst(REAL));
    ck("isAckClosingBurst(histórico real) = false", !isAckClosingBurst(REAL));
    ck("acceptsOpenSlotOffer(oferta, '6 works perfect, thank you') = true", acceptsOpenSlotOffer(OFFER, PICK));
    ck("clientConfirmedSlot(histórico real) = true (o [BOOK] vai passar)", clientConfirmedSlot(REAL));
    ck("dayOnlyPickNeedsTime = false (a hora foi escolhida)", !dayOnlyPickNeedsTime(REAL));
    ck("rajada em 2 bolhas ('6 works' + 'thank you') também não silencia", !isPureClosingBurst([...REAL.slice(0, -1), U("6 works"), U("thank you")]));
  }

  console.log("\n[A2] DETERMINÍSTICO — aceite de oferta com horário NUNCA é despedida");
  const TWO = A("Tuesday at 5pm or 6pm works, which one do you prefer?");
  const ONE = A("I can come out Tuesday at 5pm, does that work for you?");
  const ONE_NOQ = A("I can do Thursday at 11am.");
  const ES = A("El martes tengo 5pm o 6pm, cuál le queda mejor?");
  const PT = A("Na terça eu tenho 5pm ou 6pm, qual fica melhor?");
  const notClosing: Array<[string, ChatMessage, string]> = [
    ["'6 works, thanks'", TWO, "6 works, thanks"],
    ["'6 is perfect thank you'", TWO, "6 is perfect thank you"],
    ["'I'll take 6, thank you'", TWO, "I'll take 6, thank you"],
    ["'5 please, thanks'", TWO, "5 please, thanks"],
    ["'Six works, thank you' (por extenso → aceite)", TWO, "Six works, thank you"],
    ["'The later one, thank you'", TWO, "The later one, thank you"],
    ["'The first, thanks'", TWO, "The first, thanks"],
    ["'Perfect, thank you' a 2 horários (modelo pergunta qual)", TWO, "Perfect, thank you"],
    ["'Sounds good, thanks' a 2 horários", TWO, "Sounds good, thanks"],
    ["'That works, thank you' a 1 horário", ONE, "That works, thank you"],
    ["'Yes thank you' a 1 horário", ONE, "Yes thank you"],
    ["'Ok thank you' a 1 horário (ok = aceite quando só há um)", ONE, "Ok thank you"],
    ["'Great thanks' a 'I can do Thursday at 11am.' (oferta sem '?')", ONE_NOQ, "Great thanks"],
    ["'6 works – thank you' (travessão)", TWO, "6 works – thank you"],
    ["'Me funciona, gracias' (ES)", ES, "Me funciona, gracias"],
    ["'Las 6, gracias' (ES)", ES, "Las 6, gracias"],
    ["'Sí, a las 6 gracias' (ES, acento)", ES, "Sí, a las 6 gracias"],
    ["'Pode ser as 6, obrigada' (PT)", PT, "Pode ser as 6, obrigada"],
    ["'6 works, I'll send the address later, thanks' (hora nomeada vence o 'later')", TWO, "6 works, I'll send the address later, thanks"],
  ];
  for (const [name, offer, reply] of notClosing) {
    ck(`${name} → não é despedida`, !isPureClosingBurst([U("33182"), offer, U(reply)]), reply);
  }

  console.log("\n[A3] DETERMINÍSTICO — fechamentos que DEVEM continuar em silêncio (regra 26/08)");
  const closing: Array<[string, ChatMessage, string]> = [
    ["'Thank you' sozinho depois da oferta", TWO, "Thank you"],
    ["'Thanks, I'll let you know'", TWO, "Thanks, I'll let you know"],
    ["'Ok thanks, I’ll think about it' (apóstrofo curvo)", TWO, "Ok thanks, I’ll think about it"],
    ["'Great, thanks, I'll get back to you'", TWO, "Great, thanks, I'll get back to you"],
    ["'Not sure yet, thanks'", TWO, "Not sure yet, thanks"],
    ["'Sure, let me check and I'll let you know, thanks'", TWO, "Sure, let me check and I'll let you know, thanks"],
    ["'Ok gracias, te aviso'", ES, "Ok gracias, te aviso"],
    ["'Ok thank you' a 2 horários (ambíguo, comportamento antigo)", TWO, "Ok thank you"],
    ["'Perfect thank you' a mensagem sem horário", A("Our tile install is $3.50 per sq ft with materials included."), "Perfect thank you"],
    ["'Perfect thank you' a horário de funcionamento (não é oferta)", A("We work Monday to Saturday from 8am to 6pm."), "Perfect thank you"],
    ["'Thank you so much!' depois da confirmação da visita", A("Appointment confirmed for Tuesday, October 6 at 6pm! Our rep will text you 40 minutes before."), "Thank you so much!"],
    ["'Thanks, 6 people will be there' (6 não é hora)", TWO, "Thanks, 6 people will be there"],
    // Varredura de 30 dias (03/10): o verbo "work" NÃO é aceite, recusa segue despedida.
    ["fb_29410258235228287: 'Actually neither, my husband and I work. But we’ll get back to you thank you'", A("33144 is covered! I have tomorrow, Friday, at 1pm or 2pm, which works better for you?"), "Actually neither, my husband and I work. But we’ll get back to you thank you"],
    ["fb_26945544551739375: 'Dies t work for me anymore- Thank you -'", A("Sorry about the mix-up! Tomorrow at 3pm or 4pm, both free visits. Which works?"), "Dies t work for me anymore- Thank you -"],
    ["'Neither works, thanks'", TWO, "Neither works, thanks"],
    ["'That doesn't work for me, thank you'", ONE, "That doesn't work for me, thank you"],
    ["'No me funciona, gracias' (ES)", ES, "No me funciona, gracias"],
  ];
  for (const [name, offer, reply] of closing) {
    ck(`${name} → segue despedida`, isPureClosingBurst([U("33182"), offer, U(reply)]), reply);
  }
  // (o "where" já tira esse caso do fechamento; quem cala é isJobSeeker — aqui só o aceite importa)
  ck("fb_29524728260451161: 'I am looking for a job where I can apply to work there. | Thanks' NÃO é aceite de horário", !acceptsOpenSlotOffer(TWO.content, "I am looking for a job where I can apply to work there.\nThanks"));

  console.log("\n[A4] DETERMINÍSTICO — portão de remarcação (cliente já agendado)");
  {
    const RESCHED = "I can move you to Thursday at 5pm or 6pm, which one works better?";
    ck("'6 works, thank you' aceita a oferta de remarcação", acceptsOpenSlotOffer(RESCHED, "6 works, thank you"));
    ck("'Thank you' sozinho não aceita (segue o caminho mudo de agendado)", !acceptsOpenSlotOffer(RESCHED, "Thank you"));
    ck("confirmação de visita nunca é oferta", !acceptsOpenSlotOffer("Appointment confirmed for Thursday at 6pm!", "6 works, thank you"));
  }

  console.log("\n[B] ESTÁTICO — os 3 webhooks");
  for (const f of ["src/app/api/webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/wa-webhook/route.ts"]) {
    const s = readFileSync(join(process.cwd(), f), "utf-8");
    ck(`${f}: portão de remarcação usa acceptsOpenSlotOffer`, /isOpenSlotOffer\(lastAsst\.content\) && \(!isPureClosing\(rawText\) \|\| acceptsOpenSlotOffer\(lastAsst\.content, gateBurst \|\| rawText\)\)/.test(s));
    ck(`${f}: nenhum portão antigo '!isPureClosing(rawText)) {' sobrou`, !/isBooked && !engageReschedule && !isPureClosing\(rawText\)\) \{/.test(s));
    ck(`${f}: o silêncio de fechamento continua passando por isPureClosingBurst(history)`, /isPureClosingBurst\(history\) \|\| isAckClosingBurst\(history\)/.test(s));
  }

  if (process.env.DET_ONLY === "1") return;

  console.log(`\n[C] AO VIVO (modelo, nada gravado) — terça = ${tue}`);
  const schedule = [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    `• ${display(mon)} [${mon}]: 3pm, 5pm`,
    `• ${display(tue)} [${tue}]: 9am, 11am, 5pm, 6pm`,
    `• ${display(wed)} [${wed}]: 9am, 1pm`,
  ].join("\n");
  const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), schedule].join("\n\n")}]`;
  let learnings: string | null = null;
  if (process.env.LEARNINGS) learnings = readFileSync(process.env.LEARNINGS, "utf-8");
  else {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      let storeId = process.env.ANTHROPIC_SYSTEM_STORE_ID;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = anthropic as any;
      if (!storeId) storeId = (await a.beta.memoryStores.list()).data.find((s: { name: string }) => s.name === "ozzifloors-system")?.id;
      const page = await a.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
      const item = page.data.find((x: { type: string; path: string }) => x.type === "memory" && x.path === "/learnings.md");
      learnings = (await a.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId })).content ?? null;
    } catch (e) { console.log("   (sem learnings:", (e as Error).message, ")"); }
  }
  const N = Number(process.env.N ?? 3);
  for (let i = 1; i <= N; i++) {
    const msgs: ChatMessage[] = [...REAL.slice(0, -1), U(PICK + sys)];
    const t = (await getAIResponse(msgs, null, learnings, null, false)).text;
    console.log(`   pick #${i} →`, t.replace(/\s+/g, " ").slice(0, 260));
    const plain = msgs.map((x) => ({ role: x.role, content: x.content.split(/\n\n?\[SYSTEM:/)[0] }));
    const silenced = /\[REACT_ONLY\]/i.test(t) || isPureClosingBurst(plain) || isAckClosingBurst(plain);
    ck(`pick #${i}: o webhook ENVIA a resposta (sem REACT_ONLY, sem guarda de fechamento)`, !silenced && t.trim().length > 0, t);
    ck(`pick #${i}: pede o endereço (próximo passo do agendamento)`, /address|zip/i.test(t), t);
    ck(`pick #${i}: não re-oferece outros horários (9am/11am/5pm)`, !/\b(?:9|11|5)\s*(?::00\s*)?(?:am|pm)\b/i.test(t), t);

    // Turno seguinte: a cliente manda endereço + telefone + nome.
    const hist2: ChatMessage[] = [...REAL, A(t.replace(/\[BOOK:[\s\S]*?\]/g, "").trim()), U(ADDRESS + sys)];
    let t2 = (await getAIResponse(hist2, null, learnings, null, false)).text;
    if (!/\[BOOK:/i.test(t2)) {
      const plain2 = hist2.map((x) => ({ role: x.role, content: x.content.split(/\n\n?\[SYSTEM:/)[0] }));
      const reason = forcedBookRetryReason(t2, plain2, true);
      if (reason) t2 = (await retryForBookTag(hist2, null, learnings, null, reason)) ?? t2;
    }
    console.log(`   address #${i} →`, t2.replace(/\s+/g, " ").slice(0, 260));
    const m = /\[BOOK:(\{[\s\S]*?\})\]/.exec(t2);
    ck(`address #${i}: gera [BOOK]`, !!m, t2);
    if (!m) continue;
    const b = JSON.parse(m[1]);
    const ep = bookingEpisodeHistory(hist2.map((x) => ({ role: x.role, content: x.content.split(/\n\n?\[SYSTEM:/)[0] })));
    const rec = reconcileBookingWeekday(b.date, ep, b.time);
    const date = rec.corrected ? rec.date : b.date;
    ck(`address #${i}: [BOOK] ${b.date} ${b.time} → terça ${tue} 18:00`, date === tue && b.time === "18:00", JSON.stringify({ b, rec }));
    ck(`address #${i}: guardas do [BOOK] passam (slot escolhido + hora vista na conversa)`, clientConfirmedSlot(ep) && bookedTimeSeenInConversation(ep, b.time), JSON.stringify(b));
  }
}

main().then(() => {
  console.log(`\n${pass} ✅  ${fail} ❌`);
  if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
