// "Can I let you know Sunday around 10am?" (Giovanny, IG 2026-10-02): the client
// tells us WHEN they will answer, it is not a visit time. The bot read the 10am
// as a request twice: "10am on Sunday isn't open, but I have 1pm or 3pm", then
// "Sorry, that 10am on Sunday filled up since I mentioned it" (the accepted-slot-
// gone note fired because the 10am the bot had said was NOT open counted as
// offered, and the client's "let you know ... 10 am" as accepting it).
// [1] deterministic: detection, offer reading, accepted-slot-gone, backstop.
// [2] live: Giovanny's two turns + regressions (a real pick still books).
// Run: npx tsx src/evals/deferred-reply-verify.ts   (LIVE=0 skips [2])
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, fixDeferredReply, type ChatMessage } from "../lib/ai";
import { isDeferredReply, acceptedOfferSlot, acceptedSlotGone } from "../lib/scheduler";

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
const D = (iso: string) => new Date(iso + ":00-04:00").toISOString();
const U = (content: string, at?: string): ChatMessage => ({ role: "user", content, ...(at ? { at: D(at) } : {}) });
const A = (content: string, at?: string): ChatMessage => ({ role: "assistant", content, ...(at ? { at: D(at) } : {}) });

// Giovanny, IG, verbatim (02/10, a Friday; the offer's "Sunday" is 04/10).
const GIO_BASE: ChatMessage[] = [
  U("Do you offer any discounts for larger spaces?", "2026-09-30T00:30"), U("[Client replied to our ad]", "2026-09-30T00:30"),
  A("Yes, larger spaces get our best pricing, and the estimate is free. Are you thinking tile, vinyl, or hardwood?", "2026-09-30T00:30"),
  U("I dont know! which is the best recomendation for you?", "2026-10-02T13:25"),
  A("I'd go with our luxury vinyl, 100% waterproof, $5 per sqft with the floor and installation included. What's the zip code of the property?", "2026-10-02T13:26"),
  U("33019", "2026-10-02T13:26"),
  A("33019 is Hollywood, we cover that area. I have Sunday at 1pm or 3pm, which works better?", "2026-10-02T13:26"),
  U("Let me pass the info to the owner of the condo if he are agrre with asume the cost or at least an a half i will call you back sir", "2026-10-02T13:28"),
  A("Sure, our WhatsApp is (561) 674-8334, you can reach Ozzi directly there. No problem, just reach out whenever you hear back from him and I'll get it set up!", "2026-10-02T13:28"),
  U("Thank you", "2026-10-02T13:29"),
  U("It is just for The condo", "2026-10-02T13:41"),
  A("Do you know roughly how many square feet the condo is?", "2026-10-02T13:41"),
  U("Yes 900sqf", "2026-10-02T15:13"),
  A("For 900 sqft I need to measure in person to give you the best price, it's free and I bring all the samples. Does Sunday at 1pm or 3pm work?", "2026-10-02T15:13"),
];
const GIO_T1: ChatMessage[] = [...GIO_BASE, U("I just can tell you around 10 am sunday if it is possible", "2026-10-02T15:14")];
const GIO_T2: ChatMessage[] = [
  ...GIO_T1,
  A("10am on Sunday isn't open, but I have 1pm or 3pm that day, which works better for you?", "2026-10-02T15:15"),
  U("I dont know at this point can i let you know sunday around 10 am?", "2026-10-02T15:57"),
];
const SUNDAY_LINE = "• Sunday, October 4, 2026 [2026-10-04]: 3pm, 5pm\n• Monday, October 5, 2026 [2026-10-05]: 9am, 11am";
const TODAY = "2026-10-02";
const SLOT_TALK = /filled up|isn'?t open|not open|no longer open|is taken|holding/i;

async function main() {
  console.log("\n[1] Detection");
  const yes = [
    "I dont know at this point can i let you know sunday around 10 am?",
    "I just can tell you around 10 am sunday if it is possible",
    "I'll let you know tomorrow morning",
    "Let me check with my wife, I'll get back to you tonight",
    "I'll text you Monday",
    "I'll know by Friday",
    "te aviso el domingo a las 10",
    "te digo mañana",
    "puedo avisarte el lunes?",
    "te falo amanhã",
    "posso te avisar domingo às 10?",
  ];
  for (const t of yes) ck(`deferral: "${t}"`, isDeferredReply(t));
  const no = [
    "Sunday at 10am works",
    "Can I confirm Sunday at 10?",
    "Te confirmo el domingo a las 10",
    "Let me know if Sunday 10am is open",
    "10am Sunday is possible?",
    "I can do Sunday at 10",
    "Could I know if you have Sunday at 10am?",
    "1pm works, I'll let you know if anything changes",
    "Wenesday is posible?",
    "11 am is ok",
    "I'll be home Sunday at 10",
    "I'll take the 3pm",
    "i will call you back sir",
    "Ok 6 will work",
    "Ok I will let you know later\nOk 6 will work",
  ];
  for (const t of no) ck(`NOT deferral: "${t}"`, !isDeferredReply(t));

  console.log("\n[1b] Offer reading + accepted-slot-gone");
  ck("Giovanny turn 2: no accepted slot (deferral)", acceptedOfferSlot(GIO_T2, TODAY) === null, JSON.stringify(acceptedOfferSlot(GIO_T2, TODAY)));
  ck("Giovanny turn 2: NO 'accepted time no longer open' note", acceptedSlotGone(GIO_T2, SUNDAY_LINE, "en", TODAY) === null);
  const afterDenial = (pick: string) => [...GIO_T1, A("10am on Sunday isn't open, but I have 1pm or 3pm that day, which works better for you?", "2026-10-02T15:15"), U(pick, "2026-10-02T15:20")];
  ck("'10am works' after '10am isn't open' → not a pick of an offered time (never 'filled up since I offered it')", acceptedOfferSlot(afterDenial("10am works"), TODAY) === null);
  const one = acceptedOfferSlot(afterDenial("1pm works"), TODAY);
  ck("'1pm works' after the same message → Sunday 1pm (real offer still read)", !!one && one.label === "1pm" && one.date === "2026-10-04", JSON.stringify(one));
  const gone = acceptedSlotGone(afterDenial("1pm works"), SUNDAY_LINE, "en", TODAY);
  ck("…and 1pm gone from the line → the gone note still fires (feature kept)", !!gone && gone.slot.label === "1pm", JSON.stringify(gone?.slot));

  console.log("\n[1c] Backstop");
  const bad = "Sorry, that 10am on Sunday filled up since I mentioned it. I still have 3pm or 5pm that day, which works?";
  ck("slot apology → plain ack", fixDeferredReply(bad, "en") === "Of course, no problem, just message me then and we'll set it up.");
  ck("'isn't open' → plain ack", !SLOT_TALK.test(fixDeferredReply("10am on Sunday isn't open, but I have 1pm or 3pm that day, which works better for you?", "en")));
  ck("[BOOK] in a deferral burst → plain ack", !/\[BOOK/.test(fixDeferredReply('Perfect! [BOOK:{"date":"2026-10-04","time":"10:00"}]', "en")));
  const good = "Of course, just message me Sunday around 10am and we'll set it up!";
  ck("good ack untouched", fixDeferredReply(good, "en") === good);
  ck("ES ack", fixDeferredReply("Lo siento, esas 10am ya no están disponibles.", "es").startsWith("Claro, sin problema"));

  if (process.env.LIVE === "0") return;

  console.log("\n[2] Live");
  const runs = Number(process.env.RUNS || 3);
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const live = async (name: string, msgs: ChatMessage[], ok: (r: string) => boolean) => {
    for (let i = 0; i < runs; i++) {
      const r = await ai(msgs);
      ck(`${name} #${i + 1}`, ok(r), r);
      console.log("     → " + r.replace(/\s+/g, " "));
    }
  };
  const ack = (r: string) => !SLOT_TALK.test(r) && !/\[BOOK/.test(r) && !/sorry|lo siento|desculp/i.test(r) && r.length < 220;
  await live("Giovanny turn 1 ('I just can tell you around 10 am sunday') → ack, no slot talk", GIO_T1, ack);
  await live("Giovanny turn 2 ('can i let you know sunday around 10 am?') → ack, no 'filled up'", GIO_T2, ack);
  await live("ES 'te aviso el domingo como a las 10'", [
    U("Hola, necesito piso para 900 sqft"),
    A("Para 900 sqft necesito medir en persona, la visita es gratis. Tengo el domingo a la 1pm o a las 3pm, cuál te queda mejor?"),
    U("no se todavia, te aviso el domingo como a las 10"),
  ], (r) => ack(r) && !/[¿¡]/.test(r));
  // Regressions: a real pick still moves to the details ask, a counter still gets the real times.
  await live("REGRESSION real pick '1pm works' → asks for address/phone", [...GIO_BASE, U("1pm works", "2026-10-02T15:14")], (r) => /address|phone/i.test(r) && !/message me then/i.test(r));
  await live("REGRESSION counter '10am Sunday is possible?' → real times, not the deferral ack", [...GIO_BASE, U("10am Sunday is possible?", "2026-10-02T15:14")], (r) => /\d\s*(?:am|pm)/i.test(r) && !/message me then/i.test(r));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
