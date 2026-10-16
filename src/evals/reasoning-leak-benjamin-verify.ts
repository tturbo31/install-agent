/**
 * "3pm or 7pm... wait, Friday's latest is 5pm" NUNCA chega ao cliente
 * (caso Benjamin Dogay, Messenger 15/10/2026 20:30 ET, fb_28401302749502110).
 *
 * O cliente mandou o ZIP (33484) e recebeu: "We cover that area, no problem. I
 * can do Friday at 3pm or 7pm... wait, Friday's latest is 5pm. Let me give you
 * the real options: Friday October 16 at 3pm or 5pm, which works better?"
 *
 * Duas causas, duas correções:
 *  A) O 7pm não existia: a linha de sexta 16/10 era "3pm, 4pm, 5pm". O exemplo
 *     fixo "(for example 'today at 11am or 7pm')", que entrou na regra 33 e no
 *     bullet SOONEST DAY FIRST no deploy do mesmo dia (a1bc387, 13:52 ET),
 *     ancorou o modelo no 7pm; ele escreveu e só depois releu a linha. O
 *     exemplo agora é a DERIVAÇÃO a partir da linha ("3pm, 4pm, 5pm" → "3pm or
 *     5pm") e diz que horário não impresso na linha não existe naquele dia.
 *  B) A rede anti-vazamento devolveu "clean": "wait, Friday's…" não casava com
 *     "wait, let me / I / we", e "let me give you the real options" não estava
 *     em "right|correct|two clean". Agora "wait," abrindo frase, "let me give
 *     you the real/actual/proper options" e a MESMA sexta ofertada duas vezes
 *     com horários diferentes são sinal: o rascunho é descartado e o turno é
 *     regenerado; o que se salva é só a oferta final.
 *
 * Prova, SEM chamada paga (modelo falso local):
 *  1. PURO: a frase exata do Benjamin (e a variante com reticência Unicode) é
 *     vazamento pesado → regenera; o salvo não tem 7pm, "wait" nem "real options".
 *  2. PURO: os outros "wait" reais do corpus ("Wait, you already gave it…",
 *     "Wait, you're on WhatsApp…") disparam; a correção SEM palavra conhecida
 *     ("Friday at 3pm or 7pm. Sorry, Friday at 3pm or 5pm…") dispara pela
 *     contradição de horários do mesmo dia.
 *  3. PURO: o que NÃO é vazamento passa intacto ("wait until the layout is
 *     finalized", "the latest is 5pm on Saturdays", "the exact number on the
 *     spot", a desculpa do horário que encheu, "I'll wait, no rush").
 *  4. PIPELINE: getAIResponse com o rascunho do Benjamin → regenera e envia a 2ª
 *     amostra; 2ª amostra vazando → envia só a oferta final salva.
 *  5. ESTÁTICO: regra 33 e bullet SOONEST DAY FIRST sem o exemplo fixo "11am or
 *     7pm", com a derivação da linha; as frases que os outros evals pinam seguem.
 * Run: npx tsx src/evals/reasoning-leak-benjamin-verify.ts
 */
import { createServer } from "http";
import { readFileSync } from "fs";
import { join } from "path";
import type { AddressInfo } from "net";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}

let firstReply = ""; let redoReply = ""; let calls = 0; let redoCalls = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls++;
    const parsed = JSON.parse(body || "{}");
    const lastUser = [...(parsed.messages ?? [])].reverse().find((m: { role: string }) => m.role === "user");
    const lastText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const isRedo = /Your previous draft for this turn contained your own analysis/.test(lastText);
    if (isRedo) redoCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "msg_fake", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: isRedo ? redoReply : firstReply }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  });
});
async function main() {
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = "fake-key-for-the-local-mock";
process.env.REPLY_TIGHTEN = "off";

const { assessReasoningLeak, replyStillLeaks, getAIResponse } = await import("../lib/ai");
const { hasSelfCorrection, hasRedraftedOffer } = await import("../lib/reasoning-leak");

const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = origLog; console.warn = origWarn; console.error = origErr; };

const BENJAMIN = "We cover that area, no problem. I can do Friday at 3pm or 7pm... wait, Friday's latest is 5pm. Let me give you the real options: Friday October 16 at 3pm or 5pm, which works better?";
const FINAL = "Friday October 16 at 3pm or 5pm, which works better?";
const BAD = /7pm|\bwait\b|real options|latest is/i;

console.log("\n━━ 1. PURO: a frase exata do Benjamin ━━");
{
  quiet(); const r = assessReasoningLeak(BENJAMIN); loud();
  console.log("   →", r.text);
  ck("é vazamento (não 'clean') e o turno é REGENERADO", r.mode !== "clean" && r.regenerate === true, JSON.stringify({ mode: r.mode, regenerate: r.regenerate, signals: r.signals }));
  ck("o que se salva é SÓ a oferta final", r.text === FINAL, r.text);
  ck("nada do rascunho abandonado sobra (7pm, wait, real options)", !BAD.test(r.text), r.text);
  ck("hasSelfCorrection reconhece 'wait, Friday's latest is 5pm'", hasSelfCorrection("wait, Friday's latest is 5pm."));
  ck("hasSelfCorrection reconhece 'let me give you the real options'", hasSelfCorrection("Let me give you the real options: Friday at 3pm or 5pm."));
}
{
  const uni = "We cover that area, no problem. I can do Friday at 3pm or 7pm… wait, Friday's latest is 5pm. Let me give you the real options: Friday October 16 at 3pm or 5pm, which works better?";
  quiet(); const r = assessReasoningLeak(uni); loud();
  ck("variante com reticência Unicode (…) na mesma frase: regenera e o salvo é limpo", r.regenerate && !BAD.test(r.text) && /3pm or 5pm/.test(r.text), `${r.mode} | ${r.text}`);
}
{
  const noColon = "We cover that area. I can do Friday at 3pm or 7pm... wait, Friday only goes until 5pm, so Friday at 3pm or 5pm, which works better?";
  quiet(); const r = assessReasoningLeak(noColon); loud();
  ck("sem dois-pontos: 'wait,' no meio basta para regenerar, o 7pm não sai e o salvo é o que segue o 'wait,'", r.regenerate && !/7pm|\bwait\b/i.test(r.text) && r.text === "Friday only goes until 5pm, so Friday at 3pm or 5pm, which works better?", `${r.mode} | ${r.text}`);
}

console.log("\n━━ 2. PURO: os outros 'wait' reais e a correção sem palavra conhecida ━━");
for (const [txt, keep] of [
  ["Wait, you already gave it: 8121 NW 197 St, Hialeah FL 33015. What's the best phone number?", /best phone number/],
  ["Wait, you're on WhatsApp so I already have your number. Just need the full property address with the zip code!", /full property address/],
  ["Wait I already have your name, Ron. What's the full address with the zip code?", /full address/],
] as Array<[string, RegExp]>) {
  quiet(); const r = assessReasoningLeak(txt); loud();
  ck(`"${txt.slice(0, 48)}…": regenera e o salvo não tem o 'wait'`, r.regenerate && !/\bwait\b/i.test(r.text) && keep.test(r.text), `${r.mode} | ${r.text}`);
}
{
  const noWords = "I can do Friday at 3pm or 7pm. Sorry, Friday at 3pm or 5pm, which works better?";
  ck("mesma sexta, dois pares diferentes de horários = rascunho + re-rascunho (sinal sozinho)", hasRedraftedOffer(noWords));
  quiet(); const r = assessReasoningLeak(noWords); loud();
  ck("…e o salvo começa na oferta FINAL, sem o 7pm, e o turno regenera", r.regenerate && r.text === "Sorry, Friday at 3pm or 5pm, which works better?", `${r.mode} | ${r.text}`);
  ck("em espanhol também (viernes 3pm o 7pm → viernes 3pm o 5pm)", hasRedraftedOffer("Puedo el viernes a las 3pm o 7pm. Perdón, el viernes tengo 3pm o 5pm, cuál te queda mejor?"));
}

console.log("\n━━ 3. PURO: o que NÃO é vazamento passa intacto ━━");
for (const legit of [
  "That makes total sense to wait until the layout is finalized before committing to floors.",
  "No need to wait, I bring all the samples to the visit so you pick right there.",
  "That's fair, I totally get it. The visit is free, I come take a look and give you the exact number on the spot. What's the zip code of the property?",
  "On weekdays we go as late as 7pm, and on weekends the latest is 5pm on Saturdays and 7pm on Sundays. What works best for you?",
  "Sunday at 9am or 7pm, or Monday after 5 I've got 6pm or 8pm. Which works best?",
  "Tomorrow is Friday, I have 3pm or 6pm, which works better?",
  "I have Thursday at 9am or 11am. Which works better, 9am or 11am?",
  "I'm sorry, that Friday 7pm filled up while we were talking. The closest I have now is Friday at 3pm or 5pm, which works?",
  "I'll wait, no rush. Send me the address whenever you can.",
  "We can wait, sure. Just let me know the day that works for you.",
  "Friday at 3pm or 5pm, which works better? Both Friday times are open, 3pm and 5pm.",
  "Perfect, I'm holding that Friday 5pm for you! Can I get the full property address with the zip code and the best phone number?",
  "Saturday this week is fully booked, but I have Sunday October 18 at 9am or 7pm. Does either of those work?",
]) {
  quiet(); const r = assessReasoningLeak(legit); loud();
  ck(`intacta: "${legit.slice(0, 60)}…"`, r.mode === "clean" && !r.regenerate && r.text === legit, `${r.mode} ${r.signals.join("+")} | ${r.text}`);
}

console.log("\n━━ 4. PIPELINE: getAIResponse com modelo falso ━━");
const U = (c: string) => ({ role: "user" as const, content: c });
const A = (c: string) => ({ role: "assistant" as const, content: c });
const sched = "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• Thursday, October 15, 2026 [2026-10-15]: fully booked\n• Friday, October 16, 2026 [2026-10-16]: 3pm, 4pm, 5pm\n• Saturday, October 17, 2026 [2026-10-17]: fully booked\n• Sunday, October 18, 2026 [2026-10-18]: 9am, 11am, 1pm, 3pm, 5pm, 7pm";
const history = [
  U("Hi need to fix my kitchen floor. Can i get a quote ?"),
  A("We only do full new installations, we don't do repairs of any kind. If you ever need a whole new floor put in, I'm happy to help!"),
  U("As i mentioned above it may require full installation but i can't tell unless if there is someone who would check and let me know"),
  A("That's fair, I totally get it. The visit is free, I come take a look and give you the exact number on the spot. What's the zip code of the property?"),
  U("33484\n\n[SYSTEM: TODAY: Thursday, October 15, 2026 [2026-10-15].\n\n" + sched + "]"),
];
async function run(first: string, redo: string) {
  firstReply = first; redoReply = redo; calls = 0; redoCalls = 0;
  quiet();
  const r = await getAIResponse(history, null, null, null, false);
  loud();
  return r.text;
}
{
  const clean = "We cover that area, no problem. I can do Friday at 3pm or 5pm, which works better?";
  const out = await run(BENJAMIN, clean);
  ck("rascunho do Benjamin → REGENERA (2 chamadas) e envia a 2ª amostra limpa", out === clean && calls === 2 && redoCalls === 1, `${calls} chamadas | ${out}`);
}
{
  const out = await run(BENJAMIN, BENJAMIN);
  ck("regeneração vaza igual → envia só a oferta final salva, nunca o '7pm... wait'", out === FINAL, out);
}
{
  const clean = "We cover that area, no problem. I can do Friday at 3pm or 5pm, which works better?";
  const out = await run(clean, "não deveria ser usado");
  ck("resposta limpa: 1 chamada, texto intocado", calls === 1 && out === clean, `${calls} | ${out}`);
}

console.log("\n━━ 5. ESTÁTICO: o exemplo fixo '11am or 7pm' saiu do prompt ━━");
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
const ai = src("src/lib/ai.ts"); const sc = src("src/lib/scheduler.ts");
ck("ai.ts regra 33: sem '(for example \"today at 11am or 7pm\")'", !/for example "today at 11am or 7pm"/.test(ai));
ck("ai.ts regra 33: derivação da linha ('3pm, 4pm, 5pm' → '3pm or 5pm') e 'does not exist that day'", /a line "3pm, 4pm, 5pm" gives "3pm or 5pm"/.test(ai) && /does not exist that day/.test(ai));
ck("ai.ts regra 33: 'EARLIEST and LATEST open times' continua (pinado por review-fixes-2808-verify)", /EARLIEST and LATEST open times/.test(ai));
ck("scheduler.ts bullet: sem '(for example 'today at 11am or 7pm')'", !/for example 'today at 11am or 7pm'/.test(sc));
ck("scheduler.ts bullet: derivação da linha + 'read each time on the line BEFORE you write it'", /a line '3pm, 4pm, 5pm' gives '3pm or 5pm'/.test(sc) && /read each time on the line BEFORE you write it/.test(sc));
ck("scheduler.ts bullet: 'EARLIEST and its LATEST open time' continua (pinado por fill-the-day/no-route)", /EARLIEST and its LATEST open time/.test(sc));
ck("nenhuma outra cópia de '11am or 7pm' em src/lib", !/11am or 7pm/.test(ai) && !/11am or 7pm/.test(sc) && !/11am or 7pm/.test(src("src/lib/system-prompt.ts")));
ck("a rede roda ANTES da rede de tamanho (o vazamento é julgado no rascunho original)", ai.indexOf("assessReasoningLeak(cleaned, leakOpts)") < ai.indexOf("needsTightening(cleaned)"));
ck("replyStillLeaks pega a frase exata (a 2ª amostra nunca envia o mesmo)", replyStillLeaks(BENJAMIN, {}));

server.close();
console.log(`\n${pass} passed, ${fail} failed${fail ? ": " + fails.join(" | ") : ""}`);
process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
