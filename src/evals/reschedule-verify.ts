// Verifies the RESCHEDULE feature. Unit + source checks need no API and never
// touch the real scheduler DB (no bookings are created or deleted here). The AI
// behavior checks call the model but only inspect the generated text — they do
// NOT execute rescheduleClientBooking, so no real appointment is moved.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isRescheduleRequest, containsSchedulingOffer, type ChatMessage } from "../lib/ai";
import { getEasternDateContext } from "../lib/scheduler";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

async function main() {
  console.log("\n===================== RESCHEDULE VERIFICATION =====================");

  // ── 1. Reschedule intent detection ───────────────────────────────────────
  console.log("\n[1] isRescheduleRequest — POSITIVES (booked client wants to move the visit)");
  const positives = [
    "Can we reschedule the visit?",
    "I need to reschedule",
    "Something came up, can we move the appointment to another day?",
    "Can we change the visit to Friday instead?",
    "I can't make Thursday, can we do a different day?",
    "Podemos remarcar a visita?",
    "necesito reagendar la cita",
    "can we push the appointment to next week",
    "switch my appointment to the morning",
  ];
  for (const p of positives) ck(`positive: "${p}"`, isRescheduleRequest(p) === true, "not detected");

  console.log("\n[1b] isRescheduleRequest — NEGATIVES (must NOT trigger reschedule)");
  const negatives = [
    "Ok thank you",
    "What time will you arrive exactly?",
    "Thanks, see you then!",
    "Obrigado!",
    "Sounds good",
    "How much is it per sqft?",
    "do you handle permits?",
  ];
  for (const n of negatives) ck(`negative: "${n}"`, isRescheduleRequest(n) === false, "false-positive");

  // ── 2. In-progress detection via the last assistant message ──────────────
  console.log("\n[2] containsSchedulingOffer — keeps reschedule alive across turns");
  ck("offer with slots → true", containsSchedulingOffer("Sure! I have Friday at 1pm or Monday at 3pm, what works?") === true);
  ck("offer asking the day → true", containsSchedulingOffer("No problem, what day works best for you?") === true);
  ck("booking confirmation → false (so silence resumes after)", containsSchedulingOffer("Appointment confirmed. I will notify you approximately 40 minutes before arriving. My name is Ozzi.") === false);
  ck("reschedule success → false", containsSchedulingOffer("All set, your visit has been rescheduled. I will notify you approximately 40 minutes before arriving.") === false);

  // ── 3. Webhook wiring (source inspection, no API) ────────────────────────
  console.log("\n[3] All three webhooks wire the reschedule flow");
  const hooks: Array<[string, string]> = [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ];
  for (const [name, rel] of hooks) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: imports reschedule helpers`, /rescheduleClientBooking/.test(src) && /isRescheduleRequest/.test(src) && /containsSchedulingOffer/.test(src) && /rescheduleSuccessMessage/.test(src));
    ck(`${name}: post-booking silence still gated (only skipped when rescheduling)`, /!engageReschedule/.test(src));
    ck(`${name}: injects [RESCHEDULE MODE] note`, /RESCHEDULE MODE/.test(src));
    ck(`${name}: passes isRescheduling into processBookingCommand`, /isRescheduling\s*\)/.test(src));
    ck(`${name}: reschedule path calls rescheduleClientBooking`, /if \(isReschedule\)[\s\S]{0,400}rescheduleClientBooking/.test(src));
  }

  // ── 4. AI behavior in RESCHEDULE MODE (calls model, no DB writes) ────────
  console.log("\n[4] AI behavior under [RESCHEDULE MODE]");
  // Build a synthetic schedule with a known open future date (today + 7 days).
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 7);
  const target = base.toISOString().slice(0, 10);
  const d = new Date(target + "T12:00:00Z");
  const wd = DAYS[d.getUTCDay()], mo = MONTHS[d.getUTCMonth()], dom = d.getUTCDate(), yr = d.getUTCFullYear();
  const availability =
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n" +
    `• ${wd}, ${mo} ${dom}, ${yr} [${target}]: 9am, 1pm, 3pm\n` +
    "- ONLY offer times listed above. The weekday and the [YYYY-MM-DD] must come from the same line.";
  const note = (extra: string) => `\n\n[SYSTEM: ${getEasternDateContext()}\n\n${availability}\n\n[RESCHEDULE MODE: This client already has a confirmed visit and wants to MOVE it. Acknowledge warmly, offer new open slots from the schedule above, and when they confirm a new day and time generate [BOOK:...] with the NEW date and time. Do NOT ask for the address or phone again. Follow all date-integrity rules.]${extra}]`;

  console.log(`   target slot: ${wd} ${target} 1pm`);
  // 4a. First reschedule message → engages (offers a slot / asks day), not silent, no premature BOOK.
  const offer = await ai([
    { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving. My name is Ozzi." },
    { role: "user", content: "Hey, something came up, can we reschedule the visit to another day?" + note("") },
  ]);
  console.log("   offer:", offer.replace(/\s+/g, " ").slice(0, 160));
  ck("4a: engages (not silent)", offer.replace(/\[[^\]]*\]/g, "").trim().length > 0, offer);
  ck("4a: offers a new slot or asks the day", containsSchedulingOffer(offer) || /what day|which day|when works/i.test(offer), offer);
  ck("4a: does NOT book prematurely (no [BOOK] yet)", !/\[BOOK:/i.test(offer), offer);
  ck("4a: does NOT re-ask for address/phone", !/address|phone/i.test(offer), offer);

  // 4b. Client confirms a listed new slot → emits [BOOK] with the NEW date/time.
  const confirm = await ai([
    { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving. My name is Ozzi." },
    { role: "user", content: "Something came up, can we move the visit?" },
    { role: "assistant", content: `No problem, I have ${wd}, ${mo} ${dom} open at 9am, 1pm, or 3pm, what works for you?` },
    { role: "user", content: `Yes, lock it in for ${wd} ${mo} ${dom} at 1pm` + note("") },
  ]);
  console.log("   confirm:", confirm.replace(/\s+/g, " ").slice(0, 160));
  const bk = confirm.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  ck("4b: generates [BOOK:...] on confirmation", !!bk, confirm);
  ck(`4b: [BOOK] uses the NEW date ${target}`, !!bk && new RegExp(`"date"\\s*:\\s*"${target}"`).test(bk[1]), bk?.[1] ?? confirm);
  ck("4b: [BOOK] uses 13:00 (1pm)", !!bk && /"time"\s*:\s*"13:00"/.test(bk[1]), bk?.[1] ?? confirm);
  if (bk) {
    const dm = bk[1].match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
    if (dm) ck("4b: booked date's weekday matches the promised weekday", DAYS[new Date(dm[1] + "T12:00:00Z").getUTCDay()] === wd, `${dm[1]} vs ${wd}`);
  }

  console.log(`\n============ RESCHEDULE-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
