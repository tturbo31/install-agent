import { reportSendFailure } from "@/lib/delivery";

const FB_API = "https://graph.facebook.com/v24.0";

function getToken(): string {
  return process.env.FACEBOOK_PAGE_TOKEN!;
}

export type FbSendResult = { ok: boolean; error?: string };

// Send a text message via Facebook Messenger. VERIFIED (2026-07-22, same
// hardening as IG/WA): retry once on a transient failure, alert the owner on a
// definitive one, and return a result so callers stop recording undelivered
// replies as sent.
export async function sendFacebookMessage(psid: string, text: string): Promise<FbSendResult> {
  let lastErr = "not attempted";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${FB_API}/me/messages?access_token=${getToken()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text },
          messaging_type: "RESPONSE",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        message_id?: string;
        error?: { message?: string; code?: number };
      };
      if (!body.error && (body.message_id || res.ok)) return { ok: true };
      lastErr = `${body.error?.code ?? res.status}: ${body.error?.message ?? "unknown"}`;
      console.error(`🚨 sendFacebookMessage FAILED (attempt ${attempt}/2) psid=${psid} ${lastErr}`);
      if (body.error?.code === 190) break; // dead token won't heal on retry
    } catch (err) {
      lastErr = String(err).slice(0, 200);
      console.error(`🚨 sendFacebookMessage EXCEPTION (attempt ${attempt}/2):`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }
  await reportSendFailure("facebook", psid, lastErr);
  return { ok: false, error: lastErr };
}

// Get Facebook user profile (name + profile pic)
export async function fetchFacebookProfile(psid: string): Promise<{ name?: string; profile_pic?: string }> {
  try {
    const res = await fetch(
      `${FB_API}/${psid}?fields=name,profile_pic&access_token=${getToken()}`
    );
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

// Best-effort: "see the ad" by pulling its creative (all text fields + the main
// image) from the Meta Graph API using the ad_id that Meta sends on the referral.
// This is how we identify the flooring type (tile vs vinyl vs hardwood) even when
// the referral delivered no ad_title/photo_url. Requires the token to have
// ads_read on the ad account; returns nulls on ANY error (permissions, not found,
// network) so callers degrade safely to asking the client. Set META_ADS_TOKEN to
// use a dedicated ads token; otherwise the page token is tried.
export async function fetchAdCreative(adId: string): Promise<{ text: string | null; imageUrl: string | null }> {
  const empty = { text: null as string | null, imageUrl: null as string | null };
  try {
    if (!adId || !/^\d{3,}$/.test(adId)) return empty;
    const token = process.env.META_ADS_TOKEN || getToken();
    const fields = "name,creative{name,title,body,image_url,thumbnail_url,link_url,object_story_spec,asset_feed_spec}";
    const res = await fetch(`${FB_API}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${token}`);
    if (!res.ok) return empty;
    const data = await res.json().catch(() => null);
    if (!data || data.error) return empty;
    const c = (data.creative ?? {}) as Record<string, any>;
    const oss = (c.object_story_spec ?? {}) as Record<string, any>;
    const link = (oss.link_data ?? oss.video_data ?? oss.template_data ?? {}) as Record<string, any>;
    const afs = (c.asset_feed_spec ?? {}) as Record<string, any>;
    const texts: Array<string | undefined> = [
      data.name, c.name, c.title, c.body, c.link_url,
      link.message, link.name, link.caption, link.description, link.link,
      ...(Array.isArray(afs.titles) ? afs.titles.map((t: any) => t?.text) : []),
      ...(Array.isArray(afs.bodies) ? afs.bodies.map((b: any) => b?.text) : []),
      ...(Array.isArray(afs.link_urls) ? afs.link_urls.map((l: any) => l?.website_url) : []),
    ];
    const text = texts.filter(Boolean).join(" | ") || null;
    const imageUrl =
      c.image_url || c.thumbnail_url || link.picture ||
      (Array.isArray(afs.images) && afs.images[0]?.url) || null;
    return { text, imageUrl: imageUrl || null };
  } catch {
    return empty;
  }
}

// Download image from URL (for floor plans sent via Messenger)
export async function downloadFacebookAttachment(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 2000) return null;
    return `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}
