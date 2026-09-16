/**
 * Revisão 5 dias 09-14/09/2026 (pedido do dono: "pediu o ZIP/endereço, o cliente
 * mandou e pediu de novo" / "mandou tudo e não agendou"). Puro, sem modelo.
 * Casos reais: Dan Chen ("2 :00 pm"), KYE ("move it to 9"), Joe Patel ("reach out
 * tomorrow ... Monday 1pm" travou o [BOOK] de segunda), Jorge Guerra ("queda
 * reservado" sem endereço), fb_28368243442792476 ("cuando regreses te agendo"),
 * Yami Fonseca / Tymur (endereço re-pedido), Margarita León (ZIP fora da janela
 * de 15), Manuel Romero (canned "con el código postal" com ZIP já dado).
 * Run: npx tsx src/evals/review5d-1409-verify.ts
 */
import {
  claimsVisitScheduled, softenVisitClaim, forcedBookRetryReason, bookingDataLooksComplete,
  rewriteBookingDataAsk, bookingItemsGiven, clientTypedName, clientAlreadyGaveZip, containsBookingInfo,
} from "../lib/ai";
import {
  normalizeClockSpacing, hoursNamed, bookedTimeSeenInConversation, bookedSlotMismatchesPromise,
  clientConfirmedSlot, needAddressMessage, easternTodayStr, weekdaysNamed,
} from "../lib/scheduler";
import { withEarlierBookingFacts, carriesBookingFact } from "../lib/booking-facts";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const U = (c: string) => ({ role: "user" as const, content: c });
const A = (c: string) => ({ role: "assistant" as const, content: c });
const wd = (d: string) => new Date(d + "T12:00:00Z").getUTCDay();
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

console.log("\n━━ 1. Dan Chen (FB 12/09): '2 :00 pm' é 2pm ━━");
const dan = [
  A("Our vinyl promo is $5 per square foot and that already includes the flooring, the installation labor, and the quarter round. What's the zip code of the property?"),
  U("33484"),
  A("That zip is covered! I have tonight at 7pm or tomorrow Monday at 9am, which works better for you?"),
  U("16th afternoon"),
  A("Wednesday the 16th I have 1pm, 2pm, 3pm, 4pm, 5pm, 6pm, or 8pm, which works best for you?"),
  U("1 pm"),
  A("I'm holding that Wednesday the 16th at 1pm for you! Can I get your name, the property address, and a good phone number?"),
  U("Dan Chen 5822 spacious skies way Delray Beach , FL 33484"),
  A("Still need your phone number to lock it in, Dan!"),
  U("2 :00 pm (305)772-3782"),
];
ck("normalizeClockSpacing colapsa '2 :00 pm'", normalizeClockSpacing("2 :00 pm (305)772-3782") === "2:00 pm (305)772-3782", normalizeClockSpacing("2 :00 pm (305)772-3782"));
ck("hoursNamed('2 :00 pm …') tem 2", hoursNamed("2 :00 pm (305)772-3782").has(2));
ck("bookedTimeSeenInConversation(dan, 14:00) = true", bookedTimeSeenInConversation(dan, "14:00"));
ck("promise-match não bloqueia 16/09 14:00", !bookedSlotMismatchesPromise(dan, "2026-09-16", "14:00").mismatch, JSON.stringify(bookedSlotMismatchesPromise(dan, "2026-09-16", "14:00")));
ck("clientConfirmedSlot(dan) = true", clientConfirmedSlot(dan));
ck("bookingDataLooksComplete(dan) = true", bookingDataLooksComplete(dan, false));
ck("telefone não vira hora: hoursNamed('(305)772-3782') vazio", hoursNamed("(305)772-3782").size === 0);

console.log("\n━━ 2. KYE (IG 13/09): 'move it to 9' é 9am ━━");
const kye = [
  A("Tuesday works, I have 9am or 11am, which one is better for you?"),
  U("Okay sounds good Tuesday at 11 will work"),
  A("Appointment confirmed for Tuesday, September 15 at 11am. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."),
  U("Okay sounds good wait wait let's move it to 9 I forgot I have a meeting at 11"),
];
ck("hoursNamed('move it to 9 …') tem 9", hoursNamed("Okay sounds good wait wait let's move it to 9 I forgot I have a meeting at 11").has(9));
ck("bookedTimeSeenInConversation(kye, 09:00) = true", bookedTimeSeenInConversation(kye, "09:00"));
ck("promise-match aceita 15/09 09:00", !bookedSlotMismatchesPromise(kye, "2026-09-15", "09:00").mismatch, JSON.stringify(bookedSlotMismatchesPromise(kye, "2026-09-15", "09:00")));
ck("'move it to 3 rooms' não é hora", !hoursNamed("can we move it to 3 rooms").has(3));
ck("'push it to 2 days' não é hora", !hoursNamed("push it to 2 days later").has(2));
ck("'move it to 5pm' segue 5", hoursNamed("move it to 5pm").has(5));

console.log("\n━━ 3. Joe Patel (FB 12/09): 'reach out tomorrow … Monday 1pm' não é promessa de amanhã ━━");
{
  const today = easternTodayStr();
  const tw = (wd(today) + 3) % 7; // um dia da semana que não é hoje nem amanhã
  let bookDate = addDays(today, 1);
  while (wd(bookDate) !== tw) bookDate = addDays(bookDate, 1);
  const dayName = DAY[tw];
  const joe = [
    A(`${dayName} I have 9am or 1pm, neither 11:30 nor 12pm are open that day. Which of those works for you?`),
    U("1 pm good"),
    A(`Perfect, I'm holding that ${dayName} 1pm for you! Can I get your name, the property address, and the best phone number?`),
    U("Not now my wife is sleeping Tomorrow Sorry"),
    A(`No worries at all, just reach out tomorrow when you're ready and we'll get that info penciled in for ${dayName} 1pm!`),
    U("Joe patel 917-440-7571"),
    U("Okay"),
  ];
  ck(`weekdaysNamed vê ${dayName} = ${tw}`, weekdaysNamed(joe[4].content).length === 1 && weekdaysNamed(joe[4].content)[0] === tw, JSON.stringify(weekdaysNamed(joe[4].content)));
  const pm = bookedSlotMismatchesPromise(joe, bookDate, "13:00");
  ck(`[BOOK] ${bookDate} 13:00 (${dayName}) NÃO é bloqueado`, !pm.mismatch, JSON.stringify(pm));
  ck("dados incompletos (sem endereço) → vai pedir o endereço, não a hora", !bookingDataLooksComplete(joe, false));
  ck("nome 'Joe patel' detectado", clientTypedName(joe));
  // controle: 'tomorrow' sem dia da semana continua valendo como data prometida
  const ctrl = [A("I can come tomorrow at 1pm, does that work?"), U("yes")];
  const pm2 = bookedSlotMismatchesPromise(ctrl, addDays(today, 2), "13:00");
  ck("controle: 'tomorrow at 1pm' + [BOOK] depois de amanhã → bloqueia", pm2.mismatch && pm2.promisedDate === addDays(today, 1), JSON.stringify(pm2));
  // controle: 'tomorrow <weekday certo>' continua valendo
  const tomorrowName = DAY[wd(addDays(today, 1))];
  const ctrl2 = [A(`I have tomorrow ${tomorrowName} at 1pm, does that work?`), U("yes")];
  const pm3 = bookedSlotMismatchesPromise(ctrl2, addDays(today, 2), "13:00");
  ck(`controle: 'tomorrow ${tomorrowName} at 1pm' + [BOOK] em outro dia → bloqueia`, pm3.mismatch, JSON.stringify(pm3));
}

console.log("\n━━ 4. claimsVisitScheduled: condicional não é claim ━━");
ck("'Cuando estes listo te agendo la visita gratis…' → false", !claimsVisitScheduled("Espero que se mejore pronto, no hay apuro. Cuando estes listo te agendo la visita gratis, podemos ir hoy a las 8pm o manana viernes a la 1pm o 2pm, cual te queda mejor?"));
ck("'Avisame cuando regreses … y te agendo de una' → false", !claimsVisitScheduled("Para ese tamaño necesito ir a medir en persona para darte el precio exacto, por eso la visita es gratis. Avisame cuando regreses a finales de la próxima semana y te agendo de una."));
ck("'Once you're back let me know and you're all set for Monday' → false", !claimsVisitScheduled("Once you're back let me know and you're all set for Monday 3pm."));
ck("Yesmin: 'Listo Yesmin, te agendo el lunes 14 … 3pm.' → true", claimsVisitScheduled("Listo Yesmin, te agendo el lunes 14 de septiembre a las 3pm. Cual es el tipo de piso que tienes en mente, vinil, ceramica o madera?"));
ck("Jorge: 'queda reservado mientras me das…' → true", claimsVisitScheduled("Perfecto, el martes 15 a las 11am queda reservado mientras me das tu nombre y la direccion de la propiedad para confirmar todo."));
ck("'You're all set for Monday at 3pm, if you need anything just text me!' → true (condição depois)", claimsVisitScheduled("You're all set for Monday at 3pm, if you need anything just text me!"));

console.log("\n━━ 5. forcedBookRetryReason: claim só força retry com dados completos ━━");
const jorge = [
  U("Donde queda hubicado yo vivo sico 33016"),
  A("Estamos en Miami y atendemos todo el sur de la Florida, desde Homestead hasta Jupiter. Cuál piso te interesa, tile, vinyl o hardwood?"),
  U("Quiero un estudio"),
  A("Un estudio normalmente no llega a 500 pies cuadrados, asi que puedo darte el precio aqui mismo. Cual tipo de piso te interesa, tile, vinyl o hardwood?"),
  U("Si puede primero piso sico 33016"),
  A("Para un estudio lo mejor es que pase a verte, te doy el precio exacto en el momento y traigo las muestras para que escojas ahi mismo, sin costo. Puedo hoy a las 8pm o manana viernes a la 1pm o 2pm, cual te queda mejor?"),
  U("Me esposa esta operada"),
  A("Espero que se mejore pronto, no hay apuro. Cuando estes listo te agendo la visita gratis, podemos ir hoy a las 8pm o manana viernes a la 1pm o 2pm, cual te queda mejor?"),
  U("Me puede dar una cita para el día quince"),
  A("El martes 15 tengo a las 9am o las 11am, cual te queda mejor?"),
  U("Honce de la mañana"),
];
const jorgeReply = "Perfecto, el martes 15 a las 11am queda reservado mientras me das tu nombre y la direccion de la propiedad para confirmar todo.";
ck("Jorge (sem endereço): reason = null (nada de retry/handoff)", forcedBookRetryReason(jorgeReply, jorge, true) === null, String(forcedBookRetryReason(jorgeReply, jorge, true)));
const yesmin = [
  U("What is the installation process?"),
  A("We come in, measure the space precisely, prep the surface, and install everything cleanly from start to finish, usually done within 2 to 3 days. What's the zip code of the property so I can check availability for a free visit?"),
  U("33020"), U("And please Spanish"),
  A("Claro, con gusto en español! Ese código postal está dentro de nuestra área de servicio, tengo disponibilidad mañana lunes 14 de septiembre a las 3pm o 4pm, cual te viene mejor?"),
  U("El mejor para ti"), U("Vivo a 10 mins"), U("A las 3 pm para evitar el trafico"),
  A("Perfecto, las 3pm del lunes te quedo. Me das tu nombre y la dirección de la propiedad para reservarlo?"),
  U("Yesmin Alabart"),
  A("Perfecto Yesmin, solo necesito la dirección de la propiedad para reservar el lunes a las 3pm."),
  U("1846 Willey St. Hollywood. Fl 33020"),
];
const yesminReply = "Listo Yesmin, te agendo el lunes 14 de septiembre a las 3pm. Cual es el tipo de piso que tienes en mente, vinil, ceramica o madera?";
ck("Yesmin (dados completos): reason = claim (retry forçado segue)", forcedBookRetryReason(yesminReply, yesmin, true) === "claim", String(forcedBookRetryReason(yesminReply, yesmin, true)));

console.log("\n━━ 6. softenVisitClaim: claim sem booking vira 'apartado / penciling in' ━━");
{
  const s1 = softenVisitClaim(jorgeReply, "es");
  ck("Jorge ES → 'queda apartado' e sem claim", /queda apartado/.test(s1) && !claimsVisitScheduled(s1), s1);
  const s2 = softenVisitClaim("Jorge, te reservo el martes 15 a las 11am mientras me das la direccion de la propiedad para confirmar todo.", "es");
  ck("'te reservo' → 'te lo aparto' e pedido de endereço intacto", /te lo aparto el martes 15/.test(s2) && /direccion de la propiedad/.test(s2) && !claimsVisitScheduled(s2), s2);
  const s3 = softenVisitClaim("You're all set for Monday at 3pm! What's the best phone number to reach you?", "en");
  ck("EN 'all set for' → 'penciling you in for' + pergunta intacta", /I'm penciling you in for Monday at 3pm!/.test(s3) && /best phone number/.test(s3) && !claimsVisitScheduled(s3), s3);
  const s4 = softenVisitClaim("I've got you down for Saturday 9am. Can I get the property address?", "en");
  ck("EN 'got you down for' → penciling", /penciling you in for Saturday 9am/.test(s4) && !claimsVisitScheduled(s4), s4);
  const s5 = softenVisitClaim("Your visit is confirmed for Monday, September 14 at 11am. Ozzi will message you about 40 minutes before arriving.", "en");
  ck("canned 'Your visit is confirmed for…' NÃO é tocado", s5 === "Your visit is confirmed for Monday, September 14 at 11am. Ozzi will message you about 40 minutes before arriving.", s5);
  ck("canned 'Appointment confirmed…' NÃO é tocado", softenVisitClaim("Appointment confirmed for Tuesday, September 15 at 1pm. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.", "en").startsWith("Appointment confirmed"));
  ck("canned 'All set, your visit has been rescheduled' NÃO é tocado", softenVisitClaim("All set, your visit has been rescheduled. I will notify you approximately 40 minutes before arriving. My name is Ozzi.", "en").startsWith("All set, your visit has been rescheduled"));
  const s6 = softenVisitClaim("Pronto, te agendo segunda às 15h. Qual é o endereço da propriedade?", "pt");
  ck("PT 'te agendo' → 'deixo anotado por enquanto'", /te deixo anotado por enquanto segunda/.test(s6) && !claimsVisitScheduled(s6), s6);
  const s7 = softenVisitClaim("Listo, te agendo el lunes 3pm.[BOOK:{\"date\":\"2026-09-14\",\"time\":\"15:00\"}]", "es");
  ck("tag [BOOK] preservada intacta", s7.includes("[BOOK:{\"date\":\"2026-09-14\",\"time\":\"15:00\"}]") && /te lo aparto/.test(s7), s7);
  const plain = "Perfect, I'm holding that 3pm for you! Can I get your name and the best phone number?";
  ck("texto sem claim não muda", softenVisitClaim(plain, "en") === plain);
  const s8 = softenVisitClaim("Perfecto, la cita queda confirmada para el domingo a las 9am. Me das tu dirección?", "es");
  ck("ES 'cita queda confirmada' → 'cita queda apartada'", /cita queda apartada/.test(s8) && !claimsVisitScheduled(s8), s8);
}

console.log("\n━━ 7. rewriteBookingDataAsk: nunca re-pede o que o cliente já digitou ━━");
{
  const yami = [
    U("Good morning. Please advise when you can come by to give an estimate"),
    A("Good morning! The visit is completely free, I bring all the floor samples so you can pick right there. What's the zip code of the property?"),
    U("15269 Sw 35th terrace Miami, Fl 33185"),
    A("Miami 33185 is covered! I have today, Thursday, at 3pm or 4pm, which works better for you?"),
    U("3 pm"),
  ];
  const g = bookingItemsGiven(yami, false);
  ck("Yami: dado = endereço + zip + nome (nome sempre conta como dado desde 16/09), sem fone", g.has("address") && g.has("zip") && !g.has("phone") && g.has("name"), [...g].join(","));
  const r1 = rewriteBookingDataAsk("Perfect, I'm holding that 3pm for you! Can I get your name, the property address, and the best phone number?", yami, false, "en");
  ck("Yami: pedido vira só 'phone', sem 'property address' e sem nome (16/09)", r1 === "Perfect, I'm holding that 3pm for you! Can I get the best phone number to reach you?", r1);
  const tymur = [
    U("Looking to replace carpet 1100 sq"),
    A("For 1,100 sqft we need to come out and measure in person to give you the best price on the new floor. The visit is free and I bring samples so you can see the options right there. What's the zip code of the property?"),
    U("4516 Pinehurst trl w"), U("33309"),
    A("33309 is right in our area. I can do today at 5pm or 7pm, which works better?"),
    U("Any day works until 3pm"),
    A("Tuesday has 11am and 1pm, which fit perfectly. Tuesday at 11am or 1pm, which works better for you?"),
    U("1pm"),
  ];
  const r2 = rewriteBookingDataAsk("Perfect, I'm holding that Tuesday 1pm for you! Can I get your name, the property address, and the best phone number?", tymur, false, "en");
  ck("Tymur: idem", r2 === "Perfect, I'm holding that Tuesday 1pm for you! Can I get the best phone number to reach you?", r2);
  const marg = [
    U("33180 It is a conso Conso Condo"),
    A("33180 is covered! I have Sunday at 7pm, want me to hold that for you?"),
    U("Ok that works for us"),
    A("I'm holding that Sunday 7pm for you! Can I get your name, the property address, and the best phone number to confirm the visit?"),
    U("Name is : Margarita Leon, 2775 NE 187th st apt 726- ph26"),
  ];
  const r3 = rewriteBookingDataAsk("Almost there! What's the zip code for that address, and the best phone number to reach you?", marg, false, "en");
  ck("Margarita: ZIP já dado some, só o telefone fica", r3 === "Almost there! Can I get the best phone number to reach you?", r3);
  ck("Margarita: nome via 'Name is :' detectado", clientTypedName(marg));
  const iv = [
    U("33165"),
    A("33165 is covered! I have this Sunday the 13th at 5pm or 7pm, which works better for you?"),
    U("5:00 pm"),
    A("Perfect, I'm holding that 5pm for you! Can I get your name and the property address?"),
    U("Alexis… 4500 SW 116th Avenue"), U("Please give me a call before going to coordinate"),
  ];
  const r4 = rewriteBookingDataAsk("Got it, Ozzi will call you about 40 minutes before heading over. I just need the street address, what city is that in?", iv, true, "en");
  ck("IV Brothers (WA): 'street address' já dado → só a cidade", /Can I get the city for that address\?/.test(r4) && !/street address/.test(r4) && /Ozzi will call you/.test(r4), r4);
  const camila = [
    A("Perfect, I'm holding that Wednesday the 16th at 11am for you! Can I get your name and the property address?"),
    U("17199 Brulee breeze way"),
  ];
  const camReply = "What name should I put the visit under, and what's the city and zip code for that address?";
  ck("Camila (WA): cidade + zip faltando → pedido só deles, sem o nome (16/09)", rewriteBookingDataAsk(camReply, camila, true, "en") === "Can I get the zip code for that address and the city for that address?", rewriteBookingDataAsk(camReply, camila, true, "en"));
  const jose = [
    U("Hi, yes i have a 1,500 sq ft where i will like to put vinyl floor, can you give me. Quote! What else do you need from need"),
    A("For 1,500 sqft I need to come measure in person to give you the best price, I bring all the floor samples so you can pick right there and it's completely free. What's the zip code of the property?"),
    U("Yes thats perfect, its 33314 its Davie"),
    A("Davie is covered, no problem. I have today at 5pm or 6pm, which works better for you?"),
    U("6pm works"),
  ];
  const joseReply = "Perfect, I'm holding that 6pm for you! Can I get your name and the full property address in Davie?";
  ck("Jose (WA): endereço faltando → pede só o endereço, sem o nome (16/09)", rewriteBookingDataAsk(joseReply, jose, true, "en") === "Perfect, I'm holding that 6pm for you! Can I get the property address (number, street and city)?", rewriteBookingDataAsk(joseReply, jose, true, "en"));
  ck("Jose: 'its Davie' não vira nome", !clientTypedName(jose));
  const manuel = [
    A("So it sounds like you have luxury vinyl already and just need the installation, at $2 per square foot that comes out to about $540 for 270 sqft. Cual es el codigo postal de la propiedad?"),
    U("33319"),
    A("33319 está cubierto. Tengo hoy viernes a las 8pm, o domingo a las 9am u 11am, cual te funciona mejor?"),
    U("Domingo a las 9am y lo haría con baseboard con material cuánto sería el total , y opciones de pago,"),
  ];
  const manReply = "Para los baseboards necesito saber cuántos pies lineales tienes, pero en cuanto al pago aceptamos tarjeta de crédito, cheque, efectivo y también tenemos financiamiento. Puedo tomar tu nombre, la dirección de la propiedad y el mejor número de teléfono para apartar el domingo a las 9am?";
  {
    const manOut = rewriteBookingDataAsk(manReply, manuel, false, "es");
    ck("Manuel (ES): só o ZIP dado → pede endereço + teléfono, sem nombre, resposta dos baseboards intacta (16/09)", manOut.startsWith("Para los baseboards") && !/nombre/.test(manOut) && /dirección de la propiedad \(número, calle y ciudad\) y el mejor número de teléfono/.test(manOut) && !/[¿¡]/.test(manOut), manOut);
  }
  const manuel2 = [...manuel, A("Puedo tomar tu nombre, la dirección de la propiedad y el mejor número de teléfono para apartar el domingo a las 9am?"), U("Llamarme en Messenger"), A("Necesito un número de teléfono real para poder agendar, no puedo usar Messenger como contacto. Cual sería el mejor número para llamarte?"), U("954 2402181 Manuel Romero")];
  ck("Manuel: nome após o telefone ('954 2402181 Manuel Romero') detectado", clientTypedName(manuel2));
  const alex = [
    A("Today is fully booked, but I have Sunday the 13th at 9am or 11am, which works better?"),
    U("Alex Young 4245272282"),
    U("701 SW 148th Ave Davie, FL 33325 United States"),
    U("9 AM you have all the material right"),
  ];
  const alexReply = "Can I get your name, the property address, and the best phone number for the visit?";
  ck("Alex (tudo dado): rewrite NÃO mexe (é o retry forçado que age)", rewriteBookingDataAsk(alexReply, alex, false, "en") === alexReply);
  ck("Alex: forcedBookRetryReason = reask", forcedBookRetryReason(alexReply, alex, false) === "reask", String(forcedBookRetryReason(alexReply, alex, false)));
  const r5 = rewriteBookingDataAsk("Perfect, I'm holding that 3pm for you! Can I get your name, the property address, and the best phone number?[NOTIFY_OWNER]", yami, false, "en");
  ck("tag [NOTIFY_OWNER] preservada", r5.endsWith("[NOTIFY_OWNER]") && !/property address/.test(r5), r5);
  const yamiEs = [
    A("La visita es gratis y llevo todas las muestras. Cual es el código postal de la propiedad?"),
    U("15269 Sw 35th terrace Miami, Fl 33185"),
    A("El 33185 está cubierto. Tengo hoy jueves a las 3pm o 4pm, cual te queda mejor?"),
    U("3 pm"),
  ];
  const r6 = rewriteBookingDataAsk("Perfecto, te aparto las 3pm! Me das tu nombre, la dirección de la propiedad y el mejor número de teléfono?", yamiEs, false, "es");
  ck("ES: 'Me pasas el mejor número…' sem nome e sem ¿ (nome nunca é pedido, 16/09)", r6 === "Perfecto, te aparto las 3pm! Me pasas el mejor número de teléfono para contactarte?" && !/[¿¡]/.test(r6), r6);
  const r7 = rewriteBookingDataAsk("Perfect! What's the full property address, including the zip code, for the visit?", [U("I'm at 33176"), A("33176 is covered! I have 1pm or 3pm"), U("1pm")], false, "en");
  ck("endereço não digitado, só ZIP: pede o endereço SEM 'including the zip code'", r7 === "Perfect! Can I get the property address (number, street and city)?", r7);
  ck("bare 'Yesmin Alabart' após pedido de nome → nome dado", clientTypedName([A("Me das tu nombre y la dirección de la propiedad para reservarlo?"), U("Yesmin Alabart")]));
  ck("'Boca raton 33496' após pedido → NÃO é nome", !clientTypedName([A("What name should I put the visit under, and what's the city and zip code for that address?"), U("Boca raton 33496")]));
  ck("'Camila is my name' → nome dado", clientTypedName([A("What name should I put the visit under?"), U("Camila is my name")]));
  ck("'Not now my wife is sleeping Tomorrow Sorry' → NÃO é nome", !clientTypedName([A("Can I get your name, the property address, and the best phone number?"), U("Not now my wife is sleeping Tomorrow Sorry")]));
  ck("'What's your number?' → NÃO é nome", !clientTypedName([A("Can I get your name?"), U("What's your number?")]));
}

console.log("\n━━ 8. needAddressMessage com ZIP já dado ━━");
ck("EN zipKnown: sem 'zip'", !/zip/i.test(needAddressMessage("en", true)) && /number, street and city/.test(needAddressMessage("en", true)), needAddressMessage("en", true));
ck("ES zipKnown: sem 'código postal', sem ¿", !/postal/i.test(needAddressMessage("es", true)) && !/[¿¡]/.test(needAddressMessage("es", true)), needAddressMessage("es", true));
ck("PT zipKnown: sem 'zip'", !/zip/i.test(needAddressMessage("pt", true)), needAddressMessage("pt", true));
ck("EN default segue pedindo o zip", /zip code/.test(needAddressMessage("en")));
ck("ES default segue pedindo o código postal", /c[oó]digo postal/.test(needAddressMessage("es")));

console.log("\n━━ 9. withEarlierBookingFacts: ZIP fora da janela de 15 entra no histórico ━━");
{
  const at = (i: number) => new Date(Date.UTC(2026, 8, 12, 19, i)).toISOString();
  const rows: Array<{ role: string; content: string; created_at: string }> = [];
  const push = (m: { role: string; content: string }) => rows.push({ ...m, created_at: at(rows.length) });
  push(U("[Client replied to our ad]")); push(U("How much for 1200 sqft vinyl?")); push(A("Our vinyl promo is $5 per sqft. What's the zip code of the property?"));
  push(U("33180 It is a conso Conso Condo")); push(A("33180 is covered! I have tonight at 7pm or Sunday at 7pm?")); push(U("Is it waterproof?")); push(A("Yes, 100% waterproof."));
  push(U("How long does it take?")); push(A("2 to 3 days.")); push(U("Do you move furniture?")); push(A("Yes, we move everything."));
  push(U("What about baseboards?")); push(A("Quarter round is included.")); push(U("Ok")); push(A("Tonight is 7pm, that's the only opening left today. Want me to hold that for you?"));
  push(U("That is fine")); push(U("It works for us")); push(A("I'm holding that Sunday 7pm for you! Can I get your name, the property address, and the best phone number to confirm the visit?"));
  push(U("Is it tonight? Or sunday?")); push(U("We can do tonight")); push(A("Today is fully booked unfortunately, the next opening is tomorrow Sunday the 13th at 7pm. Want me to hold that for you?"));
  push(U("Ok that works for us")); push(A("I'm holding that Sunday 7pm for you! Can I get your name, the property address, and the best phone number to confirm the visit?"));
  push(U("Name is : Margarita Leon, 2775 NE 187th st apt 726- ph26"));
  const recent = rows.slice(-15); const older = rows.slice(0, -15);
  ck("controle: janela de 15 sozinha NÃO vê o ZIP", !clientAlreadyGaveZip(recent));
  const merged = withEarlierBookingFacts(older, recent);
  ck("janela + fatos anteriores vê o ZIP 33180", clientAlreadyGaveZip(merged));
  ck("só a bolha do ZIP foi carregada (16 linhas, ordem preservada)", merged.length === 16 && merged[0].content.startsWith("33180") && merged[1] === recent[0], String(merged.length));
  const r = rewriteBookingDataAsk("Almost there! What's the zip code for that address, and the best phone number to reach you?", merged, false, "en");
  ck("com o histórico mesclado o re-pedido do ZIP some", r === "Almost there! Can I get the best phone number to reach you?", r);
  const olderWithBooking = [...older, { ...A("Appointment confirmed for Sunday, September 6 at 7pm. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."), created_at: at(20) }];
  ck("fatos ANTES de uma visita já confirmada não são carregados", withEarlierBookingFacts(olderWithBooking, recent).length === recent.length);
  const stale = older.map((m) => ({ ...m, created_at: new Date(Date.UTC(2026, 7, 1)).toISOString() }));
  ck("fatos com mais de 14 dias não são carregados", withEarlierBookingFacts(stale, recent).length === recent.length);
  ck("sem histórico anterior → mesma janela", withEarlierBookingFacts([], recent) === recent);
  ck("carriesBookingFact: endereço/telefone/ZIP sim", carriesBookingFact("Yes 601 18th ave nw naples fl 34120 239-351-6729 Can you come today?") && carriesBookingFact("33020") && carriesBookingFact("my name is Beau"));
  ck("carriesBookingFact: pergunta / foto / metragem não", !carriesBookingFact("What is the installation process?") && !carriesBookingFact("[floor plan or photo]") && !carriesBookingFact("1000 sqft"));
  ck("containsBookingInfo continua reconhecendo endereço", containsBookingInfo("15269 Sw 35th terrace Miami, Fl 33185"));
}

console.log("\n━━ 10. Prompt ━━");
ck("prompt: regra ADDRESS ALREADY GIVEN", /ADDRESS ALREADY GIVEN/.test(SYSTEM_PROMPT));
ck("prompt: 'Read the WHOLE conversation before asking'", /Read the WHOLE conversation before asking/.test(SYSTEM_PROMPT));

console.log(`\n${pass} passed, ${fail} failed`);
if (fails.length) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
