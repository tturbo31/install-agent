// 30/09/2026 — o learnings.md do Dreaming (injetado em TODA conversa) trazia no item
// "3. After a client names a day or time..." a instrução "move straight to confirmation
// and ask for the phone number": confirmar o horário que o cliente nomeou SEM conferir a
// agenda. É exatamente o padrão do caso wa_17329668249 ("Ok 6 will work" → "I'm holding
// that 6pm for you!" com o 6pm já ocupado). Reescreve o item para mandar conferir a linha
// do dia antes de segurar o horário. A trava 15 do Dreaming impede que volte.
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
writeFileSync(`${OUT}/learnings-before-3009.md`, before);

// O parágrafo inteiro do item 3 (título + explicação), até a linha em branco.
const OLD_RE = /\*\*3\. After a client names a day or time, skip the zip question and offer slots\.\*\*\n[^\n]*move straight to confirmation[^\n]*\n/;
const NEW =
  "**3. After a client names a day or time, skip the zip question and check that time against the schedule.**\n" +
  "In (Toti), the client said \"This Sunday @11?\" and the agent asked for the zip again after already having the address. When the client has already given the address, never ask the zip again. When they name or accept a day and time, check it against the REAL-TIME SCHEDULE first: if it is listed, hold it and ask only for what is still missing (the address with the zip code, the phone off WhatsApp); if it is not listed anymore, say so in one short clause and offer that day's listed times. Never hold or confirm a time that is not on the schedule.\n";

if (!OLD_RE.test(before)) { console.log("nada a trocar (o item 3 já não manda 'move straight to confirmation')"); process.exit(0); }
const content = before.replace(OLD_RE, NEW);
console.log("ANTES :", before.match(OLD_RE)[0].replace(/\n/g, " ⏎ ").slice(0, 400));
console.log("DEPOIS:", NEW.replace(/\n/g, " ⏎ ").slice(0, 500));
if (/move straight to confirmation/.test(content)) { console.error("ABORT: a frase antiga ainda está no arquivo"); process.exit(1); }
writeFileSync(`${OUT}/learnings-after-3009.md`, content);
console.log(`\n${before.length} -> ${content.length} chars`);
if (process.env.APPLY !== "1") { console.log("DRY (nada gravado). APPLY=1 para gravar."); process.exit(0); }
await anthropic.beta.memoryStores.memories.update(item.id, { memory_store_id: storeId, content });
const again = await anthropic.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId });
console.log(`learnings.md atualizado: ${(again.content ?? "") === content ? "CONFIRMADO (releitura idêntica)" : "DIVERGENTE"}`);
