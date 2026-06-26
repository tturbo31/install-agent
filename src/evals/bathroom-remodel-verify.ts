// Verifies the BATHROOM REMODELING policy (new feature):
//  1. When a client asks if we do bathroom remodeling / renovation, the bot
//     confirms YES, says we must check the space in person to quote, and
//     proposes the FREE in-person visit (same flow as a large flooring lead).
//     It NEVER quotes a remodel price by DM, at any size. Works in EN / PT / ES.
//  2. REGRESSIONS — the remodel rule must NOT break what already worked:
//     - FLOORING in a bathroom under 200 sqft is STILL a declined small job.
//     - A small tile REPAIR is STILL "installations only" (we don't do repairs).
//     - A normal tile FLOORING job (250 sqft) is STILL quoted, not a remodel.
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
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);

// ── Predicates (bilingual EN / PT / ES) ─────────────────────────────────────
const AFFIRMS = (t: string) =>
  /\b(yes|yeah|yep|absolutely|of course|sure|we do|we can|we handle|we offer|claro|s[ií]m?|com certeza|fazemos|podemos|oferecemos|hacemos)\b/i.test(t);
const DECLINES_REMODEL = (t: string) =>
  /\b(?:don'?t|do not|cannot|can'?t|won'?t)\s+(?:do|offer|handle)\b|only\s+(?:do|offer|handle)\s+(?:flooring|floors|installations?)|installations?\s+only|n[aã]o\s+fazemos|no\s+hacemos/i.test(t);
const CONFIRMS_REMODEL = (t: string) => AFFIRMS(t) && !DECLINES_REMODEL(t);
const PROPOSES_VISIT = (t: string) =>
  /visit|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|measure|see\s+(?:the|your)\s+(?:space|bathroom)|take\s+a\s+look|visita|presencial|pessoalmente|medir|ver\s+(?:o|el)\s+(?:espa[çc]o|ba[ñn]o|local)/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const DECLINES_SMALL = (t: string) =>
  /don'?t take|do not take|under 200|focus on larger|too small|won'?t be able|not able to take|we only (?:do|work|focus|take)|larger (?:projects|installations|jobs)/i.test(t);
const DECLINES_REPAIR = (t: string) =>
  /installations?\s+only|only\s+(?:do|handle)\s+install|don'?t\s+do\s+(?:small\s+)?repair|do not do (?:small )?repair|only.*install/i.test(t);
const MENTIONS_REMODEL = (t: string) => /\bremodel|reforma|remodelaci/i.test(t);

async function main() {
  console.log("\n================ BATHROOM REMODELING VERIFICATION ================");

  // ── 1. EN: direct question → confirm + visit, no DM price ─────────────────
  console.log("\n[1] EN: \"Do you do bathroom remodeling?\"");
  const a1 = await ai([{ role: "user", content: "Hi, do you do bathroom remodeling?" }]);
  console.log("   →", a1.replace(/\s+/g, " ").slice(0, 150));
  ck("confirms YES we do bathroom remodels", CONFIRMS_REMODEL(a1), a1);
  ck("proposes the in-person visit", PROPOSES_VISIT(a1), a1);
  ck("does NOT quote a price by DM", !HAS_PRICE(a1), a1);

  // ── 2. EN: remodel vs floors-only framing ────────────────────────────────
  console.log("\n[2] EN: \"Do you remodel bathrooms or only floors?\"");
  const a2 = await ai([{ role: "user", content: "Do you guys remodel bathrooms or do you only do floors?" }]);
  console.log("   →", a2.replace(/\s+/g, " ").slice(0, 150));
  ck("confirms we also remodel bathrooms", CONFIRMS_REMODEL(a2), a2);
  ck("proposes the in-person visit", PROPOSES_VISIT(a2), a2);

  // ── 3. EN: explicit gut/redo intent → confirm + visit, no price ──────────
  console.log("\n[3] EN: \"I want to gut and redo my master bathroom\"");
  const a3 = await ai([{ role: "user", content: "I want to gut and redo my master bathroom completely" }]);
  console.log("   →", a3.replace(/\s+/g, " ").slice(0, 150));
  ck("confirms YES", CONFIRMS_REMODEL(a3), a3);
  ck("proposes the in-person visit", PROPOSES_VISIT(a3), a3);
  ck("no DM price", !HAS_PRICE(a3), a3);

  // ── 4. EN: asked mid-conversation, after the flooring opener ─────────────
  console.log("\n[4] EN: asks about remodel after the opener");
  const a4 = await ai([
    { role: "assistant", content: "Hi! Are you looking for tile, vinyl, or hardwood flooring?" },
    { role: "user", content: "Actually, do you also remodel bathrooms?" },
  ]);
  console.log("   →", a4.replace(/\s+/g, " ").slice(0, 150));
  ck("confirms YES mid-conversation", CONFIRMS_REMODEL(a4), a4);
  ck("proposes the in-person visit", PROPOSES_VISIT(a4), a4);

  // ── 5. PT: reforma de banheiro ────────────────────────────────────────────
  console.log("\n[5] PT: \"Vocês fazem reforma de banheiro?\"");
  const a5 = await ai([{ role: "user", content: "Oi, vocês fazem reforma de banheiro?" }]);
  console.log("   →", a5.replace(/\s+/g, " ").slice(0, 150));
  ck("confirma que SIM", CONFIRMS_REMODEL(a5), a5);
  ck("propõe a visita presencial", PROPOSES_VISIT(a5), a5);
  ck("sem preço no DM", !HAS_PRICE(a5), a5);

  // ── 6. ES: remodelación de baño ───────────────────────────────────────────
  console.log("\n[6] ES: \"¿Hacen remodelación de baño?\"");
  const a6 = await ai([{ role: "user", content: "Hola, ¿hacen remodelación de baño?" }]);
  console.log("   →", a6.replace(/\s+/g, " ").slice(0, 150));
  ck("confirma que SÍ", CONFIRMS_REMODEL(a6), a6);
  ck("propone la visita en persona", PROPOSES_VISIT(a6), a6);

  // ── 7. REGRESSION: flooring in a bathroom < 200 sqft → still declined ─────
  console.log("\n[7] REGRESSION: flooring for a bathroom, 150 sqft → declines (not a remodel)");
  const r1 = await ai([{ role: "user", content: "I need vinyl flooring for my bathroom, it's about 150 square feet." }]);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 150));
  ck("declines the sub-200 sqft flooring job", DECLINES_SMALL(r1), r1);
  ck("no price quoted", !HAS_PRICE(r1), r1);
  ck("does NOT route to a remodel visit", !MENTIONS_REMODEL(r1) && !PROPOSES_VISIT(r1), r1);

  // ── 8. REGRESSION: small repair → still installations only ───────────────
  console.log("\n[8] REGRESSION: repair a few broken tiles → installations only (not a remodel)");
  const r2 = await ai([{ role: "user", content: "Hi, can you repair a few broken tiles in my bathroom?" }]);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 150));
  ck("stays installations only / declines the repair", DECLINES_REPAIR(r2), r2);
  // The repair must not be scheduled or priced as a job. A friendly "reach out
  // for a remodel" invite is fine, so we check it did not propose a visit or
  // quote a price for the repair, NOT that it avoided the word "remodel".
  ck("does NOT schedule a visit or price the repair", !PROPOSES_VISIT(r2) && !HAS_PRICE(r2), r2);

  // ── 9. REGRESSION: tile flooring 250 sqft → still a quoted flooring job ───
  console.log("\n[9] REGRESSION: tile installation, 250 sqft → normal flooring quote (not a remodel)");
  const r3 = await ai([{ role: "user", content: "I need tile installation for my bathroom, around 250 sqft" }]);
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 150));
  ck("does NOT route a tile install into a remodel visit", !MENTIONS_REMODEL(r3), r3);

  // ── 10. Source inspection: prompt + reminder encode the policy ───────────
  console.log("\n[10] System prompt + final reminder encode the policy");
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("prompt: BATHROOM REMODELING section", /## BATHROOM REMODELING/.test(sp));
  ck("prompt: confirms we DO bathroom remodels", /YES, we do bathroom remodels/.test(sp));
  ck("prompt: remodel always goes to the visit, no DM price", /NEVER quote a bathroom remodel price/.test(sp));
  ck("ai.ts: FINAL REMINDER 28 (BATHROOM REMODELING RULE)", /28\.\s*BATHROOM REMODELING RULE/.test(aiSrc));

  console.log(`\n========== BATHROOM-REMODEL-VERIFY: ${pass} passed, ${fail} failed ==========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
