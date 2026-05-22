const FB_API = "https://graph.facebook.com/v24.0";

function getToken(): string {
  return process.env.FACEBOOK_PAGE_TOKEN!;
}

// Send a text message via Facebook Messenger
export async function sendFacebookMessage(psid: string, text: string): Promise<void> {
  const res = await fetch(`${FB_API}/me/messages?access_token=${getToken()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text },
      messaging_type: "RESPONSE",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("sendFacebookMessage error:", JSON.stringify(err));
  }
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
