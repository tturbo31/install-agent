// Verifies the lost-INBOUND net (no API calls) — Tony Martinez, Messenger
// 2026-09-12 11:30 UTC: Meta never POSTed the client's bubble to the webhook
// (raw capture proves it, IG kept receiving), so the bot never saw it. Pins:
//   1. the pure policy (lost-inbound-policy.ts): trailing client run, age
//      window, stickers/emoji never count, order oldest-first, per-sweep cap
//   2. the Meta-shaped repost body (same shape the live webhook receives)
//   3. delivery.ts wiring: throttle, claim before repost, failed read = skip,
//      release on failed repost, signature header, paused-mode wording
//   4. all three webhooks call the sweep next to recoverLostReplies
// Run: npx tsx src/evals/lost-inbound-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import {
  LOST_INBOUND_MAX_PER_SWEEP,
  LOST_INBOUND_MIN_AGE_MS,
  LOST_INBOUND_MAX_AGE_MS,
  buildMessengerWebhookBody,
  isReplayableBubble,
  pickLostInbounds,
  toThreadSnapshot,
  trailingClientRun,
  type ThreadBubble,
  type ThreadSnapshot,
} from "../lib/lost-inbound-policy";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 160)}»`); }
}
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8");

const PAGE = "109621555056803";
const TONY = "28332396826410353";
const NOW = Date.parse("2026-09-12T11:40:00Z");
const at = (iso: string) => iso;
function bubble(p: Partial<ThreadBubble> & { id: string; created_time: string; fromId: string }): ThreadBubble {
  return { text: "", imageUrls: [], hasOtherAttachment: false, ...p };
}
// Tony's real thread at 11:40 UTC, newest first.
function tonyThread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    clientId: TONY,
    clientName: "Tony Martinez",
    bubbles: [
      bubble({ id: "m_lost", created_time: at("2026-09-12T11:30:03+0000"), fromId: TONY, text: "Probably Monday . I’ll be coming off shift I’m a firefighter in Hollywood , but more like 9:30 if that’s ok ? Or later if you can ?" }),
      bubble({ id: "m_bot2", created_time: at("2026-09-12T11:27:24+0000"), fromId: PAGE, text: "No worries at all on the combo ... which works better?" }),
      bubble({ id: "m_c2", created_time: at("2026-09-12T11:27:00+0000"), fromId: TONY, text: "Not sure just yes tile or vinyl maybe a combo of both" }),
      bubble({ id: "m_bot1", created_time: at("2026-09-12T11:26:29+0000"), fromId: PAGE, text: "Hi, we work with luxury vinyl..." }),
    ],
    ...overrides,
  };
}
const STORED = new Set(["m_c2", "m_c1"]);

function main() {
  console.log("\n===================== LOST-INBOUND NET VERIFICATION (no API) =====================");

  console.log("\n[1] pure policy — Tony's case");
  const picked = pickLostInbounds([tonyThread()], STORED, NOW);
  ck("Tony's undelivered bubble is picked", picked.length === 1 && picked[0].missing.length === 1 && picked[0].missing[0].id === "m_lost", JSON.stringify(picked));
  ck("client id/name carried for the repost + owner alert", picked[0]?.clientId === TONY && picked[0]?.clientName === "Tony Martinez");
  ck("trailing run stops at the page's last message", trailingClientRun(tonyThread()).map((b) => b.id).join(",") === "m_lost");
  ck("stored bubble (webhook delivered it) is never picked", pickLostInbounds([tonyThread()], new Set(["m_lost", "m_c2"]), NOW).length === 0);
  ck("page spoke last (bot OR owner from the Page Inbox) → nothing to do",
    pickLostInbounds([tonyThread({ bubbles: [bubble({ id: "m_owner", created_time: at("2026-09-12T12:32:25+0000"), fromId: PAGE, text: "Tony, the 9:30 appointment..." }), ...tonyThread().bubbles] })], STORED, Date.parse("2026-09-12T12:40:00Z")).length === 0);
  ck("too fresh (live webhook may still be on it) → wait", pickLostInbounds([tonyThread()], STORED, Date.parse("2026-09-12T11:30:03Z") + LOST_INBOUND_MIN_AGE_MS - 1000).length === 0);
  ck("exactly at the minimum age → picked", pickLostInbounds([tonyThread()], STORED, Date.parse("2026-09-12T11:30:03Z") + LOST_INBOUND_MIN_AGE_MS).length === 1);
  ck("stale (older than the max age) → never replayed", pickLostInbounds([tonyThread()], STORED, Date.parse("2026-09-12T11:30:03Z") + LOST_INBOUND_MAX_AGE_MS + 1000).length === 0);

  console.log("\n[2] pure policy — what the handler drops on purpose is never 'lost'");
  ck("thumbs-up sticker (empty text, no attachment) is not replayable", !isReplayableBubble(bubble({ id: "s", created_time: "x", fromId: TONY })));
  ck("emoji-only bubble is not replayable", !isReplayableBubble(bubble({ id: "e", created_time: "x", fromId: TONY, text: "👍" })) && !isReplayableBubble(bubble({ id: "e2", created_time: "x", fromId: TONY, text: "😊 🙏" })));
  ck("text bubble is replayable", isReplayableBubble(bubble({ id: "t", created_time: "x", fromId: TONY, text: "ok" })));
  ck("photo-only bubble is replayable (the handler stores it as a photo)", isReplayableBubble(bubble({ id: "p", created_time: "x", fromId: TONY, imageUrls: ["https://x/y.jpg"] })));
  const stickerRun = tonyThread({ bubbles: [bubble({ id: "m_stk", created_time: at("2026-09-12T11:31:00+0000"), fromId: TONY }), ...tonyThread().bubbles] });
  const pickedStk = pickLostInbounds([stickerRun], STORED, NOW);
  ck("sticker on top of a lost text bubble: only the text is reposted", pickedStk.length === 1 && pickedStk[0].missing.map((b) => b.id).join(",") === "m_lost", JSON.stringify(pickedStk));
  ck("thread with only a sticker after the bot → nothing",
    pickLostInbounds([tonyThread({ bubbles: [bubble({ id: "m_stk", created_time: at("2026-09-12T11:31:00+0000"), fromId: TONY }), ...tonyThread().bubbles.slice(1)] })], STORED, NOW).length === 0);

  console.log("\n[3] pure policy — bursts, order and cap");
  const burst = tonyThread({ bubbles: [
    bubble({ id: "m_lost2", created_time: at("2026-09-12T11:30:40+0000"), fromId: TONY, text: "Or later if you can?" }),
    bubble({ id: "m_lost", created_time: at("2026-09-12T11:30:03+0000"), fromId: TONY, text: "Probably Monday, more like 9:30" }),
    ...tonyThread().bubbles.slice(1),
  ] });
  const pb = pickLostInbounds([burst], STORED, NOW);
  ck("two lost bubbles are reposted OLDEST first (debounce sees one burst)", pb[0]?.missing.map((b) => b.id).join(",") === "m_lost,m_lost2", JSON.stringify(pb));
  const half = pickLostInbounds([burst], new Set(["m_lost", "m_c2"]), NOW);
  ck("only the unstored part of the run is reposted", half[0]?.missing.map((b) => b.id).join(",") === "m_lost2", JSON.stringify(half));
  const many = Array.from({ length: LOST_INBOUND_MAX_PER_SWEEP + 3 }, (_, i) => tonyThread({ clientId: `c${i}`, bubbles: [bubble({ id: `m${i}`, created_time: at("2026-09-12T11:30:03+0000"), fromId: `c${i}`, text: "hi" })] }));
  ck(`per-sweep cap of ${LOST_INBOUND_MAX_PER_SWEEP} threads`, pickLostInbounds(many, new Set(), NOW).length === LOST_INBOUND_MAX_PER_SWEEP);
  ck("empty stored set with a real read still picks (the caller guards failed reads)", pickLostInbounds([tonyThread()], new Set(), NOW).length === 1);

  console.log("\n[4] Graph → snapshot and the Meta-shaped repost body");
  const snap = toThreadSnapshot({
    updated_time: "2026-09-12T11:30:03+0000",
    participants: { data: [{ id: TONY, name: "Tony Martinez" }, { id: PAGE, name: "Ozzi floors" }] },
    messages: { data: [
      { id: "m_lost", created_time: "2026-09-12T11:30:03+0000", from: { id: TONY }, message: "Probably Monday" },
      { id: "m_stk", created_time: "2026-09-12T11:29:00+0000", from: { id: TONY }, message: "", sticker: "https://scontent/sticker.png", attachments: { data: [{ mime_type: "image/png", image_data: { url: "https://scontent/sticker.png" } }] } },
      { id: "m_photo", created_time: "2026-09-12T11:28:00+0000", from: { id: TONY }, message: "", attachments: { data: [{ mime_type: "image/jpeg", image_data: { url: "https://scontent/floor.jpg" } }] } },
      { id: "m_bot", created_time: "2026-09-12T11:27:24+0000", from: { id: PAGE }, message: "No worries" },
    ] },
  }, PAGE)!;
  ck("client participant is the non-page one", snap.clientId === TONY && snap.clientName === "Tony Martinez");
  ck("sticker bubble carries no attachments (never replayable)", !isReplayableBubble(snap.bubbles[1]) && snap.bubbles[1].imageUrls.length === 0);
  ck("photo bubble keeps its image url", snap.bubbles[2].imageUrls[0] === "https://scontent/floor.jpg" && isReplayableBubble(snap.bubbles[2]));
  ck("page-only participants → null", toThreadSnapshot({ participants: { data: [{ id: PAGE }] } }, PAGE) === null);
  const body = buildMessengerWebhookBody(PAGE, TONY, snap.bubbles[0]) as { object: string; entry: Array<{ id: string; time: number; messaging: Array<{ sender: { id: string }; recipient: { id: string }; timestamp: number; message: { mid: string; text?: string; attachments?: unknown[] } }> }> };
  const m0 = body.entry[0].messaging[0];
  ck("body is object=page with entry[0].messaging[0]", body.object === "page" && body.entry.length === 1 && body.entry[0].id === PAGE && body.entry[0].messaging.length === 1);
  ck("sender = client, recipient = page (the handler's psid check)", m0.sender.id === TONY && m0.recipient.id === PAGE);
  ck("mid = the real Meta message id (dedupe key if Meta delivers late)", m0.message.mid === "m_lost");
  ck("text carried verbatim", m0.message.text === "Probably Monday");
  ck("timestamp in ms from created_time", m0.timestamp === Date.parse("2026-09-12T11:30:03+0000") && m0.timestamp > 1e12);
  const pbody = buildMessengerWebhookBody(PAGE, TONY, snap.bubbles[2]) as typeof body;
  const pm = pbody.entry[0].messaging[0].message as { text?: string; attachments?: Array<{ type: string; payload: { url?: string } }> };
  ck("photo bubble → attachments[{type:image,payload:{url}}] and no text", pm.text === undefined && pm.attachments?.[0]?.type === "image" && pm.attachments?.[0]?.payload.url === "https://scontent/floor.jpg");

  console.log("\n[5] delivery.ts: sweep wiring");
  const d = read("src/lib/delivery.ts");
  ck("recoverLostInbounds exported", /export async function recoverLostInbounds\(\)/.test(d));
  ck("self-throttled through the shared window claim (1 sweep / 5 min)", /shouldAlert\("lostinbound", "sweep", LOST_INBOUND_SWEEP_GAP_MS\)/.test(d));
  ck("one Graph call: me/conversations?platform=messenger with the page token resolver",
    /me\/conversations\?platform=messenger[\s\S]{0,200}?LOST_INBOUND_SCAN_LIMIT/.test(d) && /getFacebookPageToken\(\)[\s\S]{0,2000}?platform=messenger/.test(d));
  ck("thread list fetches the last bubbles with sticker + attachments", /messages\.limit\(4\)\{id,created_time,from,message,sticker,attachments\{mime_type,image_data,file_url\}\}/.test(d));
  ck("stored ids looked up by instagram_msg_id in one query", /\.select\("instagram_msg_id"\)\s*\.in\("instagram_msg_id", ids\)/.test(d));
  ck("a FAILED stored-id read skips the sweep (never 'nothing stored')",
    /const \{ data: stored, error \} = await supabaseAdmin[\s\S]{0,300}?if \(error\) \{[\s\S]{0,200}?return;/.test(d));
  ck("selection is the pure policy", /pickLostInbounds\(threads, storedIds, now\)/.test(d));
  ck("claims the bubble BEFORE reposting (an earlier sweep may own it)", /if \(!\(await claimLostInbound\(b\.id\)\)\) continue;[\s\S]{0,120}?repostMessengerBubble\(l\.clientId, b\)/.test(d));
  ck("claim is an INSERT on the unique platform column", /claimLostInbound[\s\S]{0,300}?insert\(\{ platform: `lostinbound\|\$\{mid\}`/.test(d));
  ck("failed repost releases the claim so the next sweep retries", /failed\+\+;\s*await releaseLostInbound\(b\.id\);/.test(d));
  ck("repost goes to our own /api/fb-webhook with the replay header", /fetch\(base \+ "\/api\/fb-webhook", \{ method: "POST", headers, body: raw \}\)/.test(d) && /"x-ozzi-replay": process\.env\.ADMIN_SECRET \|\| LEGACY_ADMIN_SECRET/.test(d));
  ck("repost is signed with the app secret when configured", /repostMessengerBubble[\s\S]{0,900}?x-hub-signature-256[\s\S]{0,80}?createHmac\("sha256", appSecret\)/.test(d));
  ck("repost body comes from the pure builder", /buildMessengerWebhookBody\(pageId, clientId, bubble\)/.test(d));
  ck("outcome persisted per bubble (lostinbound-result|…)", /lostinbound-result\|\$\{outcome\}/.test(d));
  ck("paused (mode=human) threads are worded as 'responda pelo app', not 'reprocessada'",
    /modeOf\.get\(`fb_\$\{l\.clientId\}`\) === "human"/.test(d) && /conversa pausada \(modo humano\)[^"]*responda pelo app/.test(d));
  ck("owner alert throttled to 1/h and sent to both owner phones", /shouldAlert\("lostinbound", "alert", LOST_INBOUND_ALERT_EVERY_MS\)/.test(d) && /OWNER_PHONES\.map\(\(p\) => sendWhatsAppMessage\(p, msg\)\)/.test(d));
  ck("sweep never throws out of the webhook (try/catch with a logged error)", /catch \(err\) \{\s*console\.error\("\[DELIVERY\] lost-inbound sweep error:", err\);/.test(d));

  console.log("\n[6] all three webhooks run the sweep");
  for (const [label, rel] of [["Messenger", "src/app/api/fb-webhook/route.ts"], ["WhatsApp", "src/app/api/wa-webhook/route.ts"], ["Instagram", "src/app/api/webhook/route.ts"]] as const) {
    const src = read(rel);
    ck(`${label}: imports recoverLostInbounds from delivery`, /import \{[^}]*recoverLostInbounds[^}]*\} from "@\/lib\/delivery"/.test(src), rel);
    ck(`${label}: waitUntil(recoverLostInbounds()) right after recoverLostReplies`, /waitUntil\(recoverLostReplies\(\)\);[\s\S]{0,400}?waitUntil\(recoverLostInbounds\(\)\);/.test(src), rel);
  }
  const fb = read("src/app/api/fb-webhook/route.ts");
  ck("Messenger handler dedupes on instagram_msg_id (late Meta delivery after a repost is dropped)", /\.eq\("instagram_msg_id", msgId\)[\s\S]{0,80}?if \(already && !opts\?\.replay\) return;/.test(fb));
  ck("Messenger handler stores the bubble BEFORE the mode=human gate (paused threads keep their history)",
    fb.indexOf("instagram_msg_id: msgId,") < fb.indexOf('if (conv.mode === "human") {'));

  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail > 0) {
    console.log("FAILED:", fails.join(" | "));
    process.exit(1);
  }
}

main();
