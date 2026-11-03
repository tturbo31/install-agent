// Prova ao vivo (16/09): com o learnings.md ATUAL da memória (já sem "zip primeiro") no contexto, a
// pergunta "Were r u located" (caso real de2355bc, 19:42Z) não recebe mais pedido de ZIP.
// Uso: npx tsx src/evals/tmp-location-learnings-1609.ts [N]
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse } from "../lib/ai";
import { getOrCreateSystemStore, readSystemMemory } from "../lib/dreaming";
import { getRealAvailabilityContext, getEasternDateContext } from "../lib/scheduler";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

const N = parseInt(process.argv[2] ?? "3", 10);
const ZIP_ASK = /\bzip\b|c[oó]digo\s+postal/i;

async function run() {
  const storeId = await getOrCreateSystemStore();
  const learnings = await readSystemMemory(storeId);
  console.log(`learnings: ${learnings?.length ?? 0} chars; ainda contém "What's the zip code"? ${/what'?s the zip code/i.test(learnings ?? "") ? "SIM" : "não"}`);
  const ctx = `\n\n[SYSTEM: ${[getEasternDateContext(), await getRealAvailabilityContext()].join("\n\n")}]`;
  let zipAsks = 0;
  for (let i = 0; i < N; i++) {
    const r = await getAIResponse(
      [
        { role: "user", content: "What type of materials are included?", at: "2026-09-16T19:39:42Z" },
        { role: "assistant", content: "Hello! It depends on the floor you pick: our vinyl promo already includes the flooring material, the installation labor, and the quarter round, while tile and hardwood cover the installation labor only. Which one are you interested in, tile, vinyl, or hardwood?", at: "2026-09-16T19:39:57Z" },
        { role: "user", content: "What is the installation process?", at: "2026-09-16T19:40:18Z" },
        { role: "assistant", content: "We move all the furniture, install the floors, add the quarter round, and clean everything up before we leave, so the space is ready to use the same day.", at: "2026-09-16T19:40:38Z" },
        { role: "user", content: "Were r u located" + ctx, at: "2026-09-16T19:42:04Z" },
      ],
      null, learnings, null, false
    );
    const t = r.text.replace(/\s+/g, " ").trim();
    const asks = ZIP_ASK.test(t);
    if (asks) zipAsks++;
    console.log(`${i + 1}. ${asks ? "PEDE ZIP " : "sem ZIP  "} | ${t.slice(0, 220)}`);
  }
  console.log(`\npede ZIP em ${zipAsks}/${N}`);
  process.exit(zipAsks === 0 ? 0 : 1);
}
run().catch((e) => { console.error(e); process.exit(1); });
