// Regra do dono (26/08/2026): "ok" / obrigado / 👍 ENCERRA a conversa.
//   • O bot respondia "Sounds good, Ozzi will be in touch!" a cada "Ok" e o
//     cliente ficava num loop de despedidas (Dary, Edna, Burt, Jale, Angie —
//     WhatsApp, clientes de follow-up de orçamento, 18–26/08).
//   • Cliente de follow-up: ack → só 👍; "quero falar com o Ozzi" → UMA frase
//     fixa ("Claro, vou repassar para o Ozzi") + aviso ao dono; depois do
//     repasse, qualquer mensagem fica sem resposta (dono avisado).
//   • Fluxo normal (3 canais): ack puro depois de uma mensagem nossa que não
//     perguntou nada, ou 2º ack seguido, → [REACT_ONLY] determinístico.
// Run: npx tsx src/evals/ack-closing-verify.ts   (LIVE=0 pula as chamadas de API)
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse,
  isBareAck,
  isAckOnlyBurst,
  isAckClosingBurst,
  botAwaitsAnswer,
  isPureClosingBurst,
  promisesOwnerContact,
  containsSchedulingOffer,
  type ChatMessage,
} from "../lib/ai";
import {
  isTalkToOzziRequest,
  talkToOzziLang,
  talkToOzziMessage,
  quoteHandoffActive,
  isFinancingApprovalNote,
  composeQuoteReply,
  buildQuoteCtxMarker,
  parseQuoteCtxMarker,
  QUOTE_HANDOFF_SUFFIX,
} from "../lib/quote-reply";
import { followupPolicyViolation, financingApprovalNote, sanitizeOutbound } from "../lib/quote-followup";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[m[1]]) process.env[m[1]] = v;
      }
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 220)}»`); }
}
const U = (content: string) => ({ role: "user", content });
const A = (content: string) => ({ role: "assistant", content });

async function main() {
  // ── 1. isBareAck ──────────────────────────────────────────────────────────
  console.log("\n[1] isBareAck: ack puro (deve ser true)");
  for (const t of [
    "Ok", "ok", "OK.", "Okay", "okay!", "Ok cool", "ok perfect", "Perfect, thank you!", "Great", "Got it",
    "Sounds good", "👍", "🙏🙏", "❤️", "Thanks", "Thank you Ozzi!", "ok gracias", "Perfecto", "Entendido", "Listo",
    "Vale", "Ok thanks", "Ok bye", "ok I'll call you tomorrow", "Ta bom", "Beleza", "Ok obrigado", "Muchas gracias",
    "Okay thank you so much!", "Alright", "Cool", "No problem", "You too!", "Ok cool 👍", "Perfeito, obrigada",
    "Sounds good, thanks!", "ok ok", "Great thanks", "Ok 🙏",
  ]) ck(`ack: ${JSON.stringify(t)}`, isBareAck(t) === true);

  console.log("\n[1b] isBareAck: NÃO é ack (deve ser false)");
  for (const t of [
    "Yes", "Sure", "Claro", "Dale", "Sim", "Ok what time?", "Ok 1pm", "Ok Tuesday", "Ok go ahead", "Ok let's do it",
    "ok yes please", "Ok book it", "Ok send me the link", "That works", "?", "...", "1", "Good morning",
    "Ok I want to move forward", "Ok, my address is 123 Main St 33032", "Ok 786-555-1234", "Ok cancel it",
    "ok how much", "No", "Ok no", "Ok but what is included?", "Perfect, I applied", "Ok I will apply",
    "Gracias, cuánto es?", "Ready to move forward", "I will be using my own cc",
    "We ordered the floors and I'm waiting for delivery", "Dile que llame a mi esposo el tiene el numero gracias 🙏",
    "Ok cool, I'll pay cash", "Thanks, do you do screens?", "Thank you! Either vinyl or laminate",
    "Im going to pay cash", "Hey, yes I did", "No quiero hacer payments es que no estoy segura del color",
    "Ok, whole house", "ok vinyl", "",
  ]) ck(`não-ack: ${JSON.stringify(t)}`, isBareAck(t) === false);

  // ── 2. isAckClosingBurst (fluxo normal) ───────────────────────────────────
  console.log("\n[2] isAckClosingBurst: contexto decide");
  ck("'Ok' depois de 'Ozzi will reach out' → silêncio",
    isAckClosingBurst([U("Can we start next week?"), A("That's something Ozzi will go over with you directly, so I'll have him reach out to you soon."), U("Ok")]));
  ck("'Ok' depois de pergunta de slot → modelo (false)",
    !isAckClosingBurst([A("I have 1pm or 3pm open on Wednesday the 19th, which works better for you?"), U("Ok")]));
  ck("2º 'Ok' seguido, mesmo com pergunta nossa → silêncio (loop breaker)",
    isAckClosingBurst([A("I have 1pm or 3pm open on Wednesday, which works better?"), U("Ok"), A("Which works better, 1pm or 3pm on Wednesday the 19th?"), U("Ok")]));
  ck("'Nice' depois de pedido de nome → modelo (false)",
    !isAckClosingBurst([A("What name should I put the visit under?"), U("Nice")]));
  ck("burst 'Ok' + 'Thanks!' depois de handoff → silêncio",
    isAckClosingBurst([A("Ozzi will be in touch with you shortly."), U("Ok"), U("Thanks!")]));
  ck("burst 'Ok' + pedido real → modelo (false)",
    !isAckClosingBurst([A("Ozzi will be in touch with you shortly."), U("Ok"), U("actually can I get Tuesday?")]));
  ck("primeiro contato 'Ok' (sem assistant) → nunca silencia",
    !isAckClosingBurst([U("Ok")]));
  ck("'Perfect' depois de oferta de horário sem '?' → modelo (false)",
    !isAckClosingBurst([A("I have Wednesday the 26th at 1pm open for you."), U("Perfect")]));
  ck("'Ok' depois de 'tile, vinyl or hardwood?' → modelo (false)",
    !isAckClosingBurst([A("Which one are you interested in, tile, vinyl, or hardwood?"), U("OK")]));
  ck("'Okay' (Angie) depois da nota de aprovação → silêncio",
    isAckClosingBurst([A("As soon as your application is approved, Ozzi will personally reach out to you to finalize everything."), U("Okay")]));
  ck("'Ok thanks' depois de resposta informativa sem pergunta → silêncio",
    isAckClosingBurst([A("For a tile job we can install right over the existing tile as long as the surface is level, which we confirm at the visit."), U("Ok thanks")]));
  ck("'Ok' depois de mensagem com [SYSTEM:] sufixo e sem pergunta → silêncio",
    isAckClosingBurst([A("Ozzi will be in touch soon.\n\n[SYSTEM: FOLLOWUP_NUDGE]"), U("Ok")]));
  ck("isPureClosingBurst continua igual p/ 'thanks' depois de pedido de nome (false)",
    !isPureClosingBurst([A("What name should I put it under?"), U("It's John, thanks!")]));
  ck("botAwaitsAnswer: pergunta", botAwaitsAnswer("Which works better, 1pm or 3pm?"));
  ck("botAwaitsAnswer: oferta de horário sem '?'", botAwaitsAnswer("I have Wednesday at 1pm or 3pm open for you."));
  ck("botAwaitsAnswer: handoff → false", !botAwaitsAnswer("Sounds good, Ozzi will be in touch with you shortly to go over everything."));

  // ── 3. Fixtures reais (WhatsApp, follow-up de orçamento) ─────────────────
  console.log("\n[3] Casos reais: cliente de follow-up");
  const marker = buildQuoteCtxMarker({ valor: 5318, parcela: 148, idioma: "en", url: "https://app.gethearth.com/partners/ozzifloors" });
  const touch = A("Hi Dary, just wanted to check if you had a chance to look over your quote for $5,318. Any questions about the quote or the products, I am happy to clear them up." + marker);
  const note = A(financingApprovalNote("en"));
  const ctx = parseQuoteCtxMarker(touch.content, "2026-08-26T13:46:00Z")!;
  ck("marker parse", !!ctx && ctx.valor === 5318);
  // Dary
  const dary1 = [touch, U("Hey, yes I did"), U("We ordered the floors and I'm waiting for delivery")];
  ck("Dary: resposta real ao touch → NÃO é ack", !isAckOnlyBurst(dary1));
  ck("Dary: sem repasse ainda", !quoteHandoffActive(dary1));
  const dary2 = [...dary1, A("Sounds like the project is already in motion, sorry for the extra messages! Ozzi will follow up personally if anything is still pending on our end." + QUOTE_HANDOFF_SUFFIX), U("Im going to pay cash"), U("That's why I didn't complete this")];
  ck("Dary: depois do repasse (marcador) → silêncio + dono", quoteHandoffActive(dary2) && !isAckOnlyBurst(dary2));
  const dary2legacy = [...dary1, A("Got it, that makes perfect sense. Ozzi will be in touch with you directly to wrap everything up."), U("Im going to pay cash")];
  ck("Dary: repasse SEM marcador (linha antiga) ainda detectado", quoteHandoffActive(dary2legacy));
  const dary3 = [...dary2, A("Of course, no financing needed. Ozzi will personally reach out to you to finalize everything." + QUOTE_HANDOFF_SUFFIX), U("Ok cool")];
  ck("Dary: 'Ok cool' → 👍 e nada", isAckOnlyBurst(dary3));
  ck("Dary: 'Okay' de novo → 👍 e nada", isAckOnlyBurst([...dary3, A("Sounds good, talk soon!"), U("Okay")]));
  // Angie: nota de aprovação NÃO é repasse
  const angie = [touch, note, U("How much would the monthly be?")];
  ck("Angie: nota de aprovação não é repasse → pergunta é respondida", !quoteHandoffActive(angie) && !isAckOnlyBurst(angie));
  ck("Angie: 'Okay' depois da nota → 👍 e nada", isAckOnlyBurst([touch, note, U("Okay")]));
  ck("isFinancingApprovalNote en/es", isFinancingApprovalNote(financingApprovalNote("en")) && isFinancingApprovalNote(financingApprovalNote("es")) && !isFinancingApprovalNote("Ozzi will reach out"));
  // Touch novo reseta o repasse
  const newTouch = [U("call me"), A(talkToOzziMessage("en") + QUOTE_HANDOFF_SUFFIX), A("Hi Dary, your quote still stands, want to move forward?" + marker), U("What was the total again?")];
  ck("novo touch da plataforma depois do repasse → volta a responder", !quoteHandoffActive(newTouch));
  // Edna (ES)
  const edna = [touch, U("No quiero hacer payments es que no estoy segura del color que me trajo🙏"), A("No te preocupes Edna, Ozzi se comunicará contigo directamente para aclarar eso." + QUOTE_HANDOFF_SUFFIX), U("Dile que llame a mi esposo el tiene el numero gracias 🙏")];
  ck("Edna: 'Dile que llame a mi esposo' depois do repasse → silêncio + dono", quoteHandoffActive(edna));
  ck("Edna: 'Ok' → 👍 e nada", isAckOnlyBurst([...edna, A("Claro Edna, le digo a Ozzi que llame a tu esposo."), U("Ok")]));
  ck("promisesOwnerContact reconhece 'Ozzi se comunicará contigo'", promisesOwnerContact("Perfecto Edna, Ozzi se comunicará con él pronto."));
  // Burt
  const burt = [touch, note, U("Ready to move forward")];
  ck("Burt: 'Ready to move forward' → modelo (não ack, sem repasse)", !isAckOnlyBurst(burt) && !quoteHandoffActive(burt));
  ck("Burt: 'Ok' depois de 'Ozzi will personally reach out' → 👍 e nada",
    isAckOnlyBurst([...burt, A("Of course, no financing needed. Ozzi will personally reach out to you to finalize everything." + QUOTE_HANDOFF_SUFFIX), U("Ok")]));
  // Jale
  ck("Jale: 'Ok' → 👍 e nada", isAckOnlyBurst([touch, U("what is included?"), A("I don't have the full breakdown of your quote details here, but Ozzi will reach out to you directly to go over exactly what's included." + QUOTE_HANDOFF_SUFFIX), U("Ok")]));

  // ── 4. isTalkToOzziRequest ────────────────────────────────────────────────
  console.log("\n[4] isTalkToOzziRequest: pedido de falar com o Ozzi / ligação");
  for (const t of [
    "I want to talk to Ozzi", "Can I speak with Ozzi?", "Could i get Diego or someone to call Me? We want to move forward but had an issue come up",
    "Call me please", "Please have Ozzi call me", "Can someone call me?", "Give me a call", "I'd rather talk on the phone",
    "Is there a number I can call?", "Quiero hablar con Ozzi", "Me pueden llamar?", "Llámame por favor", "Que me llame Ozzi",
    "Dile que llame a mi esposo el tiene el numero gracias 🙏", "Quero falar com o Ozzi", "Me liga", "Pode me ligar?",
    "Can you have him call me tomorrow?", "I want to speak to a person",
  ]) ck(`pedido: ${JSON.stringify(t)}`, isTalkToOzziRequest(t) === true);
  console.log("\n[4b] NÃO é pedido de falar com o Ozzi");
  for (const t of [
    "Don't call me", "Stop calling me", "No me llamen más", "Thanks Ozzi!", "Ok", "I applied for financing",
    "What's included in the quote?", "I'll call you tomorrow", "Ready to move forward", "Im going to pay cash",
    "Not interested, please stop", "We ordered the floors and I'm waiting for delivery", "Para de me ligar",
  ]) ck(`não-pedido: ${JSON.stringify(t)}`, isTalkToOzziRequest(t) === false);
  ck("idioma: ES pelo pedido", talkToOzziLang("Dile que llame a mi esposo", "en") === "es");
  ck("idioma: PT pelo pedido", talkToOzziLang("Quero falar com o Ozzi", "en") === "pt");
  ck("idioma: EN pelo pedido", talkToOzziLang("call me please", "es") === "en");
  ck("idioma: fallback da plataforma", talkToOzziLang("...", "es") === "es");

  // ── 5. Mensagem fixa ──────────────────────────────────────────────────────
  console.log("\n[5] Mensagem fixa do repasse");
  for (const lang of ["en", "es", "pt"] as const) {
    const m = talkToOzziMessage(lang);
    ck(`${lang}: passa no portão (sem oferta de horário, sem desconto)`, followupPolicyViolation(m) === null, m);
    ck(`${lang}: não dispara o detector de agendamento`, !containsSchedulingOffer(m), m);
    ck(`${lang}: sanitizeOutbound deixa intacta`, sanitizeOutbound(m) === m, sanitizeOutbound(m));
    ck(`${lang}: sem '?', sem venda`, !m.includes("?") && !/quote|cotiza|orçamento|financ/i.test(m), m);
  }
  ck("en: promete contato do Ozzi (promisesOwnerContact)", promisesOwnerContact(talkToOzziMessage("en")));
  ck("es: promete contato do Ozzi (promisesOwnerContact)", promisesOwnerContact(talkToOzziMessage("es")));
  ck("pt: promete contato do Ozzi (promisesOwnerContact)", promisesOwnerContact(talkToOzziMessage("pt")));

  // ── 6. Fiação (código-fonte) ──────────────────────────────────────────────
  console.log("\n[6] Fiação nos webhooks e prompts");
  const wa = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8");
  const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const qr = readFileSync(join(process.cwd(), "src/lib/quote-reply.ts"), "utf-8");
  for (const [n, s] of [["wa", wa], ["fb", fb], ["ig", ig]] as const)
    ck(`${n}: react-only usa isAckClosingBurst(history)`, /isPureClosingBurst\(history\) \|\| isAckClosingBurst\(history\)/.test(s));
  ck("wa: follow-up ack → só 👍", /isAckOnlyBurst\(historico\) \|\| isPureClosing\(rawText\)[\s\S]{0,120}sendWhatsAppReaction\(phone, messageId, "👍"\)/.test(wa));
  ck("wa: depois do repasse → silêncio + dono", /quoteHandoffActive\(historico\)[\s\S]{0,500}QUOTE_AFTER_HANDOFF_ALERT[\s\S]{0,160}return;/.test(wa));
  ck("wa: pedido de falar com o Ozzi → frase fixa", /isTalkToOzziRequest\(quoteBurst\)[\s\S]{0,200}talkToOzziMessage\(talkToOzziLang\(quoteBurst, quoteCtx\.idioma\)\)/.test(wa));
  ck("wa: repasse gravado com QUOTE_HANDOFF_SUFFIX", /reply\.notifyOwner \? reply\.text \+ QUOTE_HANDOFF_SUFFIX : reply\.text/.test(wa));
  ck("wa: [REACT_ONLY] do quote-reply → 👍", /reply\.reactOnly[\s\S]{0,80}sendWhatsAppReaction/.test(wa));
  ck("wa: o ack do follow-up vem ANTES do modelo", wa.indexOf("isAckOnlyBurst(historico)") < wa.indexOf("composeQuoteReply({ ctx: quoteCtx"));
  ck("prompt principal: 'ok' após não-pergunta e ack após handoff → [REACT_ONLY]", /One handoff line is the END of the conversation/.test(aiSrc));
  ck("prompt quote-reply: regra 15 [REACT_ONLY]", /15\. If the client's message is ONLY an acknowledgment/.test(qr) && /\[REACT_ONLY\] \(alone, rule 15\)/.test(qr));
  ck("prompt quote-reply: regra 16 falar com o Ozzi", /16\. If the client asks to talk to Ozzi or to a person/.test(qr));

  // ── 7. LIVE (modelo) ──────────────────────────────────────────────────────
  if (process.env.LIVE !== "0" && process.env.ANTHROPIC_API_KEY) {
    console.log("\n[7] LIVE: cérebro principal, 'Ok' depois do handoff → [REACT_ONLY]");
    const hist: ChatMessage[] = [
      { role: "user", content: "Hi, I saw your ad. How much for vinyl in a 900 sqft apartment?" },
      { role: "assistant", content: "Hi! Our luxury vinyl promotion is $5 per square foot with the floor and installation included. For 900 sqft that comes to about $4,500. Want me to set up a free visit so we can measure and give you the exact price on site?" },
      { role: "user", content: "Can we start talking about the floor next Wednesday or Thursday?" },
      { role: "assistant", content: "That's something Ozzi will go over with you directly, so I'll have him reach out to you soon to sort out the details." },
      { role: "user", content: "Ok" },
    ];
    try {
      const r = await getAIResponse(hist, null, null, null, false).then((x) => x.text);
      ck("modelo responde só [REACT_ONLY]", /^\s*\[REACT_ONLY\]\s*$/i.test(r), r);
    } catch (e) { ck("modelo respondeu", false, String(e)); }

    console.log("\n[7b] LIVE: quote-reply, 'Ok' → reactOnly (backstop do prompt; em prod a guarda determinística vem antes)");
    try {
      const r = await composeQuoteReply({ ctx, history: [...burt, A("Of course, no financing needed. Ozzi will personally reach out to you to finalize everything."), U("Ok")], clientText: "Ok" });
      ck("quote-reply: reactOnly=true, sem texto", r.reactOnly === true && r.text === "", JSON.stringify(r));
    } catch (e) { ck("quote-reply respondeu", false, String(e)); }

    console.log("\n[7c] LIVE: quote-reply, pergunta real ainda é respondida");
    try {
      const r = await composeQuoteReply({ ctx, history: [touch, note, U("How does the financing work?")], clientText: "How does the financing work?" });
      ck("quote-reply: responde (não reactOnly)", !r.reactOnly && r.text.length > 20, JSON.stringify(r));
    } catch (e) { ck("quote-reply respondeu", false, String(e)); }
  } else {
    console.log("\n[7] LIVE pulado (LIVE=0 ou sem ANTHROPIC_API_KEY)");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
