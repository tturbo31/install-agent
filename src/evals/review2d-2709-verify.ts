// Revisão 2 dias 25-27/09/2026 (pedido do dono: "veja se deu erro e melhore" +
// follow-up só depois de 2 dias + respostas curtas). Só funções puras: zero
// API, zero envio. Cada bloco reproduz um caso REAL da janela.
// Run: npx tsx src/evals/review2d-2709-verify.ts
import {
  isFirstContactRejection,
  isHostileRejection,
  smallJobStanding,
  stripSchedulingPush,
  dropOrphanSchedulingStumps,
  rewriteBookingDataAsk,
  softenVisitClaim,
  assertsExistingAppointment,
  staleThreadGapHours,
} from "@/lib/ai";
import { bookingEpisodeHistory, dayOnlyPickNeedsTime, clientConfirmedSlot, bookedTimeSeenInConversation, bookedSlotMismatchesPromise, unsupportedFloorDeclineMessage } from "@/lib/scheduler";
import { isInstallAck, installHandoffMessage } from "@/lib/instalacao";
import { decideFollowup, followupTemplate, ghostTemplate, financingTemplate, lastTouchTemplate, FOLLOWUP_MARKER, isClientDeferral, FOLLOWUP_DELAY_H, MAX_NUDGES_PER_CONVERSATION, type FollowupMsg } from "@/lib/followup";
import { WHAT_IS_INCLUDED_ASK_TYPE, composeAdFaqOpener } from "@/lib/system-prompt";
import { REPLY_TARGET_CHARS, REPLY_TIGHTEN_OVER, needsTightening, sentenceCount } from "@/lib/reply-length";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const U = (c: string, at?: string) => ({ role: "user" as const, content: c, at });
const A = (c: string, at?: string) => ({ role: "assistant" as const, content: c, at });

console.log("\n── 1. Brian Ander (FB 27/09): visita fantasma a partir de um episódio de agosto ──");
const brian = [
  U("What is the installation process?"), A("Great question, we move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?"),
  U("can we set up a meeting next week  to come to the house and get a quote"), U("vinyl or hardwood"), A("For next week I have Monday the 17th at 9am or 11am, which works better for you?"),
  U("monday the 17th at 9Am is perfect"), A("Perfect, Monday the 17th at 9am works! Can I get your name, the full property address with the zip code, and the best phone number for the visit?"),
  U("brian a\n2940 E Sample Ave \ncooper city Fl 33026\n5615550123"), A("Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."),
  U("thank you"), U("Do you offer any discounts or promotions?"),
];
const ep = bookingEpisodeHistory(brian);
check("episódio corrente começa depois de 'Appointment confirmed.' (2 bolhas)", ep.length === 2 && ep[0].content === "thank you", String(ep.length));
check("histórico inteiro ainda 'confirma' o slot (o bug)", clientConfirmedSlot(brian));
check("episódio corrente NÃO confirma slot → [BOOK] bloqueado", !clientConfirmedSlot(ep));
check("9am não aparece no episódio corrente", !bookedTimeSeenInConversation(ep, "09:00"));
check("confirmação anexada depois da resposta ('...discounts.\\n\\nAppointment confirmed for Monday...') também corta", bookingEpisodeHistory([...brian, A("Yes, for larger spaces we offer discounts.\n\nAppointment confirmed for Monday, October 5 at 9am. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."), U("Wait, I never asked for that")]).length === 1);
check("sem confirmação anterior: histórico inteiro", bookingEpisodeHistory(brian.slice(0, 8)).length === 8);
check("remarcação (Nicole 26/09) segue confirmando no episódio novo: 'Next weekend I have Saturday October 3rd at 9am or 1pm' → '9am works'", clientConfirmedSlot(bookingEpisodeHistory([...brian.slice(0, 9), U("Can we reschedule for next weekend?"), A("No worries at all! Next weekend I have Saturday October 3rd at 9am or 1pm, which works better?"), U("9am works")])));
check("Melissa (WA 27/09): oferta e escolha no episódio novo passam", clientConfirmedSlot(bookingEpisodeHistory([...brian.slice(0, 9), U("Is it the same price for a commercial space?"), A("Yes, same pricing. I have today at 7pm or Monday at 3pm, which works better?"), U("Tomorrow 3pm is better")])));

console.log("\n── 2. Claudio (WA 26/09): 'Ok lunes' com 1pm ou 3pm ofertados → perguntar a hora ──");
const claudio = [
  U("Ahí que medir pero más menos unos 3000"), A("Para ese tamaño necesito medir en persona para darte el precio exacto, la visita es gratis y llevo todas las muestras. Te viene mejor manana domingo a la 1pm o 3pm?"),
  U("2001 NW 100th ST FL 33142"), A("Tienen razon, ya lo tengo. Manana domingo puedo a la 1pm o 3pm, cual les viene mejor?"),
  U("Hoy"), U("O el lunes"), A("Hoy estoy completo, pero el lunes tengo la 1pm o 3pm. Cual le viene mejor?"),
  U("Ok lunes"),
];
check("dia sem hora com 2 horas ofertadas → precisa da hora", dayOnlyPickNeedsTime(claudio));
check("'Ok lunes a la 1pm' → hora dada, não pede", !dayOnlyPickNeedsTime([...claudio.slice(0, -1), U("Ok lunes a la 1pm")]));
check("'Lunes' + '3pm' em duas bolhas → não pede", !dayOnlyPickNeedsTime([...claudio.slice(0, -1), U("Lunes"), U("3pm")]));
check("'the first one' → não pede", !dayOnlyPickNeedsTime([...claudio.slice(0, -1), U("the first one")]));
check("oferta com UMA hora para o dia ('Monday at 3pm?') → dia basta", !dayOnlyPickNeedsTime([U("hi"), A("For that size I need to measure in person, it's free. Does Monday at 3pm work?"), U("Monday works")]));
check("vários dias: 'Monday 3pm or 4pm, Tuesday 2pm or 3pm' → 'Tuesday' pede a hora", dayOnlyPickNeedsTime([U("hi"), A("Monday I have 3pm or 4pm, Tuesday I have 2pm or 3pm, which works best for you?"), U("Tuesday")]));
check("vários dias: 'Monday at 3pm or Tuesday at 2pm' → 'Tuesday' basta (1 hora nesse dia)", !dayOnlyPickNeedsTime([U("hi"), A("I have Monday at 3pm or Tuesday at 2pm, which works?"), U("Tuesday")]));
check("sem dia na rajada (endereço) → não interfere", !dayOnlyPickNeedsTime([...claudio.slice(0, -1), U("2001 NW 100th ST 33142")]));

console.log("\n── 3. Claudio (WA 26/09): pedir o ZIP que acabou de ser digitado, sem hora escolhida → repete a oferta ──");
const claudioZip = claudio.slice(0, 3);
const zipAsk = "Necesito el código postal para terminar de agendarlo, cual es el zip de esa dirección?";
const r3 = rewriteBookingDataAsk(zipAsk, claudioZip, true, "es");
check("a frase deixa de pedir o ZIP", !/c[oó]digo postal|zip/i.test(r3), r3);
check("e vira a escolha do horário ofertado (1pm o 3pm)", /1pm o 3pm/.test(r3) && /\?/.test(r3), r3);
check("com hora já escolhida a frase fica para o retry forçado (inalterada)", rewriteBookingDataAsk(zipAsk, [...claudioZip, U("la 1pm")], true, "es") === zipAsk);
check("pedido de item que FALTA continua igual (telefone no IG)", /phone/i.test(rewriteBookingDataAsk("Can I get the best phone number to reach you?", [U("Tuesday @2pm is perfect"), U("1012 NE 100th Street Biscayne Park, FL 33161")], false, "en")));
check("Davide (IG 26/09): endereço+ZIP dados, telefone não → pede só o telefone", /phone/i.test(rewriteBookingDataAsk("Perfect, can I get the full property address with the zip code and the best phone number for the visit?", [A("Monday I have 3pm or 4pm, Tuesday I have 2pm or 3pm, which works best for you?"), U("Tuesday @2pm is perfect"), U("1012 NE 100th Street Biscayne Park, FL 33161 David B")], false, "en")) && !/address/i.test(rewriteBookingDataAsk("Perfect, can I get the full property address with the zip code and the best phone number for the visit?", [A("Monday I have 3pm or 4pm, Tuesday I have 2pm or 3pm, which works best for you?"), U("Tuesday @2pm is perfect"), U("1012 NE 100th Street Biscayne Park, FL 33161 David B")], false, "en")));

console.log("\n── 4. fb_26945544551739375 (27/09): '1pm tomorrow is confirmed!' sem [BOOK] ──");
const soft = softenVisitClaim("1pm tomorrow is confirmed! Can I get the full property address with the zip code and your best phone number?", "en");
check("'is confirmed' vira 'penciled in'", /penciled in/.test(soft) && !/confirmed/.test(soft), soft);
check("linha enlatada de confirmação real nunca é tocada", softenVisitClaim("Appointment confirmed for Monday, September 28 at 5pm. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.", "en").startsWith("Appointment confirmed"));
check("'Your visit is confirmed for' (visita real restated) intocada", softenVisitClaim("Your visit is confirmed for Monday at 1pm.", "en").startsWith("Your visit is confirmed"));

console.log("\n── 5. Anti-pressão sem tocos (fb_28561144770208248, Pucha, tranquile_58, mbameera) ──");
check("'Which one is better for you?' sem opções cai", dropOrphanSchedulingStumps("October 8 works perfectly then. Which one is better for you?") === "October 8 works perfectly then.");
check("'which one do you prefer?' cai", dropOrphanSchedulingStumps("October 7 works. Which one do you prefer?") === "October 7 works.");
check("'Sunday.' solto cai", dropOrphanSchedulingStumps("Yes, larger spaces get our best pricing and the estimate is free. Sunday.") === "Yes, larger spaces get our best pricing and the estimate is free.");
check("pergunta do tipo com opções FICA", dropOrphanSchedulingStumps("Larger spaces get our best pricing. Which one is it, tile, vinyl, or hardwood?").includes("Which one is it, tile, vinyl, or hardwood?"));
check("'Which works better, 1pm or 3pm?' (tem opções) fica", dropOrphanSchedulingStumps("I have Sunday at 1pm or 3pm. Which works better, 1pm or 3pm?").includes("Which works better"));
const mb = stripSchedulingPush("Unfortunately we don't carry any outdoor flooring products, just luxury vinyl, tile, hardwood, and carpet for indoor spaces. For the apartment's interior, does today at 7pm or Monday at 4pm work?");
check("preâmbulo da pergunta cortada ('For the apartment's interior.') não sobra", !/apartment's interior/.test(mb), mb);
check("a informação antes fica", /outdoor flooring/.test(mb));
const s8 = stripSchedulingPush("October 8 works perfectly then. I have October 8 at 9am or 11am, which works better for you?");
check("corte + toco de escolha: só a afirmação fica", s8 === "October 8 works perfectly then.", s8);
check("sem corte, nada muda", stripSchedulingPush("Great, which one is better for you?") === "Great, which one is better for you?");

console.log("\n── 6. Menos de 400 sqft: um cômodo 10x10 não é o projeto (Ashley IG, YAMIL WA) ──");
check("Ashley: '(3) 10by 10 rooms, (1) 12by18, all rooms' → não é small job", smallJobStanding([U("What is all in price per sq ft for (3 )10by 10 rooms , (1 )12by18 all rooms currently have carpet in them")]) === null);
check("YAMIL: two bedrooms + downstairs living dining kitchen + 'the kitchen is 10x10' → não é small job", smallJobStanding([U("Hardwood"), U("Small townhouse two bedrooms\nDownstairs is living dining kitchen"), U("I know the kitchen is 10x10")]) === null);
check("um cômodo só ('my kitchen is 10x10') continua small (100)", smallJobStanding([U("my kitchen is 10x10")]) === 100);
check("total explícito manda mesmo com vários cômodos ('2 bedrooms, 300 sqft total')", smallJobStanding([U("2 bedrooms, about 300 sqft total")]) === 300);
check("'350 sqft' simples continua small", smallJobStanding([U("about 350 sqft")]) === 350);
check("Graciela (IG 27/09): '10x13 ft' sozinho continua small (130)", smallJobStanding([U("It is 10x13 ft, I have my own tile")]) === 130);

console.log("\n── 7. Recusas no 1º contato que levaram o opener ──");
for (const t of ["No????????????? STOP Spamming", "Nooooooooooo !!!🤦🚫🫷", "No. Need polish", "None", "Not", "Not at all. Didn't know the ad was for flooring.", "just looking", "I'm a kid", "No we do epoxy", "Ahora mismo no pero si mi clientes preguntan con mucho gusto lo recomendaría", "What? No thanks", "amen", "No thanks", "not interested"]) {
  check(`silêncio: ${JSON.stringify(t)}`, isFirstContactRejection(t));
}
for (const t of ["Can you get ur AI off my D", "They need to turn that shit off", "Can I blow u"]) {
  check(`hostil: ${JSON.stringify(t)}`, isHostileRejection(t) && isFirstContactRejection(t));
}
for (const t of ["No, I want tile for the kitchen", "How much for vinyl?", "not sure yet, what do you charge per sqft?", "No thanks, but do you do carpet?", "I need new floors for my house", "Take the old tile off and put vinyl?", "just looking for a quote on 800 sqft of vinyl"]) {
  check(`interesse continua com o modelo: ${JSON.stringify(t)}`, !isFirstContactRejection(t) && !isHostileRejection(t));
}
check("'No' que abre episódio novo (6h+ de silêncio) conta como recusa de 1º contato", staleThreadGapHours([U("hi", "2026-09-20T10:00:00Z"), A("Which one?", "2026-09-20T10:01:00Z"), U("No", "2026-09-27T21:00:00Z")]) !== null && isFirstContactRejection("No"));

console.log("\n── 8. Nathalie (WA 27/09): 'Perfect we are ready' depois do lembrete de instalação ──");
for (const t of ["Perfect we are ready", "We're ready!", "Ready", "All set, thanks", "Ok we will be here", "Confirmed", "Perfecto, estamos listos", "Sim, estamos prontos"]) check(`ack: ${JSON.stringify(t)}`, isInstallAck(t));
for (const t of ["What time exactly?", "Can we move it to Tuesday?", "Do I need to move the furniture?"]) check(`não é ack: ${JSON.stringify(t)}`, !isInstallAck(t));
for (const lang of ["en", "es", "pt"] as const) {
  const h = installHandoffMessage(lang);
  check(`handoff/${lang} dá o número do Ozzi e não promete retorno`, /674-8334/.test(h) && !/get in touch|se comunicar|entrar[aá] em contato|shortly|en breve/i.test(h), h);
}

console.log("\n── 9. Niki (WA 26/09): 'I scheduled an appointment for tomorrow at 9 AM' é visita afirmada ──");
check("assertsExistingAppointment", assertsExistingAppointment("Hey guys, how are you? I scheduled an appointment for tomorrow at 9 AM. But I won't be able to make it since I have to tour properties with clients. Can we reschedule for next weekend?", "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."));
check("pedido de visita nova não é afirmação", !assertsExistingAppointment("Can I schedule an appointment for tomorrow at 9am?", null));

console.log("\n── 10. Follow-up: só depois de 2 dias, de 2 em 2 dias, no máximo 2, só WhatsApp ──");
const NOW = Date.parse("2026-09-27T18:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const m = (role: "user" | "assistant", content: string, hoursAgo: number): FollowupMsg => ({ role, content, created_at: at(hoursAgo) });
const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const VISIT_OFFER = "For a whole house I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Tuesday at 9am or 1pm, what works better for you?";
const engaged = (h: number) => [m("user", "How much for new floors?", h + 0.5), m("assistant", OPENER, h + 0.5), m("user", "Vinyl, the whole house", h), m("assistant", VISIT_OFFER, h - 0.05)];
check("constantes: 48h e máximo 2", FOLLOWUP_DELAY_H === 48 && MAX_NUDGES_PER_CONVERSATION === 2);
let d = decideFollowup("wa_15551234567", engaged(1.2), NOW);
check("WhatsApp, 1.2h de silêncio → cedo demais (antes: elegível)", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup("wa_15551234567", engaged(30), NOW);
check("WhatsApp engajado, 30h → ELEGÍVEL (29/09: lead engajado volta ao ritmo de 3h; a regra de 2 dias fica só para o fantasma do botão)", d.eligible && d.kind === "engaged", d.reason);
d = decideFollowup("wa_15551234567", engaged(49), NOW);
check("WhatsApp, 49h → ELEGÍVEL (engaged)", d.eligible && d.kind === "engaged", d.reason);
d = decideFollowup("wa_15551234567", engaged(5 * 24 + 2), NOW);
check("WhatsApp, 5 dias e 2h → janela fechada", !d.eligible && /window-closed/.test(d.reason), d.reason);
d = decideFollowup("fb_123", engaged(49), NOW);
check("Messenger, 49h → nunca (janela de 24h da Meta já fechou)", !d.eligible && /window-closed|channel-window/.test(d.reason), d.reason);
d = decideFollowup("1777752696862664", engaged(49), NOW);
check("Instagram, 49h → nunca (janela de 24h da Meta já fechou)", !d.eligible && /window-closed|channel-window/.test(d.reason), d.reason);
d = decideFollowup("fb_123", engaged(1.2), NOW);
check("Messenger, 1.2h (o alvo antigo) → nunca", !d.eligible, d.reason);
const ghost = (h: number) => [m("user", "What is the installation process?", h), m("assistant", OPENER, h - 0.02)];
d = decideFollowup("wa_15551234567", ghost(49), NOW);
check("fantasma do botão no WhatsApp, 49h → elegível (faq_ghost)", d.eligible && d.kind === "faq_ghost", d.reason);
d = decideFollowup("wa_15551234567", ghost(2), NOW);
check("fantasma do botão, 2h → cedo demais", !d.eligible, d.reason);
// segunda nudge
const first = [...engaged(100), m("assistant", followupTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 47)];
d = decideFollowup("wa_15551234567", first, NOW);
check("1ª nudge há 47h → 2ª ainda não", !d.eligible && /second-touch-too-soon/.test(d.reason), d.reason);
const second = [...engaged(100), m("assistant", followupTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 49)];
d = decideFollowup("wa_15551234567", second, NOW);
check("1ª nudge há 49h, cliente mudo → 2ª e última (last_touch)", d.eligible && d.kind === "last_touch", d.reason);
d = decideFollowup("wa_15551234567", [...second, m("assistant", lastTouchTemplate("en"), 49)], NOW);
check("2 nudges já enviadas → nunca uma 3ª", !d.eligible && d.reason === "max-nudges-reached", d.reason);
d = decideFollowup("wa_15551234567", [...engaged(100), m("assistant", ghostTemplate("en"), 100), m("user", "No", 60)], NOW);
check("cliente respondeu 'No' à nudge → cliente tem a última palavra, nada", !d.eligible && d.reason === "client-has-last-word", d.reason);
d = decideFollowup("wa_15551234567", [...engaged(100).slice(0, 3), m("user", "None", 60), m("assistant", "No problem, which flooring are you thinking about?", 59)], NOW);
check("'None' como última fala do cliente = recusa, sem nudge", !d.eligible && d.reason === "client-deferred", d.reason);
check("isClientDeferral('No')", isClientDeferral("No") && isClientDeferral("None") && isClientDeferral("no thanks") && !isClientDeferral("No, the whole house"));
for (const lang of ["en", "es", "pt"] as const) {
  for (const [nome, t] of [["classic", followupTemplate(lang)], ["ghost", ghostTemplate(lang)], ["financing", financingTemplate(lang)], ["last", lastTouchTemplate(lang)]] as const) {
    check(`${nome}/${lang}: marcador, sem traço/emoji, ≤ 2 frases, ≤ 170c, sem dia/hora`, FOLLOWUP_MARKER.test(t) && !/[-–—]/.test(t) && sentenceCount(t) <= 2 && t.length <= 170 && !/\b\d{1,2}\s*(?:am|pm)\b|\b(?:monday|lunes|segunda|this week|esta semana)\b/i.test(t), `${t.length}c: ${t}`);
  }
}
check("marcador antigo continua reconhecido (dedup histórico)", FOLLOWUP_MARKER.test("Hi, want me to check a time this week for your free estimate visit? I bring all the samples and you get the exact price on the spot."));

console.log("\n── 11. Respostas curtas: enlatados e orçamento ──");
check("enlatado das inclusões: 2 frases (era 3), < 180c, mantém 'labor only' e quem põe o material", sentenceCount(WHAT_IS_INCLUDED_ASK_TYPE) === 2 && WHAT_IS_INCLUDED_ASK_TYPE.length < 180 && /labor only/.test(WHAT_IS_INCLUDED_ASK_TYPE) && /you supply the material/.test(WHAT_IS_INCLUDED_ASK_TYPE), `${WHAT_IS_INCLUDED_ASK_TYPE.length}c`);
const trio = composeAdFaqOpener(["process", "discount", "inclusions"], "en") ?? "";
check("rajada de 3 botões < 300c (antes 314)", trio.length < 300 && /Homestead|2 to 3 days/.test(trio) && /tile, vinyl, or hardwood\?$/.test(trio), `${trio.length}c: ${trio}`);
check("orçamento da rede (29/09): 160 na reescrita, 220 de teto; o prompt segue pedindo 140/200", REPLY_TARGET_CHARS === 160 && REPLY_TIGHTEN_OVER === 220);
check("205 caracteres visíveis NÃO disparam mais a reescrita (rede em 220 desde 29/09); 230 disparam", !needsTightening("Hardwood is nailed down and can't be lifted clean, so for a rental our luxury vinyl is the better fit since it clicks together and lifts with zero damage, promo is $5 per sqft with the floor included. Size?") && needsTightening("Hardwood is nailed down and can't be lifted clean, so for a rental our luxury vinyl is the better fit since it clicks together and lifts with zero damage, promo is $5 per sqft with the floor and the installation included. What size is it?"));
check("resposta normal de 130c não dispara", !needsTightening("For 1,600 sqft I need to measure in person to give you the best price, it's free and I bring samples. Thursday at 9am or 1pm?"));
for (const lang of ["en", "es", "pt"] as const) {
  const t = unsupportedFloorDeclineMessage(lang);
  check(`recusa de piso que não fazemos/${lang}: 2 frases, cita epoxy e o que instalamos`, sentenceCount(t) === 2 && /ep[oó]x/i.test(t) && /carpet|alfombra|carpete/i.test(t) && /vinyl|vin[ií]lico/i.test(t), `${sentenceCount(t)} fr: ${t}`);
}

console.log(`\n=========== REVIEW2D-2709-VERIFY: ${passed} passed, ${failed} failed ===========`);
process.exit(failed > 0 ? 1 : 0);
