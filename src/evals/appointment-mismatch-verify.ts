// Verifica as duas correções do CASO MSLEO (2026-08-05, IG):
//
//  A cliente tinha visita 01/08 11am. Em 01/08 avisou (acidente na Europa) e o
//  DONO remarcou manualmente pelo app do IG para 05/08 9am. Os ecos do dono
//  eram DESCARTADOS no POST do webhook IG (desde o commit inicial), então nada
//  foi gravado e a conversa não pausou. O scheduler ficou com a data velha; em
//  04/08 21:25 a visita velha tinha passado, a flag booked caiu como "stale" e
//  o bot respondeu ao "Gate code:0074" oferecendo OUTROS dias ("August 5th is
//  fully booked") — contradizendo o acordo do dono. Cliente saiu decepcionada.
//
//  FIX 1: o POST do webhook IG deixa eventos is_echo chegarem ao handler (a
//         captura [Treino] + mode=human já existia lá e era código morto).
//  FIX 2: assertsExistingAppointment — com a flag booked vencida, se a rajada
//         afirma uma visita já combinada (gate code, "we had a confirmed
//         appointment", aceite de horário sem oferta em aberto), o bot faz
//         handoff neutro para o dono em vez de re-engajar vendas.
//
// 100% determinístico: nenhuma chamada de API, nenhum banco.
import { readFileSync } from "fs";
import { join } from "path";
import { assertsExistingAppointment } from "../lib/ai";
import { appointmentMismatchHandoffMessage } from "../lib/scheduler";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}

async function main() {
  console.log("\n============= APPOINTMENT-MISMATCH VERIFICATION (caso Msleo) =============");

  // ── 1. Positivos: cliente AFIRMA visita que o scheduler não mostra ────────
  console.log("\n[1] assertsExistingAppointment — POSITIVOS (handoff ao dono, nunca vender)");
  const positives: Array<[string, string | null]> = [
    ["Gate code:0074", "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."],
    ["We had a confirmed appointment already", null],
    ["I confirmed with you before I left Europe.\nThat is what you sent me", null],
    // a rajada REAL completa de 04/08 21:25 (4 bolhas não-respondidas)
    ["Good morning Ozzi, I apologize for the inconvenience. I am still in Europe due to an accident and won't be able to travel until Monday. Could you please send another appointment so we can meet? Thank you for your patience.\nI will take the 9am. Thank you very much.\nJust to clarify, that will be August 5th at 9 am\nGate code:0074", null],
    ["I will take the 9am. Thank you very much.", null], // aceite SEM oferta nossa em aberto
    ["Just to clarify, that will be August 5th at 9 am", null],
    ["My appointment is tomorrow right?", null],
    ["You already confirmed the visit with me", null],
    ["Can you confirm my appointment?", null],
    ["see you tomorrow at 9", null],
    ["the code for the gate is 4455", null],
    ["El código del portón es 4455", null],
    ["Ya tengo una cita con ustedes", null],
    ["Já tenho visita marcada com vocês", null],
    ["I already have an appointment with Ozzi", null],
  ];
  for (const [t, last] of positives) {
    ck(`positivo: "${t.replace(/\n/g, " / ").slice(0, 80)}"`, assertsExistingAppointment(t, last) === true, "não detectado");
  }

  // ── 2. Negativos: o re-engajamento normal NÃO pode morrer (trava 2026-07-21
  //      contra silêncio eterno de cliente pós-visita) ────────────────────────
  console.log("\n[2] assertsExistingAppointment — NEGATIVOS (re-engajar normalmente)");
  const negatives: Array<[string, string | null]> = [
    ["How much is it per sqft?", null],
    ["Hey, I need a new quote for my kitchen now", null],
    ["Can we reschedule the visit?", null], // pedido de mover ≠ afirmação de acordo
    ["can we do another day?", null],
    ["Can I have an appointment for Friday?", null], // PEDIDO de cita nova
    ["Ok thank you", null],
    ["you came to my house before, now I need the other bedroom done", null],
    ["Do you handle permits?", null],
    // aceite de horário COM oferta nossa em aberto = fluxo normal de agendamento
    ["I'll take the 9am", "Sure! I have Friday at 9am or 1pm, which works better for you?"],
  ];
  for (const [t, last] of negatives) {
    ck(`negativo: "${t.slice(0, 80)}"`, assertsExistingAppointment(t, last) === false, "falso-positivo");
  }

  // ── 3. Mensagem de handoff: neutra, sem afirmar data/disponibilidade ──────
  console.log("\n[3] appointmentMismatchHandoffMessage — sanidade");
  for (const lang of ["en", "es"] as const) {
    const m = appointmentMismatchHandoffMessage(lang);
    ck(`${lang}: menciona Ozzi`, /ozzi/i.test(m), m);
    ck(`${lang}: sem em/en dash`, !/[—–‒―]/.test(m), m);
    ck(`${lang}: sem emoji`, !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u.test(m), m);
    ck(`${lang}: não afirma dia/hora nem "booked/taken"`, !/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b|\d\s*(?:am|pm)|\b(?:booked|taken|unavailable|ocupad)\b/i.test(m), m);
  }

  // ── 4. Fiação nos 3 webhooks (inspeção de fonte, sem API) ─────────────────
  console.log("\n[4] Os 3 webhooks ligam a guarda ANTES do reset da flag stale");
  const hooks: Array<[string, string]> = [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ];
  for (const [name, rel] of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    const iGuard = src.indexOf("assertsExistingAppointment(");
    const iReset = src.indexOf("booked flag is stale");
    ck(`${name}: chama assertsExistingAppointment`, iGuard > -1);
    ck(`${name}: guarda roda ANTES do reset stale`, iGuard > -1 && iReset > -1 && iGuard < iReset);
    ck(`${name}: envia appointmentMismatchHandoffMessage`, /appointmentMismatchHandoffMessage\(/.test(src));
    ck(`${name}: a flag NÃO é resetada no caminho da guarda (reset segue só no caminho stale normal)`, /booking_confirmed: false/.test(src));
  }

  // ── 5. FIX 1: o POST do webhook IG NÃO descarta mais ecos ─────────────────
  console.log("\n[5] Webhook IG processa ecos (captura de resposta manual do dono viva)");
  const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8");
  ck("IG POST: skip de eco removido", !/if\s*\(\s*!messaging\s*\|\|\s*messaging\.message\?\.is_echo\s*\)/.test(ig));
  ck("IG handler: branch isBusinessSending existe (eco → [Treino] + mode=human)", /isBusinessSending/.test(ig) && /\[Treino\]/.test(ig) && /mode:\s*"human"/.test(ig));
  ck("IG handler: match de eco do próprio bot (norm + janela de 5)", /matchesRecentBot/.test(ig));
  const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8");
  ck("FB: branch de eco intacto", /is_echo/.test(fb) && /matchesRecentBot/.test(fb));

  console.log(`\n──────────────── ${pass} ✅  ${fail} ❌`);
  if (fails.length) { console.log("Falhas:"); for (const f of fails) console.log(`  • ${f}`); }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("crash:", e); process.exit(1); });
