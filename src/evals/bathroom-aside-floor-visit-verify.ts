// Lauren Ashley (IG 2026-11-03 11:09-11:13 ET): engineered wood, "Whole house",
// we offered "today at 4pm or Wednesday at 5pm, which works?", she asked "Do you
// also do tile in bathroom?" and "Do you do bathroom Reno's or just flooring?",
// got Ozzi's number twice with nothing else, answered "Ok I'll text him. Thank
// you" and got silence. The floor visit was never booked. Owner rule: the
// bathroom goes to Ozzi's number, the floor visit stays on the table.
// [1] deterministic: detection, closings, the post-model net, wiring.
// [2] live: Lauren's three turns with today's real schedule + regressions.
// Run: npx tsx src/evals/bathroom-aside-floor-visit-verify.ts   (LIVE=0 skips [2])
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, bathroomAsideInFloorBooking, keepFloorVisitAfterBathroomAside, isPureClosingBurst, isAckClosingBurst,
  containsSchedulingOffer, bathroomProjectStanding, type ChatMessage,
} from "../lib/ai";
import { getRealAvailabilityContext, getEasternDateContext } from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });

// Verbatim from instagram_messages (conversation 7819f0d9…, igsid 1953182028982379).
const OFFER = "For a whole house I need to measure in person to give you the best price, it's free and I bring the samples. I can come today at 4pm or Wednesday at 5pm, which works?";
const BASE: ChatMessage[] = [
  U("What is the installation process?\n\n[Client replied to our ad]"),
  A("Hi, we move the furniture, install the floor and leave everything clean, usually in 2 to 3 days. Are you thinking tile, vinyl, or hardwood?"),
  U("How do I get a quote. Engineered wood"),
  A("For engineered hardwood it's $3.20 per sqft for the installation labor, you supply the material. I offer a free quote, is it one area or the whole house?"),
  U("Whole house"),
  A(OFFER),
];
const ASIDE1 = "Yes we do bathrooms, those go through Ozzi directly at (561) 674-8334.";
const ASIDE2 = "Yes, we do full bathroom remodels too! For that, quotes and appointments go through Ozzi directly at (561) 674-8334, he handles all the details himself.";
const T1: ChatMessage[] = [...BASE, U("Ok. Do you also do tile in bathroom?")];
const T2: ChatMessage[] = [...T1, A(ASIDE1), U("Do you do bathroom Reno’s or just flooring?")];
const T3: ChatMessage[] = [...T2, A(ASIDE2), U("Ok I’ll text him. Thank you")];

async function main() {
  console.log("[1] Deterministic");
  ck("the offer reads as an open slot offer", containsSchedulingOffer(OFFER));
  ck("bathroom standing is OFF (whole house)", !bathroomProjectStanding(T3));
  const c1 = bathroomAsideInFloorBooking(T1);
  ck("T1 'Do you also do tile in bathroom?' → question, slots", c1?.mode === "question" && c1.slots, JSON.stringify(c1));
  const c2 = bathroomAsideInFloorBooking(T2);
  ck("T2 'bathroom Reno's or just flooring?' (after the aside) → question", c2?.mode === "question" && c2.slots, JSON.stringify(c2));
  const c3 = bathroomAsideInFloorBooking(T3);
  ck("T3 'Ok I'll text him. Thank you' → ack", c3?.mode === "ack" && c3.slots, JSON.stringify(c3));
  ck("T3 is NOT a pure closing", !isPureClosingBurst(T3));
  ck("T3 is NOT an ack closing", !isAckClosingBurst(T3));

  // The net.
  const n1 = keepFloorVisitAfterBathroomAside(T1, ASIDE1, "en");
  ck("net: T1 Ozzi-only reply gets the floor visit question", n1.startsWith(ASIDE1) && /for the floors/i.test(n1) && /which of the times/i.test(n1), n1);
  const good = "Yes, we do full bathroom remodels too, for that text Ozzi directly at (561) 674-8334. And for the whole house floors, I can still come today at 4pm or Wednesday at 5pm, which works?";
  ck("net: a reply that already re-offers is untouched", keepFloorVisitAfterBathroomAside(T1, good, "en") === good);
  const n3 = keepFloorVisitAfterBathroomAside(T3, "[REACT_ONLY]", "en");
  ck("net: T3 [REACT_ONLY] → 'Sounds good!' + the floor visit question", /^Sounds good! And for the floors/.test(n3) && !/674-8334/.test(n3), n3);
  const nBook = '[BOOK:{"date":"2026-11-04"}] Perfect';
  ck("net: a [BOOK] is never touched", keepFloorVisitAfterBathroomAside(T1, nBook, "en") === nBook);
  const n1q = keepFloorVisitAfterBathroomAside(T1, "Yes, we do bathrooms too!", "en");
  ck("net: a bathroom answer without the number gets the Ozzi line + the floor question", /674-8334/.test(n1q) && /for the floors/i.test(n1q), n1q);

  // Loop guard: after our re-offer, a second "ok" is the normal flow again.
  const T4 = [...T3, A(n3), U("ok")];
  ck("after the re-offer, a new 'ok' is not an aside ack", bathroomAsideInFloorBooking(T4) === null, JSON.stringify(bathroomAsideInFloorBooking(T4)));
  const T4b = [...T1, A(n1), U("Ok thanks")];
  ck("after the appended net line, 'Ok thanks' is not an aside ack", bathroomAsideInFloorBooking(T4b) === null, JSON.stringify(bathroomAsideInFloorBooking(T4b)));

  // Negatives.
  ck("bathroom-only lead (standing ON) → null", bathroomAsideInFloorBooking([U("Do you guys do bathroom remodels?"), A(ASIDE1), U("ok thanks")]) === null);
  ck("booked visit + 'do you do bathrooms too?' → null", bathroomAsideInFloorBooking([...BASE, U("Wednesday 5pm"), A("Appointment confirmed for Wednesday, November 4 at 5pm. I will notify you approximately 40 minutes before arriving."), U("Do you do bathrooms too?")]) === null);
  ck("no visit on the table yet → null (the prompt handles it)", bathroomAsideInFloorBooking([...BASE.slice(0, 4), U("Whole house. Do you do bathrooms too?")]) === null);
  ck("ack straight to the slot offer (no aside) → null", bathroomAsideInFloorBooking([...BASE, U("ok thanks")]) === null);
  ck("client turned the floors down → null", bathroomAsideInFloorBooking([...T2, A(ASIDE2), U("Not interested in the floors anymore, just the bathroom. Thanks")]) === null);
  ck("aside answering a NON-bathroom question → null", bathroomAsideInFloorBooking([...BASE, U("can I call you?"), A("Sure, you can call or text Ozzi directly at (561) 674-8334."), U("ok thanks")]) === null);
  const det = [...BASE, U("Wednesday 5pm works"), A("Perfect, Wednesday at 5pm! Can I get the full address with the zip code and the best phone number?"), U("Do you also do bathroom remodels?")];
  const cd = bathroomAsideInFloorBooking(det);
  ck("details being collected + bathroom question → question, details", cd?.mode === "question" && cd.details, JSON.stringify(cd));
  ck("net: details tail asks for the address", /full address with the zip code/i.test(keepFloorVisitAfterBathroomAside(det, ASIDE1, "en")));
  const es = [U("Hola, quiero vinilo para toda la casa"), A("Para toda la casa necesito medir en persona, es gratis. Tengo el miércoles a las 11am o 5pm, cuál te queda mejor?"), U("Ok. Hacen baños también?")];
  const ces = bathroomAsideInFloorBooking(es);
  ck("ES 'Hacen baños también?' → question", ces?.mode === "question", JSON.stringify(ces));
  const nes = keepFloorVisitAfterBathroomAside(es, "Sí, también hacemos baños, eso es directo con Ozzi al (561) 674-8334.", "es");
  ck("net ES: tail in Spanish, no ¿", /Y para los pisos/.test(nes) && !/[¿¡]/.test(nes), nes);

  // Wiring.
  const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("brain injects the note", /dynamicSystem \+= `\\n\\n---\\n\\n\$\{floorVisitAfterBathroomNote\(floorVisitAside\)\}`/.test(ai));
  ck("anti-pressure skips the aside", /!floorVisitAside && antiPressureShouldFire\(messages\)/.test(ai));
  ck("brain runs the net", /keepFloorVisitAfterBathroomAside\(messages, cleaned, usersLang\(\)\)/.test(ai));
  const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("prompt: the bathroom answer never ends the flooring conversation", /The bathroom answer NEVER ends the flooring conversation/.test(sp));

  if (process.env.LIVE === "0") return;

  console.log("\n[2] Live (today's real schedule)");
  const runs = Number(process.env.RUNS || 3);
  const avail = await getRealAvailabilityContext({ history: T1 });
  const withSchedule = (msgs: ChatMessage[]) => {
    const out = msgs.map((m) => ({ ...m }));
    out[out.length - 1] = { ...out[out.length - 1], content: `${out[out.length - 1].content}\n\n[SYSTEM: ${getEasternDateContext()}\n\n${avail}]` };
    return out;
  };
  const live = async (name: string, msgs: ChatMessage[], ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = (await getAIResponse(withSchedule(msgs), null, null, null, false)).text;
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };
  const TIME = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|which of the times/i;
  const keepsVisit = (r: string) => TIME.test(r) && /\?/.test(r) && !/\[BOOK|\[REACT_ONLY\]/.test(r) && !/\$\s?\d/.test(r);
  await live("T1 bathroom tile question → Ozzi line + the floor visit times", T1, (r) => /674-8334/.test(r) && keepsVisit(r));
  await live("T2 'bathroom Reno's or just flooring?' → Ozzi line + the floor visit times", T2, (r) => /674-8334/.test(r) && keepsVisit(r));
  await live("T3 'Ok I'll text him. Thank you' → no silence, the floor visit times", T3, (r) => keepsVisit(r));
  // Regressions: a bathroom-only lead still gets only Ozzi's line, and its "ok thanks" stays silent.
  await live("REGRESSION bathroom-only remodel → Ozzi line, no visit", [U("Do you guys do bathroom remodels? I want to redo my master bathroom")], (r) => /674-8334/.test(r) && !TIME.test(r) && !/\[BOOK/.test(r));
  const bathOnly: ChatMessage[] = [U("Do you guys do bathroom remodels?"), A("Yes, we do bathrooms too! Bathroom quotes and appointments are handled by Ozzi directly, he goes over the details with you himself. You can reach him at (561) 674-8334."), U("Ok I'll text him. Thank you")];
  ck("REGRESSION bathroom-only 'Ok I'll text him' stays a closing", isPureClosingBurst(bathOnly) || isAckClosingBurst(bathOnly));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
