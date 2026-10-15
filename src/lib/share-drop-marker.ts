import { supabaseAdmin } from "@/lib/supabase";

// ─── "We just dropped a forwarded reel from this person" (15/10/2026) ────────
// A reel/post forwarded from someone else's feed is dropped before it is
// stored (shared-media-policy.ts), but its caption lands as the NEXT bubble,
// one or two seconds later, in a separate invocation: "LIKE SHARE N COMMENT",
// "😂😂he's funny", "N", "CNN". Nothing in the stored thread says a reel was
// just dropped, so this marker records it: "sharedrop|<ISO>|<channel>:<id>"
// in platform_settings, the same table and style as the Instagram link-block
// marker (delivery.ts). The ISO comes first so stale rows are range-deleted
// with a short URL (black-box GC lesson: a giant .in() delete fails silently).
const PREFIX = "sharedrop|";
const KEEP_MS = 24 * 60 * 60 * 1000;

export function shareDropKey(channel: "ig" | "fb", id: string): string {
  return `${channel}:${id}`;
}

async function rowsFor(key: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", `${PREFIX}%|${key}`);
  if (error) throw error;
  return (data ?? []).map((r) => String(r.platform));
}

// When (epoch ms) a share from this sender was last dropped, or null.
export async function shareDroppedAt(key: string): Promise<number | null> {
  try {
    const ts = (await rowsFor(key))
      .map((r) => Date.parse(r.slice(PREFIX.length).split("|")[0]))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return ts ?? null;
  } catch (err) {
    console.error("[SHARE-DROP] read failed:", err);
    return null;
  }
}

// Record a drop now: one row per sender (older rows for the same sender go),
// plus a cheap sweep of anything older than a day.
export async function markShareDropped(key: string): Promise<void> {
  try {
    const now = new Date();
    const old = await rowsFor(key);
    const { error: insErr } = await supabaseAdmin
      .from("platform_settings")
      .insert({ platform: `${PREFIX}${now.toISOString()}|${key}`, paused: false });
    if (insErr) throw insErr;
    for (const r of old) {
      const { error } = await supabaseAdmin.from("platform_settings").delete().eq("platform", r);
      if (error) console.error("[SHARE-DROP] old marker delete failed:", error.message);
    }
    const cutoff = new Date(now.getTime() - KEEP_MS).toISOString();
    const { error: gcErr } = await supabaseAdmin
      .from("platform_settings")
      .delete()
      .gte("platform", PREFIX)
      .lt("platform", `${PREFIX}${cutoff}`);
    if (gcErr) console.error("[SHARE-DROP] sweep failed:", gcErr.message);
  } catch (err) {
    console.error("[SHARE-DROP] mark failed:", err);
  }
}
