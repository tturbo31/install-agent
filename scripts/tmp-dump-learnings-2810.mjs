// READ-ONLY: dumps /learnings.md from the Anthropic memory store and greps herringbone lines.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
let storeId = env.ANTHROPIC_SYSTEM_STORE_ID;
if (!storeId) storeId = (await anthropic.beta.memoryStores.list()).data.find((s) => s.name === "ozzifloors-system")?.id;
const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
const item = page.data.find((x) => x.type === "memory" && x.path === "/learnings.md");
if (!item) { console.error("learnings.md not found"); process.exit(1); }
const mem = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
const content = mem.content ?? "";
const out = process.argv[2];
writeFileSync(out, content);
console.log(`chars: ${content.length}`);
const lines = content.split("\n");
lines.forEach((l, i) => { if (/herring|harring|hearing bone|\$?7\.50|\$?11\.50|espiga|espinha/i.test(l)) console.log(`${i + 1}: ${l.slice(0, 300)}`); });
