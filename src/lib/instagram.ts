import { InstagramProfile } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase";
import { getInstagramToken } from "@/lib/ig-token";
import { reportSendFailure } from "@/lib/delivery";
import { stripInternalMarkers } from "@/lib/outbound-text";

export async function fetchInstagramProfile(igsid: string): Promise<InstagramProfile> {
  const url = new URL(`https://graph.instagram.com/v24.0/${igsid}`);
  url.searchParams.set(
    "fields",
    "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user"
  );
  url.searchParams.set("access_token", await getInstagramToken());

  const res = await fetch(url.toString());
  const data = await res.json();

  return {
    name: data.name ?? null,
    username: data.username ?? null,
    profile_pic: data.profile_pic ?? null,
    follower_count: data.follower_count ?? null,
    is_user_follow_business: data.is_user_follow_business ?? null,
    is_business_follow_user: data.is_business_follow_user ?? null,
  };
}

export type IgSendResult = {
  ok: boolean;
  via: "instagram" | "messenger-bridge" | "none";
  error?: string;
};

// Send a DM. VERIFIED + VISIBLE (2026-07-22): the old version returned the raw
// Graph response without ever looking at it, so when the prod token expired
// every reply "succeeded" locally while the client got NOTHING for 19 hours.
// Now:
//  • the Graph error is actually checked (retry once on a transient failure),
//  • on an auth-style failure we fall back to the Messenger Platform bridge
//    (graph.facebook.com/me/messages with the page token can message the same
//    IGSID when the IG account is linked to the page),
//  • a definitive failure triggers the throttled owner alert, and callers get
//    a real result so they can stop recording undelivered replies as sent.
export async function sendInstagramMessage(
  recipientIgsid: string,
  text: string
): Promise<IgSendResult> {
  text = stripInternalMarkers(text);
  if (!text) return { ok: false, via: "none", error: "empty text after marker strip" };
  const payload = JSON.stringify({ recipient: { id: recipientIgsid }, message: { text } });
  let lastErr = "not attempted";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const url = new URL("https://graph.instagram.com/v24.0/me/messages");
      url.searchParams.set("access_token", await getInstagramToken());
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body = (await res.json().catch(() => ({}))) as {
        message_id?: string;
        error?: { message?: string; code?: number };
      };
      if (!body.error && (body.message_id || res.ok)) return { ok: true, via: "instagram" };
      lastErr = `${body.error?.code ?? res.status}: ${body.error?.message ?? "unknown"}`;
      console.error(`🚨 sendInstagramMessage FAILED (attempt ${attempt}/2) igsid=${recipientIgsid} ${lastErr}`);
      // Auth errors (expired/invalid token, code 190) won't heal on retry —
      // go straight to the bridge.
      if (body.error?.code === 190) break;
    } catch (err) {
      lastErr = String(err).slice(0, 200);
      console.error(`🚨 sendInstagramMessage EXCEPTION (attempt ${attempt}/2):`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
  }

  // ── Messenger Platform bridge ──
  const pageToken = process.env.FACEBOOK_PAGE_TOKEN;
  if (pageToken) {
    try {
      const res = await fetch(
        `https://graph.facebook.com/v24.0/me/messages?access_token=${pageToken}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }
      );
      const body = (await res.json().catch(() => ({}))) as {
        message_id?: string;
        error?: { message?: string; code?: number };
      };
      if (!body.error && (body.message_id || res.ok)) {
        console.warn(`[IG] delivered via messenger-bridge (primary failed: ${lastErr})`);
        return { ok: true, via: "messenger-bridge" };
      }
      console.error(`🚨 messenger-bridge also FAILED igsid=${recipientIgsid}:`, JSON.stringify(body.error ?? body).slice(0, 300));
    } catch (err) {
      console.error("🚨 messenger-bridge EXCEPTION:", err);
    }
  }

  await reportSendFailure("instagram", recipientIgsid, lastErr);
  return { ok: false, via: "none", error: lastErr };
}

export async function sendInstagramImage(recipientIgsid: string, imageUrl: string): Promise<boolean> {
  try {
    const url = new URL("https://graph.instagram.com/v24.0/me/messages");
    url.searchParams.set("access_token", await getInstagramToken());

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl, is_reusable: true },
          },
        },
      }),
    });

    const result = await res.json();
    if (result.error) {
      console.error("Instagram image send error:", result.error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendInstagramImage error:", err);
    return false;
  }
}

export async function sendInstagramAudio(recipientIgsid: string, audioBuffer: Buffer): Promise<boolean> {
  try {
    // Upload audio to Supabase storage
    const fileName = `tts-${Date.now()}.mp3`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("audio-responses")
      .upload(fileName, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false,
      });

    if (uploadError) {
      console.error("Audio upload error:", uploadError.message);
      return false;
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from("audio-responses")
      .getPublicUrl(fileName);

    const audioUrl = urlData.publicUrl;

    // Send via Instagram API
    const url = new URL("https://graph.instagram.com/v24.0/me/messages");
    url.searchParams.set("access_token", await getInstagramToken());

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: {
          attachment: {
            type: "audio",
            payload: {
              url: audioUrl,
              is_reusable: false,
            },
          },
        },
      }),
    });

    const result = await res.json();
    if (result.error) {
      console.error("Instagram audio send error:", result.error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("sendInstagramAudio error:", err);
    return false;
  }
}
