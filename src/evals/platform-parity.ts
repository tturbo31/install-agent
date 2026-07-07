/**
 * Platform parity check — verifies the three channel webhooks behave the SAME.
 *
 * The question this answers: "is WhatsApp responding just like Instagram Direct
 * and Messenger?" All three must share the exact same conversation brain, sales
 * flow, booking/cancel/reschedule logic, safety nets, self-learning, and metrics.
 * This is a static check (no API calls): it reads the three route files and
 * asserts every SHARED behavior is present in all three, then lists the
 * INTENTIONAL per-platform differences so they are documented, not mistaken for
 * bugs. Run: npx tsx src/evals/platform-parity.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const CHANNELS = [
  { name: "Instagram (Direct)", file: "src/app/api/webhook/route.ts" },
  { name: "Messenger", file: "src/app/api/fb-webhook/route.ts" },
  { name: "WhatsApp", file: "src/app/api/wa-webhook/route.ts" },
] as const;

const SRC: Record<string, string> = {};
for (const ch of CHANNELS) SRC[ch.name] = readFileSync(join(process.cwd(), ch.file), "utf-8");

type Check = { label: string; test: (src: string) => boolean };

// ── SHARED behaviors — MUST exist identically in all three channels ──────────
const SHARED: Check[] = [
  // Channel on/off + dedup + conversation lifecycle
  { label: "Channel pause check (platform_settings.paused)", test: (s) => /from\("platform_settings"\)[\s\S]{0,80}paused/.test(s) },
  { label: "Deduplicate by inbound message id", test: (s) => s.includes("instagram_msg_id") && /maybeSingle\(\)/.test(s) },
  { label: "Find-or-create conversation with race recovery", test: (s) => s.includes("wasNewConv") && /convErr[\s\S]{0,400}existing/.test(s) },
  { label: "Store inbound message immediately", test: (s) => /insert\(\{[\s\S]{0,120}role: "user"/.test(s) },
  { label: "Early return when conversation mode = human", test: (s) => /mode === "human"/.test(s) },

  // Debounce + concurrency guards
  { label: "10s debounce before replying", test: (s) => s.includes("RESPONSE_DELAY_MS") },
  { label: "Debounce + stale-guard BOTH use id tiebreaker (>=2x)", test: (s) => (s.match(/\.order\("id", \{ ascending: false \}\)/g) || []).length >= 2 },
  { label: "Re-fetch conversation before acting (freshConv)", test: (s) => s.includes("freshConv") },
  { label: "Pause guard right after debounce", test: (s) => s.includes("paused during debounce") },
  { label: "5s duplicate-reply rate limit", test: (s) => s.includes("Date.now() - 5000") },
  { label: "Booking-info turn bypasses rate limit (never drop a booking)", test: (s) => s.includes("containsBookingInfo(rawText)") && /&& !carriesBookingInfo\) return;/.test(s) },
  { label: "Final pause guard before send (conv + channel)", test: (s) => s.includes("Paused mid-flight") && /livePlatform/.test(s) },
  { label: "Stale-context guard before send (newer msg arrived)", test: (s) => s.includes("discarding stale reply") },
  { label: "Grace window before redundant booking-info re-ask", test: (s) => s.includes("isAskingForBookingInfo") && s.includes("discarding redundant re-ask") },

  // Returning client / booking state
  { label: "Returning-client served check (hasExistingBooking)", test: (s) => s.includes("hasExistingBooking") },
  { label: "Reschedule intent detection", test: (s) => s.includes("isRescheduleRequest") && s.includes("containsSchedulingOffer") },
  { label: "Already-booked → silent owner notify", test: (s) => /isBooked && !engageReschedule/.test(s) },
  { label: "isBookingConfirmed / isRescheduling split", test: (s) => s.includes("isBookingConfirmed") && s.includes("isRescheduling") },

  // Context injected into the brain
  { label: "Eastern date context", test: (s) => s.includes("getEasternDateContext") },
  { label: "Language detection", test: (s) => s.includes("detectLang") },
  { label: "Real-time availability (only pre-booking)", test: (s) => s.includes("getRealAvailabilityContext") },
  { label: "Owner-handled returning-client note", test: (s) => s.includes("isOwnerHandled") && s.includes("isStructuredCorrection") },
  { label: "System note: BOOKING ALREADY CONFIRMED", test: (s) => s.includes("BOOKING ALREADY CONFIRMED") },
  { label: "System note: RETURNING CLIENT", test: (s) => s.includes("RETURNING CLIENT") },
  { label: "System note: RESCHEDULE MODE", test: (s) => s.includes("RESCHEDULE MODE") },
  { label: "Large-lead detection + alert (>=500 sqft)", test: (s) => s.includes("detectLargeLeadSqft") && s.includes("LARGE LEAD ALERT") },
  { label: "Job-seeker silence", test: (s) => s.includes("isJobSeeker") },

  // Self-learning + memory + corrections (the shared brain inputs)
  { label: "Per-client memory (create + read)", test: (s) => s.includes("createClientMemoryStore") && s.includes("readClientMemory") },
  { label: "SELF-LEARNING: system memory load (Dreaming)", test: (s) => s.includes("getOrCreateSystemStore") && s.includes("readSystemMemory") },
  { label: "SELF-LEARNING: systemMemory passed to brain", test: (s) => /getAIResponse\([\s\S]{0,160}systemMemory/.test(s) },
  { label: "Live owner corrections loaded", test: (s) => s.includes("loadGlobalCorrections") },
  { label: "Background memory update after reply", test: (s) => s.includes("extractMemoryUpdate") && s.includes("updateClientMemory") },

  // The brain call + outage resilience
  { label: "Same brain entrypoint (getAIResponse)", test: (s) => s.includes("getAIResponse(") },
  { label: "AI-outage handoff + burst guard + credit alert", test: (s) => s.includes("aiOutageHandoffMessage") && s.includes("staying silent (no handoff)") && s.includes("CREDIT_ALERT") },

  // Output processing + safety nets
  { label: "REACT_ONLY / pure-closing handling", test: (s) => s.includes("isPureClosing") && s.includes("REACT_ONLY") },
  { label: "Strip [BOOK] when already confirmed", test: (s) => s.includes('\\[BOOK:[\\s\\S]*?\\]/g') },
  { label: "Slot-conflict safety net (never 'slot taken')", test: (s) => s.includes("stripSlotConflictLanguage") },
  { label: "Booking / cancel / notify processors", test: (s) => s.includes("processBookingCommand") && s.includes("processCancelCommand") && s.includes("processNotifyOwner") },
  { label: "Strip forbidden tags before send", test: (s) => s.includes("stripForbiddenTags") },
  { label: "Empty-response guard (never send blank)", test: (s) => s.includes("Empty response after tag stripping") },
  { label: "METRICS: track tokens + conversion", test: (s) => s.includes("trackConversationMetrics") },
  // Rule 29 backstop, added 2026-07-07 after the review found a client who got
  // the identical canned line 12x during an outage and FAQ-button loops: the
  // same message must never be sent twice in a row, on ANY send path (AI reply,
  // no-content canned line, outage handoff).
  { label: "Consecutive-duplicate send guard (3 paths)", test: (s) => (s.match(/isConsecutiveDuplicate\(/g) ?? []).length >= 3 },
];

// ── INTENTIONAL per-platform differences (informational, NOT failures) ───────
const PLATFORM_SPECIFIC: Record<string, Check[]> = {
  "Instagram (Direct)": [
    { label: "Voice reply (TTS) when client sent audio", test: (s) => s.includes("generateSpeech") && s.includes("sendInstagramAudio") },
    { label: "Influencer partnership / follower-count path", test: (s) => s.includes("FOLLOWER_COUNT") },
    { label: "Ad-reply reinforcement note", test: (s) => s.includes("AD_REPLY_NOTE") },
    { label: "Meta signature verification on POST", test: (s) => s.includes("verifyMetaSignature") },
  ],
  "Messenger": [
    { label: "Ad-reply reinforcement note", test: (s) => s.includes("AD_REPLY_NOTE") },
    { label: "Facebook profile + attachment download", test: (s) => s.includes("fetchFacebookProfile") },
    { label: "Meta signature verification on POST", test: (s) => s.includes("verifyMetaSignature") },
  ],
  "WhatsApp": [
    { label: "Phone already known → ask address only", test: (s) => s.includes("WHATSAPP CHANNEL") },
    { label: "Emoji reaction on closing (no extra text)", test: (s) => s.includes("sendWhatsAppReaction") },
    { label: "Z-API instanceId authenticity check", test: (s) => s.includes("instanceId") },
    { label: "Optional shared-token webhook guard", test: (s) => s.includes("ZAPI_WEBHOOK_TOKEN") },
  ],
};

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(c.bold("\nOzziFloors — Platform Parity Check (Instagram vs Messenger vs WhatsApp)\n"));

let failures = 0;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));

console.log(c.bold(pad("SHARED BEHAVIOR (must be in all 3)", 52)) + "  IG   FB   WA");
console.log(c.dim("─".repeat(52) + "  ──   ──   ──"));
for (const check of SHARED) {
  const cells = CHANNELS.map((ch) => check.test(SRC[ch.name]));
  const allOk = cells.every(Boolean);
  if (!allOk) failures++;
  const mark = (ok: boolean) => (ok ? c.green(" ✓ ") : c.red(" ✗ "));
  console.log(`${allOk ? "" : c.red("")}${pad(check.label, 52)}  ${mark(cells[0])}  ${mark(cells[1])}  ${mark(cells[2])}`);
}

console.log(c.bold("\n\nINTENTIONAL per-platform features (informational)\n"));
for (const ch of CHANNELS) {
  console.log(c.cyan(`  ${ch.name}`));
  for (const check of PLATFORM_SPECIFIC[ch.name]) {
    const ok = check.test(SRC[ch.name]);
    console.log(`    ${ok ? c.green("✓") : c.yellow("•")} ${check.label}`);
  }
}

console.log("\n" + "─".repeat(70));
if (failures === 0) {
  console.log(c.bold(c.green(`PARITY OK — all ${SHARED.length} shared behaviors present in all 3 channels.`)));
  console.log(c.dim("WhatsApp responds with the same brain, flow, safety nets, and self-learning as Direct and Messenger."));
  console.log();
  process.exit(0);
} else {
  console.log(c.bold(c.red(`PARITY BROKEN — ${failures} shared behavior(s) missing in at least one channel (see ✗ above).`)));
  console.log();
  process.exit(1);
}
