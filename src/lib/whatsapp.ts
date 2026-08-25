import { stripInternalMarkers } from "@/lib/outbound-text";

const ZAPI_BASE = "https://api.z-api.io";

const OWNER_PHONES = ["15616748334", "556294554477"];

function getInstanceId(): string {
  return process.env.ZAPI_INSTANCE_ID!;
}

function getToken(): string {
  return process.env.ZAPI_TOKEN!;
}

function getClientToken(): string {
  return process.env.ZAPI_CLIENT_TOKEN!;
}

export type WaSendResult = { ok: boolean; status: number; error?: string };

// Send a WhatsApp text via Z-API. RESILIENT + VISIBLE: a failed send is the
// silent killer — the DB stores the assistant reply either way, so the panel
// shows "replied" while the client got NOTHING (the reported bug). So we now:
//  • retry once on a transient failure (network drop, 5xx, Z-API blip),
//  • return a {ok,status,error} result so the caller can react,
//  • log LOUDLY with the Z-API error body so the cause is diagnosable.
export async function sendWhatsAppMessage(phone: string, text: string): Promise<WaSendResult> {
  text = stripInternalMarkers(text);
  if (!text) return { ok: false, status: 0, error: "empty text after marker strip" };
  const url = `${ZAPI_BASE}/instances/${getInstanceId()}/token/${getToken()}/send-text`;
  let last: WaSendResult = { ok: false, status: 0, error: "not attempted" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Client-Token": getClientToken() },
        body: JSON.stringify({ phone, message: text }),
      });
      if (res.ok) return { ok: true, status: res.status };
      const errBody = await res.text().catch(() => "");
      last = { ok: false, status: res.status, error: errBody.slice(0, 300) };
      console.error(`🚨 sendWhatsAppMessage FAILED (attempt ${attempt}/2) phone=${phone} status=${res.status} body=${errBody.slice(0, 300)}`);
    } catch (err) {
      last = { ok: false, status: 0, error: String(err).slice(0, 300) };
      console.error(`🚨 sendWhatsAppMessage EXCEPTION (attempt ${attempt}/2) phone=${phone}:`, err);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

// React to a client's message with an emoji (e.g. a thumbs up) instead of
// sending another text — used when the client just closes / thanks.
export async function sendWhatsAppReaction(
  phone: string,
  messageId: string,
  reaction = "👍"
): Promise<void> {
  if (!messageId) return;
  const url = `${ZAPI_BASE}/instances/${getInstanceId()}/token/${getToken()}/send-reaction`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Token": getClientToken(),
      },
      body: JSON.stringify({ phone, messageId, reaction }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error("sendWhatsAppReaction error:", JSON.stringify(err));
    }
  } catch (err) {
    console.error("sendWhatsAppReaction exception:", err);
  }
}

export async function downloadZApiImage(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 2000) return null;
    return `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

export async function notifyOwners(params: {
  platform: string;
  clientName: string | null;
  clientId: string;
  recentMessages: { role: string; content: string }[];
  alert?: string | null;
}): Promise<void> {
  const { platform, clientName, clientId, recentMessages, alert } = params;
  const lines = recentMessages.slice(-8).map((m) => {
    const who = m.role === "user" ? "Cliente" : "Agente";
    return `${who}: ${m.content.slice(0, 300)}`;
  });
  const msg = [
    `OzziFloors - Atencao necessaria!`,
    ...(alert ? ["", alert] : []),
    ``,
    `Canal: ${platform}`,
    `Cliente: ${clientName || clientId}`,
    ``,
    `Conversa recente:`,
    ...lines,
    ``,
    `Entre em contato com o cliente!`,
  ].join("\n");
  await Promise.allSettled(OWNER_PHONES.map((phone) => sendWhatsAppMessage(phone, msg)));
}

export async function downloadZApiAudio(audioUrl: string): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(audioUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "audio/ogg";
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) return null;
    return { buffer: buf, contentType: ct };
  } catch {
    return null;
  }
}

// ─── Z-API outbound queue health ─────────────────────────────────────────────
// send-text answers 200 the moment Z-API ENQUEUES the message — it says nothing
// about the message leaving the queue. When Z-API's worker hangs (2026-08-25,
// Olimpia case: 380 items stuck, oldest 2.5 days) every reply "succeeds" here
// and reaches nobody. The only external evidence is the queue itself, so we
// read it: count + status + the oldest item's age.
export type WaQueueHealth = {
  probeOk: boolean;
  count: number;
  oldestAgeMs: number | null;
  oldestAt: string | null;
  connected: boolean;
  smartphoneConnected: boolean;
  session: boolean | null;
  error?: string;
};

async function zapiGet(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ZAPI_BASE}/instances/${getInstanceId()}/token/${getToken()}/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "Client-Token": getClientToken(), ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export async function fetchWaQueueHealth(): Promise<WaQueueHealth> {
  const out: WaQueueHealth = { probeOk: false, count: 0, oldestAgeMs: null, oldestAt: null, connected: false, smartphoneConnected: false, session: null };
  try {
    const st = await zapiGet("status");
    const s = (st.body ?? {}) as { connected?: boolean; smartphoneConnected?: boolean; session?: boolean };
    out.connected = s.connected === true;
    out.smartphoneConnected = s.smartphoneConnected === true;
    out.session = typeof s.session === "boolean" ? s.session : null;
    const cnt = await zapiGet("queue/count");
    const c = (cnt.body ?? {}) as { count?: number };
    if (cnt.status !== 200 || typeof c.count !== "number") {
      out.error = `queue/count HTTP ${cnt.status}`;
      return out;
    }
    out.count = c.count;
    out.probeOk = true;
    if (out.count === 0) return out;
    // Oldest item: the cursor endpoint first (POST /queue), the deprecated
    // page endpoint as fallback — both return items oldest-first.
    let items: { Created?: number; CreatedAt?: string }[] = [];
    const posted = await zapiGet("queue", { method: "POST", body: JSON.stringify({ pageSize: 30 }) });
    const pb = posted.body as { messages?: unknown } | null;
    if (posted.status === 200 && pb && Array.isArray(pb.messages)) items = pb.messages as typeof items;
    if (!items.length) {
      const legacy = await zapiGet("queue?page=1&pageSize=30");
      if (legacy.status === 200 && Array.isArray(legacy.body)) items = legacy.body as typeof items;
    }
    const createds = items
      .map((i) => (typeof i.Created === "number" ? i.Created : i.CreatedAt ? Date.parse(i.CreatedAt) : NaN))
      .filter(Number.isFinite);
    if (createds.length) {
      const oldest = Math.min(...createds);
      out.oldestAgeMs = Math.max(0, Date.now() - oldest);
      out.oldestAt = new Date(oldest).toISOString();
    }
    return out;
  } catch (err) {
    out.error = String(err).slice(0, 200);
    return out;
  }
}

// Z-API "Reiniciar instância": documented as the fix for "eventual problems",
// keeps the pairing (no new QR code). Returns the raw result for logging.
export async function restartWaInstance(): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const r = await zapiGet("restart", { method: "POST", body: "{}" });
    return { ok: r.status === 200, status: r.status, body: JSON.stringify(r.body).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, body: String(err).slice(0, 200) };
  }
}
