// 02/11/2026 — regra do dono: nenhum link em canal nenhum (Instagram, Messenger,
// WhatsApp), nenhum ZIP code de cara (a proposta da visita já traz os dois
// horários; o ZIP vem com o endereço completo + telefone depois do horário
// escolhido) e pedido de amostra = número do Ozzi (561) 674-8334.
// A memória do Dreaming (/learnings.md no memory store, injetada em TODA
// conversa) ainda ensinava "Zip-first, then two times", "end with the zip
// question" e a FAQ de fotos com o link https://ozzifloors.company + ZIP.
// Troca essas passagens pela regra nova e confere que não sobrou link nem
// "zip question". O cron das 06:00 reescreve a partir do conteúdo atual com as
// regras 7 e 13 do Dreaming (já atualizadas), então a troca persiste.
// DRY por padrão; APPLY=1 grava e relê para confirmar. OUT_DIR guarda antes/depois.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";

const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
let storeId = env.ANTHROPIC_SYSTEM_STORE_ID;
if (!storeId) storeId = (await anthropic.beta.memoryStores.list()).data.find((s) => s.name === "ozzifloors-system")?.id;
const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
const item = page.data.find((x) => x.type === "memory" && x.path === "/learnings.md");
if (!item) { console.error("ABORT: /learnings.md não encontrado no store"); process.exit(1); }
const mem = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
const before = mem.content ?? "";
const OUT = process.env.OUT_DIR || ".";
writeFileSync(`${OUT}/learnings-before-0211.md`, before);

const SWAPS = [
  [
    "1. **Zip-first, then two times.** Every booking followed the same flow: visit proposal → zip question in the same message → coverage confirmed → two real times offered. Clients picked one and the address came next. No deviations from this order converted.",
    "1. **Visit proposal with the two times in the same message (owner rule 2026-11-02: the zip code is never asked up front, on any channel).** The flow that converts now: visit proposal → two real times from the schedule in that same message → the client picks one → full address with the zip code and the phone, asked together. Conversations before 2026-11-02 that asked the zip code first were the retired script, not a pattern to repeat.",
  ],
  [
    "Check our floors at https://ozzifloors.company — I also bring all physical samples to the free visit. What's the zip code?",
    "I bring all the samples to the free visit, and if you want to see them before that, just text Ozzi at (561) 674-8334 (on Instagram you may add that our website link is in our bio). Never a link, on any channel. Is it one area or the whole house?",
  ],
  [
    "A differently worded reply — or a direct move to the visit proposal with the zip question — breaks the loop.",
    "A differently worded reply — or a direct move to the visit proposal with the two times — breaks the loop.",
  ],
  [
    "2. **No zip gathered before offering times.** In (CQ) the agent offered \"Monday at 2pm or 8pm\" before confirming zip or coverage, then had to circle back. When location is unknown, the zip question must come with the visit proposal, never after the times.",
    "2. **Times offered, then the address with the zip code (owner rule 2026-11-02).** The visit proposal carries the two real times right away, on every channel; the zip code is never a question of its own and never comes before the times. It is collected with the full address and the phone after the client picks a time, and the service area is checked from that address.",
  ],
  [
    "switch moves: propose the free visit and end with the zip question. Example: \"Want me to come by and show you everything in person? What's the zip code of the property?\"",
    "switch moves: propose the free visit with the two real times from the schedule. Example: \"Want me to come by and show you everything in person? I can come [soonest day] at [its earliest time] or [its latest time], which works?\"",
  ],
];

let content = before;
let swapped = 0;
for (const [oldText, newText] of SWAPS) {
  const occ = content.split(oldText).length - 1;
  console.log(`${occ}x  «${oldText.slice(0, 70)}…»`);
  if (occ > 0) { content = content.split(oldText).join(newText); swapped += occ; }
}
const LEFTOVER = /https?:\/\/|ozzifloors\.co|gethearth|zip[- ]first|zip question|end with the zip|zip code of the property\?|before offering times|zip.{0,25}before.{0,25}times/i;
const left = content.split("\n").filter((l) => LEFTOVER.test(l));
if (left.length) { console.error("ABORT: ainda sobrou link / ZIP de cara:\n" + left.map((l) => "  " + l.slice(0, 300)).join("\n")); process.exit(1); }
writeFileSync(`${OUT}/learnings-after-0211.md`, content);
console.log(`\n${swapped} trocas, ${before.length} -> ${content.length} chars, nenhum link e nenhum ZIP de cara sobrando`);
if (swapped === 0) { console.log("nada a trocar (já está com a regra nova)"); process.exit(0); }
if (process.env.APPLY !== "1") { console.log("DRY (nada gravado). APPLY=1 para gravar."); process.exit(0); }
await anthropic.beta.memoryStores.memories.update(item.id, { memory_store_id: storeId, content });
const again = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
console.log(`learnings.md atualizado: ${(again.content ?? "") === content ? "CONFIRMADO (releitura idêntica)" : "DIVERGENTE"}`);
