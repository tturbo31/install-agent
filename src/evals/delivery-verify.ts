// Verifies the DELIVERY hardening (no API calls) — the 2026-07-22 incident:
// the prod Instagram token expired at 2026-07-21 12:35 PDT and for 19 hours
// every IG reply "succeeded" in the DB/dashboard while the client received
// NOTHING (sendInstagramMessage never looked at the Graph error, and the reply
// was stored unconditionally, which also armed the duplicate/history guards
// against any re-send). These checks pin every layer of the fix:
//   1. send functions verify the API result (+ retry, + owner alert on failure)
//   2. webhooks store a reply ONLY after a confirmed delivery
//   3. IG token lives in the DB, is auto-refreshed by both daily crons, and is
//      swappable at runtime via /api/ig-diag?settoken= (no deploy)
//   4. sends fall back to the Messenger bridge when the IG token is dead
//   5. paused (mode=human) conversations with a stale backlog alert the owner
// Run: npx tsx src/evals/delivery-verify.ts
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

function main() {
  console.log("\n===================== DELIVERY / TOKEN HARDENING VERIFICATION (no API) =====================");

  // ── 1. Send functions actually verify the platform's answer ──────────────
  console.log("\n[1] send functions check the API result");
  const ig = read("src/lib/instagram.ts");
  ck("IG send returns a structured result", /IgSendResult/.test(ig) && /ok: true, via: "instagram"/.test(ig), "IgSendResult shape");
  ck("IG send inspects body.error", /body\.error/.test(ig));
  ck("IG send retries once", /attempt <= 2/.test(ig));
  ck("IG send alerts the owner on definitive failure", /reportSendFailure\("instagram"/.test(ig));
  ck("IG send falls back to the Messenger bridge", /messenger-bridge/.test(ig) && /graph\.facebook\.com\/v24\.0\/me\/messages/.test(ig));
  ck("IG send reads the token from the DB resolver (not raw env)", /getInstagramToken\(\)/.test(ig) && !/process\.env\.INSTAGRAM_ACCESS_TOKEN/.test(ig));

  const fb = read("src/lib/facebook.ts");
  ck("FB send returns a structured result", /FbSendResult/.test(fb));
  ck("FB send inspects body.error", /body\.error/.test(fb));
  ck("FB send alerts the owner on definitive failure", /reportSendFailure\("facebook"/.test(fb));

  const wa = read("src/lib/whatsapp.ts");
  ck("WA send returns {ok,...} (pre-existing)", /WaSendResult/.test(wa));

  // ── 2. Webhooks only store a reply after confirmed delivery ───────────────
  console.log("\n[2] webhooks: no phantom replies in the DB");
  for (const [label, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
  ] as const) {
    const src = read(rel);
    ck(`${label}: main send checked before storing`, /const mainSent = await send\w+Message\(/.test(src) && /if \(!mainSent\.ok\)/.test(src), rel);
    ck(`${label}: failed main send aborts BEFORE the insert`, /if \(!mainSent\.ok\) \{[\s\S]*?return;[\s\S]*?\}/.test(src), rel);
    ck(`${label}: paused-convo backlog alerts the owner`, /alertPausedBacklog\(\{/.test(src), rel);
  }
  const igSrc = read("src/app/api/webhook/route.ts");
  ck("IG: re-tap nudge stored only when delivered", /const nudgeSent = await sendInstagramMessage\(senderIgsid, retapNudge\);\s*if \(nudgeSent\.ok\)/.test(igSrc));
  ck("IG: visit details stored only when delivered", /const detailsSent = await sendInstagramMessage\(senderIgsid, details\);\s*if \(detailsSent\.ok\)/.test(igSrc));
  const fbSrc = read("src/app/api/fb-webhook/route.ts");
  ck("FB: re-tap nudge stored only when delivered", /const nudgeSent = await sendFacebookMessage\(psid, retapNudge\);\s*if \(nudgeSent\.ok\)/.test(fbSrc));

  // ── 3. Token: DB-first, refreshable, hot-swappable ───────────────────────
  console.log("\n[3] IG token lifecycle");
  const tok = read("src/lib/ig-token.ts");
  ck("token resolver falls back to env when DB empty", /INSTAGRAM_ACCESS_TOKEN \?\? ""/.test(tok));
  ck("refresh uses ig_refresh_token grant", /refresh_access_token/.test(tok) && /ig_refresh_token/.test(tok));
  ck("refresh is due after 24h", /REFRESH_AFTER_H = 24/.test(tok));
  ck("dream cron piggybacks the refresh", /refreshInstagramTokenIfDue/.test(read("src/app/api/dream/route.ts")));
  ck("followup cron piggybacks the refresh", /refreshInstagramTokenIfDue/.test(read("src/app/api/followup/route.ts")));
  const diag = read("src/app/api/ig-diag/route.ts");
  ck("ig-diag validates a new token before storing", /checkIgToken\(newToken\)/.test(diag) && /setInstagramToken\(newToken\)/.test(diag));
  ck("ig-diag settoken/rescue require the STRONG secret", /isStrongAdminSecret\(secret\)/.test(diag));
  ck("ig-diag rescue dedupes via igrescue marker", /igrescue\|/.test(diag));
  ck("ig-diag rescue skips owner-takeover convos", /mode === "human"/.test(diag));

  // 2026-08-03: one Facebook password change invalidated BOTH tokens (OAuth 190
  // subcode 460). IG recovered in minutes via settoken; Messenger was env-only,
  // so it needed a Vercel edit + redeploy. The page token now has the same
  // DB-first storage and the same no-deploy swap.
  const fbTok = read("src/lib/fb-token.ts");
  ck("FB page token resolver is DB-first with env fallback", /fbtok\|/.test(fbTok) && /FACEBOOK_PAGE_TOKEN \?\? ""/.test(fbTok));
  ck("FB page token setter keeps only the newest row", /setFacebookPageToken/.test(fbTok) && /rows\.slice\(1\)/.test(fbTok));
  ck("FB send reads the token from the DB resolver (not raw env)", /getFacebookPageToken/.test(fb) && !/process\.env\.FACEBOOK_PAGE_TOKEN/.test(fb));
  ck("IG→Messenger bridge uses the DB resolver too", /getFacebookPageToken/.test(ig) && !/process\.env\.FACEBOOK_PAGE_TOKEN/.test(ig));
  ck("ig-diag validates a new PAGE token before storing", /checkFbToken\(newFbToken\)/.test(diag) && /setFacebookPageToken\(newFbToken\)/.test(diag));
  ck("ig-diag reports the effective page-token source", /effectiveSource/.test(diag) && /readStoredPageToken/.test(diag));

  // ── 4. Failure alert: loud, actionable, throttled ────────────────────────
  console.log("\n[4] owner alert on send failure");
  const del = read("src/lib/delivery.ts");
  ck("alert throttled (1/hour/channel)", /ALERT_EVERY_MS = 60 \* 60 \* 1000/.test(del));
  ck("alert names the channel + tells owner to reply manually", /ENTREGA FALHANDO/.test(del) && /responda os clientes manualmente/.test(del));
  ck("IG token alert points to settoken (fix without deploy)", /settoken/.test(del));
  ck("FB token alert points to setfbtoken (fix without deploy)", /setfbtoken/.test(del));
  ck("alert goes to both owner phones via WhatsApp", /OWNER_PHONES = \["15616748334", "556294554477"\]/.test(del));
  ck("paused-backlog alert exists + 1h staleness gate", /alertPausedBacklog/.test(del) && /PAUSED_STALE_MS = 60 \* 60 \* 1000/.test(del));

  // ── 5. Panel manual send + follow-up sweep can't lie either ──────────────
  console.log("\n[5] other senders");
  const manual = read("src/app/api/conversations/[id]/send/route.ts");
  ck("manual panel send: IG failure returns 500 (nothing stored)", /!igResult\.ok/.test(manual));
  ck("manual panel send: FB failure returns 500 (nothing stored)", /!fbResult\.ok/.test(manual));
  ck("manual panel send: WA failure returns 500 (nothing stored)", /!waResult\.ok/.test(manual));
  const fup = read("src/lib/followup.ts");
  ck("follow-up sweep checks FB + IG send results", /sendFacebookMessage\(conv\.igsid\.slice\(3\), text\);\s*if \(!r\.ok\)/.test(fup) && /sendInstagramMessage\(conv\.igsid, text\);\s*if \(!r\.ok\)/.test(fup));

  // ── 6. Auto-retry outbox (2026-07-22 14:38 UTC transient Messenger blip) ──
  console.log("\n[6] auto-retry outbox for failed sends");
  const obt = read("src/lib/outbound-text.ts");
  ck("SEND_FAILED marker is stripped from ANY outbound text", /SEND_FAILED/.test(obt) && /\|SEND_FAILED\)/.test(obt));
  ck("SEND_FAILED_DB_SUFFIX exported", /export const SEND_FAILED_DB_SUFFIX = "\\n\\n\[SYSTEM: SEND_FAILED\]"/.test(obt));
  ck("retry sweep exists with 10-min throttle + 48h window", /retryFailedSends/.test(del) && /RETRY_SWEEP_GAP_MS = 10 \* 60 \* 1000/.test(del) && /RETRY_WINDOW_H = 48/.test(del));
  ck("retry drops the queued reply when client wrote again / owner took over", /newerUser\?\.length \|\| conv\.mode === "human"/.test(del));
  ck("retry clears the marker only after a confirmed delivery", /if \(r\.ok\) \{[\s\S]*?update\(\{ content: text \}\)/.test(del));
  ck("per-recipient errors get calm alert, not the channel siren", /PER_RECIPIENT_CODES/.test(del) && /inalcancavel/.test(del));
  for (const [label, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
  ] as const) {
    const src = read(rel);
    ck(`${label}: failed main send queued with SEND_FAILED_DB_SUFFIX`, /content: finalResponse \+ SEND_FAILED_DB_SUFFIX/.test(src), rel);
    ck(`${label}: webhook POST triggers the retry sweep`, /waitUntil\(retryFailedSends\(\)\)/.test(src), rel);
  }
  ck("dream cron sweeps the outbox", /retryFailedSends\(\)/.test(read("src/app/api/dream/route.ts")));
  ck("followup cron sweeps the outbox", /retryFailedSends\(\)/.test(read("src/app/api/followup/route.ts")));
  ck("retry gives up permanently on per-recipient errors (551 etc.)",
    /PER_RECIPIENT_CODES\.has\(code\)[\s\S]{0,200}?delete\(\)/.test(del) && /giving up permanently/.test(del));
  ck("repeated identical question never gets silence (rule 35)",
    /REPEATED IDENTICAL QUESTION RULE/.test(read("src/lib/ai.ts")));

  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail > 0) {
    console.log("FAILED:", fails.join(" | "));
    process.exit(1);
  }
}

main();
