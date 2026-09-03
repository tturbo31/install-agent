/**
 * VISITA DUPLA + TELEFONE DE GRUPO (revisão 20 dias, 02/09/2026) — guardas.
 * 100% determinístico: sem modelo, sem banco.
 *
 * Casos reais: Beverly (remarcada pelo Chris 31/08 19:11 p/ 02/09 15:00) +
 * Henry Ramos ([BOOK] da IA 31/08 19:25) ficaram no MESMO slot do MESMO
 * vendedor; Brenda/Taisha idem em 20/08 11:00. Causa: leitura de ocupados
 * falhava ABERTA (`bookedData ?? []` → agenda inteira "livre") e não havia
 * conferência pós-insert. E o booking do grupo de WhatsApp (Kendry 01/09)
 * gravou o ID do grupo como telefone.
 *
 *  1. sellerOpenForSlot: visita existente em "15:00:00" bloqueia o slot "15:00"
 *     (formato da plataforma ≠ formato do bot).
 *  2. Fonte: createBooking e rescheduleClientBooking falham FECHADO quando
 *     get_booked_slots dá erro (schedule_unreadable), nunca lista vazia.
 *  3. Fonte: insertLostSlotRace existe e é chamada nos DOIS caminhos de insert;
 *     quem chegou depois cede ("No availability" → webhook reoferece).
 *  4. Fonte: getRealAvailabilityContext e getNextOpenSlots lançam no erro do
 *     RPC (fail-closed); getAvailableSlots devolve [] e NUNCA a lista fixa.
 *  5. Fonte: wa-webhook não usa o waId de GRUPO como telefone — sem telefone
 *     digitado, pede com needPhoneMessage.
 * Run: npx tsx src/evals/slot-race-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { sellerOpenForSlot } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

console.log("\n━━ 1. sellerOpenForSlot: formatos de hora da plataforma ━━");
{
  // 2026-09-02 é quarta (weekday 3).
  const seller = { id: "s1", name: "Vendedor", priority: 1, active: true, enabled_weekdays: [0, 1, 2, 3, 4, 5, 6], time_slots: ["09:00", "11:00", "15:00"] } as Parameters<typeof sellerOpenForSlot>[0];
  const off = new Set<string>() as Parameters<typeof sellerOpenForSlot>[5];
  const b = (t: string) => [{ seller_id: "s1", booking_date: "2026-09-02", booking_time: t } as Parameters<typeof sellerOpenForSlot>[4][number]];
  ck("visita '15:00' bloqueia slot '15:00'", !sellerOpenForSlot(seller, "2026-09-02", 3, "15:00", b("15:00"), off));
  ck("visita '15:00:00' (formato da plataforma) TAMBÉM bloqueia '15:00'", !sellerOpenForSlot(seller, "2026-09-02", 3, "15:00", b("15:00:00"), off));
  ck("slot livre continua livre", sellerOpenForSlot(seller, "2026-09-02", 3, "11:00", b("15:00:00"), off));
  ck("visita de OUTRO vendedor não bloqueia", sellerOpenForSlot(seller, "2026-09-02", 3, "15:00", [{ seller_id: "s2", booking_date: "2026-09-02", booking_time: "15:00" } as Parameters<typeof sellerOpenForSlot>[4][number]], off));
}

console.log("\n━━ 2-4. fonte: scheduler.ts fail-closed + conferência pós-insert ━━");
{
  const s = src("src/lib/scheduler.ts");
  ck("createBooking: bookedErr → schedule_unreadable (fail-closed)", (s.match(/schedule_unreadable/g) ?? []).length >= 2);
  ck("insertLostSlotRace definida (cede o slot de quem chegou depois)", /async function insertLostSlotRace\(/.test(s));
  ck("insertLostSlotRace chamada nos DOIS inserts (book + reschedule)", (s.match(/await insertLostSlotRace\(/g) ?? []).length === 2);
  ck("conferência considera created/rescheduled/transferred (transferência humana conta)", /rescheduled_at,transferred_at/.test(s) && /occupiedSince/.test(s));
  ck("quem cede devolve a classe 'No availability' (webhook reoferece)", /insertLostSlotRace\(db, data\.id[\s\S]{0,200}No availability for \$\{req\.bookingDate\}/.test(s));
  ck("reschedule cede ANTES de apagar a visita antiga", /insertLostSlotRace\(db, created\.id[\s\S]{0,400}now remove the old one/.test(s));
  ck("getRealAvailabilityContext lança no erro do RPC", /get_booked_slots: \$\{bookedErr\.message\}/.test(s));
  ck("sellerOpenForSlot compara hora com hhmm dos dois lados", /hhmm\(b\.booking_time\) === hhmm\(slot\)/.test(s));
  ck("getAvailableSlots: erro → [] (lista fixa inventada REMOVIDA)", !/return \["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"\];/.test(s) && /getAvailableSlots failed — returning none/.test(s));
}

console.log("\n━━ 5. fonte: wa-webhook — grupo de WhatsApp nunca vira telefone ━━");
{
  const s = src("src/app/api/wa-webhook/route.ts");
  ck("waIdIsDialable exclui '-group' e exige 10-15 dígitos", /-group\\b/.test(s) && /waIdDigits\.length >= 10 && waIdDigits\.length <= 15/.test(s));
  ck("booking em grupo sem telefone digitado → needPhoneMessage", /waIdIsDialable \? waId : ""/.test(s) && /needPhoneMessage\(lang\)/.test(s));
  ck("reschedule também não usa id de grupo como telefone", /waIdIsDialable \? waId : undefined/.test(s));
}

console.log(`\n${pass} ✅  ${fail} ❌`);
if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
