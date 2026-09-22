/**
 * A RESPOSTA PRONTA DE FOTOS NÃO REPETE "uma área ou a casa toda?" (21/09/2026).
 *
 * Medido ao vivo: cliente disse "The whole house, around 1100 sqft", depois pediu
 * "can you send me pictures of the colors you have?" e a resposta pronta (link do
 * site, regra do dono 27/07) terminou em "Is it just one area or the whole
 * house?" em 6 de 6. Repetir pergunta já respondida é a assinatura de robô que a
 * regra 5 dos FINAL REMINDERS proíbe. Puro, sem modelo.
 * Run: npx tsx src/evals/canned-scope-reask-verify.ts
 */
process.env.ANTHROPIC_API_KEY ||= "unused-pure-eval";
import { getAIResponse, scopeAlreadyStated, type ChatMessage } from "../lib/ai";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

async function main() {
  const origLog = console.log;
  const ask = async (msgs: ChatMessage[]) => { console.log = () => {}; const r = await getAIResponse(msgs, null, null, null, false); console.log = origLog; return r.text; };

  console.log("\n━━ 1. escopo já dito → vai o link e as amostras, sem a pergunta ━━");
  const known = await ask([U("Hi, I'm interested in vinyl"), A("Our vinyl promo is $5 per sqft and that already includes the floor, the installation and the quarter round. Is it one area or the whole house?"), U("The whole house, around 1100 sqft"), A("For that size I need to measure in person, it's free and I bring the samples. When works for you?"), U("before that, can you send me pictures of the colors you have?")]);
  console.log("   →", known);
  ck("manda o site NOVO (regra do dono 27/07; link novo 22/09)", /https:\/\/ozzifloors\.company/.test(known) && !/www\.ozzifloors\.com/.test(known), known);
  ck("fala das amostras na visita", /samples/i.test(known), known);
  ck("NÃO pergunta de novo 'one area or the whole house'", !/one area|whole house/i.test(known) && !known.includes("?"), known);
  const knownPt = await ask([U("Oi, quero vinyl"), A("Nossa promo de vinyl é $5 por pé quadrado e já inclui o piso, a instalação e o quarter round. É só uma área ou a casa toda?"), U("a casa toda, uns 1100 pés"), A("Para esse tamanho eu passo para medir, é grátis e levo as amostras. Quando fica bom?"), U("me manda fotos dos pisos?")]);
  ck("PT: site + amostras, sem repetir 'uma área ou a casa toda'", /ozzifloors\.com/.test(knownPt) && !/casa toda\?/i.test(knownPt) && !knownPt.includes("?"), knownPt);

  console.log("\n━━ 2. escopo AINDA desconhecido → a pergunta continua (é o próximo passo do funil) ━━");
  const unknown = await ask([U("Hi, I'm interested in vinyl"), A("Our vinyl promo is $5 per sqft and that already includes the floor, the installation and the quarter round."), U("can you send me pictures of the colors you have?")]);
  ck("site + 'Is it just one area or the whole house?'", /ozzifloors\.com/.test(unknown) && /one area or the whole house\?/i.test(unknown), unknown);

  console.log("\n━━ 3. scopeAlreadyStated ━━");
  for (const t of ["The whole house, around 1100 sqft", "about 600 sq ft", "just the kitchen and 2 bedrooms", "toda la casa", "a casa toda", "unos 900 pies", "dos cuartos", "three rooms"]) ck(`dito: "${t}"`, scopeAlreadyStated([U(t)]));
  for (const t of ["Hi, I'm interested in vinyl", "how much?", "can you send me pictures?", "ok thanks", "What is the installation process?"]) ck(`não dito: "${t}"`, !scopeAlreadyStated([U(t)]));
  ck("só o texto do CLIENTE conta (nota [SYSTEM:] e fala nossa não)", !scopeAlreadyStated([A("Is it one area or the whole house?"), U("hi\n\n[SYSTEM: the whole house 1200 sqft]")]));

  console.log(`\n${pass} ✅  ${fail} ❌`);
  if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
