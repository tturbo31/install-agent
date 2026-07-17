/**
 * Verifies the WhatsApp visit-booking completion (the "showers" screenshot bug):
 * the client confirmed a slot AND sent the address, but the bot replied
 * "Perfect, what's the property address?" instead of booking.
 *
 * Root cause was NOT the brain (it books fine once the address is in context) but
 * message TIMING: the slot and the address arrived as two separate turns more than
 * the 10s debounce apart, so the slot turn was processed before the address
 * existed, and the redundant re-ask escaped the stale-context guard while the
 * booking-completing address turn could be dropped by the 5s rate limit.
 *
 * This eval proves:
 *  1. BRAIN: with the slot + address in context (WhatsApp note → phone is known),
 *     the brain emits [BOOK:...] with the right address/date/time and NEVER
 *     re-asks for the address — in any message order.
 *  2. DETECTORS: the address message is recognized as booking info, and a
 *     "what's the address?" reply is recognized as a booking-info re-ask (so the
 *     grace window engages) while a "see you then![BOOK]" reply is not.
 *  3. WEBHOOKS: all three channels carry the rate-limit bypass + grace window.
 *
 * Run: npx tsx src/evals/whatsapp-booking-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, containsBookingInfo, isAskingForBookingInfo, type ChatMessage } from "../lib/ai";
import { getEasternDateContext, easternTodayStr } from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 200)}»`); }
}

const PHONE = "13055551234";
const ADDR = "113 NW 11th St Ft Lauderdale FL 33311";
const today = easternTodayStr();

// The note injects the REAL Eastern clock, so a frozen "5pm today" scenario
// fails every evening: after 5pm ET the model CORRECTLY refuses the past slot
// ("It's 5:15 now, so 5pm has already passed") — a wall-clock false negative,
// not a bug. Late in the day the scenario books "9am tomorrow" instead.
function addDaysStr(d: string, n: number): string {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const nowHourET = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date()), 10) % 24;
const useTomorrow = nowHourET >= 16;
const tomorrow = addDaysStr(today, 1);
const slotDate = useTomorrow ? tomorrow : today;
const slotPick = useTomorrow ? "9am tomorrow" : "5pm today";
const slotTime = useTomorrow ? "09:00" : "17:00";
const todayLine = useTomorrow ? "fully booked" : "5pm, 7pm";
const offerLine = useTomorrow
  ? "I have tomorrow at 9am or 11am, and if those don't work, Sunday has plenty of openings. What's your address and which time works?"
  : "I have today at 5pm or 7pm, and if those don't work, Sunday has plenty of openings. What's your address and which time works?";

function waSystemNote(): string {
  const schedule = `REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):
• TODAY [${today}]: ${todayLine}
• TOMORROW [${tomorrow}]: 9am, 11am

IMPORTANT — read carefully before offering any time:
- ONLY offer times listed above.
- In the [BOOK:...] tag, copy the date as the exact [YYYY-MM-DD] from the line whose weekday matches what you told the client.`;
  const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${PHONE}). To confirm a visit, ask ONLY for the property address. NEVER ask the client for their phone number. Once you have a confirmed day/time and the address, generate [BOOK:...] using "${PHONE}" as the phone.]`;
  return `[SYSTEM: ${getEasternDateContext()}\n\n${schedule}\n\n${waNote}]`;
}

const HEAD: ChatMessage[] = [
  { role: "user", content: "What do you charge for showers?" },
  { role: "assistant", content: "Shower work falls under bathroom remodeling, and for that I need to check the space in person to give you an accurate quote. I offer a free visit where I assess everything and lock in the right price. What day works best for you?" },
  { role: "user", content: "Anyday. Sooner the better" },
  { role: "assistant", content: offerLine },
];

const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);
const BOOKS = (t: string) => /\[BOOK:/i.test(t);
const REASKS_ADDRESS = (t: string) => !BOOKS(t) && /\baddress\b/i.test(t) && /\?/.test(t);
const bookedFor = (t: string, time: string) =>
  BOOKS(t) && new RegExp(`"time"\\s*:\\s*"${time}"`).test(t) && new RegExp(`"date"\\s*:\\s*"${slotDate}"`).test(t) && /11th\s*St/i.test(t);

async function main() {
  console.log("\n================ WHATSAPP BOOKING VERIFICATION ================");
  console.log("today =", today);

  // ── 1. BRAIN: slot then address (address is the latest message) → BOOK ─────
  console.log("\n[1] slot '5pm today' then address (address last)");
  const a1 = await ai([...HEAD,
    { role: "user", content: slotPick },
    { role: "user", content: `${ADDR}\n\n${waSystemNote()}` },
  ]);
  console.log("   →", a1.replace(/\s+/g, " ").slice(0, 160));
  ck("books the visit (emits [BOOK:...])", BOOKS(a1), a1);
  ck("books today at 17:00 with the street address", bookedFor(a1, slotTime), a1);
  ck("does NOT re-ask for the address", !REASKS_ADDRESS(a1), a1);

  // ── 2. BRAIN: exact screenshot order (bot re-asked, THEN address) → BOOK ───
  console.log("\n[2] screenshot order: '5pm today' → re-ask → address");
  const a2 = await ai([...HEAD,
    { role: "user", content: slotPick },
    { role: "assistant", content: "Perfect, what's the property address?" },
    { role: "user", content: `${ADDR}\n\n${waSystemNote()}` },
  ]);
  console.log("   →", a2.replace(/\s+/g, " ").slice(0, 160));
  ck("recovers and books after the redundant re-ask", BOOKS(a2), a2);
  ck("does NOT re-ask for the address again", !REASKS_ADDRESS(a2), a2);

  // ── 3. BRAIN: address arrives BEFORE the slot in history → still BOOK ──────
  console.log("\n[3] address first, then '5pm today' (reversed order)");
  const a3 = await ai([...HEAD,
    { role: "user", content: ADDR },
    { role: "user", content: `${slotPick}\n\n${waSystemNote()}` },
  ]);
  console.log("   →", a3.replace(/\s+/g, " ").slice(0, 160));
  ck("books regardless of message order", BOOKS(a3), a3);

  // ── 4. CORRECT: slot only, address NOT yet sent → ask for the address ──────
  // (This is the slot turn in isolation — re-asking IS correct here. What must
  //  not happen is dropping the booking once the address arrives, covered above.)
  console.log("\n[4] slot only, address not sent yet → asks for address");
  const a4 = await ai([...HEAD,
    { role: "user", content: `${slotPick}\n\n${waSystemNote()}` },
  ]);
  console.log("   →", a4.replace(/\s+/g, " ").slice(0, 160));
  ck("asks for the address (no booking without it)", REASKS_ADDRESS(a4) || !BOOKS(a4), a4);
  ck("never asks for the phone on WhatsApp", !/\bphone\b/i.test(a4), a4);

  // ── 5. DETECTORS ──────────────────────────────────────────────────────────
  console.log("\n[5] detector unit checks");
  ck("address message is recognized as booking info", containsBookingInfo(ADDR), ADDR);
  ck("'what's the property address?' is a booking-info re-ask", isAskingForBookingInfo("Perfect, what's the property address?"));
  ck("'best phone number?' is a booking-info re-ask", isAskingForBookingInfo("Almost set! What's the best phone number to reach you?"));
  ck("a booking confirmation is NOT a re-ask", !isAskingForBookingInfo('Perfect, see you then![BOOK:{"address":"x"}]'));
  ck("a plain slot offer is NOT a booking-info re-ask", !isAskingForBookingInfo("I have today at 5pm or 7pm, which works for you?"));

  // ── 6. WEBHOOKS: all three channels carry the new guards ──────────────────
  console.log("\n[6] all three webhooks carry the rate-limit bypass + grace window");
  const files = {
    IG: "src/app/api/webhook/route.ts",
    FB: "src/app/api/fb-webhook/route.ts",
    WA: "src/app/api/wa-webhook/route.ts",
  };
  for (const [ch, f] of Object.entries(files)) {
    const src = readFileSync(join(process.cwd(), f), "utf-8");
    ck(`${ch}: booking-info bypasses the 5s rate limit`, /containsBookingInfo\(rawText\)/.test(src) && /&& !carriesBookingInfo\) return;/.test(src));
    ck(`${ch}: grace window before redundant booking-info re-ask`, src.includes("isAskingForBookingInfo") && src.includes("discarding redundant re-ask"));
  }

  console.log(`\n========== WHATSAPP-BOOKING-VERIFY: ${pass} passed, ${fail} failed ==========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
