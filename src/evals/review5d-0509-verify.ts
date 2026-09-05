/**
 * REVISÃO 5 DIAS 31/08–05/09/2026 — guardas dos achados. 100% determinístico:
 * sem modelo, sem banco.
 *
 * Casos reais:
 *  - Yusimi (WA 03/09): visita quinta 3pm; "Hi, is it possible to change it to
 *    5pm?" 2h38 antes → TOTAL SILENCE (o padrão de reschedule exigia um
 *    substantivo de visita depois do verbo).
 *  - Aida Álvarez (WA 01/09): visita terça 3pm; "Hola buenas tardes podrías
 *    pasar a las 5:00 por favor es que me olvidé de una cita que tenía" 1h
 *    antes → TOTAL SILENCE; perdeu a visita e passou 3 dias confusa, muda.
 *  - Cleveland Thomas (WA 02/09): segundos após o [BOOK] de quinta 8pm disse
 *    "If anything changes and you have a eailer time - please let me know." →
 *    o modo reschedule abriu, o modelo leu a quinta (cheia por causa da vaga
 *    DELE) como "fully booked" e o empurrou para sexta 9am.
 *  - fb_115760b0 "I do not", fb_663bfb02 "No", fb_d5868fe8 "I have no house.",
 *    fb_94076582 "no thanks"×2 + "Don't knt" → todos levaram o opener enlatado.
 *  - fb_28139031199080435 / fb_28089475887328093 / fb_26749299551427986: o
 *    MESMO botão de FAQ re-enviado 1–4 dias depois ficou MUDO (pendência da
 *    revisão semanal 03/09, agora fechada com re-resposta determinística).
 *
 * Run: npx tsx src/evals/review5d-0509-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  isRescheduleRequest,
  isConditionalEarlierRequest,
  stripConditionalEarlier,
  isFirstContactRejection,
  cannedFaqReanswer,
} from "../lib/ai";
import { earlierSlotAckMessage } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

console.log("\n━━ 1. isRescheduleRequest: mudar só com hora, sem substantivo ━━");
{
  const positivos = [
    "Hi, is it possible to change it to 5pm?", // Yusimi, literal
    "Hola buenas tardes podrías pasar a las 5:00 por favor es que me olvidé de una cita que tenía", // Aida, literal
    "Can we move it to Friday?",
    "change it to 5",
    "puede venir a la 1?",
    "pode passar às 5?",
    "podrías venir más tarde?",
    "can you come earlier?",
  ];
  for (const p of positivos) ck(`pega: ${JSON.stringify(p.slice(0, 52))}`, isRescheduleRequest(p));
  const negativos = [
    "Thank you.",
    "Perfect sounds good Thank you",
    "Wednesday at 1pm",
    "Nos vemos a las 5",
    "Ok gracias hasta mañana",
    "Can you make it possible to go cheaper",
    "See you at 5, thanks!",
  ];
  for (const n of negativos) ck(`NÃO pega: ${JSON.stringify(n.slice(0, 52))}`, !isRescheduleRequest(n));
  ck("regressão: 'I need to reschedule' continua pegando", isRescheduleRequest("I need to reschedule"));
  ck("regressão: 'please cancel the appointment' continua pegando", isRescheduleRequest("please cancel the appointment"));
  ck("regressão: \"I can't tomorrow\" continua pegando", isRescheduleRequest("I can't tomorrow"));
}

console.log("\n━━ 2. Pedido condicional 'se abrir mais cedo me avisa' (Cleveland) ━━");
{
  const cleveland = "If anything changes and you have a eailer time - please let me know. Thank you.";
  ck("frase literal do Cleveland é condicional", isConditionalEarlierRequest(cleveland));
  ck("resto da rajada do Cleveland NÃO é remarcação", !isRescheduleRequest(stripConditionalEarlier(cleveland)), stripConditionalEarlier(cleveland));
  ck("'let me know if anything earlier opens up' é condicional", isConditionalEarlierRequest("let me know if anything earlier opens up"));
  ck("'keep me posted if a slot frees up' é condicional", isConditionalEarlierRequest("keep me posted if a slot frees up"));
  ck("'si se abre algo más temprano me avisas' é condicional", isConditionalEarlierRequest("si se abre algo más temprano me avisas"));
  ck("'can we do an earlier time?' NÃO é condicional (remarcação real)", !isConditionalEarlierRequest("can we do an earlier time?"));
  ck("'I need to reschedule' NÃO é condicional", !isConditionalEarlierRequest("I need to reschedule"));
  const misto = "Can we move it to Friday? If anything earlier opens up let me know.";
  ck("misto: condicional detectado", isConditionalEarlierRequest(misto));
  ck("misto: depois do strip a remarcação REAL sobrevive", isRescheduleRequest(stripConditionalEarlier(misto)), stripConditionalEarlier(misto));
  const ack = earlierSlotAckMessage("en", "2026-09-03", "20:00");
  ck("ack EN restata a visita real (Thursday, September 3 at 8pm)", ack.includes("Thursday, September 3 at 8pm") && ack.startsWith("Will do!"), ack);
  const ackEs = earlierSlotAckMessage("es", "2026-09-04", "09:00");
  ck("ack ES sem ¿/¡ e com a visita real", !/[¿¡]/.test(ackEs) && ackEs.includes("viernes 4 de septiembre") && ackEs.includes("9am"), ackEs);
}

console.log("\n━━ 3. fonte: 3 webhooks interceptam o condicional ANTES do reschedule ━━");
for (const [name, file] of [
  ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
  ["Messenger", "src/app/api/fb-webhook/route.ts"],
  ["Instagram", "src/app/api/webhook/route.ts"],
] as const) {
  const s = src(file);
  const iCond = s.indexOf("isConditionalEarlierRequest(condText) && !isRescheduleRequest(stripConditionalEarlier(condText))");
  ck(`[${name}] intercepta condicional (fixo + restate, sem modo reschedule)`, iCond > 0);
  const iVisitQ = s.indexOf("isVisitDetailQuestion(rawText)");
  ck(`[${name}] intercepto roda ANTES do branch de pergunta de visita`, iCond > 0 && iVisitQ > 0 && iCond < iVisitQ);
  ck(`[${name}] ack usa earlierSlotAckMessage com a visita real`, s.includes("earlierSlotAckMessage(detectLang(condText), bookedVisit.date, bookedVisit.time)"));
}

console.log("\n━━ 4. Rejeição de 1º contato: negativas nuas + rejeição pegajosa ━━");
{
  const positivos = [
    "I do not",
    "No I don't thanks",
    "I have no house.",
    "no thanks\nno thanks\nDon't knt", // fb_94076582: gibberish não reabre
    "No I don't thanks\nNo",           // fb_663bfb02
    "No",
  ];
  for (const p of positivos) ck(`silencia: ${JSON.stringify(p.slice(0, 44))}`, isFirstContactRejection(p));
  const negativos = [
    "I don't need floors but do you do stairs?",   // pergunta = interesse
    "no thanks but how much is vinyl?",            // preço = interesse
    "I do not want vinyl, I want tile",            // tipo nomeado = interesse
    "Don't knt",                                    // sozinho não é rejeição
    "no thanks\nactually I want the estimate",     // afirmação de interesse
    "no thanks\ncall me at 305-555-1234",          // booking info
  ];
  for (const n of negativos) ck(`NÃO silencia: ${JSON.stringify(n.slice(0, 44))}`, !isFirstContactRejection(n));
}

console.log("\n━━ 5. FAQ repetida dias depois → re-resposta determinística ━━");
{
  const q = "what is the installation process?";
  const hist = (n: number) => {
    const ms: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < n; i++) {
      ms.push({ role: "user", content: q });
      if (i < n - 1) ms.push({ role: "assistant", content: `resposta ${i}` });
    }
    return ms;
  };
  const r3 = cannedFaqReanswer(q, hist(3));
  ck("3º ask: responde (nunca silêncio)", !!r3 && /furniture/i.test(r3!) && /2 to 3 days/i.test(r3!), r3 ?? "null");
  ck("3º ask: pergunta o tipo (conversa sem tipo)", !!r3 && /tile, vinyl, or hardwood/i.test(r3!), r3 ?? "null");
  const r4 = cannedFaqReanswer(q, hist(4));
  ck("lead-in rotativo: 3º e 4º ask têm aberturas diferentes (anti-dup)", !!r3 && !!r4 && r3 !== r4, `${r3} ||| ${r4}`);
  const es = cannedFaqReanswer("cómo es el proceso de instalación", [
    { role: "user", content: "cómo es el proceso de instalación" },
    { role: "assistant", content: "respuesta" },
    { role: "user", content: "cómo es el proceso de instalación" },
  ]);
  ck("botão ES: responde em espanhol SEM ¿/¡", !!es && !/[¿¡]/.test(es!) && /muebles/.test(es!), es ?? "null");
  ck("pergunta fora das famílias de FAQ → null (segue ao modelo)", cannedFaqReanswer("what is your warranty?", hist(2)) === null);
  const discount = cannedFaqReanswer("do you offer any discounts for larger spaces?", [
    { role: "user", content: "do you offer any discounts for larger spaces?" },
    { role: "assistant", content: "yes" },
    { role: "user", content: "do you offer any discounts for larger spaces?" },
  ]);
  ck("família discount coberta", !!discount && /best pricing/i.test(discount!), discount ?? "null");
  const s = src("src/lib/ai.ts");
  const iFaq = s.indexOf("cannedFaqReanswer(lastText, messages)");
  const iFresh = s.indexOf("repeated question after a gap (or no timestamps)");
  ck("fonte: re-resposta roda ANTES do 'answering it fresh' (caminho que silenciava)", iFaq > 0 && iFresh > 0 && iFaq < iFresh);
}

console.log(`\n${"━".repeat(50)}\n${pass} ✅ | ${fail} ❌${fail ? "\nFALHAS: " + fails.join(" | ") : ""}`);
process.exit(fail ? 1 : 0);
