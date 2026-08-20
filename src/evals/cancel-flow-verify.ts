// Verifies the CANCELLATION flow (2026-08-19): when a booked client asks to
// cancel, the visit is really cancelled in the scheduler and the client gets a
// DETERMINISTIC confirmation naming the cancelled day/time plus the invitation
// to rebook, the owner is alerted, and a failed delete is NEVER presented to
// the client as a done cancellation. Pure unit + source checks — no API calls,
// no scheduler DB access, nothing is created or deleted.
import { readFileSync } from "fs";
import { join } from "path";
import {
  cancellationConfirmedMessage,
  cancellationHandoffMessage,
  cancellationAlert,
} from "../lib/scheduler";
import { getAIResponse, isCancelRequest, isRescheduleRequest, type ChatMessage } from "../lib/ai";

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

async function main() {
  console.log("\n===================== CANCELLATION FLOW VERIFICATION =====================");

  // ── 1. Client confirmation names the REAL cancelled visit ────────────────
  console.log("\n[1] cancellationConfirmedMessage — confirms with the visit's day and time");
  const en = cancellationConfirmedMessage("en", "2026-08-20", "15:00");
  ck("EN says cancelled", /cancelled/i.test(en), en);
  ck("EN names the weekday", /Thursday/.test(en), en);
  ck("EN names month + day", /August 20/.test(en), en);
  ck("EN names the time (12h)", /3pm/.test(en), en);
  ck("EN invites to rebook when ready", /whenever you'?re ready/i.test(en), en);
  ck("EN says at your disposal", /at your disposal/i.test(en), en);

  const es = cancellationConfirmedMessage("es", "2026-08-20", "15:00");
  ck("ES says cancelada", /cancelada/i.test(es), es);
  ck("ES names the weekday", /jueves/.test(es), es);
  ck("ES names day + month", /20 de agosto/.test(es), es);
  ck("ES names the time (12h)", /3pm/.test(es), es);
  ck("ES invites to rebook when ready", /cuando est[eé]s listo/i.test(es), es);

  const noTime = cancellationConfirmedMessage("en", "2026-08-22", "");
  ck("missing time degrades gracefully", /Saturday, August 22 is cancelled/.test(noTime), noTime);

  // ── 2. Failure handoff never claims the visit is cancelled ───────────────
  console.log("\n[2] cancellationHandoffMessage — honest, no false 'cancelled' claim");
  for (const lang of ["en", "es"] as const) {
    const m = cancellationHandoffMessage(lang);
    ck(`${lang}: does NOT claim cancelled`, !/\bcancelled\b|\bcancelada\b|\bcancelado\b/i.test(m), m);
    ck(`${lang}: mentions Ozzi confirming`, /ozzi/i.test(m), m);
  }

  // ── 3. Owner alert per outcome ───────────────────────────────────────────
  console.log("\n[3] cancellationAlert — owner can track every cancellation");
  const okAlert = cancellationAlert({
    success: true,
    visits: [{ date: "2026-08-20", time: "15:00", address: "123 Main St, Miami FL 33130" }],
  });
  ck("success: says VISITA CANCELADA", /VISITA CANCELADA/.test(okAlert), okAlert);
  ck("success: seller must NOT go", /NAO precisa ir/.test(okAlert), okAlert);
  ck("success: carries date and time", /2026-08-20/.test(okAlert) && /15:00/.test(okAlert), okAlert);
  ck("success: carries the address", /123 Main St/.test(okAlert), okAlert);

  const notFound = cancellationAlert({ success: false, error: "no_booking_found" });
  ck("no_booking_found: says nothing was cancelled", /nada foi cancelado/i.test(notFound), notFound);
  ck("no_booking_found: no false CANCELADA siren", !/VISITA CANCELADA/.test(notFound), notFound);

  const failed = cancellationAlert({ success: false, error: "timeout" });
  ck("failure: demands manual cancel", /CANCELE MANUALMENTE/.test(failed), failed);
  ck("failure: carries the error", /timeout/.test(failed), failed);

  // ── 4. Cancel intent still reaches the model (gate regression) ───────────
  console.log("\n[4] cancel intent detection — booked client asking to cancel is never silenced");
  for (const t of [
    "I need to cancel the appointment",
    "please cancel my visit for tomorrow",
    "necesito cancelar la cita",
    "quiero cancelar",
    "pode desmarcar a visita?",
  ]) {
    ck(`isCancelRequest: "${t}"`, isCancelRequest(t) === true);
    ck(`isRescheduleRequest (engage gate): "${t}"`, isRescheduleRequest(t) === true);
  }

  // ── 5. Source checks — all 3 webhooks wired the verified flow ────────────
  console.log("\n[5] source: the three webhooks confirm-after-cancel and alert the owner");
  const files: Array<[string, string]> = [
    ["IG", "src/app/api/webhook/route.ts"],
    ["FB", "src/app/api/fb-webhook/route.ts"],
    ["WA", "src/app/api/wa-webhook/route.ts"],
  ];
  for (const [label, rel] of files) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${label}: sends deterministic confirmation`, src.includes("cancellationConfirmedMessage(lang, result.visits[0].date, result.visits[0].time)"));
    ck(`${label}: honest handoff on failure`, src.includes("cancellationHandoffMessage(lang)"));
    ck(`${label}: owner alerted with cancellationAlert`, src.includes("alert: cancellationAlert(result)"));
    ck(`${label}: clears stale booked flag on no_booking_found`, /no_booking_found"\)\s*\{[\s\S]{0,400}booking_confirmed: false/.test(src));
  }
  const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck("cancelClientBooking uses Eastern today (not UTC)", /cancelClientBooking[\s\S]{0,700}easternTodayStr\(\)/.test(sched));
  ck("cancelClientBooking returns the cancelled visits", /cancelClientBooking[\s\S]{0,600}visits\?: CancelledVisit\[\]/.test(sched));

  // ── 6. AI behavior — booked client cancelling gets [CANCEL_BOOKING] ──────
  // Calls the model but only inspects the generated TEXT: the tag is never
  // processed here, so no real booking is touched.
  console.log("\n[6] AI behavior under [RESCHEDULE MODE, CANCEL INTENT]");
  const CANCEL_NOTE =
    "[SYSTEM: TODAY: Wednesday, August 19, 2026 [2026-08-19].\n\n" +
    "[RESCHEDULE MODE, CANCEL INTENT: This client has a confirmed visit and asked to CANCEL it. If they only want to cancel, acknowledge warmly in ONE sentence and end with [CANCEL_BOOKING]. You MAY lightly offer to pick another day instead, but NEVER push slots, NEVER state or assume a day or time they did not pick themselves, and NEVER claim any day works for them. Address them by name ONLY if certain it is the client's own name, otherwise use no name. If they clearly ask to move to a specific new day/time, treat it as a reschedule: offer slots from the schedule above and generate [BOOK:...] once they confirm.]]";
  const history: ChatMessage[] = [
    { role: "user", content: "Hi, I want new floors for my living room" },
    { role: "assistant", content: "Perfect, see you then!" },
    { role: "assistant", content: "Your visit is confirmed for Thursday, August 20 at 3pm. Ozzi will message you about 40 minutes before arriving, and if you need to move the visit just tell me the new day and time." },
    { role: "user", content: `Sorry, something came up and I need to cancel the appointment\n\n${CANCEL_NOTE}` },
  ];
  const r = await getAIResponse(history, null, null, undefined, false);
  const text = r.text ?? "";
  console.log(`   model: ${text.slice(0, 160)}`);
  ck("emits [CANCEL_BOOKING]", /\[CANCEL_BOOKING\]/i.test(text), text);
  ck("does not push slots or invent a new day/time", !/\b\d{1,2}\s*(am|pm)\b/i.test(text.replace(/\[CANCEL_BOOKING\]/gi, "")), text);
  ck("does not generate [BOOK:...]", !/\[BOOK:/i.test(text), text);

  console.log(`\n================= RESULT: ${pass} passed, ${fail} failed =================`);
  if (fail > 0) {
    console.log("Failed checks:\n - " + fails.join("\n - "));
    process.exit(1);
  }
}

main();
