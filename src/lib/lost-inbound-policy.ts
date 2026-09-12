// Pure policy for the lost-INBOUND net (no I/O; eval-covered by
// src/evals/lost-inbound-verify.ts). The sweep itself lives in delivery.ts.
//
// 2026-09-12, Tony Martinez (Messenger, fb_28332396826410353): the client's
// third bubble ("Probably Monday ... more like 9:30 if that's ok?") was sent
// at 11:30:03 UTC and Meta NEVER posted it to /api/fb-webhook. The raw capture
// (caixa-preta, funil_raw_fb_*) shows his two earlier bubbles and both bot
// echoes, then nothing for that thread until the owner's manual reply an hour
// later — while the Instagram webhook kept receiving POSTs at 11:33. No deploy
// happened in that window and the message was a plain text bubble. The bot
// never saw it, so it never answered; the owner rescued the lead by chance.
//
// The 7-day audit (1,325 client bubbles) found this to be the ONLY lost text
// bubble; the other 31 gaps were stickers (19, mostly the thumbs-up) and empty
// reactions that the handler drops on purpose. So this is a rare Meta-side
// delivery failure — but one lost bubble is one lost lead, and nothing was
// watching for it. This net reads the page's recent Messenger threads from the
// Graph API, compares the trailing client bubbles against what the webhook
// stored (instagram_msg_id = Meta message id), and re-posts the missing ones
// to our own webhook so the normal flow answers them.

export const LOST_INBOUND_MIN_AGE_MS = 2 * 60_000; // give the live webhook (and Meta's own retries) time
export const LOST_INBOUND_MAX_AGE_MS = 6 * 3_600_000; // older than this, a bot reply would be stale
export const LOST_INBOUND_SWEEP_GAP_MS = 5 * 60_000;
export const LOST_INBOUND_SCAN_LIMIT = 40; // newest threads by updated_time, one Graph call
export const LOST_INBOUND_MAX_PER_SWEEP = 5; // threads per sweep

export interface ThreadBubble {
  id: string; // Meta message id — the same value the webhook stores as instagram_msg_id
  created_time: string;
  fromId: string;
  text: string;
  imageUrls: string[];
  hasOtherAttachment: boolean;
}

export interface ThreadSnapshot {
  clientId: string;
  clientName: string | null;
  bubbles: ThreadBubble[]; // newest first, as the Graph API returns them
}

export interface LostInbound {
  clientId: string;
  clientName: string | null;
  missing: ThreadBubble[]; // oldest first — reposted in that order so the debounce sees one burst
}

export interface GraphConversation {
  updated_time?: string;
  participants?: { data?: Array<{ id?: string; name?: string }> };
  messages?: {
    data?: Array<{
      id?: string;
      created_time?: string;
      from?: { id?: string };
      message?: string;
      sticker?: string;
      attachments?: { data?: Array<{ mime_type?: string; image_data?: { url?: string }; file_url?: string }> };
    }>;
  };
}

// Same emoji classes the Messenger handler uses to drop emoji-only bubbles.
const EMOJI_ONLY =
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}\s]*$/u;

// Graph API conversation → snapshot. Stickers come back with an empty message
// and a `sticker` url (sometimes also under attachments) — they are never
// replayable, so a sticker bubble carries no attachments here.
export function toThreadSnapshot(c: GraphConversation, pageId: string): ThreadSnapshot | null {
  const client = (c.participants?.data ?? []).find((p) => p.id && p.id !== pageId);
  if (!client?.id) return null;
  const bubbles: ThreadBubble[] = [];
  for (const m of c.messages?.data ?? []) {
    if (!m.id || !m.created_time) continue;
    const atts = m.sticker ? [] : (m.attachments?.data ?? []);
    const imageUrls = atts.map((a) => a.image_data?.url).filter((u): u is string => !!u);
    bubbles.push({
      id: m.id,
      created_time: m.created_time,
      fromId: m.from?.id ?? "",
      text: m.sticker ? "" : (m.message ?? ""),
      imageUrls,
      hasOtherAttachment: atts.length > imageUrls.length,
    });
  }
  return { clientId: client.id, clientName: client.name ?? null, bubbles };
}

// A bubble the webhook would have stored had it arrived. Stickers, reactions
// and emoji-only bubbles are dropped by the handler on purpose, so they are
// never "lost".
export function isReplayableBubble(b: ThreadBubble): boolean {
  if (b.text.trim() && !EMOJI_ONLY.test(b.text)) return true;
  return b.imageUrls.length > 0 || b.hasOtherAttachment;
}

// The trailing run of client bubbles (newest first, stopping at the first page
// message). Empty when the page spoke last: whoever answered — the bot or the
// owner from the Page Inbox — saw the thread.
export function trailingClientRun(t: ThreadSnapshot): ThreadBubble[] {
  const run: ThreadBubble[] = [];
  for (const b of t.bubbles) {
    if (b.fromId !== t.clientId) break;
    run.push(b);
  }
  return run;
}

// Threads whose newest client bubble has waited long enough for the live
// webhook, is not stale, and where at least one bubble of the trailing run was
// never stored. A failed stored-id read must never reach here as an empty set
// (the caller skips the sweep instead) — replaying bubbles the webhook DID
// handle would answer clients twice.
export function pickLostInbounds(threads: ThreadSnapshot[], storedIds: Set<string>, nowMs: number): LostInbound[] {
  const out: LostInbound[] = [];
  for (const t of threads) {
    const run = trailingClientRun(t);
    if (!run.length) continue;
    const newestAge = nowMs - Date.parse(run[0].created_time);
    if (!(newestAge >= LOST_INBOUND_MIN_AGE_MS && newestAge <= LOST_INBOUND_MAX_AGE_MS)) continue;
    const missing = run.filter((b) => !storedIds.has(b.id) && isReplayableBubble(b)).reverse();
    if (!missing.length) continue;
    out.push({ clientId: t.clientId, clientName: t.clientName, missing });
    if (out.length >= LOST_INBOUND_MAX_PER_SWEEP) break;
  }
  return out;
}

// Meta-shaped webhook body for one bubble — the same shape the live webhook
// receives (object=page, entry[0].messaging[0].message.mid/text/attachments),
// so the handler needs no special case and dedupes on the real mid.
export function buildMessengerWebhookBody(pageId: string, clientId: string, b: ThreadBubble): Record<string, unknown> {
  const ts = Date.parse(b.created_time) || Date.now();
  const attachments = [
    ...b.imageUrls.map((url) => ({ type: "image", payload: { url } })),
    ...(b.hasOtherAttachment ? [{ type: "fallback", payload: {} }] : []),
  ];
  const message: Record<string, unknown> = { mid: b.id };
  if (b.text) message.text = b.text;
  if (attachments.length) message.attachments = attachments;
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: ts,
        messaging: [{ sender: { id: clientId }, recipient: { id: pageId }, timestamp: ts, message }],
      },
    ],
  };
}
