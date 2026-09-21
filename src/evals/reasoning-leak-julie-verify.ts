/**
 * O PENSAMENTO DO MODELO NUNCA CHEGA AO CLIENTE (caso Julie, WhatsApp 21/09/2026).
 *
 * A cliente perguntou "Do you have Wed at 6:00 pm or 7:00pm Or Thursday or Friday"
 * e recebeu 1.245 caracteres do modelo discutindo a nota da agenda em voz alta
 * ("Wednesday has 7pm in parenthesis (open if asked), so I can accept it… Since
 * the client specifically asked… Actually let me re-read…"). Foi o 7º monólogo em
 * 35 dias; cada um anterior virou FRASE nova na lista negra e o seguinte veio com
 * palavras novas (a lista do próprio dia 21 deixava passar 11 das 16 frases).
 *
 * Prova, SEM nenhuma chamada paga (o modelo é um servidor falso local):
 *  1. PURO: o texto exato da Julie e os outros 6 vazamentos reais saem limpos
 *     (detecção por FORMA + corte do trecho inteiro do monólogo).
 *  2. PURO: falsos-positivos medidos no corpus de 13.714 respostas reais não
 *     disparam ("since they are in good shape", "closest match", "el cliente
 *     compra su material", corretor falando do próprio cliente).
 *  3. PURO: a tag [BOOK] nunca se perde num vazamento, e turno com tag nunca é
 *     regenerado.
 *  4. PIPELINE (getAIResponse com modelo falso): monólogo → REGENERA; regeneração
 *     vaza de novo → usa o que salvou do 1º rascunho; nada limpo → [NOTIFY_OWNER]
 *     (o dono é avisado, o cliente não recebe nada). Falha FECHADA.
 *  5. ESTÁTICO: a rede roda antes da rede de tamanho e o porquê está no código.
 * Run: npx tsx src/evals/reasoning-leak-julie-verify.ts
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

// ── modelo falso: responde pela fila; a chamada de regeneração é reconhecida
// pela nota CLEAN_REPLY_NOTE no último turno do cliente ──────────────────────
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
process.env.REPLY_TIGHTEN = "off"; // este eval é sobre o vazamento; a rede de tamanho tem o dela

const { assessReasoningLeak, stripReasoningLeak, replyStillLeaks, getAIResponse } = await import("../lib/ai");
const { mentionsThirdParty, hasRedraftedOffer } = await import("../lib/reasoning-leak");

const JULIE = "Wednesday has 7pm in parenthesis (open if asked), so I can accept it. Thursday has 6pm and 7pm in parenthesis too, so those are open if asked. Friday has 6pm in parenthesis as well. Since the client specifically asked for 6pm or 7pm, I can accept those from the parenthesis. The soonest match is Wednesday 7pm (6pm is not listed for Wednesday even in parenthesis, only 7pm is). Actually let me re-read: Wednesday parenthesis shows: 2pm, 4pm, 7pm, 8pm. So Wednesday 7pm is open if asked. Thursday parenthesis: 1pm, 2pm, 4pm, 6pm, 7pm, 8pm. So Thursday 6pm and 7pm are both open if asked. Wednesday has 7pm (not 6pm) in parenthesis. They also asked for Thursday or Friday. Thursday has 6pm and 7pm available if asked. Friday has 6pm in parenthesis. I'll confirm Wednesday 7pm works, and since they asked for it specifically, I can offer that. I'll keep it simple: Wednesday at 7pm works, and Thursday I have 6pm or 7pm. Let me offer Wednesday 7pm or Thursday 6pm as the two clearest options matching their request. Wednesday at 7pm works, or Thursday at 6pm, which one do you prefer? Then ask for the address. Wednesday at 7pm or Thursday at 6pm, which works better for you? And what's the full property address with the zip code so I can hold it?";
const MONO = /parenthes|if asked|the client|they also|their request|let me|i'll keep|then ask|clearest|soonest match/i;

const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = origLog; console.warn = origWarn; console.error = origErr; };

console.log("\n━━ 1. PURO: a Julie e os outros 6 vazamentos reais ━━");
quiet();
const j = assessReasoningLeak(JULIE);
loud();
console.log("   →", j.text);
ck("Julie: vazamento pesado, o turno é regenerado", j.mode === "heavy" && j.regenerate === true, JSON.stringify({ mode: j.mode, regenerate: j.regenerate }));
ck("Julie: o que se salva é SÓ a resposta final (137c de 1.245)", j.text === "Wednesday at 7pm or Thursday at 6pm, which works better for you? And what's the full property address with the zip code so I can hold it?", j.text);
ck("Julie: nenhuma palavra do monólogo sobra", !MONO.test(j.text), j.text);
ck("Julie: os 4 sinais de forma dispararam", ["internal-vocabulary", "self-talk", "third-person"].every((s) => j.signals.includes(s)), j.signals.join(","));

const REAL: Array<[string, string, RegExp, RegExp]> = [
  ["a9a3e8da 24/08", "The type is still unknown here, but 1,900 sqft is already a large lead so no DM price regardless. I need to propose the visit, but I also don't know if they want vinyl, tile, or hardwood. I'll acknowledge the size, note that LVP can go right over existing tile, and propose the free in-person visit without giving a dollar figure. For 1,900 sqft I need to come measure in person to give you the best price. I have Wednesday the 26th at 5pm or Thursday the 27th at 9am or 11am, which works for you?", /^For 1,900 sqft/, /large lead|still unknown|acknowledge/i],
  ["d9ccd9bc 26/08", "It looks like the client may have received a message from someone and wants to verify if they're associated with us. I'll let Ozzi handle this directly since we can't confirm or deny who that person is.", /^I'll let Ozzi handle/, /the client/i],
  ["65eff0ac 28/08 (Keky)", "Which time works better, 11am or 2pm? Wait, I notice this is a vague reply and I already offered those two times before the system context loaded. Let me just ask for the booking info since they said \"that works\" without specifying which of the two times. Which one works for you, the 11am or the 2pm?", /^Which one works for you, the 11am or the 2pm\?$/, /notice|system context|they said/i],
  ["374066de 29/08 (Natasha)", "They said next week, so the first available next-week day is Monday August 31. Today is Saturday August 29. \"Next week\" from Saturday August 29 would typically mean the week of Monday August 31. I'll offer Monday August 31 first. Boca Raton is in our service area. Zip 33432 already given. Boca is covered, great! I have Monday the 31st at 9am or 11am, which works better for you?", /^Boca is covered, great!/, /they said|today is|i'll offer|already given|typically mean/i],
  ["21445c49 31/08", "However, they also sent their address. Also get their name since I don't have it. Actually, they haven't picked a specific time. I need to ask which one. And I need their name. Let me ask for the time and name together. I'm holding Wednesday for you! Which works better, 11am or 1pm?", /^I'm holding Wednesday for you!/, /they also|their name|need to ask|let me ask/i],
  ["7798856b 17/09", "Since they already asked this once and got the explanation, I'll give a brief, differently worded version per rule 35. Since you're asking about what comes with the package, it really comes down to the floor: vinyl includes the flooring material, installation, and quarter round all in one. Which of those are you considering?", /^Since you're asking/, /rule 35|differently worded|they already/i],
  ["868bf420 19/08 (autocorreção no meio da frase)", "No problem, two weeks out works perfectly! For the week of September 1st I have Tuesday September 1 at 9am, 11am, 1pm, 3pm, 5pm, or 7pm, and Wednesday September 2 at those same hours , actually, let me give you two clean options: Tuesday September 1 at 9am or 11am, or Wednesday September 2 at 9am or 11am, whichever works better?", /Tuesday September 1 at 9am or 11am, or Wednesday September 2 at 9am or 11am, whichever works better\?$/, /let me give|those same hours|1pm, 3pm/i],
];
for (const [id, text, keep, gone] of REAL) {
  quiet(); const r = assessReasoningLeak(text); loud();
  ck(`${id}: limpo (${text.length}c → ${r.text.length}c)`, keep.test(r.text) && !gone.test(r.text) && !replyStillLeaks(r.text), r.text);
}

console.log("\n━━ 2. PURO: o que NÃO é vazamento passa intacto (falsos-positivos medidos no corpus) ━━");
for (const legit of [
  "At 485 sqft the promo rate applies, so that comes out to about $2,425 for the luxury vinyl, and yes we can install right over the existing tile since they are in good shape.",
  "The sides of the stairs (risers) are included in the per-step price, so no extra charge there. Landings are measured at the visit since they vary in size.",
  "I can't confirm specific model names on my end, but I bring the full sample collection to the visit so you can find the closest match right there. I have Sunday the 6th at 11am or 1pm, which works better?",
  "El porcelanato sale a $4.50 por pie cuadrado para la mano de obra (el cliente compra su material), y el vinyl sale a $5 por pie cuadrado con todo incluido.",
  "That's not something we handle, we only do the installation itself and the client takes care of getting the materials to the property.",
  "3:30 isn't listed, but I do have 3pm tomorrow Monday, does that work?",
  "Let me check what I have open. What day works best for you?",
  "Wednesday at 7pm works, or Thursday at 6pm. Which one?",
  "I have Thursday at 9am or 11am. Which works better, 9am or 11am?",
  "Perfect, I'm holding that Tuesday 2pm for you! Can I get the full property address with the zip code?",
]) {
  quiet(); const r = assessReasoningLeak(legit); loud();
  ck(`intacta: "${legit.slice(0, 58)}…"`, r.mode === "clean" && !r.regenerate && r.text === legit, r.text);
}
ck("corretor falando do PRÓPRIO cliente: terceira pessoa deixa de ser sinal", mentionsThirdParty("Hi, I'm a realtor and my client needs new floors before closing"));
quiet();
const realtor = assessReasoningLeak("Sure, when would the client be home so we can come measure?", { thirdPartyContext: true });
const notRealtor = assessReasoningLeak("Sure, when would the client be home so we can come measure? I have Monday at 9am or 11am open.");
loud();
ck("…e a resposta ao corretor passa intacta", realtor.mode === "clean", realtor.text);
ck("…mas sem esse contexto 'the client' é sinal", notRealtor.mode !== "clean", notRealtor.text);
ck("rascunho + re-rascunho (mesmos horários em 2 perguntas) é sinal sozinho", hasRedraftedOffer("Which time works better, 11am or 2pm? Which one works for you, the 11am or the 2pm?"));
ck("oferta + pergunta de confirmação NÃO é re-rascunho", !hasRedraftedOffer("I have Thursday at 9am or 11am. Which works better, 9am or 11am?"));

console.log("\n━━ 3. PURO: a visita nunca se perde num vazamento ━━");
const TAG = '[BOOK:{"name":"","phone":"17865550142","address":"1420 NW 3rd St, Fort Lauderdale FL 33311","date":"2026-09-22","time":"14:00","notes":"the client asked for vinyl"}]';
quiet();
const b1 = assessReasoningLeak("The client confirmed Tuesday at 2pm and sent the address. I can accept it from the parenthesis. Perfect, see you then!" + TAG);
const b2 = assessReasoningLeak("The client confirmed Tuesday at 2pm. Wednesday has 7pm in parenthesis." + TAG);
const b3 = assessReasoningLeak("All set!" + TAG + " Wait, let me re-check the date. The client said Tuesday.");
const b4 = assessReasoningLeak("Perfect, see you then!" + TAG);
loud();
ck("monólogo + 'Perfect, see you then!' + [BOOK]: fica a frase e a tag INTEIRA", b1.text === "Perfect, see you then!" + TAG, b1.text);
ck("só monólogo + [BOOK]: fica a tag sozinha (o webhook escreve a confirmação)", b2.text === TAG, b2.text);
ck("[BOOK] antes do 'Wait, …': a tag sobrevive e o monólogo não", b3.text.includes(TAG) && !/re-check|the client/i.test(b3.text.replace(TAG, "")), b3.text);
ck("turno com tag NUNCA é regenerado (a 2ª amostra pode não escrever o [BOOK])", !b1.regenerate && !b2.regenerate && !b3.regenerate);
ck("frase-gatilho DENTRO das notes da tag não conta ('the client asked for vinyl')", b4.mode === "clean" && b4.text === "Perfect, see you then!" + TAG, b4.text);
quiet();
const short = "Wait, let me redo this. Ok.";
ck("helper puro stripReasoningLeak: nada limpo sobra → devolve o original (quem regenera é o getAIResponse)", stripReasoningLeak(short) === short);
loud();

console.log("\n━━ 4. PIPELINE: getAIResponse com modelo falso (zero custo) ━━");
const U = (c: string) => ({ role: "user" as const, content: c });
const A = (c: string) => ({ role: "assistant" as const, content: c });
const sched = "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• Wednesday, September 23, 2026 [2026-09-23]: 9am, 11am (open only if the client asks for one of these: 7pm)\n• Thursday, September 24, 2026 [2026-09-24]: 11am, 3pm (open only if the client asks for one of these: 6pm, 7pm)";
const history = [
  U("What is the installation process?"),
  A("We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?"),
  U("Hi yes please can you call me"),
  A("Got it, I have your number on file already. Today I only have 7pm left, or Tuesday at 2pm. Which works better for you?"),
  U("Do you have Wed at 6:00 pm or 7:00pm\nOr Thursday or Friday\n\n[SYSTEM: TODAY: Monday, September 21, 2026 [2026-09-21].\n\n" + sched + "]"),
];
async function run(first: string, redo: string) {
  firstReply = first; redoReply = redo; calls = 0; redoCalls = 0;
  quiet();
  const r = await getAIResponse(history, null, null, null, false);
  loud();
  return r.text;
}
{
  const out = await run(JULIE, "Wednesday at 7pm works, or Thursday at 6pm. Which one?");
  ck("monólogo da Julie → REGENERA e envia a 2ª amostra limpa", out === "Wednesday at 7pm works, or Thursday at 6pm. Which one?" && calls === 2 && redoCalls === 1, `${calls} chamadas | ${out}`);
}
{
  const out = await run(JULIE, JULIE);
  ck("regeneração vaza de novo → envia o que salvou do 1º rascunho, nunca o monólogo", !MONO.test(out) && /7pm/.test(out) && /6pm/.test(out) && out.length < 200, out);
}
{
  const bad = "The client asked for 6pm. Wednesday has 7pm in parenthesis. I should offer it.";
  const out = await run(bad, bad);
  ck("nada limpo em nenhuma das 2 amostras → [NOTIFY_OWNER]: o dono é avisado, o cliente não recebe o pensamento", out === "[NOTIFY_OWNER]", out);
}
{
  const out = await run("The client confirmed it. I can accept it from the parenthesis. Perfect, see you then!" + TAG, "não deveria ser usado");
  ck("monólogo em turno com [BOOK]: NÃO regenera (1 chamada) e a tag sai inteira", calls === 1 && out.includes(TAG) && !MONO.test(out.replace(TAG, "")), `${calls} chamadas | ${out}`);
}
{
  const clean = "Wednesday at 7pm works, or Thursday at 6pm. Which one?";
  const out = await run(clean, "não deveria ser usado");
  ck("resposta limpa: 1 chamada, texto intocado", calls === 1 && out === clean, `${calls} | ${out}`);
}
{
  // o texto real de 17/09 (7798856b): uma frase de monólogo na frente de uma resposta inteira
  const light = "Since you're asking about what comes with the package, it really comes down to the floor: vinyl includes the flooring material, installation, and quarter round all in one, while tile and hardwood cover the labor only. Which of those are you considering?";
  const out = await run("Since they already asked this once, I'll give a brief version per rule 35. " + light, "não deveria ser usado");
  ck("vazamento LEVE sem autocorreção: tira a frase, sem 2ª chamada", calls === 1 && out === light, `${calls} | ${out}`);
}
{
  const out = await run("Wednesday at 7pm works! Can I get your name, the address and the phone? Wait, I already have your number. Just need the full property address with the zip code!", "Wednesday at 7pm works, what's the full property address with the zip code?");
  ck("autocorreção ('Wait, I already have…'): o rascunho não é confiável → regenera", redoCalls === 1 && out === "Wednesday at 7pm works, what's the full property address with the zip code?", `${redoCalls} | ${out}`);
}
{
  process.env.LEAK_REGENERATE = "off";
  const out = await run(JULIE, "não deveria ser usado");
  delete process.env.LEAK_REGENERATE;
  ck("LEAK_REGENERATE=off: sem 2ª chamada, vai o que se salvou (nunca o monólogo)", redoCalls === 0 && !MONO.test(out) && /7pm/.test(out), `${redoCalls} | ${out}`);
}

console.log("\n━━ 5. ESTÁTICO ━━");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
const iLeak = ai.indexOf("const leak = assessReasoningLeak(cleaned, leakOpts);");
const iNet = ai.indexOf("needsTightening(cleaned)");
ck("a rede de vazamento roda ANTES da rede de tamanho (que reescreveria o monólogo em vez de descartá-lo)", iLeak > 0 && iNet > iLeak, `${iLeak} ${iNet}`);
ck("falha FECHADA escrita no pipeline ([NOTIFY_OWNER], nunca o original)", /if \(!shipped\.trim\(\) \|\| replyStillLeaks\(shipped, leakOpts\)\) \{[\s\S]{0,260}shipped = "\[NOTIFY_OWNER\]";/.test(ai));
ck("regeneração usa o MESMO modelo e os mesmos blocos de sistema (cache)", /async function regenerateCleanReply[\s\S]{0,700}model: "claude-sonnet-4-6"[\s\S]{0,400}text: stableSystem[\s\S]{0,200}text: dynamicSystem/.test(ai));
ck("o rascunho vazado NÃO é mostrado ao modelo na regeneração", !/async function regenerateCleanReply[\s\S]{0,1500}role: "assistant"/.test(ai.slice(ai.indexOf("async function regenerateCleanReply"), ai.indexOf("async function regenerateCleanReply") + 1900)));
ck("o rascunho vazado fica no log (diagnóstico da próxima vez)", /reasoning leak in the draft/.test(ai));
ck("chave de emergência LEAK_REGENERATE=off", /process\.env\.LEAK_REGENERATE !== "off"/.test(ai));
const rl = readFileSync(join(process.cwd(), "src/lib/reasoning-leak.ts"), "utf-8");
ck("o porquê está escrito no módulo (para ninguém voltar à lista de frases)", /DETECTION BY PHRASE/.test(rl) && /FAIL OPEN/.test(rl));

server.close();
console.log(`\n${pass} ✅  ${fail} ❌`);
if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
