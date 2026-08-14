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
import { getAIResponse, scrubForeignPhones, installConfirmationPhones, hasInstallationConfirmation, type ChatMessage } from "../lib/ai";

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
  "Our installation team will be taking care of the job. If you have any questions, you can reach out directly to Diego, the sales rep who put together your estimate, at (954) 325-6735.\n\n" +
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

  // ── 1c. UNIT + STATIC: stale-booked guard yields to the confirmation ───────
  // Caso Jean E Raymond 2026-08-11: "See you tomorrow" após a confirmação de
  // instalação levou o handoff enlatado ("double check your visit details") em
  // vez da continuidade natural — a guarda visita-afirmada rodava ANTES do
  // modelo e a seção INSTALLATION CONFIRMED nunca agia.
  console.log("\n[1c] Guarda visita-afirmada não intercepta pós-confirmação de instalação");
  ck("hasInstallationConfirmation detecta a confirmação", hasInstallationConfirmation(history) === true);
  ck("sem confirmação no histórico → false", hasInstallationConfirmation([
    { role: "assistant", content: "Perfect, see you then!" },
    { role: "user", content: "See you tomorrow" },
  ]) === false);
  ck("confirmação vinda do CLIENTE não conta", hasInstallationConfirmation([
    { role: "user", content: "your flooring installation is confirmed for Tuesday" },
  ]) === false);
  for (const [name, file] of [["wa-webhook", "src/app/api/wa-webhook/route.ts"], ["fb-webhook", "src/app/api/fb-webhook/route.ts"], ["ig webhook", "src/app/api/webhook/route.ts"]] as const) {
    const src = readFileSync(join(process.cwd(), file), "utf-8");
    ck(`${name}: guarda condicionada a !hasInstallationConfirmation`, /!hasInstallationConfirmation\(staleRows\) && assertsExistingAppointment\(/.test(src));
  }

  // ── 1d. STATIC: quem instala é a EQUIPE, o vendedor é só o contato ────────
  // Regra do dono 2026-08-14: o template dizia "<vendedor> will be taking care
  // of your installation" e o cliente entendia que o representante de vendas
  // faria a instalação.
  console.log("\n[1d] Template: instaladores fazem o serviço, vendedor é só contato de dúvidas");
  const rotaSrc = readFileSync(join(process.cwd(), "src/app/api/confirmar-instalacao/route.ts"), "utf-8");
  ck("template nomeia a equipe de instalação como executora", /Our installation team will be taking care of the job/.test(rotaSrc));
  ck("template NÃO diz que o vendedor faz a instalação", !/\$\{nomeVendedor\} will be taking care of your installation/.test(rotaSrc));
  ck("template apresenta o vendedor como quem fez o orçamento", /the sales rep who put together your estimate/.test(rotaSrc));
  ck("confirmação de exemplo bate com o template atual", /Our installation team will be taking care of the job\./.test(CONFIRMATION));
  ck("prompt proíbe dizer que o vendedor instala", /THE INSTALLATION IS DONE BY OUR INSTALLATION TEAM/.test(promptSrc));

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

  // ── 6. LIVE: 'quem vem instalar?' → a equipe, nunca o vendedor ─────────────
  console.log("\n[6] 'Diego é quem vem instalar?' → equipe de instalação, nunca o vendedor");
  const r5 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "So Diego is the one coming to install my floor?" },
  ]);
  console.log("   AI:", r5.replace(/\s+/g, " ").slice(0, 220));
  ck("aponta a equipe/instaladores como quem faz o serviço", /\b(installation team|install team|crew|installers|our team)\b/i.test(r5), r5);
  ck("NÃO confirma que o vendedor instala", !/^\s*(yes|yep|correct|that'?s right|exactly)\b/i.test(r5), r5);
  ck("não fica em silêncio ([REACT_ONLY])", !r5.includes("[REACT_ONLY]"), r5);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed${fail ? `: ${fails.join(", ")}` : ""}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
