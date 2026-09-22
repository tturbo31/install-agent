// 22/09/2026 — o site mudou para https://ozzifloors.company. A memória do Dreaming
// (learnings.md, injetada em TODA conversa) ainda ensinava o link antigo como
// "ideal answer" (item 5, "Can you send photos of the floors?"). Troca todas as
// ocorrências do link antigo pelo novo. O cron das 06:00 só reescreve a partir do
// conteúdo atual, então a troca persiste.
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
writeFileSync(`${OUT}/learnings-before-2209.md`, before);

// Mesma grafia que o canonicalizeSiteLink do ai.ts aceita: com ou sem https://,
// com ou sem www., barra final solta; e-mails e subdomínios ficam de fora.
const OLD_RE = /(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?ozzifloors\.com(?!pany)(?![\w-])\/?/g;
const NEW = "https://ozzifloors.company";
const occ = (before.match(OLD_RE) ?? []).length;
console.log(`ocorrências do link antigo: ${occ}`);
for (const l of before.split("\n")) if (OLD_RE.test(l)) console.log("  ANTES:", l.slice(0, 200));
if (occ === 0) { console.log("nada a trocar (já está com o link novo)"); process.exit(0); }

const content = before.replace(OLD_RE, NEW);
for (const l of content.split("\n")) if (l.includes(NEW)) console.log("  DEPOIS:", l.slice(0, 200));
if (/(?<![\w.@-])(?:https?:\/\/)?(?:www\.)?ozzifloors\.com(?!pany)(?![\w-])/.test(content)) { console.error("ABORT: ainda há link antigo"); process.exit(1); }
writeFileSync(`${OUT}/learnings-after-2209.md`, content);
console.log(`\n${before.length} -> ${content.length} chars`);
if (process.env.APPLY !== "1") { console.log("DRY (nada gravado). APPLY=1 para gravar."); process.exit(0); }
await anthropic.beta.memoryStores.memories.update(item.id, { memory_store_id: storeId, content });
const again = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
console.log(`learnings.md atualizado: ${(again.content ?? "") === content ? "CONFIRMADO (releitura idêntica)" : "DIVERGENTE"}`);
