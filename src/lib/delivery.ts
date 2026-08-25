import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { SEND_FAILED_DB_SUFFIX } from "@/lib/outbound-text";

// ─── Delivery-failure visibility ────────────────────────────────────────────
// The 2026-07-22 outage: the IG token died and the bot kept "replying" into
// the void for 19 hours — the DB stored every reply, the dashboard showed the
// conversations as answered, and nobody was told. These helpers make a failed
// send IMPOSSIBLE to miss: the owner gets a WhatsApp alert (throttled so a
// dead token doesn't spam a message per client), and the callers stop storing
// replies the client never received.
//
// Throttle state lives in platform_settings row keys (the table has no value
// column): "sendfail|<channel>|<lastAlertISO>".

const ALERT_EVERY_MS = 60 * 60 * 1000; // max 1 owner alert per channel per hour
const OWNER_PHONES = ["15616748334", "556294554477"];

const CHANNEL_LABEL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook/Messenger",
  whatsapp: "WhatsApp",
};

async function shouldAlert(kind: string, key: string, everyMs: number): Promise<boolean> {
  const prefix = `${kind}|${key}|`;
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", `${prefix}%`);
    const rows = (data ?? []).map((r) => String(r.platform));
    const last = rows
      .map((r) => Date.parse(r.slice(prefix.length)))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (last && Date.now() - last < everyMs) return false;
    // Claim the slot BEFORE sending (concurrent failures race here; duplicate
    // key insert makes the loser back off).
    //
    // The claim key must be the WINDOW, not the instant. With
    // `new Date().toISOString()` two concurrent callers minted two DIFFERENT
    // keys, so BOTH inserts succeeded, the unique constraint never fired and
    // the "throttle" silently allowed N parallel runs. Every webhook POST on
    // all three channels calls retryFailedSends(), so a channel coming back
    // online ran many sweeps at once and each one re-sent the same outbox rows
    // — clients got the identical reply 2-3 times (2026-08-03). Bucketing to
    // the window makes the losers collide and back off, as always intended.
    const bucket = new Date(Math.floor(Date.now() / everyMs) * everyMs).toISOString();
    const { error } = await supabaseAdmin
      .from("platform_settings")
      .insert({ platform: `${prefix}${bucket}`, paused: false });
    if (error) return false;
    for (const old of rows) {
      await supabaseAdmin.from("platform_settings").delete().eq("platform", old);
    }
    return true;
  } catch (err) {
    console.error("[DELIVERY] throttle check failed:", err);
    return false;
  }
}

// Graph errors that are about ONE recipient, not the channel: 551/24 account
// unavailable/deleted, 10 outside the 24h window, 100 invalid/unknown user.
// These must NOT fire the "channel down" siren (crying wolf kills the alarm's
// credibility — 2026-07-22 14:38 incident review).
const PER_RECIPIENT_CODES = new Set([551, 24, 10, 100]);

// Code 200 "Permissions error" is the ambiguous one: Meta returns the SAME code
// when the token genuinely lost a messaging permission (channel down, real
// siren) and when one account simply refuses business DMs — blocked, restricted
// or "Allow access to messages" off (per-recipient, calm note). Nothing in the
// error body separates them, so the only honest way to tell is to ask the API
// whether the channel itself still works.
//
// 2026-08-15: emone455 tapped the ad and the reply came back 200. The channel
// was perfectly healthy (60 IG conversations delivering that same hour), but the
// classifier read 200 as "channel down" and woke the owner with the full
// ENTREGA FALHANDO siren — and, because the outbox also treats 200 as
// retryable, it was on course to repeat that hourly for 48h.
const AMBIGUOUS_CODES = new Set([200]);

// Cheap liveness probe on the channel's own credentials, memoised so a burst of
// failures costs one Graph call, not one per message.
const HEALTH_TTL_MS = 60 * 1000;
const healthCache = new Map<string, { at: number; ok: boolean }>();

async function channelIsHealthy(channel: "instagram" | "facebook" | "whatsapp"): Promise<boolean> {
  // Z-API exposes no equivalent one-shot credential check, so a WhatsApp
  // ambiguity stays "channel down" — the loud, safe reading.
  if (channel === "whatsapp") return false;
  const hit = healthCache.get(channel);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.ok;
  let ok = false;
  try {
    let url: string;
    if (channel === "instagram") {
      const { getInstagramToken } = await import("@/lib/ig-token");
      url = `https://graph.instagram.com/v24.0/me?fields=id&access_token=${encodeURIComponent(await getInstagramToken())}`;
    } else {
      const { getFacebookPageToken } = await import("@/lib/fb-token");
      url = `https://graph.facebook.com/v24.0/me?fields=id&access_token=${encodeURIComponent(await getFacebookPageToken())}`;
    }
    const res = await fetch(url);
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; id?: string };
    ok = !body.error && !!body.id;
  } catch (err) {
    // A probe that cannot run proves nothing; assume the worst and shout.
    console.error(`[DELIVERY] health probe failed for ${channel}:`, err);
    ok = false;
  }
  healthCache.set(channel, { at: Date.now(), ok });
  return ok;
}

// The igsid prefix is what tells the three channels apart everywhere else.
function channelOf(igsid: string): "instagram" | "facebook" | "whatsapp" {
  if (igsid.startsWith("wa_")) return "whatsapp";
  if (igsid.startsWith("fb_")) return "facebook";
  return "instagram";
}

// True when this failure is about ONE client and the channel is fine.
async function isPerRecipientFailure(
  channel: "instagram" | "facebook" | "whatsapp",
  errorMsg: string
): Promise<boolean> {
  const code = Number((String(errorMsg).match(/^(\d+):/) ?? [])[1] ?? NaN);
  if (PER_RECIPIENT_CODES.has(code)) return true;
  if (AMBIGUOUS_CODES.has(code)) return await channelIsHealthy(channel);
  return false;
}

// A send to a client failed after retries. Log loudly + alert the owner on
// WhatsApp (the channel that still works) at most once per hour per channel.
// Channel-wide failures (token, permissions, rate limit) get the loud siren;
// single-recipient failures get a calm note.
export async function reportSendFailure(
  channel: "instagram" | "facebook" | "whatsapp",
  clientId: string,
  errorMsg: string
): Promise<void> {
  console.error(`🚨 [DELIVERY] ${channel} send FAILED for ${clientId}: ${errorMsg}`);
  const perRecipient = await isPerRecipientFailure(channel, errorMsg);
  // Separate throttle slots: a calm "1 client unreachable" note must never burn
  // the hour in which a real outage would have screamed.
  const slot = perRecipient ? `${channel}-recipient` : channel;
  if (!(await shouldAlert("sendfail", slot, ALERT_EVERY_MS))) return;
  const label = CHANNEL_LABEL[channel] ?? channel;
  const msg = perRecipient
    ? [
        `⚠️ OzziFloors - 1 cliente inalcancavel no ${label}`,
        ``,
        `Nao consegui entregar a resposta para: ${clientId}`,
        `Erro: ${errorMsg.slice(0, 250)}`,
        ``,
        `Provavel conta desativada, bloqueio ou janela de 24h vencida. O canal esta funcionando normalmente para os outros clientes.`,
        `Vou tentar de novo automaticamente por 48h; se nao der, responda pelo app.`,
      ].join("\n")
    : [
        `🚨 OzziFloors - ENTREGA FALHANDO no ${label}!`,
        ``,
        `As respostas do bot NAO estao chegando aos clientes neste canal.`,
        `Erro: ${errorMsg.slice(0, 250)}`,
        `Exemplo de cliente afetado: ${clientId}`,
        ``,
        channel === "instagram"
          ? `Se o erro fala em token/sessao expirada (codigo 190): gere um token novo no Meta e envie para /api/ig-diag?secret=...&settoken=... (nao precisa de deploy).`
          : channel === "facebook"
            ? `Se o erro fala em token/sessao expirada (codigo 190): gere um token novo da PAGINA no Meta e envie para /api/ig-diag?secret=...&setfbtoken=... (nao precisa de deploy). Trocar a senha do Facebook derruba os dois tokens de uma vez — Instagram e Messenger.`
            : `Verifique a conexao do canal no painel (Z-API: assinatura em dia e celular conectado).`,
        `O sistema vai reentregar sozinho as respostas que falharem assim que o canal voltar (retry automatico por 48h).`,
        `Ate resolver, responda os clientes manualmente pelo app.`,
      ].join("\n");
  await Promise.allSettled(OWNER_PHONES.map((p) => sendWhatsAppMessage(p, msg)));
}

const PAUSED_ALERT_EVERY_MS = 6 * 60 * 60 * 1000; // per conversation
const PAUSED_STALE_MS = 60 * 60 * 1000;

// A client wrote into a PAUSED (mode=human) conversation and nobody has
// replied for over an hour — the "Aylen S" black hole (3 days of questions
// into the void on IG). Pings the owner, at most once per 6h per conversation.
// `lastHumanReplyAt` = created_at of the newest assistant/owner message.
export async function alertPausedBacklog(params: {
  conversationId: string;
  channel: "instagram" | "facebook" | "whatsapp";
  clientName: string | null;
  clientId: string;
  lastHumanReplyAt: string | null;
  clientText: string;
}): Promise<void> {
  const { conversationId, channel, clientName, clientId, lastHumanReplyAt, clientText } = params;
  try {
    if (lastHumanReplyAt && Date.now() - Date.parse(lastHumanReplyAt) < PAUSED_STALE_MS) return;
    if (!(await shouldAlert("pausealert", conversationId, PAUSED_ALERT_EVERY_MS))) return;
    const label = CHANNEL_LABEL[channel] ?? channel;
    const msg = [
      `⏸️ OzziFloors - Conversa PAUSADA sem resposta (${label})`,
      ``,
      `Cliente: ${clientName || clientId}`,
      `A IA esta desligada nesta conversa (modo humano) e o cliente continua escrevendo sem ninguem responder ha mais de 1 hora.`,
      ``,
      `Ultima mensagem: ${clientText.slice(0, 200)}`,
      ``,
      `Responda pelo app ou reative a IA no painel.`,
    ].join("\n");
    await Promise.allSettled(OWNER_PHONES.map((p) => sendWhatsAppMessage(p, msg)));
  } catch (err) {
    console.error("[DELIVERY] paused-backlog alert failed:", err);
  }
}

// ─── Single-flight claim on ONE outbound message ────────────────────────────
// The window throttle above keeps sweeps from starting together, but it cannot
// cover everything: a sweep that runs long overlaps the next window, and the
// manual rescue (/api/ig-diag?rescue=1) sends outside the sweep entirely. Both
// paths re-send the SAME stored reply, so on 2026-08-03 a client could receive
// it from the outbox AND from the rescue.
//
// platform_settings.platform is unique, so the INSERT *is* the lock: whoever
// wins sends, everyone else backs off. This makes a double send structurally
// impossible no matter how many workers race, and it is shared by every path
// that can put a stored reply on the wire.
export async function claimSendOnce(messageId: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("platform_settings")
    .insert({ platform: `sentonce|${messageId}`, paused: false });
  return !error;
}

// Only for a send that did NOT reach the client: hand the message back so a
// later sweep can retry it. Never call this after a successful send — the claim
// row is what keeps the reply from going out twice.
export async function releaseSendClaim(messageId: string): Promise<void> {
  try {
    await supabaseAdmin.from("platform_settings").delete().eq("platform", `sentonce|${messageId}`);
  } catch (err) {
    console.error("[DELIVERY] release claim failed:", err);
  }
}

const RETRY_SWEEP_GAP_MS = 10 * 60 * 1000; // sweep at most every 10 min
const RETRY_WINDOW_H = 48; // give up after 48h (reply is stale by then)
const RETRY_BATCH = 10;

// ─── Auto-retry outbox ──────────────────────────────────────────────────────
// A reply whose send failed definitively is stored with SEND_FAILED_DB_SUFFIX
// (see webhooks). This sweep — piggybacked on webhook traffic and both daily
// crons — re-sends those replies until they deliver or expire. The 2026-07-22
// 14:38 case (transient Graph blip on Messenger) needed a manual rescue; with
// this, the same failure self-heals in ≤10 minutes.
export async function retryFailedSends(): Promise<void> {
  try {
    const since = new Date(Date.now() - RETRY_WINDOW_H * 3_600_000).toISOString();
    const { data: pending } = await supabaseAdmin
      .from("instagram_messages")
      .select("id, conversation_id, content, created_at")
      .like("content", "%[SYSTEM: SEND_FAILED]%")
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .limit(RETRY_BATCH);
    if (!pending?.length) return;
    // Throttle only when there IS work (an empty sweep must not burn the slot).
    if (!(await shouldAlert("sendretry", "sweep", RETRY_SWEEP_GAP_MS))) return;

    const { sendInstagramMessage } = await import("@/lib/instagram");
    const { sendFacebookMessage } = await import("@/lib/facebook");

    for (const m of pending) {
      const { data: conv } = await supabaseAdmin
        .from("instagram_conversations")
        .select("igsid, mode")
        .eq("id", m.conversation_id)
        .single();
      if (!conv) continue;
      const text = String(m.content).replace(/\n{0,2}\[SYSTEM: ?SEND_FAILED\]/g, "").trim();
      // If the client wrote again after the failure, the normal flow answers
      // with fresh context; if the owner took over, this reply is his call.
      // Either way the undelivered row is only noise for the history guards.
      const { data: newerUser } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", m.conversation_id)
        .eq("role", "user")
        .gt("created_at", m.created_at)
        .limit(1);
      if (!text || newerUser?.length || conv.mode === "human") {
        await supabaseAdmin.from("instagram_messages").delete().eq("id", m.id);
        await releaseSendClaim(m.id);
        console.log(`[DELIVERY] retry ${conv.igsid}: dropped stale undelivered reply`);
        continue;
      }
      // Last gate before the wire: if anyone else already owns this reply, it is
      // either in flight or already delivered — never send it a second time.
      if (!(await claimSendOnce(m.id))) {
        console.log(`[DELIVERY] retry ${conv.igsid}: already claimed, skipping (no double send)`);
        continue;
      }
      let r: { ok: boolean; error?: string };
      if (conv.igsid.startsWith("wa_")) r = await sendWhatsAppMessage(conv.igsid.slice(3), text);
      else if (conv.igsid.startsWith("fb_")) r = await sendFacebookMessage(conv.igsid.slice(3), text);
      else r = await sendInstagramMessage(conv.igsid, text);
      if (r.ok) {
        // Marker off → the panel shows a normal delivered reply.
        await supabaseAdmin.from("instagram_messages").update({ content: text }).eq("id", m.id);
        console.log(`[DELIVERY] retry ${conv.igsid}: DELIVERED`);
        continue;
      }
      // Per-recipient errors never heal (blocked/deactivated/window) — give up
      // NOW instead of re-pinging the owner hourly for 48h (2026-07-23 review:
      // two 551 "person isn't available" rows kept the calm alert firing). A
      // 200 counts here only once the probe says the channel itself is fine.
      if (await isPerRecipientFailure(channelOf(conv.igsid), String(r.error ?? ""))) {
        await supabaseAdmin.from("instagram_messages").delete().eq("id", m.id);
        await releaseSendClaim(m.id);
        console.log(`[DELIVERY] retry ${conv.igsid}: unreachable (${r.error ?? "?"}) — giving up permanently`);
        continue;
      }
      // Nothing reached the client, so hand the reply back to the next sweep.
      await releaseSendClaim(m.id);
      console.log(`[DELIVERY] retry ${conv.igsid}: still failing (${r.error ?? "?"})`);
    }
  } catch (err) {
    console.error("[DELIVERY] retry sweep error:", err);
  }
}

// ─── Z-API queue watchdog ────────────────────────────────────────────────────
// 2026-08-25 (Olimpia, wa_18138414465): Z-API's send worker hung. send-text
// still answered 200 (it only means "enqueued"), so the bot stored its reply,
// the panel showed the client as answered, and the reply sat in Z-API's queue
// behind 380 stale items. The owner got no siren because the siren is ALSO a
// WhatsApp message through that same queue. This watchdog is the missing
// external check: it reads the queue on webhook traffic (any channel) and on
// both daily crons, throttled to one probe / 5 min.
//
// When the oldest queued item is older than WA_QUEUE_STUCK_AFTER_MS with the
// phone online, it (1) restarts the Z-API instance — the documented fix, keeps
// the pairing, max once per hour — and (2) alerts the owner (the alert queues
// too, but a successful restart flushes it seconds later; if the restart did
// not help, the owner still sees it once Z-API recovers, together with the
// instruction to check the panel).
const WA_QUEUE_PROBE_EVERY_MS = 5 * 60 * 1000;
const WA_QUEUE_RESTART_EVERY_MS = 60 * 60 * 1000;

export async function watchWaQueue(): Promise<void> {
  try {
    if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_TOKEN) return;
    if (!(await shouldAlert("waqueue", "probe", WA_QUEUE_PROBE_EVERY_MS))) return;
    const { fetchWaQueueHealth, restartWaInstance } = await import("@/lib/whatsapp");
    const { judgeWaQueue, fmtAge } = await import("@/lib/wa-queue-policy");
    const h = await fetchWaQueueHealth();
    const v = judgeWaQueue(h);
    if (!v.stuck) {
      if (h.count > 0) console.log(`[WAQUEUE] ${v.reason}`);
      return;
    }
    console.error(`🚨 [WAQUEUE] Z-API queue STUCK: ${v.reason} (session=${h.session}, connected=${h.connected}, phone=${h.smartphoneConnected})`);
    let restartNote = "";
    if (v.restart) {
      if (await shouldAlert("waqueue", "restart", WA_QUEUE_RESTART_EVERY_MS)) {
        const r = await restartWaInstance();
        console.error(`[WAQUEUE] restart instance → ok=${r.ok} status=${r.status} ${r.body}`);
        restartNote = r.ok
          ? "Reiniciei a instancia da Z-API automaticamente (nao precisa de QR code). Se as mensagens presas nao sairem em alguns minutos, reinicie pelo painel da Z-API."
          : `Tentei reiniciar a instancia da Z-API e NAO consegui (HTTP ${r.status}). Reinicie pelo painel da Z-API.`;
      } else {
        restartNote = "Ja reiniciei a instancia na ultima hora e a fila continua parada — reinicie pelo painel da Z-API ou reconecte o celular.";
      }
    } else {
      restartNote = "O celular do WhatsApp aparece OFFLINE na Z-API — ligue o celular na internet / abra o WhatsApp nele.";
    }
    if (!(await shouldAlert("waqueue", "alert", WA_QUEUE_RESTART_EVERY_MS))) return;
    const msg = [
      `🚨 OzziFloors - WhatsApp com ${h.count} mensagem(ns) PRESA(S) na fila da Z-API`,
      ``,
      `A mais antiga esta esperando ha ${fmtAge(h.oldestAgeMs)}. Enquanto isso NENHUMA resposta do bot chega aos clientes no WhatsApp (o sistema acha que enviou).`,
      ``,
      restartNote,
      ``,
      `Ate normalizar, responda os clientes do WhatsApp pelo celular.`,
    ].join("\n");
    await Promise.allSettled(OWNER_PHONES.map((p) => sendWhatsAppMessage(p, msg)));
  } catch (err) {
    console.error("[WAQUEUE] watchdog error:", err);
  }
}
