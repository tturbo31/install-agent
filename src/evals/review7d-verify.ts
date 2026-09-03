/**
 * REVISÃO SEMANAL 03/09/2026 — guardas dos 3 achados. 100% determinístico:
 * sem modelo, sem banco.
 *
 * Casos reais:
 *  - Josue Gonzalez (WA 29/08): "Saturday September 5th at 9am is locked in!"
 *    dito DURANTE a coleta de nome/endereço; o [BOOK] nunca gravou (re-ask de
 *    ZIP) e o cliente ficou 5 dias acreditando numa visita fantasma.
 *  - wa_13057903205 (01/09): "Thursday at 9am is locked in!" → 7h depois o
 *    slot tinha ido embora e o cliente desistiu ("Never mind").
 *  - Raul Gallon (WA 02/09): "llamaba para confirmar la cita que tengo mañana
 *    en siete 24 West Palmetto Park Road" (voz: "siete 24" = 724) caiu na
 *    correção de endereço ("anoté la dirección nueva") e depois "Pls confirm"
 *    ficou MUDO na véspera da visita.
 *
 *  1. softenPrematureLockIn: "locked in" vira "penciled in"; enlatados com
 *     "lock in your best price" intactos; conteúdo de [BOOK:...] protegido.
 *  2. Fonte: os 3 webhooks chamam softenPrematureLockIn gated em
 *     !booked && !isBookingConfirmed, ANTES do check de confirmação nua.
 *  3. isVisitDetailQuestion: "Pls confirm", "confirmar la cita", "Confirma?"
 *     → true; pergunta de preço com "confirm" → false.
 *  4. detectAddressCorrection: mesmo endereço com número de casa partido pela
 *     transcrição de voz ("siete 24" → house 24, booked 724) = null, não
 *     "moved"; rua diferente continua "moved"; troca de unidade intacta.
 * Run: npx tsx src/evals/review7d-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { softenPrematureLockIn, isVisitDetailQuestion } from "../lib/ai";
import { detectAddressCorrection } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

console.log("\n━━ 1. softenPrematureLockIn ━━");
{
  const r1 = softenPrematureLockIn("Saturday September 5th at 9am is locked in! Can I get your name and the property address (number, street and city) to hold that for you?");
  ck("'is locked in!' vira 'is penciled in!' e o resto fica igual", r1.includes("is penciled in!") && !/locked in/i.test(r1) && r1.includes("Can I get your name"), r1);
  const r2 = softenPrematureLockIn("Thursday at 9am is locked in! We're OzziFloors, based in Miami.");
  ck("caso wa_13057903205 coberto", r2.startsWith("Thursday at 9am is penciled in!"), r2);
  const canned = "For a project that size I do a free in-person visit, I measure everything, bring all the samples, and lock in your best price on the spot. What day works best for you?";
  ck("'lock in your best price' (enlatado) fica intacto", softenPrematureLockIn(canned) === canned);
  const future = "I'll lock that in as soon as I have your name and address.";
  ck("promessa futura 'I'll lock that in' fica intacta", softenPrematureLockIn(future) === future);
  const tagged = 'Perfect! [BOOK: {"notes":"client said locked in"}] See you then.';
  ck("conteúdo dentro de [BOOK:...] é protegido (não reescreve)", softenPrematureLockIn(tagged).includes('"client said locked in"'), softenPrematureLockIn(tagged));
  ck("'you're all locked in' também vira penciled in", /penciled in/.test(softenPrematureLockIn("You're all locked in for Saturday!")) && !/locked/i.test(softenPrematureLockIn("You're all locked in for Saturday!")));
}

console.log("\n━━ 2. fonte: 3 webhooks chamam a guarda gated ━━");
for (const [name, file, v] of [
  ["WhatsApp", "src/app/api/wa-webhook/route.ts", "afterBooking"],
  ["Messenger", "src/app/api/fb-webhook/route.ts", "afterBooking"],
  ["Instagram", "src/app/api/webhook/route.ts", "afterBookingText"],
] as const) {
  const s = src(file);
  const re = new RegExp(String.raw`if \(!booked && !isBookingConfirmed\) ${v} = softenPrematureLockIn\(${v}\);`);
  ck(`[${name}] softenPrematureLockIn gated em !booked && !isBookingConfirmed`, re.test(s));
  const softIdx = s.indexOf(`= softenPrematureLockIn(`);
  const bareIdx = s.indexOf(`isBarePreBookingText(${v})`);
  ck(`[${name}] roda ANTES do check de confirmação nua`, softIdx > 0 && bareIdx > 0 && softIdx < bareIdx);
}

console.log("\n━━ 3. isVisitDetailQuestion: pedido de confirmação ES/bare ━━");
{
  ck("'Pls confirm' → true", isVisitDetailQuestion("Pls confirm"));
  ck("'Please confirm.' → true", isVisitDetailQuestion("Please confirm."));
  ck("'Confirma?' → true", isVisitDetailQuestion("Confirma?"));
  ck("'llamaba para confirmar la cita que tengo mañana...' → true", isVisitDetailQuestion("Hola, llamaba para confirmar la cita que tengo mañana en siete 24 West Palmetto Park Road"));
  ck("'pode confirmar a visita?' (PT) → true", isVisitDetailQuestion("pode confirmar a visita?"));
  ck("'can you confirm the price for 300 sqft?' → false (não é sobre a visita)", !isVisitDetailQuestion("can you confirm the price for 300 sqft?"));
}

console.log("\n━━ 4. detectAddressCorrection: número de casa partido pela voz ━━");
{
  const booked = "724 W Palmetto Park Rd, Boca Raton FL 33486";
  ck("'siete 24 West Palmetto Park Road' vs 724 → null (mesmo endereço falado)",
    detectAddressCorrection("Hola, llamaba para confirmar la cita que tengo mañana en siete 24 West Palmetto Park Road", booked) === null);
  const moved = detectAddressCorrection("actually the visit is at 500 W Palmetto Park Rd, Boca Raton", booked);
  ck("500 na mesma rua (não é sufixo de 724) → continua 'moved'", moved?.kind === "moved", JSON.stringify(moved));
  const other = detectAddressCorrection("we moved to 123 Ocean Drive, Miami Beach", booked);
  ck("rua diferente → continua 'moved'", other?.kind === "moved", JSON.stringify(other));
  const unit = detectAddressCorrection("sorry it's apt 210", "220 Foxtail Drive Apt B, Greenacres FL 33415");
  ck("correção de unidade continua funcionando", unit?.kind === "unit" && unit.unit === "210", JSON.stringify(unit));
  ck("mesmo endereço repetido igual → null", detectAddressCorrection("724 W Palmetto Park Rd, Boca Raton FL 33486", booked) === null);
}

console.log(`\n${pass} ✅  ${fail} ❌`);
if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
