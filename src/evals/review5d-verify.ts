/**
 * Guardas da revisão de 5 dias (27/07 → 01/08/2026).
 *
 * Cada seção trava um defeito REAL encontrado nas 595 conversas da janela:
 *  1. rajada com vários botões de FAQ da Meta respondia só UMA pergunta
 *  2. cliente agendado pedindo outra data ficava MUDO (caso Msleo, visita perdida)
 *  3. dia da semana × data errados no TEXTO da oferta (o [BOOK] já era guardado)
 *  4. pergunta enviada junto com os dados do agendamento morria no "Appointment confirmed"
 *  5. regras de disponibilidade vaga e de slot re-oferecido no prompt do scheduler
 *
 * Rodar: npx tsx src/evals/review5d-verify.ts
 */
import fs from "node:fs";
import path from "node:path";
import { composeAdFaqOpener, type AdFaqTopic } from "../lib/system-prompt";
import { isRescheduleRequest, questionSwallowedByBooking } from "../lib/ai";
import { reconcileOfferedDates } from "../lib/scheduler";

let pass = 0;
let fail = 0;
function ck(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const U = (c: string) => ({ role: "user", content: c });
const A = (c: string) => ({ role: "assistant", content: c });

// ── 1. Rajada multi-FAQ ─────────────────────────────────────────────────────
console.log("\n1) RAJADA COM VÁRIOS BOTÕES DE FAQ (17 de 24 vinham incompletas)");
{
  const two = composeAdFaqOpener(["process", "inclusions"], "en");
  ck("2 tópicos geram uma resposta combinada", !!two, String(two));
  ck(
    "responde o PROCESSO na combinada",
    !!two && /move all the furniture/i.test(two),
    String(two)
  );
  ck(
    "responde as INCLUSÕES na combinada (por tipo: vinyl material+labor+quarter round, tile/hardwood só labor)",
    !!two && /vinyl promo already includes/i.test(two) && /tile and hardwood cover the installation labor only/i.test(two),
    String(two)
  );
  ck(
    "termina pedindo o tipo (conta como o type-ask permitido: cita tile + hardwood)",
    !!two && /\btile\b/i.test(two) && /\bhardwood\b/i.test(two) && two.trim().endsWith("?"),
    String(two)
  );

  const three = composeAdFaqOpener(["inclusions", "discount", "process"], "en");
  ck(
    "3 tópicos: responde os três",
    !!three && /furniture/i.test(three) && /best pricing/i.test(three) && /vinyl promo already includes/i.test(three),
    String(three)
  );
  ck("3 tópicos: uma única pergunta no fim", (String(three).match(/\?/g) ?? []).length === 1, String(three));

  const es = composeAdFaqOpener(["process", "discount"], "es");
  ck("espanhol combina e abre com ¡", !!es && es.startsWith("¡") && /muebles/i.test(es) && /mejor precio/i.test(es), String(es));
  ck("espanhol pergunta com ¿ de abertura", !!es && /¿[^?]*\?/.test(es), String(es));

  ck("1 tópico só NÃO combina (mantém o opener já testado)", composeAdFaqOpener(["process"], "en") === null);
  ck("0 tópicos → null", composeAdFaqOpener([], "en") === null);

  // A ordem é fixa: as inclusões ficam por último porque emendam no type-ask.
  const ordered = composeAdFaqOpener(["inclusions", "location"], "en") ?? "";
  ck(
    "ordem fixa: localização antes das inclusões",
    ordered.indexOf("Miami") < ordered.indexOf("vinyl promo already includes"),
    ordered
  );

  const ai = fs.readFileSync(path.join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck(
    "a combinada é consultada ANTES da cadeia de tópico único",
    ai.indexOf("composeAdFaqOpener(topics, lang)") < ai.indexOf("if (AD_FAQ_PROCESS.test(burst)) {"),
    "a cadeia first-match-wins voltaria a engolir perguntas"
  );
}

// ── 2. Cliente agendado pedindo outra data ──────────────────────────────────
console.log("\n2) AGENDADO PEDINDO OUTRA DATA (caso Msleo 01/08: visita perdida)");
{
  const msleo =
    "Good morning Ozzi,\nI apologize for the inconvenience. I am still in Europe due to an accident and won't be able to travel until Monday.\nCould you please send another appointment so we can meet?\nThank you for your patience.";
  ck("a mensagem exata do Msleo abre o portão", isRescheduleRequest(msleo), msleo.slice(0, 60));
  for (const s of [
    "Could you please send another appointment so we can meet?",
    "can you set up another time?",
    "I need a different day please",
    "me puedes dar otra cita?",
    "I won't be able to make it",
    "I will not be able to be there on Tuesday",
    "no voy a estar en la casa ese dia",
  ]) {
    ck(`pega: ${JSON.stringify(s.slice(0, 46))}`, isRescheduleRequest(s));
  }
  // Não pode virar falso positivo em conversa normal.
  for (const s of [
    "What is the installation process?",
    "Do you offer any discounts for larger spaces?",
    "Thank you so much!",
    "yes that works",
    "My address is 123 NW 5th St, Miami FL 33125",
    "I have 1200 square feet of tile",
  ]) {
    ck(`NÃO pega: ${JSON.stringify(s.slice(0, 46))}`, !isRescheduleRequest(s));
  }
  // As guardas antigas continuam de pé.
  ck("regressão: 'I need to reschedule' continua pegando", isRescheduleRequest("I need to reschedule"));
  ck("regressão: 'please cancel the appointment' continua pegando", isRescheduleRequest("please cancel the appointment"));
  ck("regressão: \"I can't tomorrow\" continua pegando", isRescheduleRequest("I can't tomorrow"));
}

// ── 3. Dia da semana × data no TEXTO da oferta ──────────────────────────────
console.log("\n3) DIA DA SEMANA × DATA NA OFERTA (4 casos reais na janela)");
{
  // 2026: 30/07 = quinta, 31/07 = sexta, 02/08 = domingo, 03/08 = segunda.
  const c1 = reconcileOfferedDates(
    "Saturday is fully booked, but I have Thursday July 31 at 7pm or Sunday August 2 at 11am, which works for you?",
    "2026-07-29"
  );
  ck("John Schmidt: 'Thursday July 31' vira July 30", /Thursday July 30\b/.test(c1.text), c1.text);
  ck("John Schmidt: não mexe no 'Sunday August 2' que já estava certo", /Sunday August 2\b/.test(c1.text), c1.text);

  const c2 = reconcileOfferedDates("I have Friday July 31 at 7pm or Sunday August 3 at 11am, which works better for you?", "2026-07-29");
  ck("fcf81ab4: 'Sunday August 3' vira August 2", /Sunday August 2\b/.test(c2.text), c2.text);

  const c3 = reconcileOfferedDates("I have Sunday, August 3 at 1pm or 5pm, which works better for you?", "2026-07-30");
  ck("Christina Terron: 'Sunday, August 3' vira August 2", /Sunday, August 2\b/.test(c3.text), c3.text);

  // Nada pode ser tocado quando já está certo.
  for (const [today, text] of [
    ["2026-07-29", "I have Thursday July 30 at 7pm or Sunday August 2 at 11am"],
    ["2026-07-31", "Tengo el lunes 3 de agosto a las 5pm o el martes 4 de agosto a las 9am"],
    ["2026-08-01", "I have Saturday August 8th at 9am, 1pm, 3pm, or 5pm"],
    ["2026-08-01", "Friday August 7th works perfectly, would 9am or 11am be better?"],
    ["2026-08-01", "I have Friday at 7pm or Sunday at 11am, which works better for you?"],
  ] as const) {
    const r = reconcileOfferedDates(text, today);
    ck(`intocado (já correto): ${text.slice(0, 44)}…`, r.text === text && r.corrections.length === 0, r.corrections.join("; "));
  }

  // FORA da janela de 21 dias = data do CLIENTE sendo repetida, nunca reescrever.
  const outside = reconcileOfferedDates("Lunes 3 de octubre no lo tengo en mi calendario todavia", "2026-07-27");
  ck(
    "data fora da janela de 21 dias fica intocada (é a data que o cliente propôs)",
    outside.text === "Lunes 3 de octubre no lo tengo en mi calendario todavia",
    outside.text
  );
  const past = reconcileOfferedDates("I had you down for Monday July 6 at 9am", "2026-08-01");
  ck("data no passado fica intocada", past.corrections.length === 0, past.text);

  const wa = fs.readFileSync(path.join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  const fb = fs.readFileSync(path.join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8");
  const ig = fs.readFileSync(path.join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8");
  for (const [name, src] of [["IG", ig], ["FB", fb], ["WA", wa]] as const) {
    ck(`${name}: reconcileOfferedDates roda no texto de saída`, /reconcileOfferedDates\(safe/.test(src));
  }
}

// ── 4. Pergunta engolida pelo "Appointment confirmed" ───────────────────────
console.log("\n4) PERGUNTA ENGOLIDA PELA CONFIRMAÇÃO (Kenny Abbasi + Meylan, 31/07)");
{
  const kenny = questionSwallowedByBooking(
    'Yes, we do bathroom remodels as well, and Ozzi can price that out for you at the same visit. [BOOK:{"date":"2026-08-05","time":"15:00"}]',
    [
      A("Perfect, can I get your name, the property address, and the best phone number for the visit?"),
      U("Kenny Abbasi\n280 NE 34th St\nOakland Park, FL 33334"),
      U("561 723 2571"),
      U("Do you guys do bathrooms too?"),
    ]
  );
  ck("Kenny: a resposta sobre banheiro é preservada", !!kenny && /bathroom remodels/i.test(kenny), String(kenny));

  const meylan = questionSwallowedByBooking(
    'Sí, instalamos los rodapiés y van incluidos en el paquete. [BOOK:{"date":"2026-08-03","time":"17:00"}]',
    [A("¿Cuál te queda mejor para la visita?"), U("5 está bien !"), U("Ustedes ponen los rodapiés ??")]
  );
  ck("Meylan: a resposta sobre rodapé é preservada", !!meylan && /rodapi[eé]s/i.test(meylan), String(meylan));

  ck(
    "sem pergunta na rajada → null (fluxo de agendamento normal intocado)",
    questionSwallowedByBooking('Great, all set. [BOOK:{"date":"2026-08-03","time":"17:00"}]', [
      A("Can I get your name and address?"),
      U("Jorge Llapur"),
      U("17701 SW 92 Ave, Palmetto Bay, FL 33157"),
    ]) === null
  );
  ck(
    "query string de URL não é pergunta → null",
    questionSwallowedByBooking('Thanks for the link. [BOOK:{"date":"2026-07-29","time":"17:00"}]', [
      A("Can I get your name and the property address?"),
      U("Jared"),
      U("https://www.zillow.com/homedetails/21074-x/46505178_zpid/?utm_campaign=iosappmessage"),
    ]) === null
  );
  ck(
    "texto do modelo que só confirma/tem horário → null (nada compete com a confirmação)",
    questionSwallowedByBooking(
      'Perfect, Tuesday at 11am is locked in and I will notify you 40 minutes before. [BOOK:{"date":"2026-08-04","time":"11:00"}]',
      [A("What time works?"), U("11am"), U("Is that time still ok?")]
    ) === null
  );
  const noReask = questionSwallowedByBooking(
    'Yes, we install baseboards too. What is the best phone number for you? [BOOK:{"date":"2026-08-04","time":"11:00"}]',
    [A("Name and address?"), U("Bette, 251 S Cypress Rd, Pompano Beach FL 33060"), U("Do you install baseboards?")]
  );
  ck("nunca re-pergunta um dado já coletado", !!noReask && !/\?/.test(noReask), String(noReask));

  const ig = fs.readFileSync(path.join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8");
  const fb = fs.readFileSync(path.join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8");
  const wa = fs.readFileSync(path.join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  for (const [name, src] of [["IG", ig], ["FB", fb], ["WA", wa]] as const) {
    ck(`${name}: a confirmação vai DEPOIS da resposta pendente`, /questionSwallowedByBooking\(aiResponse, history\)/.test(src));
    // Since 2026-08-25 the confirmation restates the booked day/time, so the
    // call carries the booking's date and time (never the model's).
    ck(`${name}: a frase canônica da confirmação continua intacta`, /bookingSuccessMessage\(lang(?:, bookingData\.date, bookingData\.time)?\)/.test(src));
  }
}

// ── 5. Regras do prompt do scheduler ────────────────────────────────────────
console.log("\n5) REGRAS NOVAS NO CONTEXTO DE DISPONIBILIDADE");
{
  const sched = fs.readFileSync(path.join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck(
    "slot aceito que sumiu: exige assumir o erro e pedir desculpa antes de re-ofertar",
    /ONE EXCEPTION, and it is mandatory/.test(sched) && /filled up/.test(sched),
    "9 clientes tiveram o horário trocado sem aviso na janela"
  );
  ck("cita o caso Rolando como âncora", /Rolando, 2026-07-29/.test(sched));
  ck(
    "proíbe dizer 'locked in' antes da visita existir",
    /do NOT tell the client a time is 'locked in'/.test(sched)
  );
  ck(
    "proíbe resumo de disponibilidade em vez da lista de horários",
    /A SUMMARY OF availability is not a list of times/.test(sched)
  );
  ck(
    "lista as frases vagas vistas em produção",
    /several options/.test(sched) && /plenty of availability/.test(sched) && /full availability/.test(sched)
  );
  ck("regra antiga de nunca dizer 'just taken' continua", /just taken/.test(sched));
  ck("regra antiga de nomear horários para CADA dia continua", /you MUST name open times for EVERY day you offer/.test(sched));
}

console.log(`\n================= REVIEW 5D: ${pass} passed, ${fail} failed =================`);
process.exit(fail === 0 ? 0 : 1);
