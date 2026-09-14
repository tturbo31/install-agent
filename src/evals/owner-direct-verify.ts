/**
 * OWNER DIRECT (regra do dono 14/09/2026) + [BOOK] FORÇADO (Yesmin / Alex Young).
 *
 * 1. Nunca prometer "o Ozzi entra em contato": toda promessa vira o número
 *    (561) 674-8334 (redirectOwnerPromiseToPhone), nas 3 línguas, com tags
 *    protegidas; o aviso de chegada ("40 minutes before") NÃO é promessa.
 * 2. Toda mensagem enlatada de repasse carrega o número e não promete contato.
 * 3. claimsVisitScheduled: "te agendo" / "you're booked" / "agendei" sem [BOOK].
 * 4. bookingDataLooksComplete + forcedBookRetryReason nos históricos reais da
 *    Yesmin (WA) e do Alex Young (IG); negativo quando falta o ZIP ou o slot.
 * 5. stripReasoningLeak pega "Wait, I already have your name...".
 * 6. Os 3 webhooks chamam o retry e o redirect; prompt carrega as regras.
 * Run: npx tsx src/evals/owner-direct-verify.ts
 */
import {
  redirectOwnerPromiseToPhone, promisesOwnerContact, ozziDirectLine, claimsVisitScheduled,
  bookingDataLooksComplete, forcedBookRetryReason, stripReasoningLeak, priceNegotiationHandoff,
  BOOK_NOW_NOTE, smallJobPhotosMessage, smallJobLeak, type ChatMessage,
} from "../lib/ai";
import {
  bookingFailureHandoffMessage, bookingUnverifiedHandoffMessage, aiOutageHandoffMessage,
  addressChangeHandoffMessage, appointmentMismatchHandoffMessage, cancellationHandoffMessage, type Lang,
} from "../lib/scheduler";
import { talkToOzziMessage, isFinancingApprovalNote, quoteHandoffActive, QUOTE_HANDOFF_SUFFIX } from "../lib/quote-reply";
import { financingApprovalNote } from "../lib/quote-followup";
import { SYSTEM_PROMPT } from "../lib/system-prompt";
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const NUM = /674-8334/;

console.log("\n[1] redirectOwnerPromiseToPhone");
{
  const cases: Array<[string, Lang, string]> = [
    ["I'm sorry we dropped the ball on that, David, Ozzi will call you right away on the number you provided.", "en", "David"],
    ["Of course, I'll pass this along to Ozzi and he will get in touch with you.", "en", "Emilio"],
    ["I'll connect you with Ozzi for anything else you need!", "en", "Pedro"],
    ["Ozzi will call you on the number you provided shortly.", "en", "Pedro 2"],
    ["Got it, so you need the installation done right after you close on October 1. I'll have Ozzi reach out to you directly to work out the pricing, he's the one who can get to a better number on that.", "en", "tile-over-tile"],
    ["I'll make sure our team reaches out to you directly to go over all the details from your visit. You'll hear from us very shortly!", "en", "visit details"],
    ["Passing your info along to Ozzi now, he's the right person to connect with directly!", "en", "Cole"],
    ["That sounds interesting! Let me pass this along to our team and someone will reach out to you shortly.", "en", "partnership"],
    ["Le paso el número a Ozzi para que lo llame.", "es", "ES llame"],
    ["Claro, le paso tu mensaje a Ozzi y él se comunicará contigo.", "es", "ES comunicará"],
    ["Gracias Angelica, Ozzi escuchará tu mensaje y se comunicará contigo personalmente para finalizar todo.", "es", "ES Angelik"],
    ["Claro, vou repassar para o Ozzi e ele entrará em contato com você.", "pt", "PT repassar"],
  ];
  for (const [text, lang, name] of cases) {
    const out = redirectOwnerPromiseToPhone(text, lang);
    ck(`${name}: promessa vira o número`, NUM.test(out) && !promisesOwnerContact(out), out);
  }
  const mixed = redirectOwnerPromiseToPhone("Yes, we do stairs at $150 per step. I'll have Ozzi reach out to you directly to work out the pricing.[NOTIFY_OWNER]", "en");
  ck("mantém a frase útil, troca só a promessa, preserva a tag", /\$150 per step/.test(mixed) && NUM.test(mixed) && /\[NOTIFY_OWNER\]$/.test(mixed) && !/reach out/.test(mixed), mixed);
  const arrival = "Got it, Ozzi will call you about 40 minutes before heading over. I just need the street address, what city is that in?";
  ck("aviso de chegada (40 min antes) NÃO é promessa", redirectOwnerPromiseToPhone(arrival, "en") === arrival, redirectOwnerPromiseToPhone(arrival, "en"));
  const plain = "For 700 sqft I need to come measure in person, the visit is free. What's the zip code?";
  ck("resposta normal intocada", redirectOwnerPromiseToPhone(plain, "en") === plain);
  const already = "For that the best is to reach Ozzi directly at (561) 674-8334. He'll reach out to you shortly.";
  const out2 = redirectOwnerPromiseToPhone(already, "en");
  ck("já tem o número: só remove a promessa, não duplica", (out2.match(/674-8334/g) || []).length === 1 && !/reach out/.test(out2), out2);
  ck("linha direta nas 3 línguas tem o número", (["en", "es", "pt"] as Lang[]).every((l) => NUM.test(ozziDirectLine(l)) && !promisesOwnerContact(ozziDirectLine(l))));
  const booked = "Your visit is confirmed for Monday, September 14 at 3pm. Ozzi will message you about 40 minutes before arriving, and if you need to move the visit just tell me the new day and time.";
  ck("visitDetailsMessage (mensagem 40 min) intocada", redirectOwnerPromiseToPhone(booked, "en") === booked);
}

console.log("\n[2] mensagens enlatadas de repasse dão o número, sem promessa");
{
  const fns: Array<[string, (l: Lang) => string]> = [
    ["bookingFailureHandoffMessage", bookingFailureHandoffMessage],
    ["bookingUnverifiedHandoffMessage", bookingUnverifiedHandoffMessage],
    ["aiOutageHandoffMessage", aiOutageHandoffMessage],
    ["addressChangeHandoffMessage", addressChangeHandoffMessage],
    ["appointmentMismatchHandoffMessage", appointmentMismatchHandoffMessage],
    ["cancellationHandoffMessage", cancellationHandoffMessage],
  ];
  for (const [name, fn] of fns) for (const l of ["en", "es", "pt"] as Lang[]) {
    const m = fn(l);
    ck(`${name} ${l}`, NUM.test(m) && !promisesOwnerContact(m) && !/locked in|taken|ocupad/i.test(m), m);
  }
  for (const l of ["en", "es", "pt"] as const) ck(`talkToOzziMessage ${l}`, NUM.test(talkToOzziMessage(l)) && !promisesOwnerContact(talkToOzziMessage(l)), talkToOzziMessage(l));
  for (const l of ["en", "es"] as const) ck(`financingApprovalNote ${l}`, NUM.test(financingApprovalNote(l)) && !promisesOwnerContact(financingApprovalNote(l)) && isFinancingApprovalNote(financingApprovalNote(l)));
  ck("nota de aprovação ANTIGA ainda é reconhecida (não vira repasse)", isFinancingApprovalNote("As soon as your application is approved, Ozzi will personally reach out to you to finalize everything.") && isFinancingApprovalNote("En cuanto tu solicitud sea aprobada, Ozzi se comunicará contigo personalmente para finalizar todo."));
  ck("histórico antigo com a nota velha + 'ok' não ativa o silêncio de repasse", !quoteHandoffActive([A("Hi, financing available."), A("As soon as your application is approved, Ozzi will personally reach out to you to finalize everything."), U("ok")]));
  ck("repasse marcado com sufixo continua ativando o silêncio", quoteHandoffActive([U("call me"), A(talkToOzziMessage("en") + QUOTE_HANDOFF_SUFFIX), U("hello?")]));
  for (const t of ["Can you go cheaper than 750", "Puede rebajar el precio?", "Consegue abaixar o preço?"]) {
    const m = priceNegotiationHandoff(t);
    ck(`priceNegotiationHandoff "${t}"`, NUM.test(m) && /\[NOTIFY_OWNER\]$/.test(m) && !promisesOwnerContact(m), m);
  }
}

console.log("\n[3] claimsVisitScheduled");
{
  const yes = [
    "Listo Yesmin, te agendo el lunes 14 de septiembre a las 3pm. Cual es el tipo de piso que tienes en mente, vinil, ceramica o madera?",
    "You're all set for Monday at 3pm!",
    "I've got you down for Sunday at 9am.",
    "Your visit is set for Tuesday at 11am, see you then.",
    "Perfecto, queda agendado para el domingo a las 11am.",
    "Pronto, agendei sua visita para segunda às 15h.",
    "Sua visita está marcada para terça às 9h.",
  ];
  for (const t of yes) ck(`claim: "${t.slice(0, 50)}"`, claimsVisitScheduled(t), t);
  const no = [
    "Perfect, I'm holding that 3pm for you! What name should I put the visit under?",
    "Monday at 11am it is, I'm holding that for you! Can I get your name, the property address, and the best phone number?",
    "Sunday at 9am works, I'll hold that for you!",
    "I'll book you in as soon as I have the zip code.",
    "Totally understood, David. Ozzi will call you to confirm the address before the visit Wednesday at 3pm.",
    "Perfecto, las 3pm del lunes te quedo. Me das tu nombre y la dirección de la propiedad para reservarlo?",
    "Appointment confirmed for Monday, September 14 at 3pm.[BOOK:{\"name\":\"x\"}]",
  ];
  for (const t of no) ck(`não-claim: "${t.slice(0, 50)}"`, !claimsVisitScheduled(t) || /\[BOOK:/.test(t), t);
}

console.log("\n[4] bookingDataLooksComplete / forcedBookRetryReason (casos reais)");
{
  const yesmin: ChatMessage[] = [
    U("What is the installation process?"),
    A("We come in, measure the space precisely, prep the surface, and install everything cleanly from start to finish, usually done within 2 to 3 days. What's the zip code of the property so I can check availability for a free visit?"),
    U("33020"), U("And please  Spanish"),
    A("Claro, con gusto en español! Ese código postal está dentro de nuestra área de servicio, tengo disponibilidad mañana lunes 14 de septiembre a las 3pm o 4pm, cual te viene mejor?"),
    U("El mejor para ti"), U("Vivo a 10 mins"), U("A las 3 pm para evitar el trafico"),
    A("Perfecto, las 3pm del lunes te quedo. Me das tu nombre y la dirección de la propiedad para reservarlo?"),
    U("Yesmin Alabart"),
    A("Perfecto Yesmin, solo necesito la dirección de la propiedad para reservar el lunes a las 3pm."),
    U("1846 Willey St. Hollywood. Fl 33020"),
  ];
  const yesminReply = "Listo Yesmin, te agendo el lunes 14 de septiembre a las 3pm. Cual es el tipo de piso que tienes en mente, vinil, ceramica o madera?";
  ck("Yesmin (WA): dados completos", bookingDataLooksComplete(yesmin, true));
  ck("Yesmin: motivo = claim", forcedBookRetryReason(yesminReply, yesmin, true) === "claim", String(forcedBookRetryReason(yesminReply, yesmin, true)));
  ck("Yesmin: com [BOOK] na resposta não há retry", forcedBookRetryReason("Listo![BOOK:{\"name\":\"Yesmin\"}]", yesmin, true) === null);
  const semZip = yesmin.map((m) => (m.role === "user" ? U(m.content.replace(/33020/g, "")) : m));
  ck("Yesmin sem ZIP: dados incompletos", !bookingDataLooksComplete(semZip, true));
  ck("Yesmin sem ZIP: claim ainda é claim (vira handoff, não re-pergunta)", forcedBookRetryReason(yesminReply, semZip, true) === "claim");

  const alex: ChatMessage[] = [
    U("Five stairs"), A("Stairs are $150 per step with the flooring material and installation included, so five steps comes out to $750."),
    U("When can you do it"), A("I have Wednesday the 9th at 7pm or 8pm, what's the zip code of the property?"),
    U("It’s in sunrise Florida"), A("Sunrise is covered, we're there all the time. which of those works better?"),
    U("7pm"), A("I'm holding that 7pm for you! Can I get your name, the property address, and your best phone number?"),
    U("Alex young \n4245272282"), U("701 SW 148 Ave, Apt 104,\nSunrise FL"), U("Can you go cheaper than 750"),
    A("Let me get our team on this one. We'll check the space in person and see if we can get to a better number for you, someone will reach out shortly!"),
    U("Can we schedule it for Friday afternoon? Is that possible?"), A("Friday the 11th works, I have 1pm or 2pm, which one do you want?"),
    U("Do you work weekends"), A("Yes, we work Saturdays and Sundays. This Saturday the 12th I have 3pm or 5pm, which works for you?"),
    U("The 12th works for me 3 PM is perfect. I’ll see you then."), A("Almost set! What's the zip code for that address?"),
    U("Do you guys have availability today?"), A("Today is fully booked, but I have Sunday the 13th at 9am or 11am, which works better?"),
    U("701 SW 148th Ave\nDavie, FL  33325\nUnited States"), U("9 AM you have all the material right"), U("Can you call me?"),
  ];
  const alexReply = "Sunday at 9am works, I'll hold that for you! Can I get your name, the property address, and the best phone number for the visit? Wait, I already have your name as Alex Young and the number. Just need the full property address, is it 701 SW 148th Ave, Apt 104, Sunrise FL 33325?";
  ck("Alex (IG): dados completos (nome, fone, rua, zip, slot)", bookingDataLooksComplete(alex, false));
  ck("Alex: motivo = reask", forcedBookRetryReason(alexReply, alex, false) === "reask", String(forcedBookRetryReason(alexReply, alex, false)));
  const alexSemSlot = alex.slice(0, -3);
  ck("Alex sem escolha de horário: sem retry", forcedBookRetryReason("Can I get the property address?", alexSemSlot.concat([U("hi")]), false) === null);
  ck("pergunta legítima com dados incompletos: sem retry", forcedBookRetryReason("Almost set! What's the zip code for that address?", alex.slice(0, 10), false) === null);
  const leak = stripReasoningLeak(alexReply);
  ck("stripReasoningLeak remove 'Wait, I already have...'", !/Wait, I already/.test(leak) && /hold that for you/.test(leak), leak);
  ck("BOOK_NOW_NOTE: tag, tipo não obrigatório, só o nome se faltar", /\[BOOK:/.test(BOOK_NOW_NOTE) && /flooring type is NOT required/i.test(BOOK_NOW_NOTE) && /name alone/i.test(BOOK_NOW_NOTE));
}

console.log("\n[4b] fotos/amostras com <400 sqft: resposta fixa em vez da linha de insistência");
{
  const hist: ChatMessage[] = [U("Hi, I need vinyl for my bedroom, about 300 sqft. How much?"), A("For a project under 400 square feet, the best is to speak with Ozzi directly at (561) 674-8334."), U("Can you send me some photos of your floors?")];
  for (const l of ["en", "es", "pt"] as const) ck(`smallJobPhotosMessage ${l}: site + número, não dispara o leak`, /ozzifloors\.com/.test(smallJobPhotosMessage(l)) && NUM.test(smallJobPhotosMessage(l)) && !smallJobLeak(hist, smallJobPhotosMessage(l)), smallJobPhotosMessage(l));
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf8");
  ck("getAIResponse: backstop da foto ligado após o smallJobLeak", /SMALL_JOB_INSIST_RE\.test\(cleaned\)/.test(aiSrc) && aiSrc.indexOf("SMALL_JOB_INSIST_RE.test(cleaned)") > aiSrc.indexOf("if (smallJobLeak(messages, cleaned)) {"));
}

console.log("\n[5] webhooks e prompt");
{
  const root = process.cwd();
  for (const [name, rel] of [["WA", "src/app/api/wa-webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["IG", "src/app/api/webhook/route.ts"]] as const) {
    const src = readFileSync(join(root, rel), "utf8");
    ck(`${name}: retry forçado de [BOOK] ligado`, /forcedBookRetryReason\(/.test(src) && /retryForBookTag\(/.test(src) && /let booked = bookingStep\.booked/.test(src));
    ck(`${name}: redirect da promessa antes do envio`, /redirectOwnerPromiseToPhone\(afterNotify, lang\)/.test(src) && /promisedOwnerContact \|\| promisesOwnerContact\(outboundResponse\)/.test(src));
    ck(`${name}: nota pós-booking dá o número`, /reach Ozzi directly at \(561\) 674-8334!\[NOTIFY_OWNER\]/.test(src) && !/I\\'ll connect you with Ozzi for anything else/.test(src));
  }
  const wa = readFileSync(join(root, "src/app/api/wa-webhook/route.ts"), "utf8");
  ck("WA quote-reply: resposta do modelo passa pelo redirect", /const replyText = redirectOwnerPromiseToPhone\(reply\.text/.test(wa) && /sendWhatsAppMessage\(phone, replyText\)/.test(wa));
  ck("prompt: regra 'nunca prometer callback' + número", /NEVER PROMISE A CALLBACK/.test(SYSTEM_PROMPT) && /\(561\) 674-8334/.test(SYSTEM_PROMPT));
  ck("prompt: booking não espera o tipo / nunca 'te agendo' sem tag", /BOOKING NEVER WAITS FOR THE FLOORING TYPE/.test(SYSTEM_PROMPT) && /"te agendo"/.test(SYSTEM_PROMPT));
  ck("prompt: resposta com hedge não é fechamento", /I need to double check/.test(SYSTEM_PROMPT));
  ck("prompt: exemplos antigos de promessa sumiram", !/someone will reach out to you shortly/.test(SYSTEM_PROMPT) && !/I'll have Ozzi reach out to you directly to get everything scheduled/.test(SYSTEM_PROMPT) && !/I'll connect you with Ozzi for anything else you need/.test(SYSTEM_PROMPT));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
