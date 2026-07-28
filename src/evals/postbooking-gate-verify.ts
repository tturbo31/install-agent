/**
 * Post-booking gate verify — the 2026-07-21 "IA não responde" fix.
 *
 * Root cause found in the 3-day DB triage: EVERY silent conversation had
 * booking_confirmed=true. The silent post-booking path swallowed, forever:
 *   • reschedule requests spread across a debounced burst ("I can't tomorrow /
 *     Can you make possible for tomorrow in the morning / 11 is perfect / Done")
 *   • questions about the client's own visit ("Are you coming at 3?",
 *     "Which day, Tuesday?")
 *   • EVERYTHING from clients whose visit date was already weeks in the past
 *     (new quote requests, callbacks, FAQ taps, ad re-taps).
 *
 * This eval pins the fix: burst-aware reschedule detection, the visit-details
 * deterministic reply, the stale booked-flag reset, and the Otto seam repair in
 * stripLargeLeadPrices. No API calls, no DB writes.
 * Run: npx tsx src/evals/postbooking-gate-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  isRescheduleRequest,
  unansweredUserBurst,
  isVisitDetailQuestion,
  pastVisitSystemNote,
  stripLargeLeadPrices,
  isPureClosing,
} from "../lib/ai";
import { visitDetailsMessage, visitStillUpcoming, VISIT_UPCOMING_GRACE_MIN } from "../lib/scheduler";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

let failures = 0;
function ck(name: string, cond: boolean, detail?: string) {
  console.log(`  ${cond ? c.green("✓") : c.red("✗")} ${name}${!cond && detail ? c.dim(` — ${detail}`) : ""}`);
  if (!cond) failures++;
}

console.log(c.bold("\nPost-booking gate verify (silêncio de cliente agendado)\n"));

// ── 1. Reschedule patterns: the exact bubbles that were silenced ────────────
console.log(c.bold("[1] isRescheduleRequest — novas frases reais"));
ck('"I can\'t tomorrow"', isRescheduleRequest("I can't tomorrow"));
ck('"Can you make possible for tomorrow in the morning"', isRescheduleRequest("Can you make possible for tomorrow in the morning"));
ck('"Can you make it possible for Saturday"', isRescheduleRequest("Can you make it possible for Saturday"));
ck('"I cannot Friday"', isRescheduleRequest("I cannot Friday"));
// Regressions: the old phrasings must still match
ck('"can we reschedule?" (regressão)', isRescheduleRequest("can we reschedule?"));
ck('"I need to cancel the appointment" (regressão)', isRescheduleRequest("I need to cancel the appointment"));
ck('"no puedo mañana" (regressão)', isRescheduleRequest("no puedo mañana"));
// "Cansela" (2026-07-27, FB): "cancela" digitado com s ficou mudo — a família
// de typos s/z tem que casar, e o burst inteiro ("Candela tube q salir de
// viaje" + "Cansela") também.
ck('"Cansela" (typo real 27/07) é cancel', isRescheduleRequest("Cansela"));
ck('"canzelar" (typo z) é cancel', isRescheduleRequest("quiero canzelar la cita"));
ck('"Candela tube q salir de viaje\\nCansela" (burst real) é cancel', isRescheduleRequest("Candela tube q salir de viaje\nCansela"));
// Must NOT over-fire on plain closings / bare day-time
ck('"Thank you." NÃO é reschedule', !isRescheduleRequest("Thank you."));
ck('"Perfect sounds good Thank you" NÃO é reschedule', !isRescheduleRequest("Perfect sounds good Thank you"));
ck('"Wednesday at 1pm" (dia/hora puro) NÃO é reschedule', !isRescheduleRequest("Wednesday at 1pm"));
ck('"Can you make it possible to go cheaper" NÃO é reschedule', !isRescheduleRequest("Can you make it possible to go cheaper"));

// ── 2. Burst-aware: the debounce keeps only the last bubble ─────────────────
console.log(c.bold("\n[2] unansweredUserBurst — o burst real do YunioC (2026-07-20)"));
const yunioBurst = [
  { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi." },
  { role: "user", content: "Ok" },
  { role: "user", content: "I can't tomorrow" },
  { role: "user", content: "I have a dr appointment" },
  { role: "user", content: "My bad I misunderstood" },
  { role: "user", content: "Sorry" },
  { role: "user", content: "Can you make possible for tomorrow in the morning" },
  { role: "user", content: "11 is perfect" },
  { role: "user", content: "Done" },
];
const burstText = unansweredUserBurst(yunioBurst);
ck("burst junta TODOS os balões desde a última resposta do bot", burstText.includes("I can't tomorrow") && burstText.includes("11 is perfect") && burstText.includes("Done"));
ck("último balão sozinho ('Done') NÃO dispararia o reschedule", !isRescheduleRequest("Done"));
ck("o burst COMPLETO dispara o reschedule", isRescheduleRequest(burstText), `burst: ${burstText.slice(0, 80)}`);
ck("burst para na última resposta do bot", !burstText.includes("Appointment confirmed"));
const withSystem = [
  { role: "user", content: "Ok thanks\n\n[SYSTEM: FOLLOWUP_NUDGE]" },
];
ck("sufixo [SYSTEM:] é removido do burst", unansweredUserBurst(withSystem) === "Ok thanks");
ck("burst de fechamento puro NÃO dispara reschedule", !isRescheduleRequest(unansweredUserBurst([
  { role: "assistant", content: "Appointment confirmed." },
  { role: "user", content: "Looking forward" },
  { role: "user", content: "Thank you" },
])));

// ── 3. Visit-detail questions (booked client asking about their own visit) ──
console.log(c.bold("\n[3] isVisitDetailQuestion"));
ck('"Are you coming at 3?"', isVisitDetailQuestion("Are you coming at 3?"));
ck('"Which day, Tuesday"', isVisitDetailQuestion("Which day, Tuesday"));
ck('"What time will you arrive exactly?"', isVisitDetailQuestion("What time will you arrive exactly?"));
ck('"are we still on for tomorrow?"', isVisitDetailQuestion("are we still on for tomorrow?"));
ck('"A que hora vienes?"', isVisitDetailQuestion("A que hora vienes?"));
ck('"Sigue en pie la visita?"', isVisitDetailQuestion("Sigue en pie la visita?"));
ck('"Que horas você chega?"', isVisitDetailQuestion("Que horas você chega?"));
ck('"Thank you" NÃO é pergunta de visita', !isVisitDetailQuestion("Thank you"));
ck('"Wednesday at 1pm" NÃO é pergunta de visita', !isVisitDetailQuestion("Wednesday at 1pm"));
ck('"What is the installation process?" NÃO é pergunta de visita', !isVisitDetailQuestion("What is the installation process?"));
ck('"What type of materials are included?" NÃO é pergunta de visita', !isVisitDetailQuestion("What type of materials are included?"));

// ── 4. Deterministic visit-details message ──────────────────────────────────
console.log(c.bold("\n[4] visitDetailsMessage"));
const en = visitDetailsMessage("en", "2026-07-21", "15:00");
const es = visitDetailsMessage("es", "2026-07-21", "11:00");
ck("EN traz dia da semana + data + hora 12h", en.includes("Tuesday") && en.includes("July 21") && en.includes("3pm"), en);
ck("ES traz dia da semana + data + hora", es.includes("martes") && es.includes("21 de julio") && es.includes("11am"), es);
ck("sem travessão e sem emoji (regras do dono)", !/[—–‒―]/.test(en + es) && !/[\u{1F300}-\u{1FAFF}]/u.test(en + es));
ck("abre a porta da remarcação", /move the visit|mover la visita/.test(en) && /mover la visita/.test(es));
ck("hora fora do formato HH:MM passa como veio", visitDetailsMessage("en", "2026-07-22", "3pm").includes("at 3pm"));

// ── 5. PAST VISIT note (stale flag reset) ───────────────────────────────────
console.log(c.bold("\n[5] pastVisitSystemNote"));
const note = pastVisitSystemNote({ date: "2026-06-25", time: "11:00" });
ck("nota carrega a data da visita passada", note.includes("2026-06-25"));
ck("proíbe o pitch frio e permite [NOTIFY_OWNER]", note.includes("PAST VISIT") && note.includes("[NOTIFY_OWNER]"));
ck("sem lastPast também funciona", pastVisitSystemNote(null).includes("PAST VISIT"));

// ── 6. Otto seam repair (stripLargeLeadPrices) ──────────────────────────────
console.log(c.bold("\n[6] stripLargeLeadPrices — emenda do caso Otto (2026-07-21)"));
const otto = stripLargeLeadPrices(
  "The $2,350 you saw for 1000 sqft was our vinyl promo estimate, and the exact price always depends on the flooring type, so I wouldn't want to give you a wrong number here."
);
ck("preço grande removido", !otto.includes("$2,350"), otto);
ck("NÃO começa com conectivo minúsculo ('and ...')", !/^(?:and|so|but)\b/i.test(otto) && /^[A-Z]/.test(otto), otto);
ck("resto da frase preservado", otto.includes("exact price always depends"), otto);
const perSqft = stripLargeLeadPrices("Our promo is $5 per sqft, so 1,577 sqft comes to about $7,885, and it includes the quarter round.");
ck("taxa por sqft sobrevive, total some (regressão)", perSqft.includes("$5 per sqft") && !perSqft.includes("$7,885"), perSqft);

// ── 7. Gate order in the 3 webhooks (source check) ──────────────────────────
console.log(c.bold("\n[7] Ordem do gate nos 3 webhooks"));
for (const [name, file] of [
  ["IG", "src/app/api/webhook/route.ts"],
  ["FB", "src/app/api/fb-webhook/route.ts"],
  ["WA", "src/app/api/wa-webhook/route.ts"],
] as const) {
  const src = readFileSync(join(process.cwd(), file), "utf-8");
  const iStale = src.indexOf("booked flag is stale");
  const iBurst = src.indexOf("isRescheduleRequest(gateBurst)");
  const iVisitQ = src.indexOf("isVisitDetailQuestion(rawText)");
  const iSilent = src.indexOf("If already booked (and NOT rescheduling)");
  ck(`${name}: reset de flag obsoleta ANTES do gate de silêncio`, iStale > -1 && iSilent > -1 && iStale < iSilent);
  ck(`${name}: burst-aware ANTES do silêncio`, iBurst > -1 && iBurst < iSilent);
  ck(`${name}: resposta de detalhes da visita ANTES do silêncio`, iVisitQ > -1 && iVisitQ < iSilent);
  ck(`${name}: served-check só marca booked com visita FUTURA`, /served\?\.upcoming/.test(src));
  // Rosy (2026-07-21): 15 balões sem resposta encheram a janela de histórico,
  // o opener enlatado achou que era primeiro contato e atropelou a pergunta
  // sobre a cotação. A janela precisa reter a última resposta do bot.
  ck(`${name}: janela de histórico retém a última resposta do bot`, src.includes("Keep at least the latest assistant reply in context") && /history\.unshift\(lastAsstMsg\)/.test(src));
}

// ── 8. isPureClosing sanity (gate ainda silencia fechamentos) ───────────────
console.log(c.bold("\n[8] Fechamentos continuam silenciosos"));
ck('"Ok thank you" segue sendo fechamento puro', isPureClosing("Ok thank you"));
ck('"Thanks, see you then!" segue sendo fechamento puro', isPureClosing("Thanks, see you then!"));

// ── 9. Visita de HOJE expira depois do horário + graça (caso Lisa 27/07) ────
// Comparação só por data mantinha a cliente da visita de 1pm silenciada até
// MEIA-NOITE: ela voltou 6:30pm perguntando do pacote de materiais (re-tap do
// anúncio 3x) e caiu no caminho silencioso pós-booking.
console.log(c.bold("\n[9] visitStillUpcoming — visita de hoje expira com o horário"));
const T = "2026-07-27";
const min = (h: number, m = 0) => h * 60 + m;
ck("data futura → upcoming", visitStillUpcoming("2026-07-28", "09:00", T, min(23)));
ck("data passada → past", !visitStillUpcoming("2026-07-26", "19:00", T, min(0, 5)));
ck("hoje, antes da visita → upcoming (silêncio mantido)", visitStillUpcoming(T, "13:00", T, min(10)));
ck("hoje, durante a graça (visita 1pm, agora 2:30pm) → upcoming", visitStillUpcoming(T, "13:00", T, min(14, 30)));
ck("hoje, graça vencida (visita 1pm, agora 6:30pm) → past (caso Lisa)", !visitStillUpcoming(T, "13:00", T, min(18, 30)));
ck("hora ilegível → upcoming o dia todo (fail safe, nunca fail chatty)", visitStillUpcoming(T, "afternoon", T, min(23, 59)) && visitStillUpcoming(T, null, T, min(23, 59)));
ck("graça é ampla o bastante p/ visita atrasada (>=90min)", VISIT_UPCOMING_GRACE_MIN >= 90);

console.log("\n" + "─".repeat(60));
if (failures === 0) {
  console.log(c.bold(c.green("POST-BOOKING GATE OK — all checks passed.")));
  process.exit(0);
} else {
  console.log(c.bold(c.red(`FAILED — ${failures} check(s) broken.`)));
  process.exit(1);
}
