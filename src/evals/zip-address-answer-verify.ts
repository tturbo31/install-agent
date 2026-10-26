/**
 * RESPOSTA AO PEDIDO DE ZIP COM O ENDEREÇO COMPLETO → HORÁRIOS (26/10/2026).
 * Dragos Strugaru (WhatsApp wa_17738995511, 26/10 11:45 ET): "50 Biscayne blvd,
 * Miami 33132" em resposta a "...What's the zip code of the property?" recebeu
 * "33132 is covered, we're in that area all the time." e NENHUM horário.
 * Causa: a exceção do anti-pressão (antiPressureShouldFire) só reconhecia a
 * resposta de localização até 4 palavras (isLocationAnswer); com 5 palavras o
 * guard disparou (a proposta da visita conta como push) e stripSchedulingPush
 * comeu a frase da oferta. Reproduzido ao vivo 2/2 com o histórico real: o
 * modelo escrevia a oferta e o log mostrava "[AI] anti-pressure: stripped
 * repeated scheduling push". Segundo achado da mesma verificação: "Let me
 * offer you ... which works?" era lido como monólogo (self-talk) e a frase da
 * oferta caía do mesmo jeito.
 *
 * Puro (sem modelo):
 *  1. isLocationAnswer: ZIP / endereço em qualquer frase; curta sem pergunta.
 *  2. asksForZip: nosso pedido do ZIP com ou sem "visit" na frase.
 *  3. antiPressureShouldFire: NÃO dispara no histórico do Dragos (nem nas
 *     variantes de endereço); continua disparando na pergunta informativa sem
 *     ZIP; o rascunho com a oferta sobrevive inteiro.
 *  4. Vazamento: "Let me offer you ..." limpo; a frase da Julie ("Let me offer
 *     Wednesday 7pm or Thursday 6pm. Then ask for the address.") continua
 *     monólogo.
 *  5. Estático: a exceção em ai.ts usa asksForZip + isLocationAnswer.
 * Ao vivo (LIVE=1): replay do Dragos com as mesmas notas do webhook do
 *  WhatsApp → a resposta oferece horários da linha mais próxima
 *  (offerLineDeviation null) e continua curta.
 * Run: npx tsx src/evals/zip-address-answer-verify.ts   |   LIVE=1 npx tsx src/evals/zip-address-answer-verify.ts
 */
import {
  isLocationAnswer, asksForZip, antiPressureShouldFire, stripSchedulingPush, assessReasoningLeak, containsSchedulingOffer,
  getAIResponse, adFlooringTypeNote, type ChatMessage,
} from "../lib/ai";
import { getRealAvailabilityContext, getEasternDateContext } from "../lib/scheduler";
import { offerLineDeviation } from "../lib/offer-line-guard";
import { sentenceCount } from "../lib/reply-length";
import { readFileSync } from "fs";
import { join } from "path";

function loadEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const PROMO = "Our vinyl promo is $5 per sqft and that already includes the flooring, installation, and quarter round. I offer a free quote, is it just one area or the whole house?";
const ZIP_ASK = "For a whole apartment I need to measure in person to give you the best price, it's free and I bring the samples. What's the zip code of the property?";
const ZIP_ASK_NO_VISIT = "Yes, 100% waterproof. What's the zip code of the property?";
const DRAGOS_ANSWER = "50 Biscayne blvd, Miami 33132";
const SHIPPED = "33132 is covered, we're in that area all the time.";
// O que o modelo escreve de verdade nesse turno (replay ao vivo 26/10/2026).
const DRAFT = `${SHIPPED} I can come by Wednesday at 9am or 6pm, which works better for you?`;

// Histórico real do Dragos até o endereço.
const dragos = (last: string): ChatMessage[] => [U("Hello"), A(OPENER), U("Luxury vinyl"), A(PROMO), U("Whole apartment"), A(ZIP_ASK), U(last)];
// Como o webhook entrega a última bolha ao cérebro: com a nota [SYSTEM: ...] colada.
const withNote = (msgs: ChatMessage[], note = "[SYSTEM: TODAY: Monday, October 26, 2026 [2026-10-26].\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• Wednesday, October 28, 2026 [2026-10-28]: 9am, 1pm, 6pm]"): ChatMessage[] => {
  const out = msgs.map((m) => ({ ...m }));
  out[out.length - 1] = { ...out[out.length - 1], content: `${out[out.length - 1].content}\n\n${note}` };
  return out;
};

console.log("\n━━ 1. isLocationAnswer: ZIP ou endereço em qualquer frase ━━");
for (const t of [
  "33132", "Miami 33132", "Coral Gables FL", "Homestead",
  DRAGOS_ANSWER, "50 Biscayne Blvd Miami FL 33132", "1234 NW 12th Ave Apt 5 Miami FL 33132", "it's in Coral Gables, 33134",
  "The property is at 50 Biscayne blvd in downtown Miami", "33132, is the quarter round included?", "50 Biscayne blvd, Miami 33132. Do you cover that area?",
  "Es en la calle 8, 33135", "33132 Brickell area, whole apartment about 1200 sqft",
]) ck(`location answer: ${JSON.stringify(t)}`, isLocationAnswer(t));
for (const t of [
  "Is it waterproof?", "How much for 1200 sqft?", "I have 2 bedrooms and a hallway, about 1200 sqft", "What's included in the $5?", "By the way, is the material included?",
]) ck(`NOT a location answer: ${JSON.stringify(t)}`, !isLocationAnswer(t));
ck("a nota [SYSTEM:] colada não muda o veredito", isLocationAnswer(withNote(dragos(DRAGOS_ANSWER))[6].content) && !isLocationAnswer(withNote(dragos("Is it waterproof?"))[6].content));

console.log("\n━━ 2. asksForZip ━━");
ck("proposta da visita com o ZIP", asksForZip(ZIP_ASK));
ck("pedido do ZIP sem 'visit' na frase", asksForZip(ZIP_ASK_NO_VISIT));
ck("espanhol: código postal", asksForZip("Perfecto! Cuál es el código postal de la propiedad?"));
ck("opener de tipo não pede ZIP", !asksForZip(OPENER));
ck("menção ao ZIP sem pergunta não é pedido", !asksForZip("33132 is covered, we're in that area all the time."));

console.log("\n━━ 3. antiPressureShouldFire: a resposta ao ZIP não é pressão ━━");
ck("Dragos: endereço completo (5 palavras) após o pedido do ZIP → guard NÃO dispara", !antiPressureShouldFire(withNote(dragos(DRAGOS_ANSWER))));
ck("ZIP sozinho (fluxo antigo) → guard NÃO dispara", !antiPressureShouldFire(withNote(dragos("33132"))));
ck("endereço longo com apartamento → guard NÃO dispara", !antiPressureShouldFire(withNote(dragos("1234 NW 12th Ave Apt 5 Miami FL 33132"))));
ck("ZIP + pergunta de produto junto → guard NÃO dispara (o modelo responde e oferece)", !antiPressureShouldFire(withNote(dragos("33132, is the quarter round included?"))));
ck("pedido do ZIP sem 'visit' + endereço → guard NÃO dispara", !antiPressureShouldFire(withNote([U("Hello"), A(OPENER), U("Luxury vinyl"), A(PROMO), U("Is it waterproof?"), A(ZIP_ASK_NO_VISIT), U(DRAGOS_ANSWER)])));
ck("pergunta informativa SEM ZIP após o pedido do ZIP → guard continua protegendo", antiPressureShouldFire(withNote(dragos("Is it waterproof?"))));
ck("'2 bedrooms and a hallway' (número sem rua) após o pedido do ZIP → não é localização, guard protege", antiPressureShouldFire(withNote(dragos("I have 2 bedrooms and a hallway, is the material included?"))));
// Depois do turno que saiu SEM horário (o que o Dragos recebeu), a primeira oferta nunca é repetição.
ck("após o turno sem horário, 'Ok' do cliente → guard NÃO dispara", !antiPressureShouldFire(withNote([...dragos(DRAGOS_ANSWER), A(SHIPPED), U("Ok")])));
ck("após o turno sem horário, pergunta de produto → guard NÃO dispara (ZIP em mãos, nenhum horário ofertado)", !antiPressureShouldFire(withNote([...dragos(DRAGOS_ANSWER), A(SHIPPED), U("Is it waterproof?")])));
ck("após o turno sem horário, o endereço reenviado (replay de resgate) → guard NÃO dispara", !antiPressureShouldFire(withNote([...dragos(DRAGOS_ANSWER), A(SHIPPED), U(DRAGOS_ANSWER)])));
ck("depois de um horário já ofertado, pergunta de produto → guard volta a proteger", antiPressureShouldFire(withNote([...dragos("33132"), A("33132 is covered! I have Wednesday at 9am or 6pm, which works better for you?"), U("Is it waterproof?")])));
{
  const msgs = withNote(dragos(DRAGOS_ANSWER));
  const out = antiPressureShouldFire(msgs) ? stripSchedulingPush(DRAFT) : DRAFT;
  ck("o rascunho com a oferta sobrevive inteiro no turno do Dragos", out === DRAFT, out);
  ck("(contra-prova) com o guard ligado a oferta vira exatamente o que foi enviado", stripSchedulingPush(DRAFT) === SHIPPED, stripSchedulingPush(DRAFT));
}

console.log("\n━━ 4. Vazamento: 'Let me offer you' é fala para o cliente ━━");
{
  const toClient = `${SHIPPED} Let me offer you Wednesday at 9am or 6pm, which works better?`;
  const r = assessReasoningLeak(toClient, {});
  ck("'Let me offer you ... which works?' fica inteiro", r.mode === "clean" && r.text === toClient, `${r.mode} ${r.signals.join("+")} → ${r.text}`);
  const julie = "Since the client specifically asked, I can accept it. Let me offer Wednesday 7pm or Thursday 6pm. Then ask for the address. Wednesday at 7pm or Thursday at 6pm, which works better for you?";
  const j = assessReasoningLeak(julie, {});
  ck("a frase da Julie ('Let me offer Wednesday 7pm...') continua monólogo", j.mode !== "clean" && j.signals.includes("self-talk") && !/let me offer/i.test(j.text), `${j.mode} ${j.signals.join("+")} → ${j.text}`);
  ck("'let me offer' sem 'you' ainda é sinal", assessReasoningLeak("Let me offer Wednesday 7pm or Thursday 6pm. Which works?", {}).mode !== "clean");
}

console.log("\n━━ 5. Estático ━━");
{
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("a exceção do anti-pressão acha o último pedido do ZIP (asksForZip ou proposta da visita)", /\(isVisitProposalWithZipAsk\(messages\[i\]\.content\) \|\| asksForZip\(messages\[i\]\.content\)\)/.test(ai));
  ck("a exceção vale enquanto respondido (isLocationAnswer) e sem horário ofertado desde então", /const answered = since\.some\(\(m\) => m\.role === "user" && isLocationAnswer\(m\.content\)\);/.test(ai) && /if \(answered && !offeredSince\) return false;/.test(ai));
  ck("isLocationAnswer lê o ZIP (zipsInText) e o endereço (STREET_ADDRESS)", /if \(zipsInText\(t\)\.length > 0 \|\| STREET_ADDRESS\.test\(t\)\) return true;/.test(ai));
  const leak = readFileSync(join(process.cwd(), "src/lib/reasoning-leak.ts"), "utf-8");
  ck("self-talk: 'let me offer' exclui 'let me offer you'", leak.includes(String.raw`/\blet\s+me\s+offer\b(?!\s+you\b)/.source`));
}

async function main() {
if (process.env.LIVE === "1") {
  console.log("\n━━ LIVE: replay do Dragos pelo cérebro com as notas do webhook do WhatsApp ━━");
  const phone = "17738995511";
  const hist = dragos(DRAGOS_ANSWER);
  const dateContext = getEasternDateContext();
  const availability = await getRealAvailabilityContext({ history: hist });
  const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
  const msgs = withNote(hist, `[SYSTEM: ${[dateContext, availability, waNote, adFlooringTypeNote("vinyl")].join("\n\n")}]`);
  const { getOrCreateSystemStore, readSystemMemory } = await import("../lib/dreaming");
  const { loadGlobalCorrections } = await import("../lib/corrections");
  const systemMemory = await getOrCreateSystemStore().then((id) => readSystemMemory(id)).catch(() => null);
  const corrections = await loadGlobalCorrections().catch(() => null);
  const N = Number(process.env.N ?? 2);
  // [A] o turno do Dragos como aconteceu; [B] o resgate: o endereço reenviado
  // depois do turno que saiu sem horário (a última mensagem nossa já não é o
  // pedido do ZIP, nenhum horário foi ofertado ainda).
  const rescueHist: ChatMessage[] = [...hist, A(SHIPPED), U(DRAGOS_ANSWER)];
  const scenarios: Array<[string, ChatMessage[], ChatMessage[]]> = [
    ["A endereço após o pedido do ZIP", hist, msgs],
    ["B endereço reenviado após o turno sem horário", rescueHist, withNote(rescueHist, `[SYSTEM: ${[dateContext, availability, waNote, adFlooringTypeNote("vinyl")].join("\n\n")}]`)],
  ];
  for (const [label, h, m] of scenarios) {
    for (let i = 1; i <= N; i++) {
      const r = await getAIResponse(m, null, systemMemory, corrections, false);
      const text = r.text;
      console.log(`  [${label} #${i}] ${text.replace(/\s+/g, " ")}`);
      ck(`[${label} #${i}] oferece horários`, containsSchedulingOffer(text) && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(text), text);
      const dev = offerLineDeviation(text, availability, h);
      ck(`[${label} #${i}] horários da linha real (dia mais próximo primeiro)`, dev === null, dev ? `${dev.kind}: ${dev.detail}` : "");
      ck(`[${label} #${i}] curta (até 3 frases) e sem handoff`, sentenceCount(text) <= 3 && !/NOTIFY_OWNER|674-8334/.test(text), text);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed${fails.length ? "\n  - " + fails.join("\n  - ") : ""}`);
process.exit(fail ? 1 : 0);
}
void main();
