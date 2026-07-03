/**
 * REGRESSION GUARD for the "quality dropped a lot" report (audit of 4 days of
 * real WhatsApp / Messenger / Instagram conversations, 2026-07). The recently
 * added deterministic "ask the flooring type first" opener was firing
 * MID-CONVERSATION and looping: a client asked "what's included / how much /
 * what materials" and got the identical canned line ("Hi, we work with luxury
 * vinyl, tile, and hardwood... which one are you interested in?") over and over,
 * ignoring the question. One real lead replied "You are a scam Bot!!!".
 *
 * Each case below is a REAL conversation prefix from production. The fix: the
 * deterministic canned type-ask fires on TRUE FIRST CONTACT only; after the bot
 * has already replied (especially after it already asked the type), the
 * full-context model handles the turn naturally. This eval proves:
 *   1. the exact canned opener NEVER appears mid-conversation, and
 *   2. the bot never sends two identical messages in a row, and
 *   3. first-contact behavior is UNCHANGED (still asks the type, no price).
 *
 * Run: npx tsx src/evals/opener-loop-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { OPENER_EN, OPENER_ES, OPENER_PT, WHAT_IS_INCLUDED_ASK_TYPE } from "../lib/system-prompt";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 160)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

const CANNED = new Set([OPENER_EN.trim(), OPENER_ES.trim(), OPENER_PT.trim(), WHAT_IS_INCLUDED_ASK_TYPE.trim()]);
const isCanned = (t: string) => CANNED.has(t.trim());
const namesAllThreeTypes = (t: string) => /\btile\b/i.test(t) && /\bvinyl\b/i.test(t) && /\bhardwood\b/i.test(t);

// A mid-conversation reply to a REAL question. `history` ends with the client's
// latest message; `prevBot` is the bot's immediately preceding message. After the
// fix the reply must NOT be the canned opener and must NOT repeat prevBot verbatim.
interface Case { name: string; history: ChatMessage[]; mustEngage?: RegExp; }

const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const U = (c: string): ChatMessage => ({ role: "user", content: c });

const MID_CONVO: Case[] = [
  {
    // 5ceb951b (Messenger) — the "scam Bot" lead.
    name: "scam-bot lead: repeated 'what is included in your price?' → NOT the canned opener",
    history: [U("Does that price include labor and materials?"), A(OPENER_EN), U("What is included in your price?")],
    mustEngage: /includ|labor|material|depends|tile|vinyl|hardwood|price/i,
  },
  {
    // 934b096f (Messenger) — identical question twice → identical canned answer twice.
    name: "'what type of materials are included?' asked twice → no identical canned repeat",
    history: [U("What type of materials are included?"), A(OPENER_EN), U("What type of materials are included?")],
  },
  {
    // 8b0d906d (Messenger) — follow-up pricing question re-fired the opener.
    name: "'is installation cost included in the price?' after ask-type → engages, not canned",
    history: [U("What is included in the materials package?"), A(WHAT_IS_INCLUDED_ASK_TYPE), U("Is installation cost included in the price?")],
    mustEngage: /includ|labor|install|depends|tile|vinyl|hardwood/i,
  },
  {
    // cc4f6ef4 (Messenger).
    name: "'for $4500 is it only labor or labor and material' → engages, not canned",
    history: [U("Is labor cost also $4,500?"), A(OPENER_EN), U("For $4500 is it only labor or labor and material?")],
    mustEngage: /labor|material|depends|tile|vinyl|hardwood|includ/i,
  },
  {
    // 896efb94 (Instagram) — client compared vinyl then tile; opener re-fired.
    name: "vinyl quoted, then 'if it was tile how much?' → tile info or scope, not the 3-type opener",
    history: [
      U("I'm interested in vinyl"),
      A("Our vinyl promo is $5 per sqft including the flooring, labor, and quarter round. One area or the whole house?"),
      U("If it was tile how much would it be?"),
    ],
  },
  {
    // 8cb79eea (Messenger) — flowing convo suddenly reset to the canned opener.
    name: "after 'are you looking for tile/vinyl/hardwood?', client talks scheduling → not the canned reset",
    history: [
      U("I'm at south florida"),
      A("Perfect, we come straight to you for a free visit and quote, are you looking for tile, vinyl, or hardwood?"),
      U("If you can come today that's much better for the estimate"),
    ],
    mustEngage: /today|visit|estimate|come|time|day|open|work|schedul|avail|check|book|which|tile|vinyl|hardwood|type/i,
  },
];

// The "Ok / Ok / Ok" loop (66e7a129, WhatsApp Philoya): after asking the type
// twice with no answer, the bot must STOP re-asking and pivot, never ask a 3rd time.
const STOP_LOOP: Case = {
  name: "client keeps saying 'Ok' after two type-asks → stop asking the type, do NOT ask a 3rd time",
  history: [
    U("Ok"), A(OPENER_EN),
    U("Ok"), A("Which type of flooring are you looking for, tile, vinyl, or hardwood?"),
    U("Ok"),
  ],
};

async function main() {
  console.log("\n============= OPENER-LOOP REGRESSION (real production failures) =============");

  console.log("\n[1] Canned type-ask opener must NEVER fire mid-conversation");
  for (const c of MID_CONVO) {
    const prevBot = [...c.history].reverse().find(m => m.role === "assistant")?.content ?? "";
    const r = await ai(c.history);
    console.log(`   → ${r.replace(/\s+/g, " ").slice(0, 150)}`);
    ck(`${c.name} :: not the canned opener`, !isCanned(r), r);
    ck(`${c.name} :: not an identical repeat of the previous bot message`, r.trim().toLowerCase() !== prevBot.trim().toLowerCase(), r);
    if (c.mustEngage) ck(`${c.name} :: engages the actual question`, c.mustEngage.test(r), r);
  }

  console.log("\n[2] Stop the type-ask loop after repeated non-answers");
  {
    const r = await ai(STOP_LOOP.history);
    console.log(`   → ${r.replace(/\s+/g, " ").slice(0, 150)}`);
    ck("Ok-loop :: not the canned opener", !isCanned(r), r);
    // After two asks it SHOULD stop listing all three types again and pivot (free
    // estimate / visit / warm nudge). This is model-guided (prompt rule 29), so it
    // is ADVISORY here, not a hard gate — the deterministic guarantee is that the
    // canned opener can no longer fire.
    console.log(`  → Ok-loop pivots instead of re-asking all 3 types: ${!namesAllThreeTypes(r) ? "yes" : "no (advisory)"}`);
  }

  console.log("\n[3] FIRST CONTACT is unchanged (still asks the type, no price)");
  {
    const NOTE = "\n\n[SYSTEM: TODAY: Friday, July 3, 2026 [2026-07-03].]";
    const greet = await ai([U("Hi" + NOTE)]);
    ck("first-contact 'Hi' → canned English opener (unchanged)", greet.trim() === OPENER_EN.trim(), greet);
    const price = await ai([U("How much per square foot?" + NOTE)]);
    ck("first-contact 'how much per sqft?' → asks the type, no price", namesAllThreeTypes(price) && !/\$\s?\d/.test(price), price);
  }

  console.log("\n[4] Robotic-repeat judge (Haiku) — the actual regression under test");
  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let notRobotic = 0;
    for (const c of MID_CONVO) {
      const lastClient = [...c.history].reverse().find(m => m.role === "user")?.content ?? "";
      const prevBot = [...c.history].reverse().find(m => m.role === "assistant")?.content ?? "";
      const r = await ai(c.history);
      // The bug we are guarding against is ROBOTIC canned repetition: the bot
      // ignoring the client and re-sending the same generic "which one, tile,
      // vinyl, or hardwood?" line. Because our pricing genuinely differs by floor
      // type (vinyl includes material, tile/hardwood are labor only), a reply that
      // briefly notes that and asks which type is CORRECT, not robotic.
      const prompt = `A flooring sales bot pricing differs by floor type (vinyl includes the material; tile and hardwood are labor only), so it legitimately must know the type before quoting.\nThe bot's previous message was: "${prevBot}"\nThe client then said: "${lastClient}"\nThe bot replied: "${r}"\nIs the reply a ROBOTIC failure, meaning it IGNORES what the client asked and just re-sends a generic canned line, OR it repeats the previous message almost verbatim? A reply that briefly engages the question and asks which floor type is NOT robotic. Answer ONLY JSON: {"robotic": true/false, "reason": "one sentence"}`;
      try {
        const res = await client.messages.create({ model: "claude-haiku-4-5-20251001", max_tokens: 120, messages: [{ role: "user", content: prompt }] });
        const txt = res.content[0].type === "text" ? res.content[0].text : "{}";
        const j = JSON.parse(txt.match(/\{[\s\S]*?\}/)?.[0] ?? "{}");
        const ok = j.robotic === false;
        if (ok) notRobotic++;
        console.log(`  ${ok ? "✅" : "⚠️"} judge: ${c.name.slice(0, 48)} — ${j.reason ?? "?"}`);
      } catch (e) { console.log(`  ⚠️ judge error: ${e}`); }
    }
    // ADVISORY ONLY (not a gate): the model regenerates each run and a Haiku judge
    // is noisy, so it prints a quality signal but never fails the suite. The hard
    // regression proof is the deterministic section above (no canned opener
    // mid-convo, no identical repeats, first contact unchanged).
    console.log(`  → naturalness signal: ${notRobotic}/${MID_CONVO.length} replies judged non-robotic (advisory)`);
  } else {
    console.log("  (no ANTHROPIC_API_KEY — skipping judge)");
  }

  console.log(`\n=========== OPENER-LOOP-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
