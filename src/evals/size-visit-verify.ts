// Verifies the owner rule of 2026-11-04: NO SIZE THRESHOLD FOR THE VISIT.
//  Owner: "hoje tem uma restrição de 500 sq ft para a gente fazer a visita. Se
//  a pessoa falar 300 sq ft, pode fazer. Quando ela falar que é 3 quartos ou 2
//  quartos, também pode fazer a visita. Não é para calcular, estimar e falar que
//  a gente não faz. A gente vai fazer a visita no mesmo formato."
//  Replaces the rules of 2026-09-11 (under 400 sqft = Ozzi's number, 400 to 499
//  = quoted by DM, 500+ = visit). This file replaces small-job-ozzi-verify.ts.
//
//  1. DETERMINISTIC (no API): the size parser (detectStatedSqft /
//     mentionsStatedSize), the no-total backstop armed for any stated size,
//     and the wiring (no under-400 guard left in the brain, the prompt, the
//     three webhooks, the scheduler, the Dreaming constraints).
//  2. LIVE MODEL: 300 sqft, a closet, 2 bedrooms, 3 bedrooms, 450 sqft tile,
//     Spanish and Portuguese, mid-conversation answers → the free visit, no
//     total, no square-footage estimate, no "too small", no Ozzi number for
//     the size. Regressions: whole house 1500 sqft → visit; bathroom remodel →
//     still Ozzi direct.
// DET_ONLY=1 runs section 1 only.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, detectStatedSqft, mentionsStatedSize, conversationHasLargeLead, stripLargeLeadPrices,
  smallJobStanding, type ChatMessage,
} from "../lib/ai";
import { SYSTEM_PROMPT, OPENER_EN } from "../lib/system-prompt";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 240)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then((r) => r.text);
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works/i.test(t);
const OZZI_NUMBER = (t: string) => /\(?\s?561\s?\)?[\s.-]*674[\s.-]*8334/.test(t);
// A DM total: any dollar figure of $100 or more (per-sqft rates are under $10).
const HAS_TOTAL = (t: string) => /\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d{3,}/.test(t);
const TOO_SMALL = (t: string) =>
  /too small|minimum|only\s+(?:do|take|handle|work\s+(?:on|with))\s+(?:projects|jobs|installations)\s+(?:over|above|of)|over\s+500|under\s+400|menos\s+de\s+400|m[aá]s\s+de\s+500|acima\s+de\s+500|n[aã]o\s+fazemos|no\s+hacemos|don'?t\s+(?:do|take)\s+(?:small|that)/i.test(t);
const SQFT_ESTIMATE = (t: string) => /(?:about|around|roughly|approximately|probably|usually|typically|aprox\w*|unos|uns|cerca\s+de)\s+\d[\d,]*\s*(?:sq|square|pies|p[ée]s|sqft)/i.test(t);
const CLEAN_VISIT = (t: string) => PROPOSES_VISIT(t) && !HAS_TOTAL(t) && !TOO_SMALL(t) && !OZZI_NUMBER(t);

async function main() {
  console.log("\n================ NO SIZE THRESHOLD — EVERY SIZE GETS THE VISIT (owner rule 2026-11-04) ================");

  // ── 1. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[1] the size parser");
  ck("detectStatedSqft('about 300 sqft') = 300", detectStatedSqft("Hi, I need vinyl for my bedroom, about 300 sqft") === 300);
  ck("detectStatedSqft('30 m2') ≈ 323", Math.abs((detectStatedSqft("son unos 30 m2") ?? 0) - 323) <= 1);
  ck("detectStatedSqft('12x14 room') = 168", detectStatedSqft("my room is 12x14") === 168);
  ck("detectStatedSqft('1500 sq ft') = 1500", detectStatedSqft("whole house, 1500 sq ft") === 1500);
  ck("detectStatedSqft('2 bedrooms') = null (a room count is not a size, never estimated)", detectStatedSqft("carpet for 2 bedrooms") === null);
  ck("detectStatedSqft ignores the [SYSTEM:] note", detectStatedSqft("Hi\n\n[SYSTEM: Client stated about 900 sqft]") === null);
  ck("mentionsStatedSize: 300 sqft / 40 sqft / 12x14 room / 1500 sqft", ["about 300 sqft", "a closet, 40 sqft of vinyl", "my kitchen is 12x14", "1500 sqft"].every(mentionsStatedSize));
  ck("mentionsStatedSize: greeting / promo / 12x24 tile → false", !mentionsStatedSize("Hi") && !mentionsStatedSize("I'm interested in the promotion") && !mentionsStatedSize("I want 12x24 tiles"));
  ck("smallJobStanding still parses (informational): '350 sqft' = 350", smallJobStanding([u("about 350 sqft")]) === 350);

  console.log("\n[1b] the no-total backstop is armed for ANY stated size");
  ck("300 sqft arms it", conversationHasLargeLead([u("vinyl for my bedroom, about 300 sqft")]));
  ck("12x14 ft room arms it", conversationHasLargeLead([u("my kitchen is 12x14 ft, tile")]));
  ck("1500 sqft arms it (unchanged)", conversationHasLargeLead([u("whole house 1500 sqft")]));
  ck("no size → not armed", !conversationHasLargeLead([u("Hi, how much is the vinyl?")]));
  const leaked = "Our vinyl promo is $5 per sqft, so 300 sqft comes to about $1,500, and I can come measure for free on Tuesday at 9am or 5pm.";
  const stripped = stripLargeLeadPrices(leaked);
  ck("stripLargeLeadPrices drops the $1,500 total and keeps the rate + the visit", !/1,500/.test(stripped) && /\$5 per sqft/.test(stripped) && /measure/.test(stripped), stripped);

  console.log("\n[1c] wiring — no under-400 guard left anywhere");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  const schSrc = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  const drSrc = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
  ck("brain: no smallJobLeak / smallJobNote / smallJobReply", !/smallJobLeak\(|smallJobNote\(|smallJobReply\(/.test(aiSrc));
  ck("brain: rule 18 = EVERY SIZE GETS THE FREE VISIT", /18\. EVERY SIZE GETS THE FREE VISIT \(owner rule 2026-11-04/.test(aiSrc));
  ck("brain: rule 12 = NO DM TOTAL, ANY SIZE", /12\. NO DM TOTAL, ANY SIZE/.test(aiSrc));
  ck("brain: first-contact gate on ANY stated size", /const sizedFirstMessage = mentionsStatedSize\(burst\)/.test(aiSrc) && !/smallFirstMessage/.test(aiSrc));
  ck("prompt: NO SIZE THRESHOLD section, the PROJECTS UNDER 400 SQFT section is gone", /NO SIZE THRESHOLD \(owner rule 2026-11-04/.test(SYSTEM_PROMPT) && !/## PROJECTS UNDER 400 SQFT/.test(SYSTEM_PROMPT) && !/## STEP 2A: SMALL LEAD/.test(SYSTEM_PROMPT));
  ck("prompt: STEP 2B is the visit for every project", /## STEP 2B: THE FREE VISIT \(every project, any size\)/.test(SYSTEM_PROMPT));
  ck("prompt: no live 'under 400 = Ozzi' / '400 to 499 = DM quote' / '500 sqft or more' rule",
    !SYSTEM_PROMPT.split("\n").some((l) => !/owner rule 2026-11-04|retired/.test(l) && /under 400|400 to 499|500 sqft or more|500\+ sqft/i.test(l)));
  ck("prompt: never estimate sqft from a room count", /NEVER estimate or compute the square footage from the room count/.test(SYSTEM_PROMPT));
  ck("scheduler: the 'under 400 square feet' canned lines are gone", !/under 400 square feet|menos de 400 pies|menos de 400 pés/.test(schSrc) && /export const OZZI_DIRECT_PHONE = "\(561\) 674-8334"/.test(schSrc));
  ck("Dreaming: constraint 5 = NO SIZE THRESHOLD", /5\. NO SIZE THRESHOLD \(owner rule 2026-11-04/.test(drSrc) && !/the only compliant move is pointing the client to Ozzi directly at \(561\) 674-8334, and holding that line if the client insists\. NEVER recommend quoting or scheduling a job under 400/.test(drSrc));
  for (const [name, file] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]]) {
    const s = readFileSync(join(process.cwd(), file), "utf-8");
    ck(`${name}: no under-400 [BOOK] guard, no under-400 backstop`, !/smallJobStanding\(history\) !== null/.test(s) && !/smallJobLeak\(/.test(s));
    ck(`${name}: SIZE STATED note for any stated size`, /detectStatedSqft\(t\)/.test(s) && /\[SIZE STATED: Client stated about/.test(s));
  }

  if (process.env.DET_ONLY === "1") return finish();

  // ── 2. LIVE MODEL ─────────────────────────────────────────────────────────
  const cases: Array<{ name: string; msgs: ChatMessage[]; extra?: (t: string) => [string, boolean][] }> = [
    { name: "[2a] 'vinyl for my bedroom, about 300 sqft, how much?' (the owner's example)", msgs: [u("Hi, I need vinyl for my bedroom, about 300 sqft. How much?")] },
    { name: "[2b] 'carpet installed in 2 bedrooms, how much?' (room count, no size)", msgs: [u("I need carpet installed in 2 bedrooms. How much?")],
      extra: (t) => [["never estimates the sqft from the room count", !SQFT_ESTIMATE(t)]] },
    { name: "[2c] '3 bedrooms with tile' (room count)", msgs: [u("I want tile in 3 bedrooms, can you give me a price?")],
      extra: (t) => [["never estimates the sqft from the room count", !SQFT_ESTIMATE(t)]] },
    { name: "[2d] 'just a closet, about 40 sqft of vinyl'", msgs: [u("It's just a closet, about 40 sqft of vinyl. Do you do that?")] },
    { name: "[2e] 'tile, about 450 sqft' (was a $2,025 DM quote)", msgs: [u("Hi"), a(OPENER_EN), u("tile, about 450 sqft")],
      extra: (t) => [["no $2,025", !/2[,.]?025/.test(t)]] },
    { name: "[2f] mid-conversation: opener → 'vinyl' → '250 sqft'", msgs: [u("Hi"), a(OPENER_EN), u("vinyl"), a("Our vinyl promo is $5 per sqft, floor, installation and quarter round included. One area or the whole house?"), u("Just the living room, about 250 sqft")] },
    { name: "[2g] ES 'piso vinil para un cuarto de 250 pies cuadrados'", msgs: [u("Hola, necesito piso vinil para un cuarto de 250 pies cuadrados, cuanto sale?")],
      extra: (t) => [["answers in Spanish", /visita|medir|gratis|horario/i.test(t)]] },
    { name: "[2h] PT 'piso vinílico para 2 quartos'", msgs: [u("Oi, quero piso vinílico para 2 quartos, quanto fica?")],
      extra: (t) => [["answers in Portuguese", /visita|medir|medição|medicao|grátis|gratis|de graça|gratuita|horário|pessoalmente/i.test(t)], ["never estimates the sqft", !SQFT_ESTIMATE(t)]] },
    { name: "[2i] carpet 300 sqft (was the Ozzi line)", msgs: [u("Do you install carpet?"), a("Yes, we install carpet, it's $2.20 per square foot for the installation labor and you provide the carpet material. Is it one area or the whole house?"), u("It's 300 square feet, 2 bedrooms.")] },
  ];
  // The webhooks append the real schedule to the client's last bubble; the
  // live cases carry one too, so the model can offer two real times.
  const SCHED = [
    "", "", "[SYSTEM: Today is Wednesday, November 4, 2026.", "",
    "REAL-TIME SCHEDULE (Eastern time), SOONEST DAY FIRST:",
    "Thursday November 5 [2026-11-05]: 9am, 11am, 1pm, 5pm, 7pm",
    "Friday November 6 [2026-11-06]: 9am, 1pm, 5pm]",
  ].join("\n");
  const withSched = (msgs: ChatMessage[]): ChatMessage[] => msgs.map((m, i) => (i === msgs.length - 1 && m.role === "user" ? { ...m, content: m.content + SCHED } : m));
  for (const c of cases) {
    console.log("\n" + c.name);
    const t = await ai(withSched(c.msgs));
    console.log("   →", t.replace(/\s+/g, " ").slice(0, 240));
    ck("proposes the free visit", PROPOSES_VISIT(t), t);
    ck("no DM total ($100+)", !HAS_TOTAL(t), t);
    ck("never 'too small' / a minimum / a decline", !TOO_SMALL(t), t);
    ck("never Ozzi's number because of the size", !OZZI_NUMBER(t), t);
    for (const [label, ok] of c.extra?.(t) ?? []) ck(label, ok, t);
  }

  console.log("\n[3] REGRESSION: whole house 1500 sqft → visit, no total");
  const r1 = await ai([u("I need vinyl flooring for my whole house, about 1500 sqft.")]);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 240));
  ck("whole house: the clean visit", CLEAN_VISIT(r1), r1);

  console.log("\n[3b] REGRESSION: bathroom remodel → still Ozzi direct, no visit");
  const r2 = await ai([u("Hi, do you do bathroom remodeling?")]);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 240));
  ck("bathroom remodel: Ozzi's number, no visit, no price", OZZI_NUMBER(r2) && !PROPOSES_VISIT(r2) && !/\$\s?\d/.test(r2), r2);

  finish();
}
function finish() {
  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
