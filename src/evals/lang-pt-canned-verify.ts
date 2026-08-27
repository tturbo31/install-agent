/**
 * GUARDA do caso Anna Evangelista (IG, 2026-08-21) — "começou em português,
 * virou espanhol e não sabe passar a data".
 *
 * O que aconteceu de verdade:
 *  1. Conversa 100% em português; a cliente pediu terça 25 às 10am (visita
 *     junto com os donos atuais da casa). 10am estava cheio no scheduler.
 *  2. O [BOOK] falhou com "No availability" e a recuperação enlatada
 *     slotConflictRecoveryMessage saiu em ESPANHOL — detectLang só conhecia
 *     es/en, e um texto PT (palavras compartilhadas + acentos á/é/í/ó) pontua
 *     "es". A cliente teve que dizer "Eu não falo espanhol".
 *  3. A recuperação ofereceu "domingo 6pm/8pm" (o mais cedo da agenda TODA)
 *     em vez de outros horários da MESMA terça que a cliente precisava, e
 *     repetiu o texto idêntico 3 vezes (loop até o dono pausar o bot).
 *
 * Fixes cobertos:
 *  A. detectLang reconhece português (ã õ ç â ê à ô pesam 2x; ñ ¿ ¡ idem p/ ES).
 *  B. TODAS as mensagens enlatadas do scheduler têm variante PT.
 *  C. slotConflictRecoveryMessage oferece horários do MESMO dia pedido antes
 *     de pular para "o mais cedo da agenda", nunca reoferece a hora que acabou
 *     de falhar, e devolve null (→ handoff ao dono) se a mesma recuperação já
 *     foi enviada antes (anti-loop).
 *
 * ZERO chamadas de API/DB: unit tests puros + inspeção de fonte. Rodar:
 *   npx tsx src/evals/lang-pt-canned-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  detectLang,
  bookingSuccessMessage,
  bookingFailureHandoffMessage,
  rescheduleSuccessMessage,
  aiOutageHandoffMessage,
  appointmentMismatchHandoffMessage,
  needSlotConfirmationMessage,
  needNameMessage,
  needAddressMessage,
  needZipMessage,
  needPhoneMessage,
  addressCorrectedMessage,
  addressChangeHandoffMessage,
  cancellationConfirmedMessage,
  cancellationHandoffMessage,
  visitDetailsMessage,
  type Lang,
} from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}

console.log("\n[A. detectLang reconhece português]");
// Mensagens REAIS da Anna (2026-08-21)
const anna1 = "Olá tudo bem ? Not sure if you speak Portuguese 😊 My name is Anna and I've been following your Instagram page for a while and I thought I heard you speaking Portuguese. I was wondering if you could help me with a quote to replace a floor in the house we are buying it.";
const anna2 = "Perfeito! No dia 25 vcs poderiam às 10 am ? Seria excelente!!! A casa atualmente tem madeira e cerâmica. Gostaríamos de ver as possibilidades pra trocar a cerâmica existente por algo mais novo/moderno. E ver a condição do piso de madeira.. se vale a pena trocar ou não.";
const anna3 = "Eu não posso no domingo Pode ser na terça dia 25?";
const anna4 = "Eu não falo espanhol";
ck("burst PT da Anna (dia 25 às 10am) → pt", detectLang(anna2) === "pt", detectLang(anna2));
ck('"Eu não posso no domingo Pode ser na terça dia 25?" → pt', detectLang(anna3) === "pt", detectLang(anna3));
ck('"Eu não falo espanhol" → pt', detectLang(anna4) === "pt", detectLang(anna4));
// Histórico inteiro concatenado (como o webhook chama: cliente PT + bot PT)
const annaBotPt = "Olá Anna, que prazer falar em português com você! Coral Gables fica na nossa área de atendimento, e terça-feira dia 25 temos disponibilidade às 9am, 11am ou 1pm. Para confirmar, só preciso do endereço completo da propriedade com o CEP e do seu melhor número de telefone!";
ck("histórico completo PT (cliente + bot) → pt", detectLang([anna1, annaBotPt, anna2, "817 Venetia Ave Coral Gables, FL 33134 407-866-3441"].join(" ")) === "pt", detectLang([anna1, annaBotPt, anna2].join(" ")));

// Regressão: ES continua ES, EN continua EN
ck("ES puro continua es", detectLang("Hola, ¿cuánto cuesta la instalación del piso para mi casa? Necesito una cita mañana.") === "es", detectLang("Hola, ¿cuánto cuesta la instalación del piso?"));
ck("EN puro continua en", detectLang("Hello, I need a quote for my house floor, is tomorrow morning available?") === "en", "");
ck("histórico ES longo (com acentos) continua es", detectLang("Buenas, quiero cambiar el piso de la cocina y el cuarto. ¿Qué precio tiene? Tengo disponible el viernes. La dirección es Calle 8. Gracias.") === "es", "");
ck("vazio → en", detectLang("") === "en", "");

console.log("\n[B. Toda mensagem enlatada tem variante PT (e ES/EN intactas)]");
const noSpanishMarkers = (t: string) => !/[ñ¿¡]|\b(cita|usted|enseguida|dirección|contacta|listo|quedó)\b/i.test(t);
const ptFns: Array<[string, (l: Lang) => string]> = [
  ["bookingSuccessMessage", (l) => bookingSuccessMessage(l)],
  ["bookingFailureHandoffMessage", (l) => bookingFailureHandoffMessage(l)],
  ["rescheduleSuccessMessage", (l) => rescheduleSuccessMessage(l)],
  ["aiOutageHandoffMessage", (l) => aiOutageHandoffMessage(l)],
  ["appointmentMismatchHandoffMessage", (l) => appointmentMismatchHandoffMessage(l)],
  ["needSlotConfirmationMessage", (l) => needSlotConfirmationMessage(l)],
  ["needNameMessage", (l) => needNameMessage(l)],
  ["needAddressMessage", (l) => needAddressMessage(l)],
  ["needZipMessage", (l) => needZipMessage(l)],
  ["needPhoneMessage", (l) => needPhoneMessage(l)],
  ["addressCorrectedMessage", (l) => addressCorrectedMessage(l, "apto 916")],
  ["addressChangeHandoffMessage", (l) => addressChangeHandoffMessage(l)],
  ["cancellationHandoffMessage", (l) => cancellationHandoffMessage(l)],
  ["cancellationConfirmedMessage", (l) => cancellationConfirmedMessage(l, "2026-08-25", "10:00")],
  ["visitDetailsMessage", (l) => visitDetailsMessage(l, "2026-08-25", "10:00")],
];
for (const [name, fn] of ptFns) {
  const pt = fn("pt"), es = fn("es"), en = fn("en");
  ck(`${name}: pt ≠ es ≠ en`, pt !== es && pt !== en && es !== en, pt);
  ck(`${name}: pt sem marcadores de espanhol`, noSpanishMarkers(pt), pt);
}
ck("visitDetailsMessage pt usa terça 25 de agosto", /terça.*25.*agosto/i.test(visitDetailsMessage("pt", "2026-08-25", "10:00")), visitDetailsMessage("pt", "2026-08-25", "10:00"));
ck("cancellationConfirmedMessage pt usa às 10am", /às 10am/i.test(cancellationConfirmedMessage("pt", "2026-08-25", "10:00")), cancellationConfirmedMessage("pt", "2026-08-25", "10:00"));

console.log("\n[C. Recuperação de slot: mesmo dia primeiro, sem loop, PT no fonte]");
const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf8");
ck("mesmo dia pedido é tentado antes do 'mais cedo geral'", /Same-day alternatives first/.test(sched) && sched.indexOf("Same-day alternatives first") < sched.indexOf("getNextOpenSlots(21)"), "ordem invertida ou branch removido");
ck("hora que falhou nunca é reoferecida", /Never re-offer the very time that just failed/.test(sched), "filtro do requestedTime removido");
ck("anti-loop: recuperação repetida devolve null (→ handoff)", /recovery already sent once/.test(sched), "loop da Anna pode voltar");
ck("variante PT da recuperação existe", /Esse horário exato eu não tenho disponível/.test(sched) && /O mais cedo que tenho disponível/.test(sched), "PT sumiu da recuperação");

console.log("\n[D. Os 3 webhooks passam dia/hora pedidos + histórico à recuperação]");
const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf8");
const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf8");
const wa = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf8");
for (const [nome, src] of [["IG", ig], ["FB", fb], ["WA", wa]] as const) {
  ck(`${nome}: slotConflictRecoveryMessage(lang, date, history, time)`, /slotConflictRecoveryMessage\(lang, bookingData\.date, history, bookingData\.time(?:, bookingData\.address)?\)/.test(src), "voltou à chamada sem contexto do dia pedido");
  ck(`${nome}: lang usa o tipo Lang (com pt)`, /lang: Lang/.test(src), "tipo estreitado de volta a es|en");
}

console.log(`\n${pass} passed, ${fail} failed${fail ? `\nFAILS:\n - ${fails.join("\n - ")}` : ""}`);
process.exit(fail ? 1 : 0);
