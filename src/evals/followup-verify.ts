// Regression guard for the one-shot follow-up feature (2026-07-09).
// Pure-function tests only — deterministic, instant, ZERO API calls and ZERO
// sends. Proves the anti-spam guards hold: ghosts, deferrals, closed loops,
// double-nudges, and messaging windows are all hard-blocked, while the real
// target (engaged lead, scheduling ask, went quiet) is caught.
// Run: npx tsx src/evals/followup-verify.ts
import {
  decideFollowup,
  followupTemplate,
  FOLLOWUP_MARKER,
  isAdFaqButton,
  isClientDeferral,
  botClosedTheLoop,
  isSchedulingAsk,
  isEtDaytime,
  pickLang,
  type FollowupMsg,
} from "@/lib/followup";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-07-09T18:00:00Z"); // 2pm ET — daytime
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const m = (role: "user" | "assistant", content: string, hoursAgo: number): FollowupMsg => ({ role, content, created_at: at(hoursAgo) });

const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const VISIT_OFFER = "For a whole house I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Tuesday at 9am or 1pm, what works better for you?";

console.log("\n── 1. The real target: engaged lead + scheduling ask + went quiet ──");
const target: FollowupMsg[] = [
  m("user", "How much for new floors?", 10),
  m("assistant", OPENER, 10),
  m("user", "Vinyl, the whole house", 9.5),
  m("assistant", VISIT_OFFER, 9.4),
];
let d = decideFollowup("fb_123", target, NOW);
check("engaged lead, visit offered, 9.5h silent → ELIGIBLE", d.eligible, d.reason);
check("english conversation → english template", d.lang === "en", d.lang);

console.log("\n── 2. Ghosts and mis-taps are NEVER followed up ──");
d = decideFollowup("fb_1", [m("user", "What type of materials are included?", 10), m("assistant", OPENER, 10)], NOW);
check("one-tap ad FAQ ghost → blocked", !d.eligible && d.reason === "never-genuinely-engaged", d.reason);
d = decideFollowup("fb_1", [
  m("user", "What type of materials are included?", 10),
  m("assistant", OPENER, 10),
  m("user", "Can I customize the design?", 9),
  m("assistant", OPENER, 9),
], NOW);
check("multi-tap FAQ ghost (only buttons, no real message) → blocked", !d.eligible, d.reason);
check("isAdFaqButton catches the $4,500 button", isAdFaqButton("Is labor cost also $4,500?"));
check("isAdFaqButton does NOT flag a real question", !isAdFaqButton("What vinyl brands do you install?"));

console.log("\n── 3. Client deferrals are respected — no nudge ──");
const deferred: FollowupMsg[] = [
  ...target.slice(0, 3),
  m("user", "I'll ask my husband and let you know thanks", 9),
  m("assistant", "No problem, just reach out whenever you're ready!", 9),
];
d = decideFollowup("fb_123", deferred, NOW);
check("'I'll ask my husband and let you know' → blocked", !d.eligible, d.reason);
check("'te aviso' (ES) is a deferral", isClientDeferral("Ok.Buscaremos el piso 1ro.Y luego te avisamos.Gracias"));
check("'when I'm ready I'll reach out' is a deferral", isClientDeferral("It's ok. I'll reach out when I'm ready"));
check("'not interested' is a deferral", isClientDeferral("no thanks, not interested"));
check("'Vinyl, whole house' is NOT a deferral", !isClientDeferral("Vinyl, the whole house"));

console.log("\n── 4. Bot already closed the loop → no contradictory nudge ──");
check("'reach out whenever you're ready' closes the loop", botClosedTheLoop("No problem, just reach out whenever you're ready and we'll get everything set up!"));
check("'team will reach out' handoff closes the loop", botClosedTheLoop("Thanks for your message! Let me get our team to reach out, someone will get right back to you."));
check("out-of-area decline closes the loop", botClosedTheLoop("Unfortunately Palm Bay is outside our service area, we only cover South Florida."));
check("a visit offer does NOT close the loop", !botClosedTheLoop(VISIT_OFFER));

console.log("\n── 5. One nudge EVER — the marker blocks a second ──");
for (const lang of ["en", "es", "pt"] as const) {
  check(`FOLLOWUP_MARKER matches the ${lang} template (dedup invariant)`, FOLLOWUP_MARKER.test(followupTemplate(lang)));
}
d = decideFollowup("fb_123", [...target, m("assistant", followupTemplate("en"), 5)], NOW);
check("conversation with a prior follow-up → blocked forever", !d.eligible && d.reason === "already-followed-up", d.reason);

console.log("\n── 6. Timing windows per channel ──");
const fresh = [...target.slice(0, 3), m("user", "sounds good", 1), m("assistant", VISIT_OFFER, 1)];
d = decideFollowup("fb_123", fresh, NOW);
check("only 1h of silence → too fresh, blocked", !d.eligible, d.reason);
const stale = [m("user", "vinyl whole house", 30), m("assistant", OPENER, 30.1), m("user", "yes vinyl", 30), m("assistant", VISIT_OFFER, 29.9)];
d = decideFollowup("fb_123", stale, NOW);
check("Messenger 30h → Meta window closed, blocked", !d.eligible, d.reason);
d = decideFollowup("wa_15551234567", stale, NOW);
check("WhatsApp 30h → still inside Z-API window, ELIGIBLE", d.eligible, d.reason);
d = decideFollowup("fb_123", [...target.slice(0, 3), m("assistant", VISIT_OFFER, 1)], NOW);
check("bot's own message only 1h old → blocked", !d.eligible, d.reason);

console.log("\n── 7. Unanswered client message is NOT this feature's job ──");
d = decideFollowup("fb_123", [...target, m("user", "do you take credit cards?", 5)], NOW);
check("client has the last word → blocked (webhook flow owns that)", !d.eligible && d.reason === "client-has-last-word", d.reason);

console.log("\n── 8. Language matching ──");
check("Spanish convo → es", pickLang(["Hola, necesito piso para mi casa", "porcelanato, toda la casa"]) === "es");
check("Portuguese convo → pt", pickLang(["Oi, quero orçamento", "a casa toda, piso vinílico"]) === "pt");
check("English convo → en", pickLang(["hi, need new floors", "vinyl please"]) === "en");
// 2026-07-09 dry-run bugs: signal-free client text must follow the BOT's language.
check("'Cuando pueden darme una cita' → es (cita/pueden/darme)", pickLang(["What is the installation process?", "Cuando pueden darme una cita"]) === "es");
check(
  "address-only client msgs + Spanish bot reply → es (Jose case)",
  pickLang(["2436 se 28th st homestead Florida 33035", "Jose Hernandez"], "Gracias Jose, ¿cuál de los dos horarios te funciona mejor, la 1pm o las 3pm del jueves?") === "es"
);
check(
  "address-only client msgs + Portuguese bot reply → pt",
  pickLang(["123 Main St Boca Raton"], "Perfeito, levo todas as amostras para você escolher na hora, a visita é gratuita.") === "pt"
);
check("address-only client msgs + English bot reply → en", pickLang(["123 Main St"], "Perfect, what works better for you?") === "en");
const es: FollowupMsg[] = [
  m("user", "Hola, necesito un estimado para porcelanato", 8),
  m("assistant", "Hola, trabajamos con vinilo de lujo, porcelanato y madera. ¿Cuál te interesa?", 8),
  m("user", "porcelanato, toda la casa", 7.5),
  m("assistant", "Para porcelanato la instalación es $4.50 por pie cuadrado. Tengo el lunes a las 9am o el martes a las 11am, visita gratis, ¿cuál te queda mejor?", 7.4),
];
d = decideFollowup("wa_15551234567", es, NOW);
check("Spanish lead gets the Spanish nudge", d.eligible && d.lang === "es", `${d.reason}/${d.lang}`);

console.log("\n── 9. Scheduling-ask detection ──");
check("slot offer is a scheduling ask", isSchedulingAsk(VISIT_OFFER));
check("scope question is a scheduling ask", isSchedulingAsk("Are you planning to do just one area or the whole house?"));
check("type-ask opener is a scheduling ask", isSchedulingAsk(OPENER));
check("pure info answer is NOT a scheduling ask", !isSchedulingAsk("We move all the furniture, install the floors, and clean everything up within 2 to 3 days."));

console.log("\n── 10. Templates obey the owner's style rules ──");
for (const lang of ["en", "es", "pt"] as const) {
  const t = followupTemplate(lang);
  check(`${lang}: no dashes/emoji/dollar amounts`, !/[—–\u{1F300}-\u{1FAFF}]/u.test(t) && !/\$\s?\d/.test(t));
  check(`${lang}: max 2 sentences`, (t.match(/[.!?](?:\s|$)/g) ?? []).length <= 2, t);
  check(`${lang}: no invented slots (no weekday/clock time)`, !/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|segunda|ter[çc]a|\d{1,2}\s*(?:am|pm))\b/i.test(t));
}

console.log("\n── 11. ET daytime gate ──");
check("2pm ET is daytime", isEtDaytime(Date.parse("2026-07-09T18:00:00Z")));
check("2am ET is quiet hours", !isEtDaytime(Date.parse("2026-07-09T06:00:00Z")));
check("7pm ET (the cron hour) is daytime", isEtDaytime(Date.parse("2026-07-09T23:05:00Z")));

console.log(`\n=========== FOLLOWUP-VERIFY: ${passed} passed, ${failed} failed ===========`);
process.exit(failed > 0 ? 1 : 0);
