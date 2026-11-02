// 02/11/2026 — SÓ LEITURA: baixa o /learnings.md do memory store do Dreaming
// (injetado em toda conversa) para procurar padrões que briguem com a regra do
// dono de 02/11 (nenhum link em canal nenhum; nenhum ZIP de cara).
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
let storeId = env.ANTHROPIC_SYSTEM_STORE_ID;
if (!storeId) storeId = (await anthropic.beta.memoryStores.list()).data.find((s) => s.name === "ozzifloors-system")?.id;
const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
const item = page.data.find((x) => x.type === "memory" && x.path === "/learnings.md");
if (!item) { console.error("ABORT: /learnings.md não encontrado"); process.exit(1); }
const mem = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
writeFileSync("learnings-live-0211.md", mem.content ?? "");
console.log(`learnings.md: ${(mem.content ?? "").length} chars, ${(mem.content ?? "").split("\n").length} linhas -> learnings-live-0211.md`);
