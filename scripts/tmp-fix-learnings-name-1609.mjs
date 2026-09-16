// Tira o "nome + endereço + telefone" do learnings.md (memória do Dreaming) —
// regra do dono 16/09/2026: o nome NÃO é requisito e nunca é pedido.
// Tudo ou nada: cada trecho tem que existir exatamente uma vez; senão nada é gravado.
// DRY=1 só mostra o antes/depois sem gravar.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
let storeId = env.ANTHROPIC_SYSTEM_STORE_ID;
if (!storeId) storeId = (await anthropic.beta.memoryStores.list()).data.find((s) => s.name === "ozzifloors-system")?.id;
const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
const item = page.data.find((x) => x.type === "memory" && x.path === "/learnings.md");
const mem = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
let content = mem.content ?? "";
const before = content;

const patches = [
  [
    `5. **Collecting all three booking details in one request** — Confirmed appointments included a single clean ask: *"Can I get your name, the property address, and the best phone number?"* Splitting this across multiple messages (as in 27e7469c, deac6555) added friction and delayed or stalled confirmation.`,
    `5. **Collecting both booking details in one request** — Confirmed appointments included a single clean ask: *"Can I get the property address with the zip code and the best phone number?"* (the client's name is NOT asked, owner rule 2026-09-16). Splitting this across multiple messages (as in 27e7469c, deac6555) added friction and delayed or stalled confirmation.`,
  ],
  [
    `Each additional message is a drop-off risk. Collecting name + address + phone in a single ask closes this gap.`,
    `Each additional message is a drop-off risk. Collecting address (with the zip code) + phone in a single ask closes this gap; the name is never asked (owner rule 2026-09-16).`,
  ],
  [
    `2. **Always collect name + address + phone in a single message once a time slot is agreed.** Current pattern splits this across two or three messages, causing drop-off (27e7469c, deac6555, gabymgam). Use: *"I'm holding that [Day] at [Time] for you — can I get your name, the property address, and the best phone number?"* as one unit, every time.`,
    `2. **Always collect address (with the zip code) + phone in a single message once a time slot is agreed, never the name.** Current pattern splits this across two or three messages, causing drop-off (27e7469c, deac6555, gabymgam). Use: *"I'm holding that [Day] at [Time] for you, can I get the property address with the zip code and the best phone number?"* as one unit, every time. The client's name is NOT a booking requirement and is never asked (owner rule 2026-09-16).`,
  ],
];
for (const [find, rep] of patches) {
  const n = content.split(find).length - 1;
  if (n !== 1) { console.error(`ABORT: trecho encontrado ${n}x: ${find.slice(0, 80)}`); process.exit(1); }
  content = content.replace(find, rep);
}
if (/can i get your name|name \+ address \+ phone|your name, the property address/i.test(content)) { console.error("ABORT: ainda há pedido de nome no texto"); process.exit(1); }

const out = "C:/Users/vicam/AppData/Local/Temp/claude/c--Users-vicam-Downloads-Ozzi-floors-instagram-dm-agent/e6cd9248-ebfe-433b-aca2-65ba4df3e067/scratchpad/learnings-after-name-1609.md";
writeFileSync(out, content);
if (process.env.DRY === "1") { console.log(`DRY: ${before.length} -> ${content.length} chars, gravado só em ${out}`); process.exit(0); }
await anthropic.beta.memoryStores.memories.update(item.id, { memory_store_id: storeId, content });
const again = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
const ok = (again.content ?? "") === content;
console.log(`learnings.md atualizado: ${ok ? "CONFIRMADO (releitura idêntica)" : "DIVERGENTE"}; ${before.length} -> ${content.length} chars; linhas com 'name' agora:`);
for (const l of content.split("\n").filter((l) => /\bname\b/i.test(l))) console.log("  " + l.slice(0, 220));
