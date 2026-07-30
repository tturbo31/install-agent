// Company email rule (2026-07-30, owner request): if the client asks for our
// email (or whether we even have one), the bot must say YES and give EXACTLY
// ozzifloors@gmail.com — never deny having an email, never invent another one.
// Static guard: the prompt carries the COMPANY EMAIL rule with that address.
// Live guard: direct ask + "do you have an email?" both get the right address.
// Run: npx tsx src/evals/company-email-verify.ts
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

const EMAIL = "ozzifloors@gmail.com";
// any other email address in the reply = invented contact, hard fail
function onlyOurEmail(text: string): boolean {
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return found.every(e => e.toLowerCase() === EMAIL);
}

async function main() {
  // ── 1. STATIC: the system prompt itself ────────────────────────────────────
  console.log("\n[1] Prompt source carries the COMPANY EMAIL rule");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("system-prompt.ts has COMPANY EMAIL rule", promptSrc.includes("COMPANY EMAIL"));
  ck(`system-prompt.ts has ${EMAIL}`, promptSrc.includes(EMAIL));

  // ── 2. LIVE: direct email ask mid-convo ────────────────────────────────────
  console.log("\n[2] 'What's your email?' mid-convo → gives ozzifloors@gmail.com");
  const r1 = await ai([
    { role: "user", content: "Hi! How much is your flooring?" },
    { role: "assistant", content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
    { role: "user", content: "Vinyl. What's your email? I want to send you some photos of the space." },
  ]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 160));
  ck("gives ozzifloors@gmail.com", r1.toLowerCase().includes(EMAIL), r1);
  ck("no invented email", onlyOurEmail(r1), r1);
  ck("does not deny having an email", !/(don'?t|do not|no)\s+(have|use)\s+(an?\s+)?e-?mail/i.test(r1), r1);

  // ── 3. LIVE: "do you guys have an email?" → yes + the address ──────────────
  console.log("\n[3] 'Do you guys have an email?' → confirms and gives the address");
  const r2 = await ai([
    { role: "user", content: "Hello, do you guys have an email address for the company?" },
  ]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 160));
  ck("gives ozzifloors@gmail.com", r2.toLowerCase().includes(EMAIL), r2);
  ck("no invented email", onlyOurEmail(r2), r2);
  ck("does not deny having an email", !/(don'?t|do not|no)\s+(have|use)\s+(an?\s+)?e-?mail/i.test(r2), r2);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("Failed:"); for (const f of fails) console.log(`  • ${f}`); }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("company-email-verify crashed:", e); process.exit(1); });
