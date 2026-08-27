/**
 * [BOOK] tag integrity verify — caso Shaeleen Herrera-Garcia (IG, 2026-08-26).
 *
 * O que aconteceu: a cliente aceitou "Thursday at 7pm", mandou nome + endereço
 * com ZIP + telefone, e o modelo respondeu "Perfect, see you then![BOOK:{...}]"
 * (conversation_metrics: 288 tokens de saída = 6 turnos × 3 de overhead + 206
 * de texto visível + ~64 da tag). As "notes" do JSON bateram numa regex de
 * REASONING_LEAK_SENTENCE ("large lead", "the client said…"), stripReasoningLeak
 * tratou a tag como "frase de monólogo" e apagou a tag INTEIRA; sobrou "Perfect,
 * see you then!" (22 chars ≥ 20, o piso de substância) — o webhook mandou isso,
 * sem visita no scheduler. No dia seguinte, "still coming today at 7?" caiu no
 * fluxo de cliente NÃO agendado e o bot disse que o 7pm "filled up".
 *
 * Trava aqui:
 *  [1] withTagsProtected: scrubbers de frase nunca tocam nas tags
 *  [2] stripReasoningLeak: tag intacta com qualquer frase-gatilho nas notes;
 *      monólogo REAL na prosa continua sendo removido (sem regressão)
 *  [3] stripLargeLeadPrices: "$" total dentro das notes não quebra o JSON
 *  [4] isBarePreBookingText: "Perfect, see you then!" sozinho = confirmação nua;
 *      qualquer frase útil (pergunta, oferta, handoff, confirmação real) não é
 *  [5] reconcileBookingPhone: telefone do [BOOK] tem que ser o que o cliente
 *      digitou (o modelo trocou 305-431-3770 por 3053413770 em 5 de 8 replays)
 *  [6] bookingUnverifiedHandoffMessage: neutra, nunca "locked in"/falha, e
 *      nunca dispara o próprio backstop (sem loop)
 *  [7] Fluxo Shaeleen ponta a ponta (pós-processamento + regex do webhook)
 *
 * Sem API, sem banco. Run: npx tsx src/evals/book-tag-integrity-verify.ts
 */
import {
  withTagsProtected,
  stripReasoningLeak,
  stripLargeLeadPrices,
  isBarePreBookingText,
} from "../lib/ai";
import {
  reconcileBookingPhone,
  bookingUnverifiedHandoffMessage,
  bookingSuccessMessage,
  bookingFailureHandoffMessage,
  rescheduleSuccessMessage,
  visitDetailsMessage,
  needZipMessage,
  needPhoneMessage,
  needAddressMessage,
  isRealPhoneNumber,
} from "../lib/scheduler";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};
let failures = 0;
let total = 0;
function ck(name: string, cond: boolean, detail?: string) {
  total++;
  console.log(`  ${cond ? c.green("✓") : c.red("✗")} ${name}${!cond && detail ? c.dim(` — ${detail}`) : ""}`);
  if (!cond) failures++;
}

const BOOK_RE = /\[BOOK:(\{[\s\S]*?\})\]/;
const tag = (notes: string, phone = "3054313770") =>
  `[BOOK:{"name":"Shaeleen","phone":"${phone}","address":"3132 SE 2nd Dr, Homestead FL 33033","date":"2026-08-27","time":"19:00","notes":${JSON.stringify(notes)}}]`;

// Frases que a lista REASONING_LEAK_SENTENCE considera monólogo interno — todas
// plausíveis dentro de "notes" (o prompt chama projetos grandes de "large lead").
const TRIGGER_NOTES = [
  "large lead, luxury vinyl, stairs and whole second floor",
  "luxury vinyl stairs and second floor, the client said they are not home Thu/Fri daytime",
  "the client asked for 7pm, whole second floor plus stairs",
  "the client wants luxury vinyl, no DM price, visit to measure",
  "the type is still unknown, whole house, I need to propose the visit",
  "I'll propose the visit and acknowledge the size, second floor plus stairs",
  "Wait, let me redo this: second floor plus stairs, luxury vinyl",
  "el cliente eligió el jueves a las 7pm, vinilo segundo piso y escaleras",
  "o cliente disse que só pode depois das 7pm, vinil segundo andar e escadas",
  "small-job tier, 400 sqft vinyl, plus $500 add-on",
];

const SHAELEEN_HISTORY = [
  { role: "user", content: "[Client replied to our ad]" },
  { role: "user", content: "Hi, I’d like to get a quote to do my floors" },
  { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
  { role: "user", content: "The vinyl" },
  { role: "assistant", content: "Our vinyl promo is $5 per sqft and that already includes the flooring, the installation labor, and the quarter round. I offer a free quote, are you planning to do just one area or the whole house?" },
  { role: "user", content: "Just the stairs and all of second floor" },
  { role: "assistant", content: "For a whole second floor plus stairs, I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Thursday the 27th at 2pm or 5pm, which works better?" },
  { role: "user", content: "Can we do Saturday morning or even Sunday? We won’t be home Thursday or Friday during those times. Unless you can meet at 7 pm" },
  { role: "assistant", content: "Thursday at 7pm works, and Saturday I have 11am open. Which of those works better for you?" },
  { role: "user", content: "Tomorrow at 7 works" },
  { role: "assistant", content: "Perfect, I'm holding that slot while I grab your details. Can I get your name, the full property address including the zip code, and the best phone number?" },
  { role: "user", content: "Shaeleen\n3132 se 2nd dr homestead, fl 33033 \n305-431-3770\n\n[SYSTEM: TODAY: Wednesday, August 26, 2026 [2026-08-26]. Current time: 15:26 Eastern.]" },
];

function main() {
  console.log(c.bold("\n[BOOK] tag integrity verify (caso Shaeleen Herrera-Garcia, IG 26/08)\n"));

  // ── 1. withTagsProtected ──────────────────────────────────────────────────
  console.log(c.bold("[1] withTagsProtected"));
  const upper = (s: string) => s.toUpperCase();
  ck("sem tag: fn recebe o texto original", withTagsProtected("hello there.", upper) === "HELLO THERE.");
  const t1 = `Perfect, see you then!${tag("large lead, vinyl")}`;
  ck("tag [BOOK] volta intacta e a prosa é transformada", withTagsProtected(t1, upper) === `PERFECT, SEE YOU THEN!${tag("large lead, vinyl")}`);
  const t2 = `I'll connect you with Ozzi.[NOTIFY_OWNER] Bye.[CANCEL_BOOKING][REACT_ONLY]`;
  ck("várias tags, ordem preservada", withTagsProtected(t2, upper) === `I'LL CONNECT YOU WITH OZZI.[NOTIFY_OWNER] BYE.[CANCEL_BOOKING][REACT_ONLY]`);
  ck("fn que apaga a prosa toda ainda devolve a tag", withTagsProtected(t1, () => "") === "" || withTagsProtected(t1, (p) => p.replace(/[^\[\]#\dTAG]/g, "")).includes("[BOOK:"));
  ck("placeholder não deixa rastro quando fn é identidade", withTagsProtected(t1, (p) => p) === t1);

  // ── 2. stripReasoningLeak ────────────────────────────────────────────────
  console.log(c.bold("\n[2] stripReasoningLeak nunca apaga a tag"));
  for (const notes of TRIGGER_NOTES) {
    const input = `Perfect, see you then!${tag(notes)}`;
    const out = stripReasoningLeak(input);
    ck(`notes "${notes.slice(0, 48)}…" → tag intacta`, out === input, out);
  }
  const allSet = `All set!${tag("large lead, whole second floor")}`;
  ck('"All set!" (8 chars, abaixo do piso de 20) + notes-gatilho → intacto', stripReasoningLeak(allSet) === allSet);
  const leakBefore = `The client sent all the details. Perfect, see you then!${tag("large lead, vinyl second floor")}`;
  const leakOut = stripReasoningLeak(leakBefore);
  ck("monólogo na PROSA é removido e a tag fica", leakOut === `Perfect, see you then!${tag("large lead, vinyl second floor")}`, leakOut);
  const plainLeak = "Wait, let me redo this. Our vinyl promo is $5 per sqft, which area are you thinking about?";
  const plainOut = stripReasoningLeak(plainLeak);
  ck("regressão: monólogo sem tag continua sendo removido", plainOut === "Our vinyl promo is $5 per sqft, which area are you thinking about?", plainOut);
  const shortLeak = "Wait, let me redo this. Ok.";
  ck("regressão: piso de substância (< 20 chars) devolve o original", stripReasoningLeak(shortLeak) === shortLeak);
  const clean = "Our vinyl promo is $5 per sqft, one area or the whole house?";
  ck("regressão: texto limpo passa igual", stripReasoningLeak(clean) === clean);

  // ── 3. stripLargeLeadPrices ──────────────────────────────────────────────
  console.log(c.bold("\n[3] stripLargeLeadPrices não quebra o JSON"));
  const priceTag = `Perfect, see you then!${tag("whole house 1,500 sqft. Client expects around $7,500, bring samples")}`;
  const priceOut = stripLargeLeadPrices(priceTag);
  ck("total em $ dentro das notes → tag intacta e parseável", priceOut === priceTag && BOOK_RE.test(priceOut) && (() => { try { JSON.parse(priceOut.match(BOOK_RE)![1]); return true; } catch { return false; } })(), priceOut);
  const bigTotal = "Our promo is $5 per sqft, so 1,577 sqft comes to about $7,885, and I can come measure. What day works?";
  const bigOut = stripLargeLeadPrices(bigTotal);
  ck("regressão: total grande na prosa continua sendo removido", !/7,885/.test(bigOut) && /\$5 per sqft/.test(bigOut), bigOut);

  // ── 4. isBarePreBookingText ──────────────────────────────────────────────
  console.log(c.bold("\n[4] isBarePreBookingText"));
  const bare = [
    "Perfect, see you then!", "All set!", "Perfect, all set!", "You're all set!", "See you then!", "Great, see you soon!",
    "Perfect, see you then![NOTIFY_OWNER]", "You're welcome, see you then!", "Perfecto, nos vemos!", "¡Listo, nos vemos!",
    "¡Perfecto, hasta entonces!", "Perfeito, até lá!", "Tudo certo, até lá!", "Perfect, see you then",
    // A [BOOK] tag still in the text AFTER processBookingCommand means the tag
    // was malformed (the webhook regex never matched) and would go to the client
    // raw — that is a lost booking too, so the backstop must intercept it.
    `Perfect, see you then!${tag("vinyl")}`,
    "Perfect, see you then![BOOK: {\"name\":\"X\"}]",
  ];
  for (const s of bare) ck(`nua: ${JSON.stringify(s.slice(0, 70))}`, isBarePreBookingText(s));
  const notBare = [
    "", "Perfect!", "Thank you!", "Perfect, what's the address?", "Sounds good, Ozzi will be in touch.",
    "Perfect, I'm holding that slot while I grab your details. Can I get your name, the full property address including the zip code, and the best phone number?",
    "Thursday at 7pm works, and Saturday I have 11am open. Which of those works better for you?",
    "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]",
    "I'm sorry, that Thursday 7pm filled up while we were talking. The closest I have open now is Friday at 9am or 11am, which works better for you?",
    bookingSuccessMessage("en", "2026-08-27", "19:00"), bookingSuccessMessage("es", "2026-08-27", "19:00"), bookingSuccessMessage("pt", "2026-08-27", "19:00"),
    bookingFailureHandoffMessage("en"), bookingFailureHandoffMessage("es"), bookingFailureHandoffMessage("pt"),
    bookingUnverifiedHandoffMessage("en"), bookingUnverifiedHandoffMessage("es"), bookingUnverifiedHandoffMessage("pt"),
    rescheduleSuccessMessage("en"), rescheduleSuccessMessage("es"), rescheduleSuccessMessage("pt"),
    visitDetailsMessage("en", "2026-08-27", "19:00"), visitDetailsMessage("es", "2026-08-27", "19:00"),
    needZipMessage("en"), needPhoneMessage("en"), needAddressMessage("en"), needZipMessage("es"), needPhoneMessage("pt"),
    "Ok, I will text you 40 minutes before arriving.",
  ];
  for (const s of notBare) ck(`não nua: ${JSON.stringify(s.slice(0, 70))}`, !isBarePreBookingText(s));

  // ── 5. reconcileBookingPhone ─────────────────────────────────────────────
  console.log(c.bold("\n[5] reconcileBookingPhone"));
  const r1 = reconcileBookingPhone("3053413770", SHAELEEN_HISTORY);
  ck("dígitos trocados pelo modelo → corrigido para o que a cliente digitou", r1.corrected && r1.phone === "3054313770", JSON.stringify(r1));
  ck("número igual ao digitado (formatado) → não mexe", !reconcileBookingPhone("305-431-3770", SHAELEEN_HISTORY).corrected);
  ck("número igual ao digitado (parênteses) → não mexe", !reconcileBookingPhone("(305) 431-3770", SHAELEEN_HISTORY).corrected);
  ck("número igual com +1 → não mexe", !reconcileBookingPhone("+1 305 431 3770", SHAELEEN_HISTORY).corrected);
  ck("o endereço 3132 … 33033 nunca vira telefone", r1.phone === "3054313770" && !/3132|33033/.test(r1.phone ?? ""));
  const noPhoneHist = SHAELEEN_HISTORY.slice(0, 11).concat([{ role: "user", content: "Shaeleen, 3132 se 2nd dr homestead fl 33033" }]);
  ck("cliente não digitou telefone (WhatsApp / voz) → valor da tag fica", !reconcileBookingPhone("3053413770", noPhoneHist).corrected);
  ck("sem histórico → valor da tag fica", !reconcileBookingPhone("3053413770", []).corrected);
  const twoNums = [
    { role: "user", content: "My number is 786-308-0116" },
    { role: "assistant", content: "Got it!" },
    { role: "user", content: "Actually use my wife's, (954) 555-0199" },
  ];
  ck("dois números digitados, tag = o primeiro → aceito", !reconcileBookingPhone("7863080116", twoNums).corrected);
  const r2 = reconcileBookingPhone("7863080117", twoNums);
  ck("tag não bate com nenhum → o ÚLTIMO digitado", r2.corrected && r2.phone === "9545550199", JSON.stringify(r2));
  ck("telefone só na mensagem do BOT não conta", !reconcileBookingPhone("3053413770", [{ role: "assistant", content: "call 305-431-3770" }]).corrected);
  ck("phone vazio + cliente digitou → preenche com o digitado", (() => { const r = reconcileBookingPhone("", SHAELEEN_HISTORY); return r.corrected && r.phone === "3054313770"; })());
  ck("telefone corrigido passa em isRealPhoneNumber", isRealPhoneNumber(r1.phone));

  // ── 6. bookingUnverifiedHandoffMessage ───────────────────────────────────
  console.log(c.bold("\n[6] bookingUnverifiedHandoffMessage"));
  for (const lang of ["en", "es", "pt"] as const) {
    const m = bookingUnverifiedHandoffMessage(lang);
    ck(`${lang}: menciona Ozzi e não promete visita marcada`, /ozzi/i.test(m) && !/locked in|all set|confirmed for|see you|taken|filled up|nos vemos|até lá|confirmada para/i.test(m), m);
    ck(`${lang}: não é a frase de falha (regra do dono 26/08)`, m !== bookingFailureHandoffMessage(lang));
    ck(`${lang}: não dispara o próprio backstop (sem loop)`, !isBarePreBookingText(`${m}[NOTIFY_OWNER]`));
  }

  // ── 7. Fluxo Shaeleen ponta a ponta ──────────────────────────────────────
  console.log(c.bold("\n[7] Fluxo Shaeleen: saída do modelo → scrubbers → regex do webhook → JSON → telefone"));
  const modelOut = `Perfect, see you then!${tag("large lead, the client said they are not home Thu/Fri daytime, luxury vinyl second floor plus stairs", "3053413770")}`;
  const afterScrub = stripLargeLeadPrices(stripReasoningLeak(modelOut));
  const m = afterScrub.match(BOOK_RE);
  ck("tag sobrevive aos scrubbers", !!m, afterScrub);
  let parsed: Record<string, string> | null = null;
  try { parsed = m ? JSON.parse(m[1]) : null; } catch { parsed = null; }
  ck("JSON parseável", !!parsed);
  ck("data/hora da promessa (quinta 27/08 19:00)", parsed?.date === "2026-08-27" && parsed?.time === "19:00");
  const rp = reconcileBookingPhone(parsed?.phone, SHAELEEN_HISTORY);
  ck("telefone final = 305-431-3770 (o que ela digitou)", rp.phone === "3054313770");
  ck("o que sobra para o cliente NÃO é a confirmação nua (o sistema manda a confirmação real)", afterScrub.replace(BOOK_RE, "").trim() === "Perfect, see you then!" && isBarePreBookingText(afterScrub.replace(BOOK_RE, "")));
  // O cenário original: a tag some, sobra só a frase → o backstop dos webhooks tem que pegar.
  ck("cenário original (tag perdida): 'Perfect, see you then!' sozinho é interceptado", isBarePreBookingText("Perfect, see you then!"));

  console.log(c.bold(`\n${total - failures}/${total} checks passed${failures ? c.red(` — ${failures} FAILED`) : ""}\n`));
  process.exit(failures === 0 ? 0 : 1);
}

main();
