/**
 * SHOWROOM → "Yes, we have a mobile showroom" (caso WA +1 954 695-5414, 27/08/2026).
 *
 * O cliente perguntou "Do you have a showroom" e o bot respondeu "We don't have a
 * showroom". Regra do dono: a resposta é SIM, temos o MOBILE showroom, não a
 * loja física, levamos as amostras até a casa.
 *
 * Puro (sem modelo):
 *  1. isShowroomQuestion: EN/ES/PT reconhecem a pergunta; frases sem showroom não.
 *  2. fixShowroomDenial: troca a negação pela resposta certa (mantém a pergunta
 *     de continuidade), não toca em reply que já cita "mobile showroom", tags
 *     protegidas.
 *  3. Prompt carrega a regra (2c).
 * Ao vivo (LIVE=1): 3 chamadas ao modelo (EN mid-convo como no caso real, ES, PT).
 * Run: npx tsx src/evals/showroom-verify.ts   |   LIVE=1 npx tsx src/evals/showroom-verify.ts
 */
import { isShowroomQuestion, fixShowroomDenial, getAIResponse, type ChatMessage } from "../lib/ai";
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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

console.log("\n━━ 1. isShowroomQuestion ━━");
for (const q of [
  "Do you have a showroom", "Do you have a showroom?", "Where is your showroom?", "Do u have a show room",
  "Is there a store I can visit?", "Can I come to your shop to see the floors?", "Do you have a physical location?",
  "Do you have a warehouse where I can see the samples", "Tienen showroom?", "¿Tienen tienda?", "¿Dónde está su tienda?",
  "Vocês têm loja?", "Vocês têm showroom?", "Onde fica a loja de vocês?",
  "Do you have a showroom\n\n[SYSTEM: REAL-TIME SCHEDULE …]",
]) ck(`pergunta: «${q.split("\n")[0]}»`, isShowroomQuestion(q));
for (const q of [
  "Hi, I need flooring for my living room", "How much is vinyl per sqft?", "Where are you located",
  "Can you come tomorrow at 9?", "I bought the floor at a store already, just need installation",
  "Home Depot has the same vinyl cheaper", "33176", "The local pricing seems high",
]) ck(`não é: «${q}»`, !isShowroomQuestion(q));

console.log("\n━━ 2. fixShowroomDenial ━━");
const real = "We don't have a showroom, but that's actually the better setup: I come directly to your property, bring all the floor samples so you can see and compare them right on your own floor, take the exact measurements, and give you the price on the spot, all at no cost. Which flooring are you interested in, tile, vinyl, or hardwood?";
const fixedReal = fixShowroomDenial(real, "en");
ck("caso real: negação some", !/don'?t have a showroom/i.test(fixedReal), fixedReal);
ck("caso real: diz mobile showroom + sem loja física + amostras em casa", /mobile showroom/i.test(fixedReal) && /physical store/i.test(fixedReal) && /samples/i.test(fixedReal), fixedReal);
ck("caso real: a pergunta de continuidade sobrevive", /Which flooring are you interested in, tile, vinyl, or hardwood\?$/.test(fixedReal), fixedReal);
ck("caso real: sem frase redundante de 'come directly to your property'", !/come directly to your property/i.test(fixedReal), fixedReal);
for (const [inp, lang] of [
  ["No, we don't have a showroom. Is it just one area or the whole house?", "en"],
  ["We do not have a physical showroom right now. Is it one area or the whole house?", "en"],
  ["There's no showroom, I bring the samples to you. Is it one area or the whole house?", "en"],
  ["No tenemos showroom, pero llevo las muestras a tu casa. ¿Es un área o toda la casa?", "es"],
  ["Não temos loja física, mas levo as amostras. É uma área ou a casa toda?", "pt"],
] as Array<[string, "en" | "es" | "pt"]>) {
  const out = fixShowroomDenial(inp, lang);
  const ok = /mobile showroom|showroom m[oó]v/i.test(out) && !/(?:don'?t|do not|no)\s+(?:currently\s+)?have\s+(?:a\s+)?(?:physical\s+)?showroom|no tenemos showroom|n[aã]o temos showroom/i.test(out) && /\?$/.test(out.trim());
  ck(`«${inp.slice(0, 45)}…» → resposta certa + pergunta mantida`, ok, out);
}
const good = "Yes, we have a mobile showroom, I bring every sample to your place so you can compare them on your floor. One area or the whole house?";
ck("reply que já cita mobile showroom fica igual", fixShowroomDenial(good) === good);
const goodMixed = "We don't have a physical store, but we do have a mobile showroom: I bring all the samples to you. One area or the whole house?";
ck("reply certa com 'don't have a physical store' + 'mobile showroom' fica igual", fixShowroomDenial(goodMixed) === goodMixed, fixShowroomDenial(goodMixed));
const unrelated = "For 800 sqft I'd need to come measure, what's the zip code there?";
ck("reply sem showroom fica igual", fixShowroomDenial(unrelated) === unrelated);
const tagged = 'We don\'t have a showroom. [NOTIFY_OWNER: client asked "do you have a showroom or store"]';
const outTag = fixShowroomDenial(tagged);
ck("tag [NOTIFY_OWNER] intacta", outTag.includes('[NOTIFY_OWNER: client asked "do you have a showroom or store"]') && /mobile showroom/.test(outTag), outTag);

console.log("\n━━ 3. prompt ━━");
const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
ck("regra (2c) SHOWROOM no prompt", /\(2c\) SHOWROOM → the answer is YES, we have a MOBILE SHOWROOM/.test(prompt));
ck("prompt proíbe 'we don't have a showroom'", /NEVER say "we don't have a showroom"/.test(prompt));

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 4. ao vivo ━━");
  const cases: Array<[string, ChatMessage[], RegExp, RegExp]> = [
    ["EN mid-convo (caso real)", [
      U("Where are you located"),
      A("We are based in Miami and serve all of South Florida, from Homestead to Jupiter. Which flooring are you thinking about, tile, vinyl, or hardwood?"),
      U("Do you have a showroom"),
    ], /mobile showroom/i, /(?:don'?t|do not)\s+have\s+(?:a\s+)?showroom|no showroom/i],
    ["ES", [U("Hola, quiero cambiar el piso de la sala"), A("¿Cuál piso te interesa, tile, vinyl o hardwood?"), U("Vinyl. ¿Tienen showroom para ir a ver?")], /showroom m[oó]vil/i, /no tenemos showroom/i],
    ["PT", [U("Oi, quero trocar o piso da sala"), A("Qual piso você está pensando, tile, vinyl ou hardwood?"), U("Vinyl. Vocês têm loja ou showroom pra eu ver?")], /showroom m[oó]vel/i, /n[aã]o temos showroom/i],
  ];
  for (const [name, msgs, want, forbid] of cases) {
    try {
      const r = await getAIResponse(msgs, null, null, undefined, false);
      const text = typeof r === "string" ? r : ((r as { text?: string; response?: string }).text ?? (r as { response?: string }).response ?? JSON.stringify(r));
      ck(`${name}: cita showroom móvel e não nega`, want.test(text) && !forbid.test(text), text);
    } catch (e) { ck(`${name}: chamada`, false, String(e)); }
  }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
