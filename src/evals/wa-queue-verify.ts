// Verifies the Z-API QUEUE WATCHDOG (no API calls) — the 2026-08-25 incident
// (Olimpia, wa_18138414465): the client tapped the ad at 18:46Z, the bot stored
// its reply at 18:47:54Z, Z-API answered 200 to send-text, and the phone showed
// NOTHING. Z-API's send worker had hung with 380 items in its queue (oldest
// 2026-08-23 00:32Z); it recovered on its own ~18:55Z. Every owner siren also
// travels through that same queue, so nobody was told for the whole window.
//
// What this pins:
//   1. the pure policy: what counts as "stuck", when a restart is allowed
//   2. the probe + restart helpers exist in whatsapp.ts and read the queue
//   3. the watchdog runs on ALL webhook traffic + both crons, throttled
//   4. /api/wa-diag exposes the queue so a human can see it too
// Run: npx tsx src/evals/wa-queue-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { judgeWaQueue, fmtAge, WA_QUEUE_STUCK_AFTER_MS, WA_QUEUE_BLIND_BACKLOG } from "../lib/wa-queue-policy";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");
const MIN = 60 * 1000;
const online = { probeOk: true, connected: true, smartphoneConnected: true };

function main() {
  console.log("\n===================== Z-API QUEUE WATCHDOG VERIFICATION (no API) =====================");

  console.log("\n[1] policy: what is 'stuck'");
  let v = judgeWaQueue({ ...online, count: 0, oldestAgeMs: null });
  ck("empty queue → healthy", !v.stuck && !v.restart, v.reason);
  v = judgeWaQueue({ ...online, count: 1, oldestAgeMs: 2 * 1000 });
  ck("1 item, 2s old (normal drain) → healthy", !v.stuck, v.reason);
  v = judgeWaQueue({ ...online, count: 15, oldestAgeMs: 4 * MIN });
  ck("15 items, oldest 4 min (busy burst: quote followups) → healthy", !v.stuck, v.reason);
  v = judgeWaQueue({ ...online, count: 1, oldestAgeMs: WA_QUEUE_STUCK_AFTER_MS });
  ck("1 item at the threshold age → STUCK + restart (Olimpia alone would have tripped it)", v.stuck && v.restart, v.reason);
  v = judgeWaQueue({ ...online, count: 380, oldestAgeMs: 2.5 * 24 * 60 * MIN });
  ck("the real 2026-08-25 snapshot (380, oldest 2.5 days) → STUCK + restart", v.stuck && v.restart, v.reason);
  ck("reason names the age in days", /2d|3d/.test(v.reason), v.reason);
  v = judgeWaQueue({ ...online, count: WA_QUEUE_BLIND_BACKLOG, oldestAgeMs: null });
  ck("items unreadable but big backlog → STUCK", v.stuck, v.reason);
  v = judgeWaQueue({ ...online, count: 3, oldestAgeMs: null });
  ck("items unreadable, tiny backlog → not stuck (no blind restarts)", !v.stuck, v.reason);
  v = judgeWaQueue({ ...online, smartphoneConnected: false, count: 40, oldestAgeMs: 60 * MIN });
  ck("phone OFFLINE → stuck but NO restart (owner must bring the phone online)", v.stuck && !v.restart, v.reason);
  ck("phone OFFLINE reason says so", /offline/i.test(v.reason), v.reason);
  v = judgeWaQueue({ ...online, connected: false, count: 40, oldestAgeMs: 60 * MIN });
  ck("instance not connected → stuck, no restart", v.stuck && !v.restart, v.reason);
  v = judgeWaQueue({ probeOk: false, connected: false, smartphoneConnected: false, count: 0, oldestAgeMs: null });
  ck("probe failed → cannot judge (never restart on a blind probe)", !v.stuck && !v.restart, v.reason);
  ck("fmtAge: minutes/hours/days", fmtAge(3 * MIN) === "3min" && fmtAge(90 * MIN) === "1h30" && fmtAge(3 * 24 * 60 * MIN) === "3d" && fmtAge(null) === "?", `${fmtAge(3 * MIN)} ${fmtAge(90 * MIN)} ${fmtAge(3 * 24 * 60 * MIN)}`);
  ck("threshold is 10 minutes (healthy drain is ~2s/msg; 10 min is unambiguous)", WA_QUEUE_STUCK_AFTER_MS === 10 * MIN);

  console.log("\n[2] whatsapp.ts: probe + restart helpers");
  const wa = read("src/lib/whatsapp.ts");
  ck("fetchWaQueueHealth exported", /export async function fetchWaQueueHealth\(\)/.test(wa));
  ck("probe reads status", /zapiGet\("status"\)/.test(wa));
  ck("probe reads queue/count", /zapiGet\("queue\/count"\)/.test(wa));
  ck("probe reads the oldest item via POST /queue (cursor API) with legacy GET fallback", /zapiGet\("queue", \{ method: "POST"/.test(wa) && /queue\?page=1&pageSize=30/.test(wa));
  ck("probe computes oldestAgeMs from Created/CreatedAt", /Created === "number"/.test(wa) && /Date\.parse\(i\.CreatedAt\)/.test(wa));
  ck("probeOk only after queue/count succeeded", /out\.count = c\.count;\s*out\.probeOk = true;/.test(wa));
  ck("restartWaInstance exported and POSTs /restart", /export async function restartWaInstance\(\)/.test(wa) && /zapiGet\("restart", \{ method: "POST"/.test(wa));

  console.log("\n[3] delivery.ts: watchdog wiring");
  const d = read("src/lib/delivery.ts");
  ck("watchWaQueue exported", /export async function watchWaQueue\(\)/.test(d));
  ck("throttled: one probe / 5 min via the window claim", /shouldAlert\("waqueue", "probe", WA_QUEUE_PROBE_EVERY_MS\)/.test(d) && /WA_QUEUE_PROBE_EVERY_MS = 5 \* 60 \* 1000/.test(d));
  ck("uses the pure policy (judgeWaQueue)", /judgeWaQueue\(h\)/.test(d));
  ck("restart gated by verdict.restart AND once per hour", /if \(v\.restart\) \{\s*if \(await shouldAlert\("waqueue", "restart", WA_QUEUE_RESTART_EVERY_MS\)\)/.test(d) && /WA_QUEUE_RESTART_EVERY_MS = 60 \* 60 \* 1000/.test(d));
  ck("owner alert once per hour, to both owner phones", /shouldAlert\("waqueue", "alert", WA_QUEUE_RESTART_EVERY_MS\)/.test(d) && /OWNER_PHONES\.map\(\(p\) => sendWhatsAppMessage\(p, msg\)\)/.test(d));
  ck("alert explains the phone-offline case", /OFFLINE na Z-API/.test(d));
  ck("alert tells the owner to answer WhatsApp manually meanwhile", /responda os clientes do WhatsApp pelo celular/.test(d));
  ck("watchdog never throws (try/catch)", /\[WAQUEUE\] watchdog error/.test(d));
  ck("skips silently without Z-API credentials (evals/local)", /if \(!process\.env\.ZAPI_INSTANCE_ID \|\| !process\.env\.ZAPI_TOKEN\) return;/.test(d));

  console.log("\n[4] every heartbeat runs the watchdog");
  for (const [label, rel, viaWaitUntil] of [
    ["WhatsApp webhook", "src/app/api/wa-webhook/route.ts", true],
    ["Messenger webhook", "src/app/api/fb-webhook/route.ts", true],
    ["Instagram webhook", "src/app/api/webhook/route.ts", true],
    ["followup cron", "src/app/api/followup/route.ts", false],
    ["dream cron", "src/app/api/dream/route.ts", false],
  ] as const) {
    const src = read(rel);
    ck(`${label}: imports watchWaQueue from delivery`, /import \{[^}]*watchWaQueue[^}]*\} from "@\/lib\/delivery"/.test(src), rel);
    ck(`${label}: calls it next to retryFailedSends`, viaWaitUntil
      ? /waitUntil\(retryFailedSends\(\)\);[\s\S]{0,400}waitUntil\(watchWaQueue\(\)\);/.test(src)
      : /await retryFailedSends\(\);\s*await watchWaQueue\(\);/.test(src), rel);
  }

  console.log("\n[5] /api/wa-diag shows the queue");
  const diag = read("src/app/api/wa-diag/route.ts");
  ck("wa-diag reads the queue", /const queue = await fetchWaQueueHealth\(\);/.test(diag));
  ck("wa-diag returns queue + verdict", /queue: queue,/.test(diag) && /queueVerdict: judgeWaQueue\(queue\)/.test(diag));

  console.log(`\n${"=".repeat(60)}\nPASS ${pass} · FAIL ${fail}`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}

main();
