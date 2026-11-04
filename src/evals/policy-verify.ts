// Verifies two owner policies:
//  1. Jobs UNDER 200 sqft are declined (no price, no visit) — while 200-400 sqft
//     is still quoted as before (no regression).
//  2. Job seekers / people offering their labor get NO reply at all (deterministic
//     silence in all three webhooks + a [REACT_ONLY] prompt backup).
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isJobSeeker, stripWrappingQuotes, type ChatMessage } from "../lib/ai";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);

// "wouldn't be able to take that on since we focus on installations over 200
// square feet" is a valid decline phrasing the model produces — accept
// "wouldn't be able" and "over 200" alongside the original stems.
const DECLINES = (t: string) => /don'?t take|do not take|under 200|over 200|focus on larger|too small|won'?t be able|wouldn'?t be able|not able to take|we only|larger (projects|installations|jobs)/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const PROPOSES_VISIT = (t: string) => /visit|in.?person|come (by|out|measure)|stop by|measure in person/i.test(t);
// Owner rule 2026-11-04: every size gets the visit (the under-400 Ozzi rule of 2026-09-11 is retired); the number below must NOT show up for a size. Was: under 400 sqft is never priced or declined, the client
// gets Ozzi's direct line instead.
const OZZI_DIRECT = (t: string) => /\(?\s?561\s?\)?[\s.-]*674[\s.-]*8334/.test(t);

async function main() {
  console.log("\n===================== POLICY VERIFICATION =====================");

  // ── 1. Job-seeker detection (unit, no API) ───────────────────────────────
  console.log("\n[1] isJobSeeker — POSITIVES (must be silenced)");
  const positives = [
    "Are you guys hiring?",
    "I'm an installer looking for work, do you have any jobs?",
    "Do you need workers?",
    "I'm a painter, can I work for you?",
    "Looking for a job, I do flooring installation",
    "busco trabajo, soy instalador",
    "están contratando? necesito trabajo",
    "procuro emprego, sou instalador de pisos",
    "vocês estão contratando? sou pintor",
    "do you have any openings for installers",
    "can I join your crew",
  ];
  for (const p of positives) ck(`positive: "${p}"`, isJobSeeker(p) === true, "not detected");

  console.log("\n[1b] isJobSeeker — NEGATIVES (real customers, must NOT be silenced)");
  const negatives = [
    "Do you have installers available?",
    "I need my floor installed, how much?",
    "Who installs the flooring?",
    "How much per sqft?",
    "Can you install over tile?",
    "I need a job done in my kitchen",
    "Do you do installation or just sell material?",
    "What is included in the package?",
  ];
  for (const n of negatives) ck(`negative: "${n}"`, isJobSeeker(n) === false, "false-positive (would silence a customer)");

  // ── 2. EVERY size gets the free visit (owner rule 2026-11-04, replaces the
  //       under-400 Ozzi rule and the 400-499 DM quote of 2026-09-11)
  console.log("\n[2] Every size → the free visit (no Ozzi line for size, no DM total, no decline)");
  const TOTAL = (t: string) => /\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{3,}/.test(t);
  for (const [label, msg] of [
    ["150 sqft bathroom floor", "Hi, I need new flooring for my bathroom, it's about 150 square feet."],
    ["100 sqft closet", "just a small closet, maybe 100 sqft of vinyl"],
    ["250 sqft room", "I want luxury vinyl for a 250 sqft room, how much?"],
    ["450 sqft room", "I want luxury vinyl for a 450 sqft room, how much?"],
  ] as const) {
    const r = await ai([{ role: "user", content: msg }]);
    console.log(`   ${label}:`, r.replace(/\s+/g, " ").slice(0, 140));
    ck(`${label} → proposes the visit`, PROPOSES_VISIT(r), r);
    ck(`${label} → no DM total, no decline, no Ozzi number for the size`, !TOTAL(r) && !DECLINES(r) && !OZZI_DIRECT(r), r);
  }

  // ── 4. Job seeker → AI backup emits [REACT_ONLY] ─────────────────────────
  console.log("\n[4] AI backup silences a job seeker ([REACT_ONLY])");
  const j1 = await ai([{ role: "user", content: "Hello, I'm a flooring installer looking for work. Are you hiring?" }]);
  console.log("   AI:", j1.replace(/\s+/g, " ").slice(0, 120));
  const silenced = /\[REACT_ONLY\]/i.test(j1) || j1.replace(/\[[^\]]*\]/g, "").trim().length === 0;
  ck("job seeker → [REACT_ONLY] or empty (no sales pitch)", silenced, j1);
  ck("job seeker → does not quote $5 sales pitch", !/\$5/.test(j1), j1);

  // ── 5. Webhook wiring (source inspection) ────────────────────────────────
  console.log("\n[5] All three webhooks silence job seekers deterministically");
  const hooks: Array<[string, string]> = [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ];
  for (const [name, rel] of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports isJobSeeker`, /isJobSeeker/.test(src));
    ck(`${name}: silently returns on job seeker`, /if \(isJobSeeker\(enrichedText\)\) \{[\s\S]{0,120}return;/.test(src), rel);
  }

  // ── 6. Prompt has the under-200 decline + job-seeker rules ───────────────
  console.log("\n[6] System prompt encodes both policies");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("prompt: NO SIZE THRESHOLD (owner rule 2026-11-04), the PROJECTS UNDER 400 SQFT section is gone", /NO SIZE THRESHOLD \(owner rule 2026-11-04/.test(sp) && !/## PROJECTS UNDER 400 SQFT/.test(sp));
  ck("prompt: the old under-200 decline is gone", !/UNDER 200 sqft: WE DO NOT TAKE THESE JOBS/.test(sp));
  ck("prompt: JOB SEEKERS section emits [REACT_ONLY]", /JOB SEEKERS \/ SERVICE PROVIDERS[\s\S]{0,900}\[REACT_ONLY\]/.test(sp));

  // ── 7. Wrapping quotes are stripped (the reported bug) ───────────────────
  console.log("\n[7] Wrapping quotation marks are stripped from replies");
  const screenshotMsg = '"Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. Are you planning to do just one area, or will it be the entire house?"';
  ck("strips straight double-quotes wrapping the whole message", !stripWrappingQuotes(screenshotMsg).startsWith('"') && !stripWrappingQuotes(screenshotMsg).endsWith('"'), stripWrappingQuotes(screenshotMsg));
  ck("keeps the actual content", stripWrappingQuotes(screenshotMsg).startsWith("Hello, the promotional package"), stripWrappingQuotes(screenshotMsg));
  ck("strips curly quotes", stripWrappingQuotes("“All set, see you then!”") === "All set, see you then!");
  ck("strips a stray leading quote", stripWrappingQuotes('"Hello there') === "Hello there");
  ck("leaves an interior quote alone", stripWrappingQuotes('He said "hi" to me') === 'He said "hi" to me');
  ck("leaves a normal message untouched", stripWrappingQuotes("Perfect, see you then!") === "Perfect, see you then!");
  ck("does not break a [BOOK] message (ends with ])", stripWrappingQuotes('All set![BOOK:{"date":"2026-06-14"}]') === 'All set![BOOK:{"date":"2026-06-14"}]');
  // Live: the exact screenshot scenario must not come back quoted.
  const live = await ai([
    { role: "assistant", content: "Hi Jacque! Need flooring done? We offer expert installation services like the one you see here." },
    { role: "user", content: "Is installation labor cost extra?" },
  ]);
  console.log("   live:", live.replace(/\s+/g, " ").slice(0, 120));
  ck("live reply is not wrapped in quotes", !live.trim().startsWith('"') && !live.trim().endsWith('"'), live);

  console.log(`\n============ POLICY-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
