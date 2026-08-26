/**
 * Post-booking reminder + lost-reply verify — the 2026-08-26 cases.
 *
 * CASO 1 (Prince Cambow, fb_27572562225755806, Messenger): right after
 * "Appointment confirmed for Thursday, August 27 at 2pm…" the client wrote
 * "Perfect" / "Text me or call me please 40 mins before" and got "Sorry, I
 * couldn't lock in that exact time in the system". Root cause: since 25/08 the
 * confirmation restates the slot, containsSchedulingOffer read it as an OPEN
 * offer, the booked gate flipped into RESCHEDULE MODE, the model re-emitted
 * [BOOK] for the same slot and rescheduleClientBooking failed against the
 * client's own visit. Owner rules (26/08): thanks/ok after the booking = end of
 * conversation; "text/call me X min before" = ONE fixed line promising the
 * 40-minute text; never that failure line for a booked client.
 *
 * CASO 2 (Wilmar Campos, fb_27999916679658144, Messenger): the canned ad-FAQ
 * reply was generated (conversation_metrics counted the turn) but never sent
 * nor stored — 7 such conversations in 7 days. delivery.recoverLostReplies is
 * the safety net; its pure selection is pinned here.
 *
 * No API calls, no DB writes. Run: npx tsx src/evals/postbooking-reminder-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  isBookingRestatement,
  isOpenSlotOffer,
  containsSchedulingOffer,
  isReminderRequest,
  botAwaitsAnswer,
  isAckClosingBurst,
  isRescheduleRequest,
  isPureClosing,
  isVisitDetailQuestion,
  unansweredUserBurst,
  assertsExistingAppointment,
} from "../lib/ai";
import {
  bookingSuccessMessage,
  rescheduleSuccessMessage,
  visitDetailsMessage,
  reminderAckMessage,
  isSameBookingSlot,
  detectLang,
} from "../lib/scheduler";

// delivery.ts builds the Supabase admin client at import time → load .env.local
// first and import it dynamically inside main().
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
let failures = 0;
let total = 0;
function ck(name: string, cond: boolean, detail?: string) {
  total++;
  console.log(`  ${cond ? c.green("✓") : c.red("✗")} ${name}${!cond && detail ? c.dim(` — ${detail}`) : ""}`);
  if (!cond) failures++;
}

const CONF_EN = bookingSuccessMessage("en", "2026-08-27", "14:00");
const CONF_ES = bookingSuccessMessage("es", "2026-08-27", "14:00");
const CONF_PT = bookingSuccessMessage("pt", "2026-08-27", "14:00");
const OFFER = "The visit is completely free, I bring all the floor samples, and you get the exact price on the spot. I have Thursday the 27th at 2pm or 5pm, which works better?";
const HOLD = "Perfect, I'm holding that 2pm slot for you! Can I get your name, the full property address including the zip code, and the best phone number?";
const NEXT_WEEK = "For next week I have Monday August 31 at 9am or 11am, which works better?";

async function main() {
  console.log(c.bold("\nPost-booking reminder + lost-reply verify (casos Prince Cambow / Wilmar Campos, 26/08)\n"));

  // ── 1. The confirmation is a restatement, never an open offer ─────────────
  console.log(c.bold("[1] isBookingRestatement / isOpenSlotOffer"));
  ck("confirmação EN é restatement", isBookingRestatement(CONF_EN), CONF_EN);
  ck("confirmação ES é restatement", isBookingRestatement(CONF_ES), CONF_ES);
  ck("confirmação PT é restatement", isBookingRestatement(CONF_PT), CONF_PT);
  ck("confirmação antiga (sem hora) também", isBookingRestatement("Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."));
  for (const l of ["en", "es", "pt"] as const) {
    ck(`remarcação confirmada ${l} é restatement`, isBookingRestatement(rescheduleSuccessMessage(l)));
    ck(`visitDetailsMessage ${l} é restatement`, isBookingRestatement(visitDetailsMessage(l, "2026-08-27", "14:00")));
  }
  ck("resposta pendente + confirmação (mesma bolha) é restatement", isBookingRestatement(`Yes, we work Saturdays too.\n\n${CONF_EN}`));
  ck("containsSchedulingOffer(confirmação) continua true (é por isso que a gate precisa do isOpenSlotOffer)", containsSchedulingOffer(CONF_EN));
  ck("isOpenSlotOffer(confirmação EN) = false — o bug do Prince", !isOpenSlotOffer(CONF_EN));
  ck("isOpenSlotOffer(confirmação ES) = false", !isOpenSlotOffer(CONF_ES));
  ck("isOpenSlotOffer(confirmação PT) = false", !isOpenSlotOffer(CONF_PT));
  ck("oferta real de horários continua oferta aberta", isOpenSlotOffer(OFFER));
  ck("'holding that 2pm slot… name/address/phone?' continua oferta aberta", isOpenSlotOffer(HOLD));
  ck("'next week I have Monday 9am or 11am' continua oferta aberta", isOpenSlotOffer(NEXT_WEEK));
  ck("oferta não é restatement", !isBookingRestatement(OFFER) && !isBookingRestatement(HOLD) && !isBookingRestatement(NEXT_WEEK));
  ck("[SYSTEM:] sufixo não muda o veredito", !isOpenSlotOffer(`${CONF_EN}\n\n[SYSTEM: QUOTE_HANDOFF]`));

  // ── 2. Ack after the confirmation closes the conversation ────────────────
  console.log(c.bold("\n[2] botAwaitsAnswer / isAckClosingBurst após a confirmação"));
  ck("confirmação não espera resposta", !botAwaitsAnswer(CONF_EN));
  ck("oferta espera resposta", botAwaitsAnswer(OFFER));
  ck("'Perfect' depois da confirmação = cliente encerrando (react-only)", isAckClosingBurst([
    { role: "user", content: "9543805555" },
    { role: "assistant", content: CONF_EN },
    { role: "user", content: "Perfect" },
  ]));
  ck("'Perfect' depois de uma OFERTA não é encerramento (é aceite)", !isAckClosingBurst([
    { role: "user", content: "When can you guys have look and give me estimate" },
    { role: "assistant", content: OFFER },
    { role: "user", content: "Perfect" },
  ]));
  ck("assertsExistingAppointment: aceite de horário após confirmação conta como visita já combinada", assertsExistingAppointment("I will take the 2pm", CONF_EN));

  // ── 3. The booked gate on the real Prince burst ──────────────────────────
  console.log(c.bold("\n[3] Gate de cliente agendado — rajada real do Prince"));
  const princeHistory = [
    { role: "user", content: "9543805555" },
    { role: "assistant", content: CONF_EN },
    { role: "user", content: "Perfect" },
    { role: "user", content: "Text me or call me please 40 mins before" },
  ];
  const rawText = "Text me or call me please 40 mins before";
  const gateBurst = unansweredUserBurst(princeHistory);
  const lastAsst = CONF_EN;
  const engageReschedule =
    isRescheduleRequest(rawText) || isRescheduleRequest(gateBurst) || (!isPureClosing(rawText) && isOpenSlotOffer(lastAsst));
  ck("burst = Perfect + Text me…", gateBurst === "Perfect\nText me or call me please 40 mins before", gateBurst);
  ck("NÃO entra em RESCHEDULE MODE", !engageReschedule);
  ck("não é pergunta sobre a visita", !isVisitDetailQuestion(rawText) && !isVisitDetailQuestion(gateBurst));
  ck("é pedido de aviso (rawText)", isReminderRequest(rawText));
  ck("é pedido de aviso (burst)", isReminderRequest(gateBurst));
  ck("'Perfect' sozinho: nem remarcação, nem aviso → silêncio (encerra)", !isRescheduleRequest("Perfect") && !isReminderRequest("Perfect") && !(!isPureClosing("Perfect") && isOpenSlotOffer(lastAsst)));
  ck("resposta fixa EN para o Prince", reminderAckMessage(detectLang(`${rawText} ${gateBurst}`)) === "Ok, I will text you 40 minutes before arriving.");
  // Regression: a REAL reschedule in progress still engages
  ck("oferta de remarcação em aberto ainda engaja o follow-up 'Friday at 3pm'", (!isPureClosing("Friday at 3pm") && isOpenSlotOffer("I can move it, I have Friday at 3pm or Saturday at 10am, which works better?")));

  // ── 4. isReminderRequest coverage ────────────────────────────────────────
  console.log(c.bold("\n[4] isReminderRequest — positivos"));
  const positives = [
    "Text me or call me please 40 mins before",
    "Please call me before you come",
    "Can you text me when you're on your way?",
    "Give me a heads up before arriving",
    "Let me know when you are close",
    "Call before coming please",
    "Send me a message 30 minutes ahead of time",
    "Please confirm before the visit",
    "Ring me when you're about 10 minutes away",
    "I need a 30 minute notice please",
    "Can someone call me in advance?",
    "text me before u come",
    "Avísame cuando estés en camino",
    "Llámame 30 minutos antes por favor",
    "Me mandas un mensaje antes de llegar?",
    "Por favor llamar antes de venir",
    "Avisen con anticipación",
    "Me avisa antes de chegar",
    "Liga uns 30 minutos antes",
    "Manda mensagem quando estiver a caminho",
    "Me avise com antecedência por favor",
  ];
  for (const t of positives) ck(JSON.stringify(t), isReminderRequest(t));

  console.log(c.bold("\n[4b] isReminderRequest — negativos (nunca a frase fixa)"));
  const negatives = [
    "Perfect",
    "Thank you",
    "Ok",
    "Ok thanks, see you Thursday",
    "Looking forward to it",
    "Call me",
    "Text me the quote please",
    "Can you send me a text with the address?",
    "Let me know if you have any discounts",
    "Is the price before tax?",
    "I'll call you before I leave",
    "We will text you when we get home",
    "What time are you coming?",
    "Can we move it to Friday?",
    "I can't tomorrow",
    "Gracias",
    "Perfecto, nos vemos el jueves",
    "Cuál es el precio?",
    "Obrigado",
    "Qual o preço do vinil?",
    "What is the installation process?",
    "Do you offer any discounts for larger spaces?",
  ];
  for (const t of negatives) ck(JSON.stringify(t) + " NÃO é pedido de aviso", !isReminderRequest(t));

  // ── 5. Fixed reply ────────────────────────────────────────────────────────
  console.log(c.bold("\n[5] reminderAckMessage"));
  for (const l of ["en", "es", "pt"] as const) {
    const m = reminderAckMessage(l);
    ck(`${l}: uma frase, fala em 40 minutos e em texto`, /40/.test(m) && /text|mensaje|mensagem/i.test(m) && (m.match(/[.!?]/g) || []).length === 1, m);
    ck(`${l}: sem travessão e sem emoji`, !/[—–‒―]/.test(m) && !/[\u{1F300}-\u{1FAFF}]/u.test(m));
    ck(`${l}: começa com Ok (frase do dono)`, /^Ok,/.test(m));
  }

  // ── 6. Same-slot reschedule = nothing to move ────────────────────────────
  console.log(c.bold("\n[6] isSameBookingSlot (remarcação para o MESMO slot)"));
  ck("14:00 vs 14:00 mesmo dia", isSameBookingSlot("2026-08-27", "14:00", "2026-08-27", "14:00"));
  ck("14:00:00 (DB) vs 14:00 (modelo)", isSameBookingSlot("2026-08-27", "14:00:00", "2026-08-27", "14:00"));
  ck("14:00 vs 2pm", isSameBookingSlot("2026-08-27", "14:00", "2026-08-27", "2pm"));
  ck("9:00 vs 09:00", isSameBookingSlot("2026-08-27", "9:00", "2026-08-27", "09:00"));
  ck("outro dia NÃO", !isSameBookingSlot("2026-08-27", "14:00", "2026-08-28", "14:00"));
  ck("outra hora NÃO", !isSameBookingSlot("2026-08-27", "14:00", "2026-08-27", "16:00"));
  ck("sem data NÃO", !isSameBookingSlot(null, "14:00", "2026-08-27", "14:00"));
  ck("sem hora NÃO", !isSameBookingSlot("2026-08-27", "", "2026-08-27", ""));

  // ── 7. Lost-reply candidate selection (pure) ─────────────────────────────
  console.log(c.bold("\n[7] pickLostReplyCandidates — caso Wilmar + controles"));
  const { pickLostReplyCandidates, isUnansweredForAWhile } = await import("../lib/delivery");
  const now = Date.parse("2026-08-26T21:11:00Z");
  const mk = (over: Partial<import("../lib/delivery").LostReplyRow> & { newestAt?: string; newestRole?: string; mid?: string | null }) => ({
    conversationId: "conv",
    igsid: "fb_27999916679658144",
    mode: "agent",
    totalTurns: 1,
    assistantReplies: 0,
    newest: { id: "m1", role: over.newestRole ?? "user", content: "What is the installation process?", created_at: over.newestAt ?? "2026-08-26T21:03:39Z", instagram_msg_id: over.mid === undefined ? "m_biUANpt74" : over.mid },
    ...over,
  });
  const wilmar = mk({});
  ck("Wilmar (1 turno, 0 respostas, 7 min sem resposta, agent) É candidato", pickLostReplyCandidates([wilmar], now).length === 1);
  ck("conversa saudável (1 turno, 1 resposta) NÃO", pickLostReplyCandidates([mk({ assistantReplies: 1 })], now).length === 0);
  ck("em processamento (1 min) NÃO", pickLostReplyCandidates([mk({ newestAt: "2026-08-26T21:10:00Z" })], now).length === 0);
  ck("pausada (mode=human) NÃO", pickLostReplyCandidates([mk({ mode: "human" })], now).length === 0);
  ck("última mensagem é do bot NÃO", pickLostReplyCandidates([mk({ newestRole: "assistant" })], now).length === 0);
  ck("mais de 6h NÃO (resposta ficaria velha)", pickLostReplyCandidates([mk({ newestAt: "2026-08-26T14:00:00Z" })], now).length === 0);
  ck("2 turnos / 1 resposta, cliente esperando 10 min É candidato", pickLostReplyCandidates([mk({ totalTurns: 2, assistantReplies: 1, newestAt: "2026-08-26T21:01:00Z" })], now).length === 1);
  ck("silêncio por design (0 turnos contados) NÃO", pickLostReplyCandidates([mk({ totalTurns: 0, assistantReplies: 0 })], now).length === 0);
  ck("isUnansweredForAWhile ignora contagem", isUnansweredForAWhile(mk({ totalTurns: 0 }), now));
  ck("sem newest NÃO", pickLostReplyCandidates([mk({ newest: null })], now).length === 0);

  // ── 8. Wiring in the three webhooks + delivery ────────────────────────────
  console.log(c.bold("\n[8] Fiação nos 3 webhooks"));
  const files = {
    fb: readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8"),
    ig: readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8"),
    wa: readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8"),
  };
  for (const [k, src] of Object.entries(files)) {
    ck(`${k}: gate usa isOpenSlotOffer (não containsSchedulingOffer)`, /isOpenSlotOffer\(lastAsst\.content\)/.test(src) && !/containsSchedulingOffer\(lastAsst\.content\)/.test(src));
    ck(`${k}: pedido de aviso → reminderAckMessage antes do silêncio`, /isReminderRequest\(rawText\) \|\| isReminderRequest\(gateBurst\)/.test(src) && /reminderAckMessage\(/.test(src));
    ck(`${k}: bloco do aviso vem DEPOIS da pergunta de visita e ANTES do silêncio`, src.indexOf("isVisitDetailQuestion(rawText)") < src.indexOf("isReminderRequest(rawText)") && src.indexOf("isReminderRequest(rawText)") < src.indexOf("notify owner silently, no message"));
    ck(`${k}: remarcação para o mesmo slot restata a visita`, /r\.success && r\.unchanged/.test(src) && /nothing to move/.test(src));
    ck(`${k}: envio final blindado contra exceção`, /final send THREW/.test(src));
    ck(`${k}: heartbeat da varredura de resposta perdida`, /waitUntil\(recoverLostReplies\(\)\)/.test(src));
    ck(`${k}: nota do pedido no booking`, /appendUpcomingBookingNote\(/.test(src));
  }
  ck("fb: replay gated pelo admin secret", /isDashboardAuthorized\(req\.headers\.get\("x-ozzi-replay"\)\)/.test(files.fb) && /opts\?\.replay/.test(files.fb));
  ck("ig: replay gated pelo admin secret", /isDashboardAuthorized\(req\.headers\.get\("x-ozzi-replay"\)\)/.test(files.ig) && /opts\?\.replay/.test(files.ig));
  // 1º deploy (26/08 22:04): o replay morria no dedup por mid ANTES do insert (updated_at nem mexeu).
  ck("fb: dedup por mid deixa o replay passar", /if \(already && !opts\?\.replay\) return;/.test(files.fb));
  ck("ig: dedup por mid deixa o replay passar", /if \(alreadyProcessed && !opts\?\.replay\) return;/.test(files.ig));
  const delivery = readFileSync(join(process.cwd(), "src/lib/delivery.ts"), "utf-8");
  ck("delivery: checa a thread na Meta antes de reenviar", /pageRepliedAfter\(/.test(delivery) && /me\/conversations/.test(delivery));
  ck("delivery: cada bolha tratada uma vez (lostreply| claim)", /lostreply\|/.test(delivery));
  ck("delivery: WhatsApp só alerta (sem replay)", /channel === "whatsapp"/.test(delivery));
  ck("delivery: base URL nunca cai em localhost em produção", /PRODUCTION_BASE_URL = "https:\/\/instagram-dm-agent-chi\.vercel\.app"/.test(delivery) && /allowLocal \|\| !isLocalhost\(u\)/.test(delivery));
  ck("delivery: resultado de cada bolha vai para o banco", /lostreply-result\|/.test(delivery));

  console.log(`\n${failures === 0 ? c.green(`ALL ${total} CHECKS PASSED`) : c.red(`${failures} of ${total} CHECKS FAILED`)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
