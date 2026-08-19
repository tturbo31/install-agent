/**
 * REGRESSION GUARD for the "offered a day-off seller's schedule" bug
 * (2026-08-19, Mayra Rosabal, Messenger fb_25768736862824314).
 *
 * The owner registered days off in the Ozzi Plataforma at 20:01 UTC (Chris out
 * until 24/08, Diego off 20-21/08 with his agenda transferred to Chris). The
 * agent's availability math only knew enabled_weekdays + time_slots + bookings,
 * so at 22:24 it offered "Para el jueves tengo 1pm, 3pm, 5pm, o 7pm" — every
 * one of those except 3pm existed only on Diego's (off) schedule. The client
 * picked 5pm, gave name/address/phone, and the [BOOK] insert was killed by the
 * platform's DB trigger: code 23514, "Vendedor esta de folga em 2026-08-20
 * (Diego off - agenda transferida para Chris). Agendamento bloqueado." Because
 * that error does not start with "No availability", the slot-recovery path
 * never fired and the lead fell into the dead-end human handoff.
 *
 * Proves, with the REAL 19-22/08 scheduler state frozen below:
 *  - sellerOpenForSlot excludes a seller on his day off (Diego, Thu 17:00);
 *  - Thursday 20/08 only truly had 15:00 (Chris) — 1pm/5pm/7pm were phantoms;
 *  - Friday 21/08 had NOTHING real (Diego off, others fully booked);
 *  - a day-off on one date never leaks into other dates for the same seller;
 *  - isScheduleBlockedError recognizes the exact production trigger error
 *    (so createBooking converts it to "No availability..." and the webhooks
 *    offer real alternatives instead of handing off), and stays quiet for
 *    unrelated errors.
 *
 * ZERO API CALLS: sellerOpenForSlot / isScheduleBlockedError are pure.
 * Run: npx tsx src/evals/folga-days-off-verify.ts
 */
import { sellerOpenForSlot, isScheduleBlockedError, type Seller } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 200)}»`); }
}

// ── the REAL scheduler state on 2026-08-19 ~22:29 UTC ────────────────────────
const ALEXANDRE: Seller = { id: "8aa8842e", name: "Alexandre", priority: 1, enabled_weekdays: [1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00"], active: true };
const DIEGO: Seller = { id: "c6fcb045", name: "Diego", priority: 2, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], active: true };
const CHRIS: Seller = { id: "35f950e6", name: "Chris", priority: 3, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], active: true };
const SELLERS = [ALEXANDRE, DIEGO, CHRIS];

const B = (seller: Seller, booking_date: string, booking_time: string) =>
  ({ seller_id: seller.id, booking_date, booking_time });
const BOOKINGS = [
  // quinta 2026-08-20
  B(CHRIS, "2026-08-20", "09:00"), B(ALEXANDRE, "2026-08-20", "09:00"),
  B(CHRIS, "2026-08-20", "11:00"), B(ALEXANDRE, "2026-08-20", "11:00"),
  B(CHRIS, "2026-08-20", "13:00"), B(ALEXANDRE, "2026-08-20", "13:00"),
  B(ALEXANDRE, "2026-08-20", "15:00"),
  B(CHRIS, "2026-08-20", "17:00"), B(ALEXANDRE, "2026-08-20", "17:00"),
  B(CHRIS, "2026-08-20", "19:00"),
  // sexta 2026-08-21
  B(CHRIS, "2026-08-21", "09:00"), B(ALEXANDRE, "2026-08-21", "09:00"),
  B(CHRIS, "2026-08-21", "11:00"), B(ALEXANDRE, "2026-08-21", "11:00"),
  B(CHRIS, "2026-08-21", "13:00"), B(ALEXANDRE, "2026-08-21", "13:00"),
  B(CHRIS, "2026-08-21", "15:00"), B(ALEXANDRE, "2026-08-21", "15:00"),
  B(CHRIS, "2026-08-21", "17:00"), B(ALEXANDRE, "2026-08-21", "17:00"),
  B(CHRIS, "2026-08-21", "19:00"),
];
// seller_days_off como registrado pela plataforma em 19/08 às 20:01 UTC
const DAYS_OFF = new Set([
  "35f950e6|2026-08-19", // Chris
  "c6fcb045|2026-08-20", // Diego
  "c6fcb045|2026-08-21", // Diego
  "35f950e6|2026-08-22", // Chris
  "35f950e6|2026-08-23", // Chris
]);
const NO_DAYS_OFF = new Set<string>();

const THU = "2026-08-20", THU_WD = 4;
const FRI = "2026-08-21", FRI_WD = 5;
const openAt = (dateStr: string, wd: number, slot: string, daysOff: Set<string>) =>
  SELLERS.filter((s) => sellerOpenForSlot(s, dateStr, wd, slot, BOOKINGS, daysOff)).map((s) => s.name);

function main() {
  console.log("\n============== FOLGA (seller_days_off) VERIFY — caso Mayra 19/08 ==============");

  console.log("\n[1] O bug exato: quinta 17:00 parecia livre (Diego), mas Diego está de folga");
  ck("SEM folga, o slot fantasma aparece (confirma que o teste morde)", openAt(THU, THU_WD, "17:00", NO_DAYS_OFF).join() === "Diego");
  ck("COM folga, quinta 17:00 não tem NINGUÉM", openAt(THU, THU_WD, "17:00", DAYS_OFF).length === 0, openAt(THU, THU_WD, "17:00", DAYS_OFF).join());
  ck("quinta 13:00 (1pm ofertada) também era fantasma", openAt(THU, THU_WD, "13:00", DAYS_OFF).length === 0);
  ck("quinta 19:00 (7pm ofertada) também era fantasma", openAt(THU, THU_WD, "19:00", DAYS_OFF).length === 0);
  ck("quinta 15:00 (3pm) era a ÚNICA real — Chris atende", openAt(THU, THU_WD, "15:00", DAYS_OFF).join() === "Chris");

  console.log("\n[2] Sexta 21/08: Diego de folga + resto lotado = dia sem NADA");
  for (const slot of ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"]) {
    ck(`sexta ${slot} vazia`, openAt(FRI, FRI_WD, slot, DAYS_OFF).length === 0, openAt(FRI, FRI_WD, slot, DAYS_OFF).join());
  }

  console.log("\n[3] A folga não vaza para outros dias nem outros vendedores");
  ck("Diego volta na segunda 24/08 (sem folga registrada)", sellerOpenForSlot(DIEGO, "2026-08-24", 1, "17:00", BOOKINGS, DAYS_OFF) === true);
  ck("folga do Diego não derruba o Chris na quinta 15:00", sellerOpenForSlot(CHRIS, THU, THU_WD, "15:00", BOOKINGS, DAYS_OFF) === true);
  ck("regras antigas seguem: weekday fora da escala continua fechado (Diego sáb)", sellerOpenForSlot(DIEGO, "2026-08-22", 6, "17:00", BOOKINGS, DAYS_OFF) === false);
  ck("regras antigas seguem: slot já reservado continua fechado (Chris qui 17:00 sem folga)", sellerOpenForSlot(CHRIS, THU, THU_WD, "17:00", BOOKINGS, NO_DAYS_OFF) === false);
  ck("regras antigas seguem: vendedor inativo nunca abre", sellerOpenForSlot({ ...DIEGO, active: false }, "2026-08-24", 1, "17:00", BOOKINGS, NO_DAYS_OFF) === false);

  console.log("\n[4] isScheduleBlockedError: o erro do trigger vira classe 'No availability'");
  const PROD_ERR = { code: "23514", details: null, hint: null, message: "Vendedor esta de folga em 2026-08-20 (Diego off - agenda transferida para Chris). Agendamento bloqueado." };
  ck("erro REAL de produção (23514 + folga) é reconhecido", isScheduleBlockedError(PROD_ERR) === true);
  ck("23514 sem texto de folga também é bloqueio de agenda", isScheduleBlockedError({ code: "23514", message: "new row violates check constraint" }) === true);
  ck("mensagem de folga sem code também é reconhecida", isScheduleBlockedError({ message: "Vendedor esta de folga em 2026-09-01. Agendamento bloqueado." }) === true);
  ck("erro de rede/auth NÃO vira 'No availability'", isScheduleBlockedError({ code: "PGRST301", message: "JWT expired" }) === false);
  ck("erro de RLS NÃO vira 'No availability'", isScheduleBlockedError({ code: "42501", message: "permission denied for table bookings" }) === false);
  ck("null/undefined não explode", isScheduleBlockedError(null) === false && isScheduleBlockedError(undefined) === false);

  console.log(`\n================= RESULT: ${pass} passed, ${fail} failed =================`);
  if (fail > 0) { console.log("FAILED: " + fails.join(" | ")); process.exit(1); }
}
main();
