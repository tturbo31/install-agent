/**
 * DESCULPA DO HORÁRIO QUE ENCHEU: uma vez basta (caso Alejandro Trigoso, WA 19/09/2026).
 *
 * Puro (sem modelo). Os 3 casos reais dos últimos 30 dias estão aqui:
 *   A. Alejandro (19/09) — ouviu a desculpa, respondeu "Tuesday", e levou a
 *      MESMA primeira frase de novo. É o único repeat indevido do período.
 *   B. Cleveland (02/09) — re-perguntou "are you coming tomorrow at 11 am";
 *      a desculpa TEM que repetir (o cliente reabriu o horário morto).
 *   C. Marguerite (27-28/08) — "Is someone still going"; idem, repete.
 *
 * Prova:
 *  1. parseSlotGoneApology: reconhece a desculpa (EN/ES/PT), acha a região de
 *     cláusulas a remover, e recusa desculpa genérica / desculpa depois da oferta.
 *  2. stripRepeatedSlotApology: apaga só as cláusulas da desculpa repetida,
 *     mantém a oferta, capitaliza o resto, nunca devolve vazio, protege tags.
 *  3. Nunca apaga a PRIMEIRA desculpa, nem desculpa de OUTRO horário perdido,
 *     nem quando o cliente retoma o horário morto.
 *  4. slotApologyAlreadyGivenNote: nota dinâmica com as mesmas regras.
 *  5. Os 3 webhooks carregam a nota e o backstop, e o backstop não roda em
 *     turno com visita gravada (booked).
 * Run: npx tsx src/evals/slot-apology-repeat-verify.ts
 */
import { parseSlotGoneApology, stripRepeatedSlotApology, slotApologyAlreadyGivenNote } from "../lib/ai";
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string) => ({ role: "user" as const, content: c });
const A = (c: string) => ({ role: "assistant" as const, content: c });

console.log("\n━━ 1. parseSlotGoneApology ━━");
const pA = parseSlotGoneApology("I'm sorry, that Sunday 3pm filled up while we were talking.");
ck("Alejandro: reconhece, times={3pm}, days={dom}", !!pA && pA.times.has("3pm") && pA.days.has(0), JSON.stringify(pA && [...pA.times]));
ck("Alejandro: região = as 2 cláusulas (nada sobra)", !!pA && pA.goneClauseIdx === 1 && pA.clauses.length === 2);
const pM = parseSlotGoneApology("I'm sorry Marguerite, that 2pm filled up since we spoke, the closest I have now is Sunday the 30th at 11am or 2pm, which works better for you?");
ck("Marguerite: desculpa é CLÁUSULA, oferta fica depois", !!pM && pM.goneClauseIdx === 1 && pM.clauses.length === 4);
ck("Marguerite: times={2pm}, sem weekday na região", !!pM && pM.times.has("2pm") && pM.times.size === 1 && pM.days.size === 0);
const pC = parseSlotGoneApology("I'm sorry Cleveland, 11am on Thursday is no longer open since we were talking.");
ck("Cleveland: 'no longer open' conta como horário perdido", !!pC && pC.times.has("11am") && pC.days.has(4));
ck("ES: 'Lo siento, ese domingo a las 3pm ya se ocupo'", !!parseSlotGoneApology("Lo siento, ese domingo a las 3pm ya se ocupo."));
ck("PT: 'Desculpa, aquele sabado as 3pm encheu'", !!parseSlotGoneApology("Desculpa, aquele sabado as 3pm encheu."));
ck("PT com acento: 'Desculpe, esse sábado às 15h já foi ocupado'", !!parseSlotGoneApology("Desculpe, esse sábado às 3pm já foi ocupado."));
ck("desculpa genérica NÃO é desculpa de horário", !parseSlotGoneApology("I'm sorry for the back and forth, let me fix this right now."));
ck("desculpa DEPOIS da oferta é preservada", !parseSlotGoneApology("I have Monday at 5pm or 6pm, sorry that Sunday 3pm filled up."));
ck("sem desculpa nenhuma → null", !parseSlotGoneApology("For Tuesday the 22nd I have 2pm or 8pm, which works better?"));

console.log("\n━━ 2. Caso A (Alejandro 19/09) — o repeat sai, a oferta fica ━━");
const alejandro = [
  U("3 pm"),
  A("Perfect, I'm holding that 3pm for you! Can I get the full property address with the zip code?"),
  U("17474 sw 272 st"),
  A("Almost set! What's the zip code for that address?"),
  U("Ok 33031"),
  A("I'm sorry, that Sunday 3pm filled up while we were talking. The soonest I have now is Monday the 21st at 5pm or 6pm, which works better?"),
  U("Teresa"),
  U("Tuesday"),
];
const repeatA = "I'm sorry, that Sunday 3pm filled up while we were talking. For Tuesday the 22nd I have 2pm or 8pm, which works better?";
const outA = stripRepeatedSlotApology(repeatA, alejandro);
console.log("   →", outA);
ck("desculpa repetida removida", !/sorry/i.test(outA), outA);
ck("oferta de terça INTACTA (2pm e 8pm)", /Tuesday the 22nd/.test(outA) && /2pm/.test(outA) && /8pm/.test(outA), outA);
ck("resultado começa maiúsculo e não fica vazio", /^For Tuesday/.test(outA));
ck("nota dinâmica dispara para esse histórico", !!slotApologyAlreadyGivenNote(alejandro));
ck("nota manda responder o dia pedido sem repetir a desculpa", /Do NOT open this reply by apologizing for that lost time again/.test(slotApologyAlreadyGivenNote(alejandro) ?? ""));

console.log("\n━━ 3. Caso B (Cleveland 02/09) e C (Marguerite 28/08) — a desculpa REPETE ━━");
const cleveland = [
  A("I'm sorry Cleveland, 11am on Thursday is no longer open since we were talking. The only time I have left on Thursday September 3 is 8pm. Would that work, or would you prefer Friday September 4 at 9am or 1pm?"),
  U("Hello my friend are you coming tomorrow at 11 am"),
];
const repeatB = "I'm sorry Cleveland, the 11am on Thursday filled up while we were talking. The only time left on Thursday September 3 is 8pm, or I have Friday September 4 at 9am or 1pm. Which works better for you?";
ck("Cleveland re-pergunta pelo 11am → desculpa mantida", stripRepeatedSlotApology(repeatB, cleveland) === repeatB);
ck("Cleveland: nota dinâmica NÃO dispara", slotApologyAlreadyGivenNote(cleveland) === null);

const marguerite = [
  A("I'm sorry, that Thursday 2pm filled up while we were talking, the closest I have is Friday August 28th at 2pm or 3pm, which works better for you Marguerite?"),
  U("Is someone still going"),
];
const repeatC = "I'm sorry Marguerite, that 2pm filled up since we spoke, the closest I have now is Sunday the 30th at 11am or 2pm, which works better for you?";
ck("Marguerite pergunta se alguém ainda vai → desculpa mantida", stripRepeatedSlotApology(repeatC, marguerite) === repeatC);
ck("Marguerite: nota dinâmica NÃO dispara", slotApologyAlreadyGivenNote(marguerite) === null);

console.log("\n━━ 3b. Cliente irritado / desconfiado: a desculpa continua viva ━━");
const scam = [
  A("I'm sorry, that Sunday 5pm filled up while we were talking. The soonest I have open is Tuesday at 9am or 11am, which works better for you?"),
  U("It now 5:10 pm"),
  A("I understand, let me check with the team right now."),
  U("No. I don't trust this. Is this a scam"),
];
const scamReply = "I'm sorry, that Sunday 5pm filled up while we were talking. OzziFloors is a real licensed flooring company in Miami, and I can have Ozzi call you at (561) 674-8334.";
ck('"is this a scam" → desculpa mantida', stripRepeatedSlotApology(scamReply, scam) === scamReply, stripRepeatedSlotApology(scamReply, scam));
ck('"is this a scam" → nota NÃO dispara', slotApologyAlreadyGivenNote(scam) === null);
const wasting = [
  A("I'm sorry, that Thursday 2pm filled up while we were talking, the closest I have is Friday at 2pm or 3pm, which works better?"),
  U("You are wasting people time"),
];
ck('"wasting people time" → nota NÃO dispara', slotApologyAlreadyGivenNote(wasting) === null);
const ninguem = [
  A("I'm sorry, that Monday 3pm filled up while we were talking. The soonest I have open is Wednesday at 9am, does that work?"),
  U("nobody came"),
];
ck('"nobody came" → nota NÃO dispara (a regra 38 manda ali)', slotApologyAlreadyGivenNote(ninguem) === null);

console.log("\n━━ 4. Nunca apaga o que é notícia ━━");
ck("PRIMEIRA desculpa (sem desculpa anterior) passa inteira",
  stripRepeatedSlotApology(repeatA, [U("Ok 33031")]) === repeatA);
const outroHorario = [
  A("I'm sorry, that Sunday 3pm filled up while we were talking. The soonest I have now is Monday the 21st at 5pm or 6pm, which works better?"),
  U("Monday 5pm"),
];
const novaPerda = "I'm sorry, that Monday 5pm filled up while we were talking. For Tuesday the 22nd I have 2pm or 8pm, which works better?";
ck("OUTRO horário perdido → desculpa nova é preservada", stripRepeatedSlotApology(novaPerda, outroHorario) === novaPerda, stripRepeatedSlotApology(novaPerda, outroHorario));
const mesmaHoraOutroDia = [
  A("I'm sorry, that Sunday 3pm filled up while we were talking. The soonest I have now is Wednesday the 23rd at 3pm or 5pm, which works better?"),
  U("Wednesday 3pm"),
];
const quartaMorreu = "I'm sorry, that Wednesday 3pm filled up while we were talking. For Thursday the 24th I have 9am or 11am, which works better?";
ck("mesma HORA em outro DIA → preservada (3pm domingo ≠ 3pm quarta)", stripRepeatedSlotApology(quartaMorreu, mesmaHoraOutroDia) === quartaMorreu, stripRepeatedSlotApology(quartaMorreu, mesmaHoraOutroDia));
const soDesculpa = "I'm sorry, that Sunday 3pm filled up while we were talking.";
ck("desculpa é a mensagem INTEIRA → nunca vira vazio", stripRepeatedSlotApology(soDesculpa, alejandro) === soDesculpa);
ck("texto sem desculpa nenhuma passa igual",
  stripRepeatedSlotApology("For Tuesday the 22nd I have 2pm or 8pm, which works better?", alejandro) === "For Tuesday the 22nd I have 2pm or 8pm, which works better?");

console.log("\n━━ 5. Cláusula removida sem comer a oferta (forma Marguerite) ━━");
const margRepeat = [
  A("I'm sorry, that Thursday 2pm filled up while we were talking, the closest I have is Friday August 28th at 2pm or 3pm, which works better for you?"),
  U("what about saturday"),
];
const margOut = stripRepeatedSlotApology("I'm sorry, that Thursday 2pm filled up since we spoke, the closest I have now is Sunday the 30th at 11am or 2pm, which works better for you?", margRepeat);
console.log("   →", margOut);
ck("cláusula da desculpa some, oferta continua na MESMA frase", !/sorry/i.test(margOut) && /Sunday the 30th at 11am or 2pm/.test(margOut), margOut);
ck("capitalizou o resto da frase", /^The closest I have now/.test(margOut), margOut);

console.log("\n━━ 6. Tags protegidas ━━");
const comTag = "I'm sorry, that Sunday 3pm filled up while we were talking. Perfect, see you then! [BOOK:{\"date\":\"2026-09-22\",\"time\":\"17:00\",\"name\":\"\",\"phone\":\"17864439815\",\"address\":\"17474 SW 272 St, 33031\"}]";
const comTagOut = stripRepeatedSlotApology(comTag, alejandro);
ck("[BOOK] sobrevive inteiro ao scrubber", /\[BOOK:\{"date":"2026-09-22","time":"17:00"/.test(comTagOut), comTagOut);
ck("[NOTIFY_OWNER] sobrevive", /\[NOTIFY_OWNER\]/.test(stripRepeatedSlotApology(repeatA.replace(/\?$/, "?[NOTIFY_OWNER]"), alejandro)));

console.log("\n━━ 7. Os 3 webhooks ━━");
for (const [nome, arq] of [["IG", "src/app/api/webhook/route.ts"], ["WhatsApp", "src/app/api/wa-webhook/route.ts"], ["Messenger", "src/app/api/fb-webhook/route.ts"]] as const) {
  const src = readFileSync(join(process.cwd(), arq), "utf-8");
  ck(`${nome}: importa as duas funções`, /slotApologyAlreadyGivenNote/.test(src) && /stripRepeatedSlotApology/.test(src));
  ck(`${nome}: nota entra em systemParts`, /const slotApologyNote = slotApologyAlreadyGivenNote\(messagesForAI\);\s*\r?\n\s*if \(slotApologyNote\) systemParts\.push\(slotApologyNote\);/.test(src));
  ck(`${nome}: backstop roda antes do envio e pula turno com visita gravada`, /if \(!booked\) \{\s*\r?\n\s*const semRepeticao = stripRepeatedSlotApology\((afterBooking|afterBookingText), messagesForAI\);/.test(src));
  ck(`${nome}: backstop entra ANTES do processCancelCommand (com os outros reescritores de prosa)`,
    src.indexOf("const semRepeticao = stripRepeatedSlotApology(") < src.indexOf("const afterCancel = await processCancelCommand(") &&
    src.indexOf("const semRepeticao = stripRepeatedSlotApology(") > src.indexOf("const bookingStep = await processBookingCommand("));
  // owner-direct-verify (14/09) fixa esta linha por regex: o redirect da promessa
  // do dono tem que ser o último passo antes do envio. O scrubber novo entra antes.
  ck(`${nome}: cadeia final do redirect da promessa do dono intacta`, /stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\)/.test(src));
}

console.log("\n━━ 8. A regra 'ONE EXCEPTION' continua no contexto de agenda ━━");
const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
ck("scheduler ainda manda ASSUMIR o horário perdido na primeira vez", /ONE EXCEPTION, and it is mandatory/.test(sched) && /filled up/.test(sched));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
