/**
 * GUARDA da revisão de 5 dias de 2026-08-10 — "IA não responde".
 *
 * Casos reais que motivaram cada fix:
 *  A. maxDuration 60s matava o turno NO MEIO (msg gravada, resposta nunca
 *     gerada, zero alerta): voice note WA (Kathe), lead de anúncio WA (Yeret),
 *     FAQ FB (fb_27715106454784027) — anomalias espalhadas nos 3 canais.
 *  B. Pergunta repetida após resposta → modelo regenera igual → guarda de
 *     duplicata silenciava = ar morto (Cathy 0d12b131, fb 010e3e84,
 *     fb d3b9394d). Agora: recap rotativo "As I mentioned above", cap 2.
 *  C. "Ozzi will reach out" SEM [NOTIFY_OWNER] era promessa vazia — Jorge
 *     (wa_13059155997) esperou semanas, 5 promessas, job de $16.625 perdido.
 *     Agora: backstop determinístico notifica o dono mesmo sem o tag.
 *  D. Falha de envio do nudge de re-tap / fallback no-content sumia sem rastro
 *     (Emoney: 5 taps, 5 respostas perdidas invisíveis). Agora: fila SEND_FAILED
 *     (outbox reenvia 48h; erro por destinatário desiste sozinho).
 *  E. WA: voice note sem transcrição ganhava fallback genérico; agora tem a
 *     linha específica de voz (paridade com IG).
 *
 * ZERO chamadas de API: inspeção de fonte + unit tests puros. Rodar:
 *   npx tsx src/evals/silence-guards-aug10-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { recapForDuplicateReply, promisesOwnerContact, isConsecutiveDuplicate } from "../lib/ai";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 140)}»`); }
}

const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf8");
const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf8");
const wa = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf8");
const canais = [["IG", ig], ["FB", fb], ["WA", wa]] as const;

console.log("\n[A. maxDuration — sem morte no meio do voo]");
for (const [nome, src] of canais) {
  ck(`${nome}: maxDuration = 300`, /export const maxDuration = 300;/.test(src), "voltou a um teto que mata turnos lentos no meio");
}

console.log("\n[B. recap em vez de silêncio na pergunta repetida]");
for (const [nome, src] of canais) {
  ck(`${nome}: guarda de duplicata usa recapForDuplicateReply`, /recapForDuplicateReply\(messagesForAI, finalResponse\)/.test(src), "voltou ao return silencioso puro");
  ck(`${nome}: envia outboundResponse (recap aplicado)`, /outboundResponse/.test(src), "resposta enviada ignora o recap");
}
// unit: 1ª repetição vira recap, cap corta na 3ª
const answer = "We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish.";
const hist1 = [
  { role: "user" as const, content: "What is the installation process?" },
  { role: "assistant" as const, content: answer },
  { role: "user" as const, content: "What is the installation process?" },
];
const r1 = recapForDuplicateReply(hist1, answer);
ck("unit: repetição 1 → recap com prefixo", !!r1 && r1 !== answer && r1.endsWith(answer), String(r1));
ck("unit: recap NÃO é duplicata consecutiva (passa a guarda)", !!r1 && !isConsecutiveDuplicate(hist1, r1), String(r1));
const hist2 = [...hist1, { role: "assistant" as const, content: r1 ?? "" }, { role: "user" as const, content: "What is the installation process?" }];
const r2 = recapForDuplicateReply(hist2, answer);
ck("unit: repetição 2 → recap com prefixo DIFERENTE", !!r2 && r2 !== r1 && r2.endsWith(answer), String(r2));
const hist3 = [...hist2, { role: "assistant" as const, content: r2 ?? "" }, { role: "user" as const, content: "What is the installation process?" }];
ck("unit: repetição 3 → null (cap 2, backstop de tempestade)", recapForDuplicateReply(hist3, answer) === null, "cap não corta");
ck("unit: idioma ES detectado", (recapForDuplicateReply(hist1, "Hola, la instalación tarda 2 días.") ?? "").startsWith("Como te mencioné"), "");

console.log("\n[C. backstop de promessa vazia]");
for (const [nome, src] of canais) {
  ck(`${nome}: backstop promisesOwnerContact presente`, /promisesOwnerContact\(outboundResponse\)/.test(src), "promessa sem [NOTIFY_OWNER] volta a ser vazia");
  ck(`${nome}: backstop checa ausência do tag no afterCancel`, /!\/\\\[NOTIFY_OWNER\\\]\/i\.test\(afterCancel\) && promisesOwnerContact/.test(src), "dispararia em dobro quando o tag JÁ notificou");
}
// unit: frases reais dos casos Jorge/Mike/Cindy detectadas
for (const frase of [
  "That's great news, Mike! Ozzi will reach out to you personally to finalize everything and confirm all the details for Monday.",
  "I'll have Ozzi reach out to you directly to confirm all the details for tomorrow.",
  "I'm flagging this for Ozzi right now and he will call you shortly.",
  "Great news Jorge, Ozzi will be reaching out to you personally to finalize everything.",
  "I'll make sure Ozzi sees these photos and gets back to you right away with everything you need.",
  "Entendido, Ozzi le devolverá la llamada a Mercedes en cuanto pueda.",
]) {
  ck(`unit: detecta promessa: "${frase.slice(0, 60)}…"`, promisesOwnerContact(frase), frase);
}
// unit: respostas normais NÃO disparam (falso positivo = spam pro dono)
for (const frase of [
  "For a whole house I need to come measure in person to give you the best price, the visit is completely free.",
  "Our vinyl promo is $5 per square foot and that already includes the flooring, installation labor, and quarter round.",
  "I have Wednesday the 12th at 9am or 11am, which works better for you?",
  "You can reach Ozzi directly at (561) 674-8334 with any questions!",
]) {
  ck(`unit: NÃO dispara em resposta normal: "${frase.slice(0, 50)}…"`, !promisesOwnerContact(frase), frase);
}

console.log("\n[D. falha de envio de nudge/fallback → outbox]");
ck("IG: nudge de re-tap enfileira SEND_FAILED na falha", /content: nudgeSent\.ok \? retapNudge : retapNudge \+ SEND_FAILED_DB_SUFFIX/.test(ig), "falha do nudge volta a sumir sem rastro");
ck("FB: nudge de re-tap enfileira SEND_FAILED na falha", /content: nudgeSent\.ok \? retapNudge : retapNudge \+ SEND_FAILED_DB_SUFFIX/.test(fb), "falha do nudge volta a sumir sem rastro");
ck("IG: fallback no-content enfileira SEND_FAILED na falha", /noContentSent\.ok \? finalResponse : finalResponse \+ SEND_FAILED_DB_SUFFIX/.test(ig), "");
ck("FB: fallback no-content enfileira SEND_FAILED na falha", /noContentSent\.ok \? fallback : fallback \+ SEND_FAILED_DB_SUFFIX/.test(fb), "");
ck("WA: fallback no-content enfileira SEND_FAILED na falha", /noContentSent\.ok \? fallback : fallback \+ SEND_FAILED_DB_SUFFIX/.test(wa), "");

console.log("\n[E. fallback específico de voz no WA]");
ck("WA: voice note sem transcrição → linha específica de voz", /Got your voice message but could not catch it/.test(wa), "fallback genérico voltou para áudio");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
