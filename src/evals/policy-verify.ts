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

const DECLINES = (t: string) => /don'?t take|do not take|under 200|focus on larger|too small|won'?t be able|not able to take|we only|larger (projects|installations|jobs)/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const PROPOSES_VISIT = (t: string) => /visit|in.?person|come (by|out|measure)|stop by|measure in person/i.test(t);

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

  // ── 2. Under 200 sqft → declined (AI), no price, no visit ────────────────
  console.log("\n[2] Under 200 sqft is declined");
  const u1 = await ai([{ role: "user", content: "Hi, I need new flooring for my bathroom, it's about 150 square feet." }]);
  console.log("   150 sqft:", u1.replace(/\s+/g, " ").slice(0, 140));
  ck("150 sqft → declines", DECLINES(u1), u1);
  ck("150 sqft → no price quoted", !HAS_PRICE(u1), u1);
  ck("150 sqft → no visit proposed", !PROPOSES_VISIT(u1), u1);

  const u2 = await ai([{ role: "user", content: "just a small closet, maybe 100 sqft of vinyl" }]);
  console.log("   100 sqft:", u2.replace(/\s+/g, " ").slice(0, 140));
  ck("100 sqft → declines, no price", DECLINES(u2) && !HAS_PRICE(u2), u2);

  // ── 3. 200-400 sqft is STILL quoted (no regression) ──────────────────────
  console.log("\n[3] 200-400 sqft still quoted (regression guard)");
  const q1 = await ai([{ role: "user", content: "I want luxury vinyl for a 250 sqft room, how much?" }]);
  console.log("   250 sqft:", q1.replace(/\s+/g, " ").slice(0, 140));
  ck("250 sqft → gives a price (not declined)", HAS_PRICE(q1) && !DECLINES(q1), q1);
  // 250 x $5 + $500 = $1,750 → must be >= $1000 (the +$500 floor is applied)
  ck("250 sqft → total includes the small-job floor (>= $1,000)", (() => {
    const nums = [...q1.matchAll(/\$\s?([\d,]+)/g)].map(m => parseInt(m[1].replace(/,/g, ""), 10));
    return nums.some(n => n >= 1000);
  })(), q1);

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
  ck("prompt: UNDER 200 sqft decline rule", /UNDER 200 sqft: WE DO NOT TAKE THESE JOBS/.test(sp));
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
