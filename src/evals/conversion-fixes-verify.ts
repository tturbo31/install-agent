// Regression guard for the 2026-07-07 conversion review fixes. Pure-function
// tests only — deterministic, instant, zero API cost. Guards:
//  1. Large-lead price backstop: no $1,000+ total ships when the client
//     signaled 500+ sqft (the "price starts at $9,170" bug the contaminated
//     dreaming learning spread to every conversation).
//  2. Consecutive-duplicate guard: the same line never ships twice in a row
//     (the outage-handoff x12 loop and the FAQ-button identical re-answer).
//  3. Spanish opener: "Q piso es el de la promo?" gets the SPANISH opener.
//  4. Spanish job-seeker: installer credentials pitch gets silence, and real
//     customers do NOT trip the new patterns.
// Run: npx tsx src/evals/conversion-fixes-verify.ts
import {
  conversationHasLargeLead,
  stripLargeLeadPrices,
  isConsecutiveDuplicate,
  openerMessage,
  isJobSeeker,
  containsBookingInfo,
  clientEngagedScheduling,
  antiPressureShouldFire,
  stripSchedulingPush,
  getAIResponse,
  type ChatMessage,
} from "@/lib/ai";
import { OPENER_ES, OPENER_EN, OPENER_LOCATION_EN, OPENER_LOCATION_ES, WHAT_IS_INCLUDED_ASK_TYPE } from "@/lib/system-prompt";
import { stripInvertedPunctuation, stripInternalMarkers } from "@/lib/outbound-text";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env.local (same pattern as regression-suite) — section 8's negative
// test intentionally reaches the real API to prove the FAQ button is NOT
// hijacked by the price-negotiation intercept.
try {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { /* CI without .env.local — API-reaching checks will fail loudly */ }

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n── 1. Large-lead price backstop ──");
const largeConv: ChatMessage[] = [
  { role: "user", content: "I want vinyl for my whole house, about 2000 sqft" },
  { role: "assistant", content: "Which type are you interested in?" },
  { role: "user", content: "Vinyl please" },
];
check("2000 sqft conversation detected as large lead", conversationHasLargeLead(largeConv));
check(
  "300 sqft conversation NOT flagged as large",
  !conversationHasLargeLead([{ role: "user", content: "vinyl for 300 sqft please" }])
);
check(
  "Floor-plan LARGE PROJECT marker detected",
  conversationHasLargeLead([{ role: "user", content: "[Floor plan analysis: Total ~120m² (~1290sqft) LARGE PROJECT]" }])
);

const priced =
  "For 2,000 sqft, the price starts at $10,000 including the luxury vinyl flooring, materials, and installation. For a project that size I need to come measure in person to give you the best price. I have Sunday at 3pm or 5pm, what works better for you?";
const strippedReply = stripLargeLeadPrices(priced);
check("$10,000 total removed from the reply", !/\$\s?10,000/.test(strippedReply), strippedReply);
check("Visit pitch sentence survives the strip", /measure in person/i.test(strippedReply));
check("Slot offer survives the strip", /Sunday at 3pm/i.test(strippedReply));
check(
  "Reply that is ONLY a price gets the visit pivot",
  /free in-person visit/i.test(stripLargeLeadPrices("The total for your project is $9,170.")),
);
check(
  "Per-sqft rates are untouched (no big total present)",
  stripLargeLeadPrices("Tile is $4.50 per sqft for labor and removal is $1.50 per sqft.") ===
    "Tile is $4.50 per sqft for labor and removal is $1.50 per sqft.",
);
check(
  "Small-job totals under $1,000 are untouched",
  stripLargeLeadPrices("That comes out to about $950 total.") === "That comes out to about $950 total.",
);
check(
  "[BOOK:] tag sentence always survives",
  stripLargeLeadPrices('All set! [BOOK:{"date":"2026-07-09","time":"15:00"}] The total is $6,860.').includes("[BOOK:"),
);
const mixedSentence = stripLargeLeadPrices(
  "Our vinyl promo is $5 per sqft, so for 1,577 sqft it comes to about $7,885, and I bring all the samples to the free visit. What day works best for you?"
);
check("Cláusula com o total ($7,885) é removida", !/7\s*,?\s*885/.test(mixedSentence), mixedSentence);
check("A taxa permitida ($5/sqft) na MESMA frase sobrevive", /\$5 per sqft/.test(mixedSentence), mixedSentence);
check("O resto da frase continua fluido", /samples|free visit/i.test(mixedSentence));

console.log("\n── 2. Consecutive-duplicate send guard ──");
const OUTAGE = "Thanks for your message! Let me get our team to reach out, someone will get right back to you.";
const histAfterOutage: ChatMessage[] = [
  { role: "user", content: "No thanks" },
  { role: "assistant", content: OUTAGE },
  { role: "user", content: "NOOOOO" },
];
check("Outage handoff repeat suppressed", isConsecutiveDuplicate(histAfterOutage, OUTAGE));
check(
  "Whitespace/case variations still count as duplicates",
  isConsecutiveDuplicate(histAfterOutage, "  thanks for your message!  Let me get our team to reach out, someone will get right back to you. "),
);
check(
  "Different reply is NOT suppressed",
  !isConsecutiveDuplicate(histAfterOutage, "Our vinyl promo is $5 per sqft, want a free quote?"),
);
check("First-ever reply is never suppressed", !isConsecutiveDuplicate([{ role: "user", content: "hi" }], OUTAGE));
check(
  "Only the LAST assistant message counts (echo two turns back is fine)",
  !isConsecutiveDuplicate(
    [
      { role: "assistant", content: OUTAGE },
      { role: "user", content: "ok" },
      { role: "assistant", content: "Different reply here, moving on!" },
      { role: "user", content: "ok" },
    ],
    OUTAGE,
  ),
);
check("Tiny strings are exempt (length < 15)", !isConsecutiveDuplicate([{ role: "assistant", content: "All set!" }], "All set!"));

console.log("\n── 3. Spanish opener detection ──");
check("'Q piso es el de la promo ?' → Spanish opener", openerMessage("Q piso es el de la promo ?") === OPENER_ES);
check("'Cuánto cuesta?' → Spanish opener", openerMessage("Cuánto cuesta la instalación?") === OPENER_ES);
check("'necesito cotización para mi casa' → Spanish opener", openerMessage("necesito cotización para mi casa") === OPENER_ES);
check("English inquiry still gets English opener", openerMessage("How much does it cost?") === OPENER_EN);
check("'I need new floors' still English", openerMessage("I need new floors for my home") === OPENER_EN);

console.log("\n── 4. Spanish job-seeker detection ──");
check(
  "'Tengo experiencia en instalación de cerámica y tengo herramientas' → job seeker",
  isJobSeeker("Tengo experiencia en instalación de cerámica y tengo herramientas"),
);
check("'busco trabajo' → job seeker", isJobSeeker("Hola, busco trabajo de instalador"));
check(
  "Customer asking for installation is NOT a job seeker",
  !isJobSeeker("Necesito instalación de pisos en mi casa, cuánto cuesta?"),
);
check(
  "Customer with tools question is NOT a job seeker",
  !isJobSeeker("Do I need to buy the materials or do you bring everything?"),
);

console.log("\n── 6. Availability constraints count as scheduling engagement ──");
// "I cant during the week, i work" got its weekend-slot reply STRIPPED to a
// dead-end "No problem." by the anti-pressure guard (2026-07-08 review) —
// these phrases must all register as the client engaging scheduling.
check("'I cant during the week, i work' engages scheduling", clientEngagedScheduling("I cant during the week, i work"));
check("'only on weekends' engages scheduling", clientEngagedScheduling("only on weekends please"));
check("'I work all day' engages scheduling", clientEngagedScheduling("I work all day"));
check("'my day off is friday' engages scheduling", clientEngagedScheduling("my day off is friday"));
check("'solo fines de semana' engages scheduling", clientEngagedScheduling("solo fines de semana"));
check("'no puedo entre semana' engages scheduling", clientEngagedScheduling("no puedo entre semana"));
// "Soonest" phrases (28/08/2026, route-offer-verify T9): the anti-pressure strip used to delete the slot sentence for a client asking for the earliest visit.
for (const t of ["Any day works, whatever is soonest.", "asap please", "the earliest you have", "anytime", "any day", "whenever works for you", "today if possible", "I'm free all week", "lo antes posible", "cuanto antes", "cualquier día", "o quanto antes", "qualquer dia", "hoje se der"]) check(`'${t}' (soonest/any day) engages scheduling`, clientEngagedScheduling(t));
check("informational question with no timing words still does NOT engage scheduling", !clientEngagedScheduling("Is the vinyl waterproof and how thick is it?"));

// Regra do dono (28/08/2026): em espanhol NUNCA "¿" / "¡" — só "?" e "!" no final, como no português.
{
  check("stripInvertedPunctuation: apaga ¿ e ¡ e mantém o resto", stripInvertedPunctuation("¡Perfecto! ¿Cuál te queda mejor?") === "Perfecto! Cuál te queda mejor?");
  check("stripInvertedPunctuation: não mexe em texto sem os sinais (nem em quebras de parágrafo)", stripInvertedPunctuation("Hola.\n\nQué tal?") === "Hola.\n\nQué tal?");
  check("envio (stripInternalMarkers, 3 canais) também limpa ¿¡", stripInternalMarkers("¿Te funciona? [SYSTEM: FOLLOWUP_NUDGE]") === "Te funciona?");
  const srcFiles = ["src/lib/scheduler.ts", "src/lib/system-prompt.ts", "src/lib/followup.ts", "src/lib/quote-followup.ts", "src/lib/route-optimizer.ts", "src/lib/ai.ts"];
  const offenders: string[] = [];
  for (const f of srcFiles) {
    const lines = readFileSync(join(process.cwd(), f), "utf-8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/[¿¡]/.test(line)) return;
      // Um fragmento de regex construída com new RegExp em VÁRIAS linhas não tem
      // "new RegExp" na própria linha (SOONEST_OR_DEFER_TO_US, ai.ts): sintaxe de
      // regex ((?: , (?! , \s , classe de caractere escapada) nunca aparece numa
      // mensagem para o cliente, então serve de marca de "isto é detecção".
      const regexSyntax = /\(\?:|\(\?!|\(\?=|\\\\?s|\[\^/.test(line);
      const regexOrComment = /^\s*\/\//.test(line) || regexSyntax || /\.(?:match|test|replace)\(|new RegExp|^\s*(?:const|let)\s+[A-Z_]+\s*=\s*\//.test(line) || /\/[^/"`]*[¿¡][^/"`]*\/[gimsuy]*/.test(line);
      if (!regexOrComment && !/never use the inverted marks/.test(line)) offenders.push(f + ":" + (i + 1));
    });
  }
  check("nenhum enlatado/prompt em espanhol com ¿ ou ¡ (só regex de detecção pode ter)", offenders.length === 0, offenders.join(", "));
  const aiSrc3 = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  check("prompt: regra 1b SPANISH PUNCTUATION presente", /1b\. SPANISH PUNCTUATION: never use the inverted marks/.test(aiSrc3));
}
check(
  "Plain info question does NOT engage scheduling",
  !clientEngagedScheduling("What is the wear layer thickness?"),
);

console.log("\n── 7. Spanish contractor/installer pitches stay silent ──");
check(
  "'necesito trabajar yo sé entalar pisos y tengo una compañía de remodelación' → job seeker",
  isJobSeeker("Buenos días necesito trabajar yo sé entalar pisos y tengo una compañía de remodelación 3057470061 este es mi número"),
);
check("'yo sé instalar pisos' → job seeker", isJobSeeker("yo sé instalar pisos de todo tipo"));
check(
  "Customer asking US to install is NOT a job seeker",
  !isJobSeeker("Do you install vinyl floors in Miami? I need my house done"),
);

console.log("\n── 9. Coleta de dados pós-slot nunca é 'pressão' (caso Emanuel/Boynton, 2026-07-28) ──");
// O cliente escolheu "Friday at 5", o bot pediu nome+endereço+telefone, o
// cliente mandou SÓ o endereço (+ um sqft novo). O guard anti-pressão viu
// "5pm" na resposta e DELETOU a frase que re-pedia telefone/nome — o funil
// travou até o dono intervir. Pós-slot o guard não pode disparar.
const emanuel: ChatMessage[] = [
  { role: "user", content: "Yes tomorrow" },
  { role: "assistant", content: "Tomorrow is fully booked, but I have Friday at 5pm or 7pm, and Sunday at 9am or 11am. What works best for you?" },
  { role: "user", content: "Friday at 5" },
  { role: "assistant", content: "Perfect! Can I get your name, the property address, and the best phone number to confirm your visit?" },
  { role: "user", content: "7820 dorchester road Boynton beach fl 33472 and I am considering doing house 1500 square foot living room" },
];
check("Slot já escolhido → guard anti-pressão NÃO dispara", !antiPressureShouldFire(emanuel));
check(
  "Sem slot escolhido + pergunta de info → guard AINDA dispara (comportamento original)",
  antiPressureShouldFire([
    { role: "user", content: "I need new floors" },
    { role: "assistant", content: "I have Sunday at 3pm or 5pm, what works best for you?" },
    { role: "user", content: "What is the wear layer thickness?" },
  ]),
);
check(
  "Cliente engajando agendamento → guard não dispara (regra 2026-07-08 preservada)",
  !antiPressureShouldFire([
    { role: "user", content: "I need new floors" },
    { role: "assistant", content: "I have Sunday at 3pm or 5pm, what works best for you?" },
    { role: "user", content: "I cant during the week, i work" },
  ]),
);
const s1 = stripSchedulingPush(
  "Great, Boynton Beach is covered! and for the living room at 1,500 sqft I can measure that at the same visit and give you the best price on the spot, does Friday at 5pm still work for you?"
);
check("'1,500 sqft' nunca é mutilado para '1, 500' pelo strip", !/1,\s500/.test(s1) && /1,500 sqft/.test(s1), s1);
check("A re-confirmação do slot ('Friday at 5pm...?') é removida", !/5pm/.test(s1), s1);
const s2 = stripSchedulingPush(
  "Boynton Beach is covered! Can I get your name and the best phone number to confirm your visit Friday at 5pm?"
);
check("Pedido de nome/telefone sobrevive mesmo citando '5pm'", /name and the best phone number/.test(s2), s2);
const s3 = stripSchedulingPush(
  "The wear layer is 20 mil, very durable. I have Sunday at 3pm or 5pm, what works best for you?"
);
check("Push genuíno repetido ainda é removido", !/Sunday at 3pm/.test(s3) && /20 mil/.test(s3), s3);

async function priceNegotiationChecks() {
  console.log("\n── 8. Price negotiation → notify owners, never commit (owner rule 2026-07-08) ──");
  // The intercept fires BEFORE the API call — these tests cost zero tokens.
  const history: ChatMessage[] = [
    { role: "user", content: "Is this also for tile?" },
    { role: "assistant", content: "For tile the rate is $4.50 per sqft for the installation labor only. How many square feet?" },
  ];
  const competitor = await getAIResponse(
    [...history, { role: "user", content: "We already bought the tile from floor & decor but they quoted 3.99 per square foot so I guess we'll do it with them" }],
    null, null, null, false
  );
  check("Cotação de concorrente → notifica os donos", competitor.text.includes("[NOTIFY_OWNER]") && competitor.inputTokens === 0);
  check("Nunca promete cobrir o preço", !/beat|match|lower than/i.test(competitor.text));
  check("Diz que a equipe verifica o espaço", /check the space/i.test(competitor.text));

  const goLower = await getAIResponse(
    [...history, { role: "user", content: "Can you go any lower on that?" }],
    null, null, null, false
  );
  check("'Can you go any lower?' → notifica os donos", goLower.text.includes("[NOTIFY_OWNER]") && goLower.inputTokens === 0);

  const spanish = await getAIResponse(
    [...history, { role: "user", content: "Otra empresa me cotizó a $4 el pie, pueden hacerlo más barato?" }],
    null, null, null, false
  );
  check("Espanhol → resposta em espanhol + notifica", spanish.text.includes("[NOTIFY_OWNER]") && /equipo|espacio/i.test(spanish.text));

  const faqButton = await getAIResponse(
    [{ role: "user", content: "Do you offer any discounts for larger spaces?" }],
    null, null, null, false
  );
  check(
    "Botão de FAQ 'discounts for larger spaces' NÃO dispara a notificação",
    !faqButton.text.includes("get to a better number"),
  );
}

async function repeatInterceptChecks() {
  console.log("\n── 5. Repeated-message intercept (double-tap only, 15min window) ──");
  // Double-tap (2 min apart): suppressed BEFORE the API call — zero tokens.
  const doubleTap = await getAIResponse(
    [
      { role: "user", content: "What is the installation process?", at: "2026-07-08T18:16:00Z" },
      { role: "assistant", content: "We move all the furniture, install the floors, add the quarter round, clean everything up, all within 2 to 3 days.", at: "2026-07-08T18:16:30Z" },
      { role: "user", content: "What is the installation process?", at: "2026-07-08T18:18:00Z" },
    ],
    null, null, null, false
  );
  check("Toque duplo (2min) → [REACT_ONLY], zero tokens", doubleTap.text === "[REACT_ONLY]" && doubleTap.inputTokens === 0);

  // Genuine re-ask 2 HOURS later (the Nardine case, 2026-07-08): the opener
  // never answered the question — the repeat MUST get a real answer now.
  const reAsk = await getAIResponse(
    [
      { role: "user", content: "What is the installation process?", at: "2026-07-08T18:16:00Z" },
      { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?", at: "2026-07-08T18:16:30Z" },
      { role: "user", content: "What is the installation process?", at: "2026-07-08T20:21:00Z" },
    ],
    null, null, null, false
  );
  check("Re-pergunta 2h depois → resposta de verdade (caso Nardine)", reAsk.text !== "[REACT_ONLY]" && reAsk.text.length > 30, reAsk.text.slice(0, 80));
  check(
    "Re-sent ADDRESS is exempt from the intercept (booking payload)",
    containsBookingInfo("11725 sw 17 ct Miramar fl 33025"),
  );

  // Double-tap folded into a burst that ALSO carries a scheduling request
  // (the Romulla case, 2026-07-23): "Can you schedule to see my house" +
  // re-tapped "What is the installation process?" landed 9s apart, the
  // debounce merged them into one turn and the intercept silenced BOTH.
  // The burst has new content → the model MUST answer (never [REACT_ONLY]).
  const burstWithSchedule = await getAIResponse(
    [
      { role: "user", content: "What is the installation process?", at: "2026-07-23T19:22:10Z" },
      { role: "assistant", content: "Great question, we move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?", at: "2026-07-23T19:22:25Z" },
      { role: "user", content: "Can you schedule to see my house", at: "2026-07-23T19:22:30Z" },
      { role: "user", content: "What is the installation process?", at: "2026-07-23T19:22:39Z" },
    ],
    null, null, null, false
  );
  check(
    "Burst com pedido de agendamento + pergunta repetida → NUNCA muda (caso Romulla)",
    burstWithSchedule.text !== "[REACT_ONLY]" && burstWithSchedule.text.trim().length > 30,
    burstWithSchedule.text.slice(0, 100)
  );
  check(
    "…e a resposta engaja o agendamento da visita",
    /visit|schedule|come (?:by|out|over)|stop by|in.?person|measure|day|time|week/i.test(burstWithSchedule.text),
    burstWithSchedule.text.slice(0, 100)
  );

  // ── Caso Tom Kiper (2026-07-29): "Where are you located" ──────────────────
  console.log("\n── 5b. Location question + repeat after type-ask opener (Tom Kiper) ──");
  // First contact: the location question gets the deterministic location
  // opener (answer + type-ask), zero tokens — never the generic opener.
  const locFirst = await getAIResponse(
    [{ role: "user", content: "Where are you located" }],
    null, null, null, false
  );
  check(
    "1º contato 'Where are you located' → opener de localização, zero tokens",
    locFirst.text === OPENER_LOCATION_EN && locFirst.inputTokens === 0,
    locFirst.text.slice(0, 80)
  );
  const locFirstEs = await getAIResponse(
    [{ role: "user", content: "Hola, dónde están ubicados?" }],
    null, null, null, false
  );
  check(
    "1º contato ES 'dónde están ubicados' → opener ES de localização",
    locFirstEs.text === OPENER_LOCATION_ES && locFirstEs.inputTokens === 0,
    locFirstEs.text.slice(0, 80)
  );

  // The EXACT production failure: generic opener steamrolled the question,
  // client re-sent it 1 minute later — the intercept must NOT silence it.
  const tomKiper = await getAIResponse(
    [
      { role: "user", content: "Where are you located", at: "2026-07-29T21:42:16Z" },
      { role: "assistant", content: OPENER_EN, at: "2026-07-29T21:42:30Z" },
      { role: "user", content: "Where are you located", at: "2026-07-29T21:43:26Z" },
    ],
    null, null, null, false
  );
  check(
    "Repetição 1min após opener genérico → resposta de verdade (caso Tom Kiper)",
    tomKiper.text !== "[REACT_ONLY]" && tomKiper.text.trim().length > 20,
    tomKiper.text.slice(0, 100)
  );
  check(
    "…e a resposta fala da localização (Miami / South Florida)",
    /miami|florida/i.test(tomKiper.text),
    tomKiper.text.slice(0, 100)
  );

  // Albania (WA, 2026-08-23): "What are the payment options?" hit the
  // samples/colors FAQ and got the website + "one area or the whole house?".
  const payOpts = await getAIResponse(
    [
      { role: "user", content: "Do you offer any discounts for larger spaces?" },
      { role: "assistant", content: "Yes, larger spaces get our best pricing and the estimate visit is completely free, which one are you thinking about: tile, vinyl, or hardwood?" },
      { role: "user", content: "What are the payment options?" },
    ],
    null, null, null, false
  );
  check(
    "'What are the payment options?' NÃO cai na FAQ de amostras/site",
    !/ozzifloors\.com/i.test(payOpts.text) && payOpts.inputTokens > 0,
    payOpts.text.slice(0, 120)
  );

  // fb_27474567792195210 (2026-08-25): "What type of materials are included?"
  // → inclusions ask-type line → SAME button 99s later → silenced, because the
  // ask-type line contained the word "included" and counted as "answered".
  // The line the client actually received (the OLD wording, which named
  // nothing) is used verbatim: a reply that does not say what is included has
  // NOT answered, so the re-tap must get a real answer.
  const OLD_ASK_TYPE_NAMES_NOTHING = "Hello! We run separate promotions for tile, vinyl, and hardwood, and what is included is a little different for each. Which one are you interested in, tile, vinyl, or hardwood?";
  const inclRetap = await getAIResponse(
    [
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:49:10Z" },
      { role: "assistant", content: OLD_ASK_TYPE_NAMES_NOTHING, at: "2026-08-25T01:49:25Z" },
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:50:49Z" },
    ],
    null, null, null, false
  );
  check(
    "FAQ de inclusões repetida 99s após a linha ask-type → resposta de verdade (nunca mudo)",
    inclRetap.text !== "[REACT_ONLY]" && inclRetap.text.trim().length > 20,
    inclRetap.text.slice(0, 100)
  );
  check(
    "…e a resposta diz o que está incluído (material / labor)",
    /material|labor|mano de obra|includ/i.test(inclRetap.text),
    inclRetap.text.slice(0, 100)
  );
  // Counter-case: the CURRENT ask-type line names the inclusions per type, so
  // the same repeat within a minute IS a double-tap — suppressed, zero tokens.
  const inclDoubleTapCanned = await getAIResponse(
    [
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:49:10Z" },
      { role: "assistant", content: WHAT_IS_INCLUDED_ASK_TYPE, at: "2026-08-25T01:49:25Z" },
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:50:49Z" },
    ],
    null, null, null, false
  );
  check(
    "Mesma FAQ re-tocada após a linha ask-type ATUAL (que nomeia as inclusões) → double-tap suprimido, zero tokens",
    inclDoubleTapCanned.text === "[REACT_ONLY]" && inclDoubleTapCanned.inputTokens === 0,
    inclDoubleTapCanned.text.slice(0, 100)
  );
  // Counter-case: after a FULL model answer, the same repeat within a minute
  // IS a double-tap — stays suppressed, zero tokens.
  const inclDoubleTap = await getAIResponse(
    [
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:49:10Z" },
      { role: "assistant", content: "It depends on the floor you choose: our vinyl promo includes the flooring material, the installation labor, and the quarter round, while tile and hardwood cover the installation labor only. Which one are you interested in, tile, vinyl, or hardwood?", at: "2026-08-25T01:49:25Z" },
      { role: "user", content: "What type of materials are included?", at: "2026-08-25T01:50:49Z" },
    ],
    null, null, null, false
  );
  check(
    "Mesma FAQ re-tocada após resposta COMPLETA de inclusões → double-tap suprimido, zero tokens",
    inclDoubleTap.text === "[REACT_ONLY]" && inclDoubleTap.inputTokens === 0,
    inclDoubleTap.text.slice(0, 100)
  );

  // Counter-case: after the LOCATION opener (which DID answer), the same
  // repeat IS a double-tap — stays suppressed, zero tokens.
  const locDoubleTap = await getAIResponse(
    [
      { role: "user", content: "Where are you located", at: "2026-07-29T21:42:16Z" },
      { role: "assistant", content: OPENER_LOCATION_EN, at: "2026-07-29T21:42:30Z" },
      { role: "user", content: "Where are you located", at: "2026-07-29T21:43:26Z" },
    ],
    null, null, null, false
  );
  check(
    "Repetição 1min após opener DE LOCALIZAÇÃO (já respondeu) → [REACT_ONLY], zero tokens",
    locDoubleTap.text === "[REACT_ONLY]" && locDoubleTap.inputTokens === 0,
    locDoubleTap.text.slice(0, 80)
  );

  // Counter-case: process FAQ re-tapped after the process-aware opener (which
  // answered it AND asked the type) — still a double-tap, still suppressed.
  const processRetap = await getAIResponse(
    [
      { role: "user", content: "What is the installation process?", at: "2026-07-29T18:00:00Z" },
      { role: "assistant", content: "Great question, we move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?", at: "2026-07-29T18:00:15Z" },
      { role: "user", content: "What is the installation process?", at: "2026-07-29T18:02:00Z" },
    ],
    null, null, null, false
  );
  check(
    "Re-tap do FAQ de processo após opener FAQ-aware → [REACT_ONLY], zero tokens",
    processRetap.text === "[REACT_ONLY]" && processRetap.inputTokens === 0,
    processRetap.text.slice(0, 80)
  );

  // A question the type-ask opener plainly did NOT answer ("do you finance?")
  // repeated 2 min later must also get a real answer, never silence.
  const financeRepeat = await getAIResponse(
    [
      { role: "user", content: "Do you offer any financing options?", at: "2026-07-29T18:00:00Z" },
      { role: "assistant", content: OPENER_EN, at: "2026-07-29T18:00:15Z" },
      { role: "user", content: "Do you offer any financing options?", at: "2026-07-29T18:02:00Z" },
    ],
    null, null, null, false
  );
  check(
    "Pergunta ignorada pelo opener repetida 2min depois → resposta de verdade",
    financeRepeat.text !== "[REACT_ONLY]" && financeRepeat.text.trim().length > 20,
    financeRepeat.text.slice(0, 100)
  );
}

repeatInterceptChecks()
  .then(priceNegotiationChecks)
  .then(() => {
    console.log(`\n=========== CONVERSION-FIXES-VERIFY: ${passed} passed, ${failed} failed ===========`);
    process.exit(failed > 0 ? 1 : 0);
  });
