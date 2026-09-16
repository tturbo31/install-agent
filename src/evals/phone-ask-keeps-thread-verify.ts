// Verifies that "what's your number?" in the middle of a booking never ends the
// booking (Brickell, FB 2026-09-14): two slots offered and the details asked,
// the client wrote "Cuál es tu número?" and the model answered with Ozzi's
// number ALONE (3 of 3 replays), so the visit was never set. Owner rule: the
// number is always (561) 674-8334 (OWNER CONTACT), but giving it must not drop
// the pending question.
//  1. DETERMINISTIC (no API): isPhoneOnlyReply (the bare line yes; the under-400,
//     bathroom, financing, question-carrying lines no), keepBookingThreadAfterPhone
//     (slots + details → both, slots only, details only, unrelated previous
//     reply → untouched, canned confirmation → untouched), no ¿ ¡ / dash.
//  2. LIVE MODEL: the Brickell turn (ES) and an EN twin through getAIResponse →
//     the reply carries the number AND a pending question.
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isPhoneOnlyReply, keepBookingThreadAfterPhone, type ChatMessage } from "../lib/ai";
import { smallJobOzziDirectMessage, bathroomOzziDirectMessage } from "../lib/scheduler";

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
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const NUM = /674[\s.-]?8334/;

const BRICKELL: ChatMessage[] = [
  U("Hola, cuánto sale el vinyl para un apartamento en Brickell de 1200 pies?"),
  A("Hola! Nuestro vinyl es $5 por pie cuadrado con el material, la instalación y el quarter round incluidos. Para 1200 pies necesito ir a medir en persona y darte el precio exacto, la visita es gratis. Cual es el código postal?"),
  U("33131"),
  A("Perfecto, 33131 está en el área. Tengo mañana martes a la 1pm o 2pm, cual te queda mejor?"),
  U("Mañana en la mañana te confirmo"),
  A("Perfecto, te tengo el martes a la 1pm o 2pm, confirmame en la mañana cual te queda mejor y me das tu nombre, la dirección del apartamento en Brickell y tu número de teléfono."),
  U("Cuál es tu número ?"),
];
const EN_TWIN: ChatMessage[] = [
  U("How much for 1500 sqft vinyl?"),
  A("Our vinyl promo is $5 per sqft and it includes the flooring, the installation and the quarter round. For 1,500 sqft I need to come measure in person, the visit is free. What's the zip code of the property?"),
  U("33131"),
  A("33131 is covered! I have tomorrow at 1pm or 2pm, which works better for you? And can I get your name, the property address, and the best phone number?"),
  U("What's your phone number?"),
];

async function main() {
  console.log("\n[1] DETERMINISTIC — number-only detector and the appended question");
  const esLine = "Puedes llamar o escribirle a Ozzi directamente al (561) 674-8334.";
  const enLine = "You can call or text Ozzi directly at (561) 674-8334.";
  ck("number-only ES", isPhoneOnlyReply(esLine));
  ck("number-only EN", isPhoneOnlyReply(enLine));
  ck("number-only PT", isPhoneOnlyReply("Pode ligar ou mandar mensagem direto pro Ozzi no (561) 674-8334."));
  ck("not number-only: under-400 referral", !isPhoneOnlyReply(smallJobOzziDirectMessage("en")));
  ck("not number-only: bathroom referral", !isPhoneOnlyReply(bathroomOzziDirectMessage("en")));
  ck("not number-only: financing line", !isPhoneOnlyReply("As soon as your application is approved, call or text Ozzi directly at (561) 674-8334 to finalize everything."));
  ck("not number-only: already carries a question", !isPhoneOnlyReply("You can reach Ozzi at (561) 674-8334. Which time works better for you?"));
  ck("not number-only: no number", !isPhoneOnlyReply("Sure, one moment."));

  const both = keepBookingThreadAfterPhone(BRICKELL, esLine, "es");
  ck("Brickell (slots + details pending): number kept AND question appended", NUM.test(both) && /\?$/.test(both) && !/nombre/.test(both) && /dirección/.test(both) && /horario/.test(both), both);
  ck("Brickell: no ¿ ¡ / dash", !/[¿¡—–]/.test(both), both);
  const slotsOnly = keepBookingThreadAfterPhone([U("1500 sqft vinyl"), A("I have tomorrow at 9am or 11am, which works better for you?"), U("What's your number?")], enLine, "en");
  ck("slots pending only: slot question appended", NUM.test(slotsOnly) && /which of those times works best/.test(slotsOnly), slotsOnly);
  const detailsOnly = keepBookingThreadAfterPhone([U("1500 sqft vinyl"), A("Perfect, I'm holding that 11am for you! Can I get your name, the property address, and the best phone number?"), U("What's your number?")], enLine, "en");
  ck("details pending only: details question appended", NUM.test(detailsOnly) && /the full address with the zip code and the best phone number/.test(detailsOnly) && !/your name/.test(detailsOnly), detailsOnly);
  const pt = keepBookingThreadAfterPhone([U("1500 sq ft vinil"), A("Tenho amanhã às 9h ou 11h, qual funciona melhor? Me passa seu nome, endereço e telefone."), U("Qual seu número?")], "Pode ligar ou mandar mensagem direto pro Ozzi no (561) 674-8334.", "pt");
  ck("PT: both pending → PT question appended", /visita marcada/.test(pt) && /\?$/.test(pt), pt);
  const unrelated = keepBookingThreadAfterPhone([U("Do you cover Jupiter?"), A("We cover all of South Florida, from Homestead up to Jupiter."), U("What's your number?")], enLine, "en");
  ck("no booking in progress: untouched", unrelated === enLine, unrelated);
  const confirmed = keepBookingThreadAfterPhone([U("ok"), A("Appointment confirmed for Monday, September 21 at 11am. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi."), U("What's your number?")], enLine, "en");
  ck("after the canned confirmation: untouched", confirmed === enLine, confirmed);
  const withQ = keepBookingThreadAfterPhone(BRICKELL, "Puedes llamar a Ozzi al (561) 674-8334. Te queda mejor 1pm o 2pm?", "es");
  ck("reply already carries a question: untouched", /Te queda mejor 1pm o 2pm\?$/.test(withQ), withQ);
  ck("wiring brain: backstop applied in getAIResponse", /keepBookingThreadAfterPhone\(messages, cleaned/.test(readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8")));
  ck("wiring prompt: OWNER CONTACT keeps the pending question", /never the number alone/.test(readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8")));

  if (process.env.DET_ONLY) { done(); return; }

  console.log("\n[2] LIVE MODEL — the number AND the pending question");
  for (let i = 1; i <= 2; i++) {
    const r = await ai(BRICKELL);
    ck(`Brickell ES #${i}: number + pending question`, NUM.test(r) && /\?/.test(r) && !/[¿¡]/.test(r), r);
  }
  for (let i = 1; i <= 2; i++) {
    const r = await ai(EN_TWIN);
    ck(`EN twin #${i}: number + pending question`, NUM.test(r) && /\?/.test(r), r);
  }
  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
