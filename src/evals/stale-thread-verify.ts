// Verifies the 2026-09-19 finding (review of the 3 channels, 16-19/09):
//   fb_39448595681394200 typed "I would like to get a free estimate
//   305-968-6096 thank you" on 09/18 00:26, four days after his own "I'm going
//   to go to sleep now I'm interested thank you good night" (09/13 21:56), and
//   the bot answered "Good night! Once you get that measurement, just shoot it
//   over…". The model gets the bubbles with NO timestamps, so the days-old
//   sign-off still read as the live turn: the fresh estimate request and the
//   phone number in it were never acted on and nobody ever called the lead.
// Now: staleThreadGapHours reads the `at` the three webhooks already carry and
// staleThreadNote tells the model the older bubbles are spent.
//   1. DETERMINISTIC (no API) — the detector's thresholds, the note, the wiring.
//   2. LIVE MODEL — the real turn replayed, plus regressions (no note when the
//      thread is live, no "gap" small talk, the normal flows unchanged).
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, staleThreadGapHours, staleThreadNote, reactOnlyIsWrong, REACT_ONLY_WRONG_NOTE, type ChatMessage } from "../lib/ai";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}

const H = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
const U = (c: string, at?: string): ChatMessage => ({ role: "user", content: c, at });
const A = (c: string, at?: string): ChatMessage => ({ role: "assistant", content: c, at });
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false);

console.log("\n═══ 1. DETERMINISTIC ═══\n");

// ── the real case ──────────────────────────────────────────────────────────
const REAL: ChatMessage[] = [
  U("I'm interested in doing my bedroom floor 305-968 6096 is my number", H(144)),
  A("Great that you're looking to redo the bedroom floor! We work with tile, vinyl, and hardwood, which one are you interested in?", H(144)),
  U("Vinyl or Hardwood something I can get a good price on labor wise do you have any senior citizen discounts", H(143.9)),
  A("On the labor side, vinyl install only is $2 per sqft and hardwood is $3.20 per sqft, both with you supplying the material.", H(143.9)),
  U("I'll measure tomorrow and let you know we'll talk more then I'm going to go to sleep now I'm interested thank you good night", H(143.8)),
  U("I would like to get a free estimate 305-968-6096 thank you", H(48)),
];
const realGap = staleThreadGapHours(REAL);
ck("real case: 4-day return is detected", realGap !== null && realGap > 90, String(realGap));

// ── thresholds ─────────────────────────────────────────────────────────────
ck("live thread (2 min) → no note", staleThreadGapHours([A("Which one, tile, vinyl, or hardwood?", H(0.1)), U("Vinyl", H(0.067))]) === null);
ck("same session (3h pause) → no note", staleThreadGapHours([A("Which one?", H(3.2)), U("Vinyl", H(0.2))]) === null, String(staleThreadGapHours([A("Which one?", H(3.2)), U("Vinyl", H(0.2))])));
ck("5h55 → still no note (under the 6h line)", staleThreadGapHours([A("Which one?", H(6.0)), U("Vinyl", H(0.1))]) === null);
{
  const g = staleThreadGapHours([A("Which one?", H(14)), U("Vinyl", H(0.1))]);
  ck("overnight (~14h) → note", g !== null && g > 13 && g < 15, String(g));
}
// ── shape of the input ─────────────────────────────────────────────────────
ck("no timestamps at all → no note (evals, followups)", staleThreadGapHours([A("Which one?"), U("Vinyl")]) === null);
ck("only one message → no note", staleThreadGapHours([U("Hi", H(100))]) === null);
ck("our own message is the last one → no note", staleThreadGapHours([U("Hi", H(100)), A("Hello!", H(0.1))]) === null);
{
  // The whole returning BURST is new: the gap is measured from the first bubble
  // of the burst, not from the last one (3 bubbles typed in the same minute).
  const burst = [
    A("Which one, tile, vinyl, or hardwood?", H(72)),
    U("Sorry for the delay", H(1)),
    U("vinyl", H(0.98)),
    U("about 900 sqft", H(0.95)),
  ];
  const g = staleThreadGapHours(burst);
  ck("returning burst: gap measured from the FIRST new bubble", g !== null && g > 70 && g < 72, String(g));
}

// ── the note ───────────────────────────────────────────────────────────────
const note4d = staleThreadNote(96);
ck("note: says how long it has been (days)", /4 days/.test(note4d), note4d);
ck("note: 26h reads 'more than a day'", /more than a day/.test(staleThreadNote(26)));
ck("note: 9h reads in hours", /9 hours/.test(staleThreadNote(9)));
ck("note: forbids answering the old bubble", /Answer ONLY the newest message/i.test(note4d));
ck("note: names the good-night trap", /good night/i.test(note4d) && /sign-off|spent/i.test(note4d));
ck("note: contact info in the new message is current", /phone number|address/i.test(note4d) && /never ask for it again/i.test(note4d));
ck("note: does not tell the model to mention the silence", /do not mention the silence/i.test(note4d));

// ── [REACT_ONLY] backstop: an old ack must not silence a live message ──────
const OFFER = A("Yes! Our luxury vinyl promo is $5 per square foot with the flooring, installation and quarter round included. Are you doing one area or the whole house?", H(74));
const withAck = (newest: string): ChatMessage[] => [U("hi do you install vinyl", H(74)), OFFER, U("ok thanks", H(73.9)), U(newest, H(2))];
ck("wrong-silence: 'I'm ready to set up the visit, whole house, 33180'", reactOnlyIsWrong(withAck("I'm ready to set up the visit, whole house, 33180")));
ck("wrong-silence: a plain question", reactOnlyIsWrong(withAck("how much for 1200 sqft?")));
ck("wrong-silence: address + phone", reactOnlyIsWrong(withAck("2451 NW 5th St, Miami 33125, 786-555-1212")));
ck("wrong-silence: a day and a time", reactOnlyIsWrong(withAck("Friday at 11am works")));
ck("real closing stays silent: 'ok thank you'", !reactOnlyIsWrong(withAck("ok thank you")));
ck("real closing stays silent: bare 'ok'", !reactOnlyIsWrong(withAck("ok")));
ck("real closing stays silent: 'I'll call you tomorrow'", !reactOnlyIsWrong(withAck("I'll call you tomorrow")));
ck("real closing stays silent: a thumbs up", !reactOnlyIsWrong(withAck("👍")));
ck("our own message last → nothing to override", !reactOnlyIsWrong([U("hi", H(3)), A("Hello!", H(2))]));
{
  // Rule 35 / the double-tap intercept own the repeats — the backstop keeps out.
  const repeated = [U("What type of materials are included?", H(5)), OFFER, U("What type of materials are included?", H(1))];
  ck("repeated identical question → backstop keeps out (rule 35 owns it)", !reactOnlyIsWrong(repeated));
}
ck("backstop note: orders a normal answer, no second [REACT_ONLY]", /Do NOT output \[REACT_ONLY\] again/i.test(REACT_ONLY_WRONG_NOTE));
ck("backstop note: calls the old ack spent", /spent|already handled/i.test(REACT_ONLY_WRONG_NOTE));
{
  const src = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("getAIResponse retries once on a wrong [REACT_ONLY]", /reactOnlyIsWrong\(messages\)/.test(src) && /REACT_ONLY_WRONG_NOTE/.test(src));
  ck("a retry that still wants silence is honored", /honoring \[REACT_ONLY\]/.test(src));
}

// ── wiring: the three webhooks must feed `at` into the model ───────────────
for (const [ch, f] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]] as const) {
  const src = readFileSync(join(process.cwd(), f), "utf-8");
  ck(`${ch}: messagesForAI carries created_at as \`at\``, /at:\s*m\.created_at/.test(src), f);
}
{
  const src = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("getAIResponse injects the stale-thread block", /staleThreadGapHours\(messages\)/.test(src) && /staleThreadNote\(gap\)/.test(src));
}

if (process.env.DET_ONLY === "1") {
  console.log(`\n═══ ${pass} passed, ${fail} failed (deterministic only) ═══`);
  if (fails.length) console.log("FAILS:\n" + fails.map((f) => "  - " + f).join("\n"));
  process.exit(fail ? 1 : 0);
}

const GOODNIGHT = /good\s*night|buenas noches|boa noite/i;
const STALE_ECHO = /once you (get|have) that measurement|when you (get|have) that measurement|sleep|descansa/i;
const MENTIONS_GAP = /been a while|long time|haven'?t heard (from you )?(in|for)|since we last|hace (mucho|tiempo)|faz tempo|sorry for the (wait|delay)/i;

async function turn(label: string, msgs: ChatMessage[], checks: (t: string) => void) {
  const r = await ai(msgs);
  const t = r.text ?? "";
  console.log(`\n  ▸ ${label}\n    → ${t.replace(/\s+/g, " ").slice(0, 260)}`);
  checks(t);
}

async function main() {
console.log("\n═══ 2. LIVE MODEL ═══\n");

// A. the real turn, twice (the model is sampled, one pass proves little)
for (const n of [1, 2]) {
  await turn(`real case, run ${n}: free-estimate ask after 4 days`, REAL, (t) => {
    ck(`run ${n}: no "good night" answer to the 4-day-old sign-off`, !GOODNIGHT.test(t), t);
    ck(`run ${n}: does not wait on the old measurement`, !STALE_ECHO.test(t), t);
    ck(`run ${n}: moves the estimate forward (visit / slot / scope)`, /visit|estimate|come (by|out|measure)|free|what day|which day|zip|area|house|room/i.test(t), t);
    ck(`run ${n}: does not read his own number back to him`, !/305[\s.-]?968[\s.-]?6096/.test(t), t);
  });
}

// B. the note must not make the model talk about the silence
await turn("returning client (3 days) asking to schedule", [
  U("hi do you install vinyl", H(74)),
  A("Yes! Our luxury vinyl promo is $5 per square foot with the flooring, installation and quarter round included. Are you doing one area or the whole house?", H(74)),
  U("ok thanks", H(73.9)),
  U("I'm ready to set up the visit, whole house, 33180", H(2)),
], (t) => {
  ck("return: no small talk about how long it has been", !MENTIONS_GAP.test(t), t);
  ck("return: answers the request (slot or scheduling)", /\d\s?(am|pm)|what day|which day|visit|available/i.test(t), t);
});

// B2. the ack that poisoned the burst: the live message must be answered
for (const n of [1, 2]) {
  await turn(`ack poison, run ${n}: "ok thanks" above a ready-to-book message`, withAck("I'm ready to set up the visit, whole house, 33180"), (t) => {
    ck(`ack poison run ${n}: not silenced`, !/\[REACT_ONLY\]/.test(t) && t.trim().length > 0, t);
    ck(`ack poison run ${n}: moves to the visit`, /what day|which day|\d\s?(am|pm)|address|phone|visit|measure|available/i.test(t), t);
  });
}

// C. regression: a LIVE thread is untouched (no note fires at all)
await turn("live thread: type answer 2 min later", [
  U("How much for vinyl?", H(0.06)),
  A("Our luxury vinyl promo is $5 per square foot and that includes the flooring, the installation labor, and the quarter round. Are you doing one area or the whole house?", H(0.05)),
  U("the whole house, about 1200 sqft", H(0.03)),
], (t) => {
  ck("live: 500+ sqft still gets the visit, no DM total", !/\$\s?\d{3,}/.test(t), t);
  ck("live: no gap talk", !MENTIONS_GAP.test(t), t);
});

// D. regression: a pure closing after a long silence is still [REACT_ONLY]
await turn("closing after 2 days (must stay [REACT_ONLY])", [
  U("what's your number", H(50)),
  A("You can reach Ozzi directly at (561) 674-8334. Are you thinking tile, vinyl, or hardwood?", H(50)),
  U("ok thank you", H(1)),
], (t) => {
  ck("closing after a gap: still [REACT_ONLY]", /\[REACT_ONLY\]/.test(t), t);
});

// E. regression: the standing rules still win over the note (under 400 sqft)
await turn("under-400 job re-asked after 2 days", [
  U("I need my hallway done, it's about 120 sqft", H(52)),
  A("For a project under 400 square feet the best is to speak with Ozzi directly, he checks the details and gives you the quote himself. You can call him at (561) 674-8334.", H(52)),
  U("so how much would it be?", H(1.5)),
], (t) => {
  ck("under 400 after a gap: still no price", !/\$\s?\d/.test(t) || /674[\s.-]?8334/.test(t), t);
  ck("under 400 after a gap: still the Ozzi line", /674[\s.-]?8334/.test(t), t);
});

console.log(`\n═══ STALE-THREAD-VERIFY: ${pass} passed, ${fail} failed ═══`);
if (fails.length) console.log("FAILS:\n" + fails.map((f) => "  - " + f).join("\n"));
process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
