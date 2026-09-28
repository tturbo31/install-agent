// Regression guard for the follow-up feature (2026-07-09, cadence rewritten
// 2026-09-27: only after 2 full days of silence, a second touch 2 days later,
// never a third, WhatsApp only because Meta's 24h window closes first).
// Pure-function tests only — deterministic, instant, ZERO API calls and ZERO
// sends. Proves the anti-spam guards hold: ghosts inside 2 days, deferrals,
// closed loops, third nudges and messaging windows are all hard-blocked, while
// the real target (engaged lead, scheduling ask, quiet for 2 days) is caught.
// Run: npx tsx src/evals/followup-verify.ts
import {
  decideFollowup,
  followupTemplate,
  lastTouchTemplate,
  FOLLOWUP_MARKER,
  FOLLOWUP_DELAY_H,
  NUDGE_GAP_H,
  MAX_NUDGES_PER_CONVERSATION,
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

const NOW = Date.parse("2026-09-27T18:00:00Z"); // 2pm ET — daytime
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const m = (role: "user" | "assistant", content: string, hoursAgo: number): FollowupMsg => ({ role, content, created_at: at(hoursAgo) });
const WA = "wa_15551234567";

const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const VISIT_OFFER = "For a whole house I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Tuesday at 9am or 1pm, what works better for you?";
// engaged lead whose last message is `h` hours old, our offer right after it
const target = (h: number): FollowupMsg[] => [
  m("user", "How much for new floors?", h + 0.5),
  m("assistant", OPENER, h + 0.5),
  m("user", "Vinyl, the whole house", h),
  m("assistant", VISIT_OFFER, h - 0.05),
];

console.log("\n── 0. The owner's cadence (2026-09-27) ──");
check("first nudge only after 48h of silence", FOLLOWUP_DELAY_H === 48);
check("second touch 48h after the first", NUDGE_GAP_H === 48);
check("never more than 2 nudges per conversation", MAX_NUDGES_PER_CONVERSATION === 2);

console.log("\n── 1. The real target: engaged lead + scheduling ask + quiet for 2 days (WhatsApp) ──");
let d = decideFollowup(WA, target(50), NOW);
check("engaged lead, visit offered, 50h silent → ELIGIBLE", d.eligible && d.kind === "engaged", d.reason);
check("english conversation → english template", d.lang === "en", d.lang);
d = decideFollowup(WA, target(9.5), NOW);
check("9.5h silent (the old target) → too fresh now", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup(WA, target(47.5), NOW);
check("47.5h silent → still too fresh", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup(WA, target(24 * 5 + 1), NOW);
check("5 days and 1h → window closed (never wake a week-old lead)", !d.eligible && /window-closed/.test(d.reason), d.reason);

console.log("\n── 2. Instagram and Messenger never get the 2-day follow-up (Meta 24h window) ──");
for (const id of ["fb_123", "1777752696862664"]) {
  d = decideFollowup(id, target(50), NOW);
  check(`${id.startsWith("fb_") ? "Messenger" : "Instagram"}, 50h → blocked (channel window closes before 2 days)`, !d.eligible && d.reason === "channel-window-closes-before-2-days", d.reason);
  d = decideFollowup(id, target(1.2), NOW);
  check(`${id.startsWith("fb_") ? "Messenger" : "Instagram"}, 1.2h → blocked too (no more 45-minute nudges)`, !d.eligible, d.reason);
}

console.log("\n── 3. Fantasma do botão (17/09/2026): still a target, but only after 2 days, WhatsApp only ──");
d = decideFollowup(WA, [m("user", "What type of materials are included?", 50), m("assistant", OPENER, 49.98)], NOW);
check("one-tap ad FAQ ghost, 50h → faq_ghost", d.eligible && d.kind === "faq_ghost", d.reason);
d = decideFollowup(WA, [m("user", "What type of materials are included?", 3), m("assistant", OPENER, 2.98)], NOW);
check("one-tap ghost, 3h → too fresh", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup("fb_1", [m("user", "What type of materials are included?", 50), m("assistant", OPENER, 49.98)], NOW);
check("Messenger ghost → never", !d.eligible, d.reason);
check("isAdFaqButton catches the $4,500 button", isAdFaqButton("Is labor cost also $4,500?"));
check("isAdFaqButton does NOT flag a real question", !isAdFaqButton("What vinyl brands do you install?"));

console.log("\n── 4. Client deferrals and bare negatives are respected — no nudge ──");
const deferred: FollowupMsg[] = [
  ...target(60).slice(0, 3),
  m("user", "I'll ask my husband and let you know thanks", 55),
  m("assistant", "No problem, just reach out whenever you're ready!", 54.9),
];
d = decideFollowup(WA, deferred, NOW);
check("'I'll ask my husband and let you know' → blocked", !d.eligible, d.reason);
check("'te aviso' (ES) is a deferral", isClientDeferral("Ok.Buscaremos el piso 1ro.Y luego te avisamos.Gracias"));
check("'when I'm ready I'll reach out' is a deferral", isClientDeferral("It's ok. I'll reach out when I'm ready"));
check("'not interested' is a deferral", isClientDeferral("no thanks, not interested"));
check("bare 'No' / 'None' / 'not now' are deferrals (27/09)", isClientDeferral("No") && isClientDeferral("None") && isClientDeferral("Not now"));
check("'Vinyl, whole house' is NOT a deferral", !isClientDeferral("Vinyl, the whole house"));
check("'No, the whole house' is NOT a deferral", !isClientDeferral("No, the whole house"));
d = decideFollowup(WA, [...target(60).slice(0, 3), m("user", "None", 55), m("assistant", "No problem, which flooring are you thinking about?", 54.9)], NOW);
check("'None' as the client's last word → client-deferred", !d.eligible && d.reason === "client-deferred", d.reason);

console.log("\n── 5. Hostile / stop-contact client is NEVER followed up ──");
const hostileHistory: FollowupMsg[] = [
  m("user", "No. Get away from me", 60),
  m("assistant", OPENER, 59.9),
  m("user", "Reporting you for spam", 55),
  m("assistant", VISIT_OFFER, 54.9),
];
d = decideFollowup(WA, hostileHistory, NOW);
check("'get away from me' in history → blocked (client-rejected)", !d.eligible && d.reason === "client-rejected", d.reason);

console.log("\n── 6. Bot already closed the loop → no contradictory nudge ──");
check("'reach out whenever you're ready' closes the loop", botClosedTheLoop("No problem, just reach out whenever you're ready and we'll get everything set up!"));
check("'team will reach out' handoff closes the loop", botClosedTheLoop("Thanks for your message! Let me get our team to reach out, someone will get right back to you."));
check("out-of-area decline closes the loop", botClosedTheLoop("Unfortunately Palm Bay is outside our service area, we only cover South Florida."));
check("a visit offer does NOT close the loop", !botClosedTheLoop(VISIT_OFFER));
d = decideFollowup(WA, [...target(60).slice(0, 3), m("user", "ok", 55), m("assistant", "No problem, just reach out whenever you're ready!", 54.9)], NOW);
check("closed loop 55h ago → blocked (bot-closed-loop)", !d.eligible && d.reason === "bot-closed-loop", d.reason);

console.log("\n── 7. Two touches, two days apart, never a third ──");
for (const lang of ["en", "es", "pt"] as const) {
  check(`FOLLOWUP_MARKER matches the ${lang} template (dedup invariant)`, FOLLOWUP_MARKER.test(followupTemplate(lang)));
  check(`FOLLOWUP_MARKER matches the ${lang} last-touch template`, FOLLOWUP_MARKER.test(lastTouchTemplate(lang)));
}
const afterFirst = (nudgeAgeH: number) => [...target(100), m("assistant", followupTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", nudgeAgeH)];
d = decideFollowup(WA, afterFirst(30), NOW);
check("first nudge 30h ago → second touch too soon", !d.eligible && /second-touch-too-soon/.test(d.reason), d.reason);
d = decideFollowup(WA, afterFirst(49), NOW);
check("first nudge 49h ago, client still silent → last_touch", d.eligible && d.kind === "last_touch", d.reason);
d = decideFollowup(WA, [...afterFirst(60), m("assistant", lastTouchTemplate("en"), 10)], NOW);
check("two nudges already sent → blocked forever (max-nudges-reached)", !d.eligible && d.reason === "max-nudges-reached", d.reason);
d = decideFollowup(WA, [...afterFirst(60), m("user", "Not interested", 50)], NOW);
check("client answered the first nudge → client has the last word, nothing more", !d.eligible && d.reason === "client-has-last-word", d.reason);
d = decideFollowup(WA, [...afterFirst(60), m("user", "Still deciding", 50), m("assistant", "No rush, take your time.", 49.9)], NOW);
check("client replied and we answered → the second touch is not for this thread (bot spoke after the nudge)", !d.eligible && d.reason === "bot-spoke-after-the-nudge", d.reason);
d = decideFollowup(WA, [...target(24 * 5 + 2), m("assistant", followupTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 49)], NOW);
check("client's last message past 5 days → no second touch either", !d.eligible && /window-closed/.test(d.reason), d.reason);

console.log("\n── 8. Unanswered client message is NOT this feature's job ──");
d = decideFollowup(WA, [...target(60), m("user", "do you take credit cards?", 50)], NOW);
check("client has the last word → blocked (webhook flow owns that)", !d.eligible && d.reason === "client-has-last-word", d.reason);

console.log("\n── 9. Our own last line must also be 2 days old ──");
d = decideFollowup(WA, [...target(60).slice(0, 3), m("assistant", VISIT_OFFER, 20)], NOW);
check("bot's own message only 20h old → blocked (bot-msg-too-fresh)", !d.eligible && /bot-msg-too-fresh/.test(d.reason), d.reason);

console.log("\n── 10. Language matching ──");
check("Spanish convo → es", pickLang(["Hola, necesito piso para mi casa", "porcelanato, toda la casa"]) === "es");
check("Portuguese convo → pt", pickLang(["Oi, quero orçamento", "a casa toda, piso vinílico"]) === "pt");
check("English convo → en", pickLang(["hi, need new floors", "vinyl please"]) === "en");
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
  m("user", "Hola, necesito un estimado para porcelanato", 60),
  m("assistant", "Hola, trabajamos con vinilo de lujo, porcelanato y madera. Cuál te interesa?", 59.9),
  m("user", "porcelanato, toda la casa", 55),
  m("assistant", "Para porcelanato la instalación es $4.50 por pie cuadrado. Tengo el lunes a las 9am o el martes a las 11am, visita gratis, cuál te queda mejor?", 54.9),
];
d = decideFollowup(WA, es, NOW);
check("Spanish lead gets the Spanish nudge", d.eligible && d.lang === "es", `${d.reason}/${d.lang}`);

console.log("\n── 11. Scheduling-ask detection ──");
check("slot offer is a scheduling ask", isSchedulingAsk(VISIT_OFFER));
check("scope question is a scheduling ask", isSchedulingAsk("Are you planning to do just one area or the whole house?"));
check("type-ask opener is a scheduling ask", isSchedulingAsk(OPENER));
check("pure info answer is NOT a scheduling ask", !isSchedulingAsk("We move all the furniture, install the floors, and clean everything up within 2 to 3 days."));

console.log("\n── 12. Templates obey the owner's style rules (short, human, no invented slots) ──");
for (const lang of ["en", "es", "pt"] as const) {
  for (const t of [followupTemplate(lang), lastTouchTemplate(lang)]) {
    check(`${lang}: no dashes/emoji/dollar amounts`, !/[—–\u{1F300}-\u{1FAFF}]/u.test(t) && !/\$\s?\d/.test(t));
    check(`${lang}: max 2 sentences, under 170 characters`, (t.match(/[.!?](?:\s|$)/g) ?? []).length <= 2 && t.length <= 170, `${t.length}c`);
    check(`${lang}: no invented slots (no weekday/clock time/this week)`, !/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|segunda|ter[çc]a|this week|esta semana|\d{1,2}\s*(?:am|pm))\b/i.test(t));
  }
}

console.log("\n── 13. ET daytime gate ──");
check("2pm ET is daytime", isEtDaytime(Date.parse("2026-07-09T18:00:00Z")));
check("2am ET is quiet hours", !isEtDaytime(Date.parse("2026-07-09T06:00:00Z")));
check("7pm ET (the cron hour) is daytime", isEtDaytime(Date.parse("2026-07-09T23:05:00Z")));

console.log(`\n=========== FOLLOWUP-VERIFY: ${passed} passed, ${failed} failed ===========`);
process.exit(failed > 0 ? 1 : 0);
