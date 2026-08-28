/**
 * TOM HUMANO (pedido do dono 27/08/2026) — puro, sem modelo.
 *  1. Prompt carrega a seção SOUND LIKE A REAL PERSON TEXTING (sem "Great question", paráfrase, variação).
 *  2. Openers enlatados não abrem com "Great question"/"Buena pregunta".
 *  3. stripSchedulingPush nunca deixa um toco de pergunta ("Does tomorrow work.") depois de cortar os horários.
 * Run: npx tsx src/evals/tone-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { stripSchedulingPush } from "../lib/ai";
import { OPENER_PROCESS_EN, OPENER_PROCESS_ES, OPENER_EN } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}

console.log("\n━━ 1. prompt ━━");
const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
ck("seção SOUND LIKE A REAL PERSON TEXTING", /SOUND LIKE A REAL PERSON TEXTING/.test(prompt));
ck("proíbe 'Great question' de abertura", /no "Great question", "Good question"/.test(prompt));
ck("proíbe copiar exemplos palavra por palavra", /NEVER copy the example sentences in this prompt word for word/.test(prompt));
ck("variação mantém 'zip code' e nome+endereço+telefone (guards)", /always the words "zip code" or "código postal", always name, address and phone together/.test(prompt));
ck("enlatados 'copy word for word' preservados", /every canned response marked "copy word for word" EXACTLY as written/.test(prompt) && /Copy it word for word/.test(prompt));

console.log("\n━━ 2. openers enlatados ━━");
ck("OPENER_PROCESS_EN sem 'Great question'", !/^great question/i.test(OPENER_PROCESS_EN) && /tile, vinyl, or hardwood/.test(OPENER_PROCESS_EN), OPENER_PROCESS_EN);
ck("OPENER_PROCESS_ES sem 'Buena pregunta'", !/^buena pregunta/i.test(OPENER_PROCESS_ES) && /tile, vinyl o hardwood/.test(OPENER_PROCESS_ES), OPENER_PROCESS_ES);
ck("OPENER_EN intacto", OPENER_EN.startsWith("Hi, we work with luxury vinyl, tile, and hardwood flooring"));

console.log("\n━━ 3. stripSchedulingPush sem toco ━━");
const cases: Array<[string, string]> = [
  ["100% waterproof with a stone composite core, so spills are no problem at all. Does tomorrow work, 9am or 1pm?", "100% waterproof with a stone composite core, so spills are no problem at all."],
  ["Yes, we move all the furniture and leave everything clean. Does tomorrow Friday work at 9am or 1pm?", "Yes, we move all the furniture and leave everything clean."],
  ["Yes, we handle the permits. What time works for you, Friday 9am or 1pm?", "Yes, we handle the permits."],
];
for (const [inp, want] of cases) { const got = stripSchedulingPush(inp); ck(`«${inp.slice(0, 55)}…»`, got === want, got); }
const keep = "Since you get off at 5:30, the earliest I can do is 6pm on Thursday, and for the living room at 1,500 sqft I can measure everything in one visit.";
ck("cláusula informativa longa continua salva (Emanuel)", /1,500 sqft I can measure/.test(stripSchedulingPush(keep)), stripSchedulingPush(keep));
ck("pedido de dados nunca é cortado", stripSchedulingPush("Can I get your name, the address and the best phone number for Friday at 1pm?").includes("name"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
