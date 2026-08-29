/**
 * REGRESSION GUARD for the "phantom Sunday hours" bug
 * (2026-08-28, Chanju-lyn Mwase fb_27631683733176190 + Gilberto fb_27702960589404555).
 *
 * The Ozzi Plataforma stores a seller's DEFAULT hour grid in sellers.time_slots
 * AND an optional PER-WEEKDAY grid in sellers.weekday_time_slots
 * ({"0":["09:00",...]}, "0"=Sunday ... "6"=Saturday). Diego works 14/16/18/20
 * Monday-Friday but 09..19 on SUNDAY. The agent read only time_slots, so:
 *   - every Sunday it offered 2pm, 4pm, 6pm and 8pm — hours that do not exist;
 *   - Diego's REAL Sunday hours (all six already booked) were invisible, so the
 *     day looked "40% booked" when he had nothing left at all.
 * Chanju picked "Sunday 2pm", gave name + address + phone, and the insert was
 * killed by the platform trigger: P0001, "Horário 14:00 indisponível para este
 * vendedor neste dia". That error does not start with "No availability", so the
 * slot-recovery never fired and both hot leads got the dead-end handoff
 * ("Sorry, I couldn't lock in that exact time in the system") with no visit.
 *
 * Proves, with the REAL 28/08 scheduler state frozen below:
 *  - slotsForWeekday: the weekday grid REPLACES the default one (never merges);
 *    an empty grid for a day means the seller does not work that day; a missing
 *    day falls back to time_slots; "14:00:00" normalizes to "14:00";
 *  - sellerOpenForSlot closes Diego's Sunday 2pm/4pm/6pm/8pm and keeps his
 *    weekday 2pm open (the old rule had it exactly backwards);
 *  - the union of open Sunday hours is 11am/5pm only — the four phantoms are gone;
 *  - isScheduleBlockedError recognizes the production P0001 error, so
 *    createBooking converts it to "No availability..." and the webhooks offer
 *    real times instead of the dead end;
 *  - every sellers SELECT in scheduler.ts carries weekday_time_slots, and no
 *    availability path reads s.time_slots directly any more.
 *
 * ZERO API CALLS: slotsForWeekday / sellerOpenForSlot / isScheduleBlockedError are pure.
 * Run: npx tsx src/evals/weekday-slots-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { sellerOpenForSlot, slotsForWeekday, isScheduleBlockedError, type Seller } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 220)}»`); }
}

// ── the REAL sellers table on 2026-08-28 ─────────────────────────────────────
const ALEXANDRE: Seller = { id: "8aa8842e", name: "Alexandre", priority: 1, enabled_weekdays: [1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00"], weekday_time_slots: null, active: true };
const DIEGO: Seller = { id: "c6fcb045", name: "Diego", priority: 2, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["14:00", "16:00", "18:00", "20:00"], weekday_time_slots: { "0": ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"] }, active: true };
const CHRIS: Seller = { id: "35f950e6", name: "Chris", priority: 3, enabled_weekdays: [0, 1, 2, 3, 4, 5], time_slots: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"], weekday_time_slots: null, active: true };
const SELLERS = [ALEXANDRE, DIEGO, CHRIS];

const SUN = "2026-08-30", SUN_WD = 0;   // domingo
const MON = "2026-08-31", MON_WD = 1;   // segunda
const B = (s: Seller, booking_date: string, booking_time: string) => ({ seller_id: s.id, booking_date, booking_time });
// Domingo 30/08 como estava: o dono lotou o domingo REAL do Diego (as 6 horas da
// grade de domingo) e o Chris tinha 09/13/15/19 ocupados.
const BOOKINGS = [
  B(DIEGO, SUN, "09:00"), B(DIEGO, SUN, "11:00"), B(DIEGO, SUN, "13:00"),
  B(DIEGO, SUN, "15:00"), B(DIEGO, SUN, "17:00"), B(DIEGO, SUN, "19:00"),
  B(CHRIS, SUN, "09:00"), B(CHRIS, SUN, "13:00"), B(CHRIS, SUN, "15:00"), B(CHRIS, SUN, "19:00"),
  B(DIEGO, MON, "14:00"), B(CHRIS, MON, "11:00"), B(CHRIS, MON, "15:00"), B(ALEXANDRE, MON, "09:00"), B(ALEXANDRE, MON, "17:00"),
];
const NO_OFF = new Set<string>();

function openUnion(dateStr: string, weekday: number): string[] {
  const set = new Set<string>();
  for (const s of SELLERS) for (const slot of slotsForWeekday(s, weekday)) {
    if (sellerOpenForSlot(s, dateStr, weekday, slot, BOOKINGS, NO_OFF)) set.add(slot);
  }
  return [...set].sort();
}

function main() {
  console.log("\n[1] slotsForWeekday: a grade do dia SUBSTITUI a grade padrão");
  ck("Diego domingo usa a grade de domingo (09..19), não 14/16/18/20", JSON.stringify(slotsForWeekday(DIEGO, 0)) === JSON.stringify(["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"]), JSON.stringify(slotsForWeekday(DIEGO, 0)));
  ck("Diego segunda a sexta segue a grade padrão", [1, 2, 3, 4, 5].every((wd) => JSON.stringify(slotsForWeekday(DIEGO, wd)) === JSON.stringify(["14:00", "16:00", "18:00", "20:00"])));
  ck("a grade do dia nunca é somada à padrão (domingo do Diego não tem 20:00)", !slotsForWeekday(DIEGO, 0).includes("20:00"));
  ck("vendedor sem grade por dia usa a padrão em todos os dias", [0, 1, 2, 3, 4, 5, 6].every((wd) => JSON.stringify(slotsForWeekday(CHRIS, wd)) === JSON.stringify(CHRIS.time_slots)));
  ck("grade VAZIA no dia = vendedor não atende nesse dia", slotsForWeekday({ ...DIEGO, weekday_time_slots: { "0": [] } }, 0).length === 0);
  ck("weekday_time_slots null/ausente não explode", slotsForWeekday({ ...DIEGO, weekday_time_slots: null }, 0).join() === "14:00,16:00,18:00,20:00" && slotsForWeekday({ ...DIEGO, weekday_time_slots: undefined }, 0).join() === "14:00,16:00,18:00,20:00");
  ck("horário com segundos vira HH:MM (o banco pode devolver 14:00:00)", slotsForWeekday({ ...DIEGO, weekday_time_slots: { "0": ["09:00:00", "17:00:00"] } }, 0).join() === "09:00,17:00");

  console.log("\n[2] Domingo 30/08: as 4 horas FANTASMA do caso Chanju/Gilberto");
  for (const slot of ["14:00", "16:00", "18:00", "20:00"]) {
    ck(`domingo ${slot} fechado (não existe na grade de domingo do Diego)`, sellerOpenForSlot(DIEGO, SUN, SUN_WD, slot, BOOKINGS, NO_OFF) === false);
    ck(`domingo ${slot} não aparece para NENHUM vendedor`, !openUnion(SUN, SUN_WD).includes(slot), openUnion(SUN, SUN_WD).join());
  }
  ck("domingo 2pm (o horário que a Chanju escolheu) está fora da oferta", !openUnion(SUN, SUN_WD).includes("14:00"));
  ck("domingo 4pm (o horário do Gilberto) está fora da oferta", !openUnion(SUN, SUN_WD).includes("16:00"));
  ck("domingo real = só 11am e 5pm", openUnion(SUN, SUN_WD).join() === "11:00,17:00", openUnion(SUN, SUN_WD).join());
  ck("o domingo REAL do Diego (lotado) continua fechado", ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].every((s) => sellerOpenForSlot(DIEGO, SUN, SUN_WD, s, BOOKINGS, NO_OFF) === false));

  console.log("\n[3] A correção não fecha nada que era legítimo");
  ck("Diego segunda 16:00 continua aberto (grade padrão intacta)", sellerOpenForSlot(DIEGO, MON, MON_WD, "16:00", BOOKINGS, NO_OFF) === true);
  ck("Diego segunda 14:00 fechado só porque já está ocupado", sellerOpenForSlot(DIEGO, MON, MON_WD, "14:00", BOOKINGS, NO_OFF) === false);
  ck("segunda mantém a oferta cheia dos 3 vendedores", openUnion(MON, MON_WD).join() === "09:00,11:00,13:00,15:00,16:00,17:00,18:00,19:00,20:00", openUnion(MON, MON_WD).join());
  ck("regra antiga segue: dia fora da escala continua fechado (Diego sábado)", sellerOpenForSlot(DIEGO, "2026-09-05", 6, "14:00", BOOKINGS, NO_OFF) === false);
  ck("regra antiga segue: folga continua fechando o vendedor", sellerOpenForSlot(CHRIS, SUN, SUN_WD, "11:00", BOOKINGS, new Set([`${CHRIS.id}|${SUN}`])) === false);
  ck("regra antiga segue: vendedor inativo nunca abre", sellerOpenForSlot({ ...CHRIS, active: false }, SUN, SUN_WD, "11:00", BOOKINGS, NO_OFF) === false);

  console.log("\n[4] isScheduleBlockedError: o P0001 da plataforma vira classe 'No availability'");
  const PROD = { code: "P0001", details: null, hint: null, message: "Horário 14:00 indisponível para este vendedor neste dia" };
  ck("erro REAL de produção (P0001 grade do dia) é reconhecido", isScheduleBlockedError(PROD) === true);
  ck("a mensagem sozinha, sem code, também é reconhecida", isScheduleBlockedError({ message: "Horario 16:00 indisponivel para este vendedor neste dia" }) === true);
  ck("folga (23514) continua reconhecida", isScheduleBlockedError({ code: "23514", message: "Vendedor esta de folga em 2026-08-20. Agendamento bloqueado." }) === true);
  ck("erro de RLS NÃO vira 'No availability'", isScheduleBlockedError({ code: "42501", message: "permission denied for table bookings" }) === false);
  ck("JWT expirado NÃO vira 'No availability'", isScheduleBlockedError({ code: "PGRST301", message: "JWT expired" }) === false);
  ck("null/undefined não explode", isScheduleBlockedError(null) === false && isScheduleBlockedError(undefined) === false);

  console.log("\n[5] Guardas estáticas: a coluna chega e ninguém volta a ler s.time_slots");
  const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  const selects = sched.match(/\.select\("id,name,priority,enabled_weekdays[^"]*"\)/g) ?? [];
  ck(`todo SELECT de sellers pede weekday_time_slots (${selects.length} encontrados)`, selects.length >= 6 && selects.every((s) => s.includes("weekday_time_slots")), selects.filter((s) => !s.includes("weekday_time_slots")).join(" | "));
  ck("sellerOpenForSlot usa a grade do dia", /slotsForWeekday\(s, weekday\)\.includes\(slot\)/.test(sched));
  ck("nenhuma varredura de horários lê s.time_slots direto", !/s\.time_slots\.(forEach|includes)|of s\.time_slots/.test(sched), (sched.match(/.{0,60}s\.time_slots\.(forEach|includes).{0,20}/g) ?? []).join(" | "));
  ck("slotsForWeekday é exportado (webhooks/evals podem checar a grade)", /export function slotsForWeekday/.test(sched));

  console.log(`\n================= RESULT: ${pass} passed, ${fail} failed =================`);
  if (fail > 0) { console.log("FAILED: " + fails.join(" | ")); process.exit(1); }
}
main();
