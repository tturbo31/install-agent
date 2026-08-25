/**
 * Caso Brian Guilford (IG, 2026-07-25) — "Let’s do 9:00–thank you".
 *
 * O teclado do iPhone envia o apóstrofo tipográfico U+2019 ("Let’s") e o
 * en-dash U+2013 ("9:00–thank you"). Duas guardas escritas com o apóstrofo
 * ASCII e com hora exigindo am/pm falharam NO MESMO texto:
 *
 *  1. isPureClosing/isPureClosingBurst: "let'?s\s+do" não casou (apóstrofo
 *     curvo), "9:00" sem am/pm não contou como hora, "thank you" casou como
 *     fechamento → a resposta do modelo foi DESCARTADA e o cliente que acabou
 *     de escolher o horário ficou 13 min no vácuo.
 *  2. clientConfirmedSlot: nenhum token de hora reconheceu "9:00" → quando o
 *     endereço chegou, o [BOOK] foi bloqueado e o bot re-perguntou o dia/hora
 *     que o cliente JÁ tinha escolhido.
 *
 * Fixes: normalizeSmartPunct em toda guarda de silêncio/gate (ai.ts), espelho
 * local em clientConfirmedSlot, e "H:MM" sem am/pm como hora válida em
 * SUBSTANTIVE_CONTENT e SLOT_TIME_REF (o dois-pontos obrigatório impede que
 * número de rua conte como hora).
 *
 * ZERO chamadas de API — tudo função pura.
 * Rodar: npx tsx src/evals/smartquote-slot-silence-verify.ts
 */
import {
  isPureClosing,
  isPureClosingBurst,
  hasSubstantiveContent,
  isRescheduleRequest,
  normalizeSmartPunct,
} from "../lib/ai";
import { clientConfirmedSlot } from "../lib/scheduler";

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` | ${detail}` : ""}`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });

// Texto EXATO do cliente (U+2019 + U+2013, hora sem am/pm).
const GUILFORD = "Let’s do 9:00–thank you";

console.log("[1] normalizeSmartPunct");
ck("’ (U+2019) vira '", normalizeSmartPunct("Let’s") === "Let's");
ck("‘ e ´ também viram '", normalizeSmartPunct("‘quote´") === "'quote'");

console.log("\n[2] Fechamento puro — a escolha de horário nunca é silenciada");
ck("isPureClosing(Guilford) = false", !isPureClosing(GUILFORD));
ck("hasSubstantiveContent(Guilford) = true", hasSubstantiveContent(GUILFORD));
ck("isPureClosingBurst(histórico Guilford) = false", !isPureClosingBurst([
  U("Ok let’s target next week if possible please."),
  A("Perfect, I have Tuesday the 28th at 9am or 1pm, which works better for you?"),
  U(GUILFORD),
]));
ck("variante ASCII 'Let's do 9:00 thank you' também não é fechamento", !isPureClosing("Let's do 9:00 thank you"));
ck("'thanks, see you at 9:00' carrega hora → não é fechamento", !isPureClosing("thanks, see you at 9:00"));
// A guarda não pode ter sido enfraquecida: agradecimento puro segue silenciado.
ck("'Thank you so much!' segue sendo fechamento puro", isPureClosing("Thank you so much!"));
ck("'Thank you so much!' com apóstrofo curvo em volta segue fechamento", isPureClosing("Ok thanks, I’ll think about it"));
// 2026-08-24 (WA, quote follow-up): "pagaré con cheque, gracias" was a pure
// closing → silence on a client saying HOW they will pay. Payment intent is
// substance; a bare "I'll check and let you know" is still a closing.
ck("'No hay problema, pagaré con cheque, gracias.' NÃO é fechamento (intenção de pagamento)", !isPureClosing("No hay problema, pagaré con cheque, gracias."));
ck("'i don't need financing, thanks' NÃO é fechamento", !isPureClosing("i don't need financing, thanks"));
ck("'Thanks, I'll pay in full' NÃO é fechamento", !isPureClosing("Thanks, I'll pay in full"));
ck("'Ok gracias, pago con Zelle' NÃO é fechamento", !isPureClosing("Ok gracias, pago con Zelle"));
ck("'Thanks, I'll check and let you know' segue fechamento puro", isPureClosing("Thanks, I'll check and let you know"));
ck("'Ok gracias, te aviso' segue fechamento puro", isPureClosing("Ok gracias, te aviso"));
// tronchris89 (IG, 2026-08-24): "Cancel for now thanks" was a pure closing → the
// cancel request was silenced and the visit stayed on the calendar.
ck("'Cancel for now thanks' NÃO é fechamento (pedido de cancelamento)", !isPureClosing("Cancel for now thanks"));
ck("'Ok, reschedule please, thanks' NÃO é fechamento", !isPureClosing("Ok, reschedule please, thanks"));

console.log("\n[3] clientConfirmedSlot — '9:00' sem am/pm é escolha de slot");
const guilfordFull = [
  A("Perfect, I have Tuesday the 28th at 9am or 1pm, which works better for you?"),
  U(GUILFORD),
  U("10611 Sw 124 Road Miami FL 33186"),
  U("Cell is 305-338-4145 (Brian)"),
];
ck("caso Guilford completo → confirmado", clientConfirmedSlot(guilfordFull) === true);
ck("'Let’s do 9' (hora ofertada, sem dois-pontos) → confirmado", clientConfirmedSlot([
  A("I have Tuesday at 9am or 1pm, which works better for you?"),
  U("Let’s do 9"),
]) === true);
ck("'let’s do 2 rooms' (número ≠ hora ofertada) → NÃO confirma", clientConfirmedSlot([
  A("I have Monday at 9am or 1pm, which works?"),
  U("let’s do 2 rooms"),
]) === false);
ck("'let's do 5' quando a oferta era 9am/1pm → NÃO confirma", clientConfirmedSlot([
  A("I have Monday at 9am or 1pm, which works?"),
  U("let's do 5"),
]) === false);
// Blindagens existentes intactas:
ck("endereço com número de rua ('11 NW 9th St') segue NÃO confirmando", clientConfirmedSlot([
  A("I have Monday at 9am or 11am, which works?"),
  U("11 NW 9th St Miami"),
]) === false);
ck("só endereço+telefone segue NÃO confirmando (caso RODOLFO)", clientConfirmedSlot([
  A("I have Monday at 9am or 1pm, which works?"),
  U("10990 sw 225 ter"),
  U("3059427955"),
]) === false);

console.log("\n[4] Apóstrofo curvo em outras guardas de silêncio");
ck("'I can’t make it tomorrow' (U+2019) detecta reschedule", isRescheduleRequest("I can’t make it tomorrow"));
ck("'I can’t tomorrow' (U+2019) detecta reschedule", isRescheduleRequest("I can’t tomorrow"));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
