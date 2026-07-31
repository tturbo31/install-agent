// Stairs price rules (2026-07-31): two tiers, and only two.
//   $150/step = flooring material + installation labor INCLUDED (default)
//   $100/step = installation labor only, when the client supplies the material
// History: the prompt carried a bare "Stairs: $150/step" with no word on what
// it covered, so the model improvised — it called the $150 "labor only, you
// buy the material" (ES: "solo la instalación, el cliente compra su propio
// material", 17/06 + 06/07) and billed the full rate to clients who had
// already said they had their own material (14/06, 22/07, 23/07, 28/07).
// Static guard: the prompt carries both tiers and zero traces of $140 / $250.
// Live guard: the bot quotes $150 WITH the material included by default, and
// switches to $100 the moment the client supplies the material.
// Run: npx tsx src/evals/stairs-price-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

// "the material is included", in any of the three languages
const INCLUDES_MATERIAL = /includ|incluy|inclui|incluso|all in|con el material|com o material/i;
// the model telling the client to bring the floor — false at the $150 rate
const CLIENT_BUYS = /labou?r only|only the (installation|labor)|just the (installation|labor)|you (buy|supply|provide|bring)( me| us)? the (material|floor|vinyl|wood)|solo (la )?(instalaci|mano de obra)|el material lo (traes|pones|compras)|(su|tu) propio material|voc[eê] (traz|compra) o material/i;

async function main() {
  // ── 1. STATIC: the system prompt itself ────────────────────────────────────
  console.log("\n[1] Prompt source carries both tiers (no $140 / $250 leftovers)");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system-prompt.ts has the $150/step tier", /\$150\/step|\$150 per step/i.test(promptSrc));
  ck("system-prompt.ts has the $100/step tier", /\$100\/step|\$100 per step/i.test(promptSrc));
  ck("prompt states the $150 includes the material", /\$150[^\n]{0,140}(material included|includes? (the )?(flooring|material|floor))/i.test(promptSrc));
  ck("prompt states the $100 is labor only", /\$100[^\n]{0,160}(labor only|installation labor|supplies the material|client supplies)/i.test(promptSrc));
  ck("prompt has NO '$140/step'", !promptSrc.includes("$140/step") && !promptSrc.includes("$140 per step"));
  ck("prompt has NO '$250/step'", !promptSrc.includes("$250/step") && !promptSrc.includes("$250 per step"));
  ck("prompt closes the list to those two rates", /only stair prices that exist/i.test(promptSrc));

  // ── 2. LIVE: direct stairs price question (type known — a bare first-contact
  // ask correctly hits the type-first opener instead, no price) ───────────────
  console.log("\n[2] Direct ask mid-convo → $150 per step, material INCLUDED");
  const r1 = await ai([
    { role: "user", content: "Hi! How much is your flooring?" },
    { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
    { role: "user", content: "Vinyl. And how much do you charge for stairs?" },
  ]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 200));
  ck("quotes $150", /\$\s?150\b/.test(r1), r1);
  ck("says per step", /step/i.test(r1), r1);
  ck("says the material/floor is included", INCLUDES_MATERIAL.test(r1), r1);
  ck("does NOT call the $150 labor-only", !CLIENT_BUYS.test(r1), r1);
  ck("never the old $140", !/\$\s?140\b/.test(r1), r1);
  ck("never the invented $250", !/\$\s?250\b/.test(r1), r1);
  // Only the STAIRS price itself may not be per-sqft ("stairs are $X per sqft").
  // The vinyl promo's own "$5 per sqft" in the same sentence is fine.
  ck("stairs price is never expressed per sqft", !/stair[^.!?\n]{0,40}\$\s?\d[\d,]*[^.!?\n]{0,15}per\s+(?:sq|square)/i.test(r1), r1);

  // ── 3. LIVE: step count given → 16 × $150 = $2,400 ────────────────────────
  console.log("\n[3] 16 steps, material included → $2,400 (never $2,240, never $4,000)");
  const r2 = await ai([
    { role: "user", content: "I want to redo my stairs with vinyl. I have 16 steps, how much would that be?" },
  ]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 200));
  ck("uses the right rate ($150/step or $2,400 total)", /\$\s?150\b/.test(r2) || /2,?400/.test(r2), r2);
  ck("no old total $2,240 (16 × $140)", !/2,?240/.test(r2), r2);
  ck("no $250/step math (no $250, no $4,000)", !/4,?000/.test(r2) && !/\$\s?250\b/.test(r2), r2);

  // ── 4. LIVE: client supplies the material → $100/step, labor only ─────────
  console.log("\n[4] Client already has the material → $100 per step (labor only)");
  const r3 = await ai([
    { role: "user", content: "Hi, do you install flooring on stairs?" },
    { role: "assistant", content: "Yes, we do stairs. Are you thinking vinyl, tile, or hardwood?" },
    { role: "user", content: "Vinyl. I already bought the vinyl myself, I just need it installed on the stairs. How much per step?" },
  ]);
  console.log("   AI:", r3.replace(/\s+/g, " ").slice(0, 200));
  ck("quotes $100", /\$\s?100\b/.test(r3), r3);
  ck("does NOT charge the full $150 for the client's own material", !/\$\s?150\b/.test(r3), r3);
  ck("never the old $140", !/\$\s?140\b/.test(r3), r3);
  ck("never the invented $250", !/\$\s?250\b/.test(r3), r3);

  // ── 5. LIVE: same case with a step count → 12 × $100 = $1,200 ─────────────
  console.log("\n[5] 12 steps with the client's own material → $1,200 (never $1,800)");
  const r4 = await ai([
    { role: "user", content: "I have 12 stairs and I already have the laminate, I just need the labor. What's the total?" },
  ]);
  console.log("   AI:", r4.replace(/\s+/g, " ").slice(0, 200));
  ck("uses the labor-only rate ($100/step or $1,200 total)", /\$\s?100\b/.test(r4) || /1,?200/.test(r4), r4);
  ck("does not bill the material-included total ($1,800)", !/1,?800/.test(r4), r4);

  // ── 6. LIVE: Spanish, client brings the material ──────────────────────────
  console.log("\n[6] ES: cliente trae el material → $100 por escalón");
  // (com contexto: numa primeira mensagem o opener de tipo dispara antes, e isso é correto)
  const r5 = await ai([
    { role: "user", content: "Hola, hacen escaleras?" },
    { role: "assistant", content: "Hola, trabajamos con piso vinílico de lujo, tile y hardwood, y tenemos una promoción en cada uno. ¿Cuál te interesa?" },
    { role: "user", content: "Vinyl. Yo ya tengo el piso comprado, solo necesito la instalación en las escaleras. ¿Cuánto por escalón?" },
  ]);
  console.log("   AI:", r5.replace(/\s+/g, " ").slice(0, 200));
  ck("cotiza $100", /\$\s?100\b/.test(r5), r5);
  ck("no cobra $150 con material del cliente", !/\$\s?150\b/.test(r5), r5);
  ck("nunca $140 ni $250", !/\$\s?140\b/.test(r5) && !/\$\s?250\b/.test(r5), r5);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("Failed:"); for (const f of fails) console.log(`  • ${f}`); }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("stairs-price-verify crashed:", e); process.exit(1); });
