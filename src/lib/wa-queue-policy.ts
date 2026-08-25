// Z-API outbound queue policy — PURE (no I/O) so the eval can pin it.
//
// The 2026-08-25 incident (Olimpia, wa_18138414465): the client tapped the ad
// at 18:46Z, the bot generated its reply in 14s, Z-API answered 200 to
// send-text — and nothing reached the phone. Z-API's send worker had hung:
// its queue held 380 messages going back to 2026-08-23 00:32Z (items that had
// been delivered but never cleared, then — from somewhere between 17:52Z and
// 18:47Z — items not sent at all). The instance recovered on its own at
// ~18:55Z and flushed everything. Meanwhile every owner alert ALSO went through
// that same queue, so nobody was told.
//
// A healthy queue empties in ~2s per message (probe on 2026-08-25 19:05Z:
// count 1 → 0 within 2s). An item older than a few minutes therefore means the
// worker is stuck, not busy.

export const WA_QUEUE_STUCK_AFTER_MS = 10 * 60 * 1000; // oldest item age
export const WA_QUEUE_BLIND_BACKLOG = 20; // count that is "stuck" even without ages

export type WaQueueSnapshot = {
  probeOk: boolean; // status + count could be read at all
  count: number;
  oldestAgeMs: number | null; // null = could not read the items
  connected: boolean; // Z-API: number linked to the instance
  smartphoneConnected: boolean; // Z-API: the phone itself is online
};

export type WaQueueVerdict = {
  stuck: boolean;
  restart: boolean; // stuck AND a restart can plausibly help
  reason: string;
};

export function judgeWaQueue(s: WaQueueSnapshot): WaQueueVerdict {
  if (!s.probeOk) return { stuck: false, restart: false, reason: "probe failed — cannot judge" };
  if (s.count <= 0) return { stuck: false, restart: false, reason: "queue empty" };
  const old = s.oldestAgeMs !== null && s.oldestAgeMs >= WA_QUEUE_STUCK_AFTER_MS;
  const blind = s.oldestAgeMs === null && s.count >= WA_QUEUE_BLIND_BACKLOG;
  if (!old && !blind) return { stuck: false, restart: false, reason: `queue draining (${s.count} item(s), oldest ${fmtAge(s.oldestAgeMs)})` };
  // A phone that is offline legitimately holds the queue — a restart does
  // nothing for that; the owner needs to put the phone online instead.
  const canRestart = s.connected && s.smartphoneConnected;
  return {
    stuck: true,
    restart: canRestart,
    reason: old
      ? `oldest queued message is ${fmtAge(s.oldestAgeMs)} old (${s.count} waiting)${canRestart ? "" : " — phone offline, restart pointless"}`
      : `${s.count} messages waiting and the queue items could not be read${canRestart ? "" : " — phone offline, restart pointless"}`,
  };
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return "?";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.round(h / 24)}d`;
}
