// Stairs price update (2026-07-24): $140/step → $150/step.
// Static guard: the prompt must carry the new price and zero traces of the old.
// Live guard: the bot must quote $150 per step (never $140, never the old
// 16×140=$2,240 math) when a client asks about stairs.
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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 160)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

async function main() {
  // ── 1. STATIC: the system prompt itself ────────────────────────────────────
  console.log("\n[1] Prompt source carries $150/step (no $140 leftovers)");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system-prompt.ts has 'Stairs: $150/step'", promptSrc.includes("Stairs: $150/step"));
  ck("system-prompt.ts has NO '$140/step'", !promptSrc.includes("$140/step"));

  // ── 2. LIVE: direct stairs price question (type known — a bare first-contact
  // ask correctly hits the type-first opener instead, no price) ───────────────
  console.log("\n[2] Direct ask mid-convo → $150 per step, never $140, never per sqft");
  const r1 = await ai([
    { role: "user", content: "Hi! How much is your flooring?" },
    { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
    { role: "user", content: "Vinyl. And how much do you charge for stairs?" },
  ]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 160));
  ck("quotes $150", /\$\s?150\b/.test(r1), r1);
  ck("says per step", /step/i.test(r1), r1);
  ck("never the old $140", !/\$\s?140\b/.test(r1), r1);
  // Only the STAIRS price itself may not be per-sqft ("stairs are $X per sqft").
  // The vinyl promo's own "$5 per sqft" in the same sentence is fine.
  ck("stairs price is never expressed per sqft", !/stair[^.!?\n]{0,40}\$\s?\d[\d,]*[^.!?\n]{0,15}per\s+(?:sq|square)/i.test(r1), r1);

  // ── 3. LIVE: step count given → new math (16 × $150 = $2,400) ─────────────
  console.log("\n[3] 16 steps → $150/step math, never the old $2,240 total");
  const r2 = await ai([
    { role: "user", content: "I want to redo my stairs with vinyl. I have 16 steps, how much would that be?" },
  ]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 160));
  ck("no old total $2,240 (16 × $140)", !/2,?240/.test(r2), r2);
  ck("uses the new price ($150/step or $2,400 total)", /\$\s?150\b/.test(r2) || /2,?400/.test(r2), r2);
  ck("never the old $140", !/\$\s?140\b/.test(r2), r2);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("Failed:"); for (const f of fails) console.log(`  • ${f}`); }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("stairs-price-verify crashed:", e); process.exit(1); });
