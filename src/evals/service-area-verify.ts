// Verifies the bot NEVER books a visit outside the service area (Miami / South
// Florida east coast, Homestead to Jupiter) — especially the Gulf / west coast
// (Fort Myers, Naples, Cape Coral, Tampa, etc.), and politely declines instead.
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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 180)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);

const SCHED = "\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\nREAL-TIME SCHEDULE AVAILABILITY:\n• Tuesday, June 9, 2026 [2026-06-09]: 9am, 11am, 1pm, 3pm\n• Wednesday, June 10, 2026 [2026-06-10]: 9am, 1pm]";

const declines = (r: string) => /only serve|don'?t (cover|service|serve)|do not (cover|service|serve)|outside our|miami area|east coast/i.test(r);
const noBook = (r: string) => !/\[BOOK:/i.test(r);

async function main() {
  console.log("\n===================== SERVICE-AREA VERIFICATION =====================");

  // ── West-coast cities: must decline, never book ──────────────────────────
  const westCities = ["Fort Myers", "Cape Coral", "Naples", "Tampa", "Bonita Springs", "Estero"];
  for (const city of westCities) {
    console.log(`\n[West coast] ${city}`);
    const r = await ai([{ role: "user", content: `Hi, I need vinyl flooring installed in my home in ${city}. Can you come give an estimate?` + SCHED }]);
    console.log("   AI:", r.replace(/\s+/g, " ").slice(0, 160));
    ck(`${city}: declines / says Miami area only`, declines(r), r);
    ck(`${city}: does NOT book`, noBook(r), r);
  }

  // ── Tries to lock a slot from a west-coast address → still must NOT book ──
  console.log("\n[West coast] client pushes to book anyway (Cape Coral address)");
  const push = await ai([
    { role: "user", content: "I want vinyl for my whole house" + SCHED },
    { role: "assistant", content: "I bring samples and measure for free. I have Tuesday at 9am or Wednesday at 1pm. What works?" },
    { role: "user", content: "Tuesday at 9am. Address is 123 SE 5th Ave, Cape Coral FL 33990, phone 239-555-1212" + SCHED },
  ]);
  console.log("   AI:", push.replace(/\s+/g, " ").slice(0, 180));
  ck("Cape Coral booking attempt → NO [BOOK] generated", noBook(push), push);
  ck("Cape Coral booking attempt → declines / Miami area only", declines(push), push);

  // ── Regression: a Miami-area client STILL books normally ─────────────────
  console.log("\n[In area] Miami client still books");
  const miami = await ai([
    { role: "user", content: "I want vinyl for my whole house in Miami" + SCHED },
    { role: "assistant", content: "I bring samples and measure for free. I have Tuesday at 9am or Wednesday at 1pm. What works?" },
    // The name is required since the owner's 2026-07-27 rule (a visit only closes
    // with a name the CLIENT typed) — without it the model correctly answers
    // "What name should I put the visit under?" and this regression check was
    // failing on a stale fixture, not on a real service-area bug.
    { role: "user", content: "Tuesday at 9am. Carlos Mendez, address is 800 NW 7th St, Miami FL 33136, phone 305-555-1212" + SCHED },
  ]);
  console.log("   AI:", miami.replace(/\s+/g, " ").slice(0, 180));
  ck("Miami booking → generates [BOOK:...] (not blocked)", /\[BOOK:/i.test(miami), miami);

  console.log(`\n============ SERVICE-AREA-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
