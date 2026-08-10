// Installation-confirmation replies (2026-08-10): when the history carries the
// confirmation message sent by /api/confirmar-instalacao ("your flooring
// installation is confirmed for ..."), a client reply is a CLOSED SALE in the
// installation stage, not a new lead:
//   • simple practical doubts (arrival time, preparing the space) → answer
//     directly, repeating ONLY what the confirmation says;
//   • rescheduling / prices / scope changes → hand to the contact NAMED IN THE
//     CONFIRMATION ITSELF (name + phone are right there in the history), never
//     the generic owner number, never a promise that the change is done.
// Static guard: the prompt carries the section and its override notes.
// Live guard: the four behaviors above against the real model.
// Run: npx tsx src/evals/instalacao-replies-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, scrubForeignPhones, installConfirmationPhones, type ChatMessage } from "../lib/ai";

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

// Exactly what composeConfirmation() in /api/confirmar-instalacao produces.
const CONFIRMATION =
  "Hi Maria! This is Ozzi Floors 😊\n\n" +
  "Great news — your flooring installation is confirmed for Tuesday, August 11 at 8am.\n\n" +
  "Diego will be taking care of your installation. If you need anything, you can reach them directly at (954) 325-6735.\n\n" +
  "See you soon! 🏠";

const SELLER_PHONE = /954[)\s.-]*325[\s.-]*6735/;
const OWNER_PHONE = /561[)\s.-]*674[\s.-]*8334/;
const TYPE_ASK = /tile,? vinyl,? (or |o )?hardwood\?/i;

async function main() {
  // ── 1. STATIC: the section exists in the prompt ────────────────────────────
  console.log("\n[1] Prompt source carries the installation-confirmed section");
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("section header present", /## INSTALLATION CONFIRMED/.test(promptSrc));
  ck("keys on the confirmation wording", /flooring installation is confirmed for/.test(promptSrc));
  ck("hands reschedule/price/scope to the NAMED contact", /HAND TO THE NAMED CONTACT/.test(promptSrc));
  ck("forbids inventing another contact", /NEVER invent, guess, or substitute any other contact/.test(promptSrc));
  ck("named contact wins over OWNER CONTACT", /WINS over the OWNER CONTACT rule/.test(promptSrc));
  ck("never promise the change is made", /NEVER promise that the change will be made/.test(promptSrc));

  // ── 1b. UNIT: the phone scrubber honors the confirmation's seller number ───
  console.log("\n[1b] scrubForeignPhones lets the confirmation's seller number through");
  const history: ChatMessage[] = [{ role: "assistant", content: CONFIRMATION }];
  const allowed = installConfirmationPhones(history);
  ck("extracts the seller digits from the confirmation", allowed.includes("9543256735"), JSON.stringify(allowed));
  const kept = scrubForeignPhones("Diego can help you directly at (954) 325-6735.", allowed);
  ck("seller number survives the scrub when allowed", /325-6735/.test(kept), kept);
  const clientEcho = scrubForeignPhones("I'll have Ozzi reach out to you at 3057668885 shortly!", allowed);
  ck("client's own number is STILL scrubbed", !/3057668885/.test(clientEcho), clientEcho);
  ck("without the allowance the seller number is scrubbed (default unchanged)", !/325-6735/.test(scrubForeignPhones("Call Diego at (954) 325-6735.")));
  ck("no confirmation in history → no allowance", installConfirmationPhones([{ role: "assistant", content: "Hi, which floor are you interested in?" }]).length === 0);

  // ── 2. LIVE: reschedule ask → Diego + his phone, no promise, no owner number ─
  console.log("\n[2] Reschedule ask → direct to Diego at (954) 325-6735");
  const r1 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Hey, something came up on Tuesday, can we move the installation to Friday?" },
  ]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 220));
  ck("names Diego", /diego/i.test(r1), r1);
  ck("gives Diego's number from the confirmation", SELLER_PHONE.test(r1), r1);
  ck("does NOT give the generic owner number", !OWNER_PHONE.test(r1), r1);
  ck("does NOT promise it is moved/rescheduled", !/(moved|rescheduled) (it|your|the)|all set|done!|i('ve| have) (moved|rescheduled)/i.test(r1), r1);
  ck("no [BOOK:] tag", !r1.includes("[BOOK:"), r1);
  ck("does not go silent ([REACT_ONLY])", !r1.includes("[REACT_ONLY]"), r1);

  // ── 3. LIVE: price/scope change → no quote, hand to Diego ─────────────────
  console.log("\n[3] 'add the hallway, how much?' → no price, direct to Diego");
  const r2 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Actually, how much would it cost to add the hallway to the job too?" },
  ]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 220));
  ck("points to Diego and/or his number", /diego/i.test(r2) || SELLER_PHONE.test(r2), r2);
  ck("quotes no per-sqft price", !/\$\s?[45](\.\d+)?\s?(\/|per)/i.test(r2), r2);
  ck("does NOT restart the type ask", !TYPE_ASK.test(r2), r2);
  ck("does NOT give the generic owner number", !OWNER_PHONE.test(r2), r2);

  // ── 4. LIVE: simple time question → repeat the confirmed 8am, invent nothing ─
  console.log("\n[4] 'what time will you arrive?' → 8am from the confirmation");
  const r3 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "What time will you guys arrive?" },
  ]);
  console.log("   AI:", r3.replace(/\s+/g, " ").slice(0, 220));
  ck("repeats the confirmed 8am", /8\s?(am|:00)/i.test(r3), r3);
  ck("invents no other hour", !/\b(9|10|11)\s?(am|:00)/i.test(r3), r3);
  ck("does not go silent ([REACT_ONLY])", !r3.includes("[REACT_ONLY]"), r3);

  // ── 5. LIVE: prep question → answered directly (we move the furniture) ─────
  console.log("\n[5] 'do I need to move furniture?' → we move everything, no sales pitch");
  const r4 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Do I need to move my furniture before you come?" },
  ]);
  console.log("   AI:", r4.replace(/\s+/g, " ").slice(0, 220));
  ck("says WE move the furniture", /we ('ll |will )?(move|take care of|handle)/i.test(r4), r4);
  ck("does NOT restart the type ask", !TYPE_ASK.test(r4), r4);
  ck("pitches no promo/price", !/\$\s?\d/.test(r4), r4);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed${fail ? `: ${fails.join(", ")}` : ""}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
