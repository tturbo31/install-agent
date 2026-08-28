/**
 * ZIP JÁ DADO → o pedido de dados não repete "with the zip code" (caso Adelyn, IG 27/08/2026).
 *
 * Puro (sem modelo). Prova:
 *  1. clientAlreadyGaveZip: ZIP numa bolha do cliente (mesmo bolhas atrás) → true;
 *     ZIP só dentro de [SYSTEM:] / legenda de anúncio / bolha nossa → false.
 *  2. stripZipReask: apaga "with the zip code" / "including the zip code" /
 *     "con el código postal" / "com o zip code" do pedido de dados, mantendo o
 *     resto da frase intacto e as tags ([BOOK], [NOTIFY_OWNER]) protegidas.
 *  3. Nunca toca em pergunta isolada de ZIP ("What's the zip code for that
 *     address?") nem em frase sem ZIP.
 *  4. Prompt e nota ROUTE PRIORITY carregam a instrução.
 * Run: npx tsx src/evals/zip-reask-verify.ts
 */
import { clientAlreadyGaveZip, stripZipReask, isAskingForBookingInfo } from "../lib/ai";
import { readFileSync } from "fs";
import { join } from "path";
import { buildRoutePriorityNote, getRouteConfig, type DayRanking } from "../lib/route-optimizer";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (c: string) => ({ role: "user" as const, content: c });
const A = (c: string) => ({ role: "assistant" as const, content: c });

console.log("\n━━ 1. clientAlreadyGaveZip ━━");
const adelyn = [
  U("I have my own LVP, 1350 sqft"),
  A("Since you already have your own LVP and just need the installation, that comes out to $2 per square foot, and for 1,350 sqft I need to come measure in person. What's the zip code of the property?"),
  U("33176"),
  A("That zip is right in our area! I have tomorrow Friday the 28th at 9am or 1pm open, which works better for you?"),
  U("1pm\n\n[SYSTEM: REAL-TIME SCHEDULE ... 33176 ...]"),
];
ck("ZIP digitado 2 bolhas atrás → true", clientAlreadyGaveZip(adelyn));
ck("sem ZIP → false", !clientAlreadyGaveZip([U("hi"), A("What's the zip code?"), U("Miami")]));
ck("ZIP só no [SYSTEM:] → false", !clientAlreadyGaveZip([U("1pm\n\n[SYSTEM: client near 33176]")]));
ck("ZIP só na legenda do anúncio → false", !clientAlreadyGaveZip([U("[Client shared a post from our ad: 'Flooring 33176']")]));
ck("ZIP só em bolha nossa → false", !clientAlreadyGaveZip([A("We cover 33176"), U("ok")]));

console.log("\n━━ 2. stripZipReask ━━");
const cases: Array<[string, string]> = [
  ["Perfect, I'm holding that 1pm for you! Can I get your name, the full property address with the zip code, and the best phone number for the visit?",
   "Perfect, I'm holding that 1pm for you! Can I get your name, the full property address, and the best phone number for the visit?"],
  ["Perfect, I'm holding that slot while I grab your details. Can I get your name, the full property address including the zip code, and the best phone number?",
   "Perfect, I'm holding that slot while I grab your details. Can I get your name, the full property address, and the best phone number?"],
  ["Perfect! Can I have your name, the full address with its zip code and the best phone number?",
   "Perfect! Can I have your name, the full address and the best phone number?"],
  ["¡Perfecto! ¿Me das tu nombre, la dirección completa con el código postal y el mejor teléfono?",
   "¡Perfecto! ¿Me das tu nombre, la dirección completa y el mejor teléfono?"],
  ["Perfeito! Me passa seu nome, o endereço completo com o zip code e o melhor telefone?",
   "Perfeito! Me passa seu nome, o endereço completo e o melhor telefone?"],
];
for (const [inp, want] of cases) {
  const got = stripZipReask(inp);
  ck(`«${inp.slice(0, 50)}…»`, got === want, got);
}
const withTag = "Great, can I get your name, the full property address with the zip code, and your phone? [NOTIFY_OWNER: large lead 1350 sqft, zip code 33176]";
const gotTag = stripZipReask(withTag);
ck("tag [NOTIFY_OWNER] com 'zip code' fica intacta", gotTag.includes("[NOTIFY_OWNER: large lead 1350 sqft, zip code 33176]") && !/address with the zip/i.test(gotTag), gotTag);
const book = 'Perfect, see you then! [BOOK:{"address":"1 Main St, Miami FL 33176","notes":"with the zip code"}]';
ck("[BOOK] nunca é alterado", stripZipReask(book) === book, stripZipReask(book));

console.log("\n━━ 3. o que NÃO pode ser tocado ━━");
const lone = "Almost set! What's the zip code for that address?";
ck("pergunta isolada de ZIP fica igual", stripZipReask(lone) === lone, stripZipReask(lone));
const noZip = "Perfect! Can I get your name, the property address, and the best phone number?";
ck("frase sem ZIP fica igual", stripZipReask(noZip) === noZip);
const offer = "That zip is right in our area! I have Friday at 9am or 1pm, which works better?";
ck("gate: pedido de dados passa; oferta de horários que cita o ZIP sai intacta", isAskingForBookingInfo(cases[0][0]) && stripZipReask(offer) === offer);
ck("resultado ainda pede nome+endereço+telefone", isAskingForBookingInfo(stripZipReask(cases[0][0])) && /name/.test(stripZipReask(cases[0][0])) && /address/.test(stripZipReask(cases[0][0])) && /phone/.test(stripZipReask(cases[0][0])));

console.log("\n━━ 4. prompt + nota de rota ━━");
const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
ck("regra ZIP ALREADY GIVEN no prompt", /ZIP ALREADY GIVEN: if the client ALREADY typed their zip code earlier/.test(prompt));
ck("Step 3 / pedido único intactos", /Ask for the client's name, full address with the ZIP CODE, and phone ONLY after/.test(prompt) && /the FULL address WITH THE ZIP CODE, AND the phone together in ONE message/.test(prompt));
const day: DayRanking = { dateStr: "2026-09-01", displayDate: "Tuesday, September 1, 2026 [2026-09-01]", ranked: [{ slot: "09:00", score: 10, tier: "great", sellers: [], best: null } as never, { slot: "13:00", score: 20, tier: "great", sellers: [], best: null } as never], capacity: 4, open: 2 } as never;
const note = buildRoutePriorityNote([day], { lat: 25.6, lng: -80.3, zip: "33176", label: "33176", source: "zip" }, getRouteConfig(), (s) => s) ?? "";
ck("nota ROUTE PRIORITY avisa que o ZIP 33176 já foi dado", /ALREADY gave their zip code \(33176\)/.test(note) && /do NOT ask for the zip code again/.test(note), note);
const noteNoZip = buildRoutePriorityNote([day], { lat: 25.6, lng: -80.3, label: "Kendall", source: "city" }, getRouteConfig(), (s) => s) ?? "";
ck("sem ZIP (cidade) a nota não promete ZIP", !/ALREADY gave their zip code/.test(noteNoZip));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
