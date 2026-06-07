import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import {
  getEasternDateContext,
  getRealAvailabilityContext,
  easternTodayStr,
} from "../lib/scheduler";

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

const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

async function main() {
  console.log("\n========================= LIVE DATE / SCHEDULE VERIFICATION =========================");

  // ── 1. Does the agent know the real current date (Eastern)? ──────────────
  console.log("\n[1] CURRENT DATE (Eastern, independent computation)");
  const todayStr = easternTodayStr();
  // Independent ground-truth via Intl in America/New_York
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric" }).formatToParts(new Date());
  const gtWeekday = parts.find(p => p.type === "weekday")!.value;
  const gtMonth = parts.find(p => p.type === "month")!.value;
  const gtDay = parts.find(p => p.type === "day")!.value;
  const gtYear = parts.find(p => p.type === "year")!.value;
  console.log(`   Ground truth (ET): ${gtWeekday}, ${gtMonth} ${gtDay}, ${gtYear} [${todayStr}]`);

  const ctx = getEasternDateContext();
  console.log(`   getEasternDateContext: ${ctx}`);
  const tM = ctx.match(/TODAY: (\w+), (\w+) (\d+), (\d+) \[(\d{4}-\d{2}-\d{2})\]/);
  ck("context TODAY date matches Eastern todayStr", !!tM && tM[5] === todayStr, ctx);
  ck("context weekday name is correct", !!tM && tM[1] === gtWeekday, `got ${tM?.[1]} want ${gtWeekday}`);
  ck("context month is correct", !!tM && tM[2] === gtMonth, `got ${tM?.[2]} want ${gtMonth}`);
  ck("context day-of-month is correct", !!tM && tM[3] === gtDay, `got ${tM?.[3]} want ${gtDay}`);
  // Verify the [YYYY-MM-DD] actually corresponds to the named weekday
  if (tM) {
    const d = new Date(tM[5] + "T12:00:00Z");
    ck("bracketed date's weekday == named weekday", DAYS[d.getUTCDay()] === tM[1], `${tM[5]} is ${DAYS[d.getUTCDay()]}, named ${tM[1]}`);
  }
  // TOMORROW consistency
  const mM = ctx.match(/TOMORROW: (\w+), (\w+) (\d+) \[(\d{4}-\d{2}-\d{2})\]/);
  if (tM && mM) {
    const dT = new Date(tM[5] + "T12:00:00Z");
    const dM = new Date(mM[4] + "T12:00:00Z");
    ck("TOMORROW = TODAY + 1 day", dM.getTime() - dT.getTime() === 86400000, `${tM[5]} -> ${mM[4]}`);
    ck("TOMORROW weekday label correct", DAYS[dM.getUTCDay()] === mM[1], `${mM[4]} is ${DAYS[dM.getUTCDay()]}, named ${mM[1]}`);
  }

  // ── 2. Real-time availability from the live scheduler DB ─────────────────
  console.log("\n[2] REAL-TIME AVAILABILITY (live scheduler DB)");
  const avail = await getRealAvailabilityContext();
  console.log(avail.split("\n").slice(0, 12).join("\n"));
  ck("availability fetched (not the error fallback)", !/Could not fetch real-time schedule/i.test(avail), avail.slice(0, 120));
  // Every weekday label in the schedule must match its own bracketed date
  const lines = avail.split("\n").filter(l => /^•/.test(l));
  let allLinesConsistent = true;
  const badLines: string[] = [];
  for (const l of lines) {
    const m = l.match(/•\s*(\w+),\s*(\w+)\s+(\d+),\s*(\d+)\s*\[(\d{4}-\d{2}-\d{2})\]/);
    if (m) {
      const d = new Date(m[5] + "T12:00:00Z");
      const weekdayOk = DAYS[d.getUTCDay()] === m[1];
      const monthOk = MONTHS[d.getUTCMonth()] === m[2];
      const dayOk = String(d.getUTCDate()) === m[3];
      if (!weekdayOk || !monthOk || !dayOk) { allLinesConsistent = false; badLines.push(l.trim()); }
    }
  }
  ck("every schedule line: weekday/month/day match its [YYYY-MM-DD]", allLinesConsistent, badLines.join(" || "));
  ck("first schedule line is today or later", lines.length === 0 || (() => {
    const m = lines[0].match(/\[(\d{4}-\d{2}-\d{2})\]/);
    return !!m && m[1] >= todayStr;
  })(), lines[0] ?? "no lines");
  // Window must span ~3 weeks so the bot can book next week and beyond.
  ck("schedule window spans ~21 days (covers future weeks)", lines.length >= 18, `only ${lines.length} day lines`);
  if (lines.length >= 8) {
    const lastM = lines[lines.length - 1].match(/\[(\d{4}-\d{2}-\d{2})\]/);
    const firstM = lines[0].match(/\[(\d{4}-\d{2}-\d{2})\]/);
    if (lastM && firstM) {
      const span = (new Date(lastM[1] + "T12:00:00Z").getTime() - new Date(firstM[1] + "T12:00:00Z").getTime()) / 86400000;
      ck("last listed date is ~20 days out (next-week booking possible)", span >= 14, `span ${span} days`);
    }
  }
  ck("guidance: never say can't see a future week's calendar", /never tell the client you cannot see/i.test(avail), avail.slice(-600));
  ck("guidance: never say a time was just taken", /never tell a client a time was 'just taken'/i.test(avail), avail.slice(-600));

  // ── 2c. Universal slot-conflict strip is wired in all three webhooks ─────
  console.log("\n[2c] Webhooks strip slot-conflict language universally (not only post-booking)");
  for (const [name, rel] of [["IG", "src/app/api/webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"]] as [string, string][]) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: strips slot-conflict unless a [BOOK] is present`, /if \(!\/\\\[BOOK:\/i\.test\([\s\S]{0,40}\)\) \{\s*[\s\S]{0,80}stripSlotConflictLanguage/.test(src), rel);
  }
  ck("prompt: reminder 24 (never say slot taken) present", /NEVER SAY A SLOT WAS TAKEN/.test(readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8")));
  ck("prompt: reminder 25 (can book future weeks) present", /CAN BOOK ANY LISTED DAY, INCLUDING FUTURE WEEKS/.test(readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8")));

  // ── 3. AI provides the CORRECT date when naming a weekday ────────────────
  console.log("\n[3] AI DATE INTEGRITY (weekday -> correct [YYYY-MM-DD] in [BOOK:...])");
  // Pick a real available line from the live schedule to drive the test
  const firstAvail = lines.find(l => !/fully booked/i.test(l));
  if (firstAvail) {
    const lm = firstAvail.match(/•\s*(\w+),\s*\w+\s+\d+,\s*\d+\s*\[(\d{4}-\d{2}-\d{2})\]:\s*(.+)$/);
    if (lm) {
      const weekday = lm[1];
      const dateStr = lm[2];
      const firstSlot = lm[3].split(",")[0].trim(); // e.g. "9am"
      console.log(`   Driving test with: ${weekday} ${dateStr} @ ${firstSlot}`);
      const sys = `[SYSTEM: ${getEasternDateContext()}\n\n${avail}\n\n[WHATSAPP CHANNEL: You already have the client's phone number (13055551234). Ask ONLY for the property address. Generate [BOOK:...] using "13055551234" as the phone.]]`;
      const conv: ChatMessage[] = [
        { role: "user", content: "whole house about 1500 sqft, need a visit" },
        { role: "assistant", content: `For that size I do a free in-person visit. I have ${weekday} at ${firstSlot} open, does that work?` },
        { role: "user", content: `yes ${weekday} at ${firstSlot} works` },
        { role: "assistant", content: "Perfect, what is the property address?" },
        { role: "user", content: `123 NW 5th St, Miami FL 33125${"\n\n" + sys}` },
      ];
      const out = await ai(conv);
      console.log("   AI:", out.replace(/\s+/g, " ").slice(0, 180));
      const bk = out.match(/\[BOOK:(\{[\s\S]*?\})\]/);
      ck("AI generated [BOOK:...] after slot+address confirmed", !!bk, out);
      ck(`[BOOK] uses the correct date ${dateStr} for ${weekday}`, !!bk && new RegExp(`"date"\\s*:\\s*"${dateStr}"`).test(bk[1]), bk?.[1] ?? out);
      // The booked date's weekday must equal the weekday the AI promised
      if (bk) {
        const dm = bk[1].match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
        if (dm) {
          const d = new Date(dm[1] + "T12:00:00Z");
          ck("booked date's weekday == promised weekday", DAYS[d.getUTCDay()] === weekday, `${dm[1]} is ${DAYS[d.getUTCDay()]}, promised ${weekday}`);
        }
      }
    }
  } else {
    console.log("   (no open slots in live schedule right now — skipping AI booking-date test)");
  }

  // ── 4. AI must NOT invent a date when asked availability with NO schedule ─
  console.log("\n[4] NO-INVENTED-SLOTS (no schedule in context)");
  const noSched = await ai([
    { role: "assistant", content: "Hello, our package is $5 per sqft. One area or the whole house?" },
    { role: "user", content: "whole house, what days do you have available this week?" },
  ]);
  console.log("   AI:", noSched.replace(/\s+/g, " ").slice(0, 160));
  ck("does not invent a specific weekday+time without schedule", !/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,15}\b\d{1,2}\s?(am|pm)\b/i.test(noSched), noSched);

  console.log(`\n============ DATE-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
