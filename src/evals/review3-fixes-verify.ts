/**
 * REGRESSION GUARD for the 2026-07-17 three-day review (Jul 15–17, all channels).
 * Each case reproduces a REAL production failure found in that review:
 *
 *  A. "El martes Está bien gracias" (slot pick + thanks) was silenced as a pure
 *     closing — the Tuesday visit was never booked (fb_26322579897413190).
 *  B. "I need to cancel" from a booked client got the RESCHEDULE-mode note
 *     ("client wants to MOVE the visit") → model pushed invented slots, called
 *     the client by the wrong name, never emitted [CANCEL_BOOKING] (Priscilla).
 *  C. Two real Meta quick-replies escaped the FAQ router (8 leads / 3 days):
 *     "Is installation cost included in the price?" and "What type of materials
 *     are included?" — and when the ad tag arrives AFTER the question (separate
 *     bubbles), the FAQ matcher missed the question entirely (Joan Caruso).
 *  D. The model wrote the literal "pending" as the address to slip past the
 *     empty-address check — a Sunday visit existed with nowhere to go.
 *
 * ZERO API CALLS: deterministic paths and pure helpers only.
 * Run: npx tsx src/evals/review3-fixes-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isPureClosing, isPureClosingBurst, isCancelRequest, getAIResponse, stripReasoningLeak, scrubForeignPhones } from "../lib/ai";

// .env.local: o teste v5 (500+ sqft no burst) cai corretamente no MODELO (não no
// opener enlatado), então precisa da chave real — 1 chamada barata.
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
import { isRealAddress, needAddressMessage } from "../lib/scheduler";
import { WHAT_IS_INCLUDED_ASK_TYPE, OPENER_DISCOUNT_EN, OPENER_PROCESS_EN } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 180)}»`); }
}
const U = (content: string) => ({ role: "user" as const, content });
const A = (content: string) => ({ role: "assistant" as const, content });

async function main() {
  console.log("\n=========== REVIEW3-FIXES VERIFY (revisão de 3 dias, 2026-07-17) ===========");

  console.log("\n[A] Escolha de dia/hora + 'gracias' NUNCA é encerramento");
  ck("'El martes Está bien gracias' NÃO é closing", !isPureClosing("El martes Está bien gracias"));
  ck("'Tuesday works, thanks!' NÃO é closing", !isPureClosing("Tuesday works, thanks!"));
  ck("'ok 3pm thanks' NÃO é closing", !isPureClosing("ok 3pm thanks"));
  ck("'Ok thank you' AINDA é closing", isPureClosing("Ok thank you"));
  ck("'Thanks, see you then!' AINDA é closing", isPureClosing("Thanks, see you then!"));
  ck("'Obrigado!' AINDA é closing", isPureClosing("Obrigado!"));
  // O caso real: burst terminando na escolha+gracias não pode ser silenciado.
  ck("burst real (oferta lunes/martes → 'El martes Está bien gracias') NÃO é pure-closing burst", !isPureClosingBurst([
    A("Tengo el lunes 20 a la 1pm o el martes 21 a la 1pm, ¿cuál te queda mejor?"),
    U("El martes Está bien gracias"),
  ]));

  console.log("\n[B] Cancel de agendado recebe a nota certa (não a de remarcação)");
  ck("isCancelRequest: 'I need to cancel'", isCancelRequest("I need to cancel"));
  ck("isCancelRequest: 'necesito cancelar la cita'", isCancelRequest("necesito cancelar la cita"));
  ck("isCancelRequest: 'preciso desmarcar'", isCancelRequest("preciso desmarcar"));
  ck("isCancelRequest: NÃO para 'can we reschedule to Friday?'", !isCancelRequest("can we reschedule to Friday?"));
  ck("isCancelRequest: NÃO para 'what time will you arrive?'", !isCancelRequest("what time will you arrive?"));
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: nota condicional CANCEL INTENT presente`, /isCancelRequest\(rawText\)\s*\n?\s*\? "\[RESCHEDULE MODE, CANCEL INTENT/.test(src), rel);
    ck(`${name}: nota de cancel exige [CANCEL_BOOKING] e proíbe slot inventado`, /end with \[CANCEL_BOOKING\]/.test(src) && /NEVER state or assume a day or time they did not pick/.test(src), rel);
    ck(`${name}: nota de RESCHEDULE clássica preservada`, /\[RESCHEDULE MODE: This client already has a confirmed visit and wants to MOVE it/.test(src), rel);
  }

  console.log("\n[C] Variantes de FAQ mapeadas + burst com tag do ad depois da pergunta");
  const NOTE = "\n\n[SYSTEM: TODAY: Friday, July 17, 2026 [2026-07-17].]";
  const v1 = await getAIResponse([U("Is installation cost included in the price?" + NOTE)], null, null, null, false);
  ck("'Is installation cost included in the price?' → ASK_TYPE (0 tokens)", v1.text === WHAT_IS_INCLUDED_ASK_TYPE && v1.inputTokens === 0, v1.text);
  const v2 = await getAIResponse([U("What type of materials are included?" + NOTE)], null, null, null, false);
  ck("'What type of materials are included?' → ASK_TYPE (0 tokens)", v2.text === WHAT_IS_INCLUDED_ASK_TYPE && v2.inputTokens === 0, v2.text);
  // Ordem invertida (caso Joan Caruso): pergunta primeiro, tag do ad por último.
  const v3 = await getAIResponse([
    U("Do you offer any discounts for larger spaces?"),
    U("[Client replied to our ad]" + NOTE),
  ], null, null, null, false);
  ck("pergunta ANTES do tag do ad → ainda recebe o opener de desconto", v3.text === OPENER_DISCOUNT_EN && v3.inputTokens === 0, v3.text);
  const v4 = await getAIResponse([
    U("What is the installation process?"),
    U("[Client replied to our ad]" + NOTE),
  ], null, null, null, false);
  ck("'installation process' antes do tag → opener de processo", v4.text === OPENER_PROCESS_EN && v4.inputTokens === 0, v4.text);
  // Metragem grande num bubble anterior também conta (burst inteiro).
  const v5 = await getAIResponse([
    U("I have 2500 sqft to do"),
    U("[Client replied to our ad]" + NOTE),
  ], null, null, null, false);
  ck("500+ sqft num bubble anterior → NÃO recebe opener enlatado", v5.text !== OPENER_DISCOUNT_EN && v5.text !== OPENER_PROCESS_EN && !/Hi, we work with luxury vinyl, tile, and hardwood flooring/.test(v5.text), v5.text.slice(0, 80));

  console.log("\n[D] Endereço placeholder nunca agenda");
  ck("'pending' é rejeitado", !isRealAddress("pending"));
  ck("'TBD' é rejeitado", !isRealAddress("TBD"));
  ck("'N/A' é rejeitado", !isRealAddress("N/A"));
  ck("'will send later' é rejeitado", !isRealAddress("will send later"));
  ck("'Edgewater, Miami' (sem número) é rejeitado", !isRealAddress("Edgewater, Miami"));
  ck("vazio/null é rejeitado", !isRealAddress("") && !isRealAddress(null) && !isRealAddress(undefined));
  ck("'10990 sw 225 ter' é aceito", isRealAddress("10990 sw 225 ter"));
  ck("'123 NW 5th St, Miami FL 33125' é aceito", isRealAddress("123 NW 5th St, Miami FL 33125"));
  ck("'6247 SW 139 Ave, Miami FL' é aceito", isRealAddress("6247 SW 139 Ave, Miami FL"));
  ck("'12850 SW 119 Street, Kendall FL' é aceito", isRealAddress("12850 SW 119 Street, Kendall FL"));
  ck("needAddressMessage EN pede endereço", /full property address/i.test(needAddressMessage("en")));
  ck("needAddressMessage ES pede endereço", /direcci[oó]n completa/i.test(needAddressMessage("es")));
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    // Desde 2026-08-01 a mesma guarda também exige o número da casa
    // (addressHasStreetNumber) — por isso o `if` aceita condições extras.
    ck(`${name}: usa isRealAddress + needAddressMessage`, /if \(!isRealAddress\(bookingData\.address\)[^)]*\)?[^{]*\)\s*\{/.test(src) && /needAddressMessage\(lang\)/.test(src), rel);
  }

  console.log("\n[E] Vazamento de raciocínio em ESPANHOL/PORTUGUÊS (pego pelo E2E ao vivo)");
  const leakES = "El cliente eligió el lunes pero no especificó la hora, necesito confirmar cuál de las dos prefiere antes de pedir los datos. Perfecto, ¿a las 9am o a la 1pm cuál te queda mejor?";
  const cleanES = stripReasoningLeak(leakES);
  ck("frase 'El cliente eligió...' é removida", !/el cliente eligi/i.test(cleanES), cleanES);
  ck("a pergunta real ao cliente sobrevive", /Perfecto, ¿a las 9am/i.test(cleanES), cleanES);
  const leakPT = "O cliente escolheu segunda mas não especificou a hora. Perfeito, ¿9am ou 1pm?";
  ck("versão PT 'O cliente escolheu...' é removida", !/o cliente escolheu/i.test(stripReasoningLeak(leakPT)), stripReasoningLeak(leakPT));
  // Frases legítimas ao cliente NÃO podem ser cortadas:
  for (const legit of [
    "¡Perfecto! Solo me falta confirmar el día y la hora, ¿cuál te queda mejor para la visita?",
    "Necesito ir a medir en persona para darte el mejor precio, la visita es gratis.",
    "Perfecto, ¿a las 9am o a la 1pm, cuál te queda mejor?",
  ]) ck(`legítima intacta: "${legit.slice(0, 44)}…"`, stripReasoningLeak(legit) === legit, stripReasoningLeak(legit));

  console.log("\n[F] Nenhum telefone além do (561) 674-8334 sai em mensagem");
  const echoed = "No worries at all, I'll have Ozzi reach out to you directly at 3057668885 shortly!";
  const scrubbed = scrubForeignPhones(echoed);
  ck("número do cliente ecoado é removido (caso Rezashahid)", !/3057668885/.test(scrubbed), scrubbed);
  ck("a frase sobrevive legível", /I'll have Ozzi reach out to you directly shortly!/.test(scrubbed), scrubbed);
  ck("número oficial (561) 674-8334 é preservado", scrubForeignPhones("Call our team at (561) 674-8334 anytime!") === "Call our team at (561) 674-8334 anytime!");
  ck("formato +1 do oficial preservado", /674-8334/.test(scrubForeignPhones("Reach us at +1 (561) 674-8334.")));
  ck("outro número em formato (xxx) xxx-xxxx é removido", !/942-7955/.test(scrubForeignPhones("I'll call you at (305) 942-7955 soon.")));
  ck("[BOOK:{...phone...}] fica intacto", scrubForeignPhones('All set![BOOK:{"name":"x","phone":"3057668885","date":"2026-07-20","time":"09:00"}]').includes('"phone":"3057668885"'));
  ck("texto sem telefone passa intacto", scrubForeignPhones("Perfect, see you Monday at 9am!") === "Perfect, see you Monday at 9am!");
  ck("endereço com CEP não é confundido com telefone", scrubForeignPhones("Visit at 123 NW 5th St, Miami FL 33125 confirmed.") === "Visit at 123 NW 5th St, Miami FL 33125 confirmed.");
  const aiSrc2 = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("scrub ligado no pipeline de saída", /cleaned = scrubForeignPhones\(cleaned[,)]/.test(aiSrc2));
  ck("regra 11 proíbe ecoar o número do cliente", /not even the CLIENT'S OWN number back to them/.test(aiSrc2));

  console.log(`\n=========== REVIEW3-FIXES-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("review3-fixes-verify crashed:", e); process.exit(1); });
