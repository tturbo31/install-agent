// Verifies the AI-outage safety net WITHOUT calling the Anthropic API.
// Covers the bug: when the AI call throws (credits exhausted, rate limit,
// timeout, network), the client used to get TOTAL SILENCE. Now each webhook
// must send a graceful holding reply, hand off to a human, and notify the owner.
import { readFileSync } from "fs";
import { join } from "path";
import { aiOutageHandoffMessage } from "../lib/scheduler";
import { isPureClosing, containsBookingInfo } from "../lib/ai";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}

const NO_DASH = (t: string) => !/[—–‒―]/.test(t) && !/ - /.test(t);
const NO_EMOJI = (t: string) => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}]/u.test(t);

function main() {
  console.log("\n===================== AI-OUTAGE SAFETY NET VERIFICATION (no API) =====================");

  // ── 1. Fallback message is graceful, bilingual, and clean ────────────────
  console.log("\n[1] aiOutageHandoffMessage");
  const en = aiOutageHandoffMessage("en");
  const es = aiOutageHandoffMessage("es");
  console.log(`   EN: ${en}`);
  console.log(`   ES: ${es}`);
  ck("EN is non-empty", en.trim().length > 0, en);
  ck("ES is non-empty", es.trim().length > 0, es);
  ck("EN has no dashes", NO_DASH(en), en);
  ck("ES has no dashes", NO_DASH(es), es);
  ck("EN has no emojis", NO_EMOJI(en), en);
  ck("ES has no emojis", NO_EMOJI(es), es);
  ck("EN does not invent a price", !/\$\d/.test(en), en);
  ck("EN points to the team/follow-up (keeps lead warm)", /team|reach|get (right )?back|shortly|contact/i.test(en), en);
  ck("ES points to the team/follow-up (keeps lead warm)", /equipo|contacta|enseguida|en seguida/i.test(es), es);

  // ── 2. The labor question must NOT be wrongly silenced as a "closing" ─────
  console.log("\n[2] 'Is installation labor cost extra?' is a real question, not a closing");
  const laborQ = "Is installation labor cost extra?";
  ck("isPureClosing(labor question) === false", isPureClosing(laborQ) === false, `got ${isPureClosing(laborQ)}`);
  ck("containsBookingInfo(labor question) === false", containsBookingInfo(laborQ) === false);
  // A few more genuine questions that must never be classified as closings
  for (const q of ["Do you handle permits?", "What about permits", "Is labor extra?", "How much per sqft?"]) {
    ck(`isPureClosing("${q}") === false`, isPureClosing(q) === false, `got ${isPureClosing(q)}`);
  }

  // ── 3. Each webhook actually wraps the AI call with the outage fallback ───
  console.log("\n[3] Webhook source contains the AI-outage try/catch + fallback wiring");
  const webhooks: Array<[string, string, RegExp]> = [
    ["Instagram", "src/app/api/webhook/route.ts", /sendInstagramMessage\(senderIgsid, fallback\)/],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts", /sendWhatsAppMessage\(phone, fallback\)/],
    ["Facebook", "src/app/api/fb-webhook/route.ts", /sendFacebookMessage\(psid, fallback\)/],
  ];
  for (const [name, rel, sendRe] of webhooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports aiOutageHandoffMessage`, /aiOutageHandoffMessage/.test(src));
    ck(`${name}: catches getAIResponse failure`, /catch\s*\(aiErr\)/.test(src), rel);
    ck(`${name}: sends the fallback to the client`, sendRe.test(src), rel);
    ck(`${name}: hands the conversation to a human`, /mode:\s*"human"/.test(src.split("catch (aiErr)")[1]?.slice(0, 1500) ?? ""), rel);
    ck(`${name}: notifies the owner on outage`, /notifyOwners\(/.test(src.split("catch (aiErr)")[1]?.slice(0, 1500) ?? ""), rel);
    ck(`${name}: skips fallback when booking already confirmed`, /if\s*\(!isBookingConfirmed\)/.test(src.split("catch (aiErr)")[1]?.slice(0, 400) ?? ""), rel);
  }

  console.log(`\n============ OUTAGE-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main();
