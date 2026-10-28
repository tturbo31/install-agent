// 28/10/2026 — o dono corrigiu o preço do herringbone: $7.50/sqft é a PROMO e já
// inclui o vinil de luxo em herringbone, a instalação e o quarter round; $4/sqft
// é só a mão de obra. A memória do Dreaming (/learnings.md no memory store,
// injetada em TODA conversa) ainda ensinava "$4 labor + $7.50 material per sqft".
// Troca essa frase pela regra correta e confere que não sobrou "$7.50 material",
// "$11.50" ou "material is $7.50". O cron das 06:00 só reescreve a partir do
// conteúdo atual, então a troca persiste (e a trava 16 do Dreaming foi corrigida).
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
writeFileSync(`${OUT}/learnings-before-2810.md`, before);

const OLD = "at $4 labor + $7.50 material per sqft (never $5)";
const NEW = "at $7.50 per sqft with our luxury vinyl herringbone floor, the installation and the quarter round included, or $4 per sqft labor only if the client supplies the material (never $5, and never the $7.50 as a material price on top of the $4 labor)";
const occ = before.split(OLD).length - 1;
console.log(`ocorrências da frase antiga: ${occ}`);
for (const l of before.split("\n")) if (l.includes(OLD)) console.log("  ANTES:", l.slice(0, 300));
const LEFTOVER = /\$?7\.50\s*(?:\/\s*sqft\s*)?(?:per\s+sqft\s+)?(?:for\s+(?:the\s+)?|of\s+(?:the\s+)?)?material|material\s+(?:is|at|per\s+sqft)?\s*\$?7\.50|\$?11\.50|\$?4\s*(?:labor\s*)?\+\s*\$?7\.50/i;
if (occ === 0) {
  const left = before.split("\n").filter((l) => LEFTOVER.test(l));
  console.log(left.length ? "nada a trocar pela frase exata, mas sobrou:\n" + left.map((l) => "  " + l.slice(0, 300)).join("\n") : "nada a trocar (já está com a regra nova)");
  process.exit(left.length ? 1 : 0);
}

const content = before.split(OLD).join(NEW);
for (const l of content.split("\n")) if (l.includes(NEW)) console.log("  DEPOIS:", l.slice(0, 400));
const leftover = content.split("\n").filter((l) => LEFTOVER.test(l));
if (leftover.length) { console.error("ABORT: ainda há a regra antiga:\n" + leftover.map((l) => "  " + l.slice(0, 300)).join("\n")); process.exit(1); }
writeFileSync(`${OUT}/learnings-after-2810.md`, content);
console.log(`\n${before.length} -> ${content.length} chars`);
if (process.env.APPLY !== "1") { console.log("DRY (nada gravado). APPLY=1 para gravar."); process.exit(0); }
await anthropic.beta.memoryStores.memories.update(item.id, { memory_store_id: storeId, content });
const again = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
console.log(`learnings.md atualizado: ${(again.content ?? "") === content ? "CONFIRMADO (releitura idêntica)" : "DIVERGENTE"}`);
