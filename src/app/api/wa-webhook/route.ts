import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage, sendWhatsAppReaction, downloadZApiImage, downloadZApiAudio, notifyOwners } from "@/lib/whatsapp";
import { alertPausedBacklog, reportSendFailure, retryFailedSends } from "@/lib/delivery";
import { SEND_FAILED_DB_SUFFIX } from "@/lib/outbound-text";
import { getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags, detectLargeLeadSqft, isPureClosing, isPureClosingBurst, isRescheduleRequest, isCancelRequest, containsSchedulingOffer, isJobSeeker, isLowCreditError, CREDIT_ALERT, containsBookingInfo, isAskingForBookingInfo, detectAdFlooringType, adFlooringTypeNote, classifyAdCreativeType, isConsecutiveDuplicate, unansweredUserBurst, isVisitDetailQuestion, pastVisitSystemNote, type AdFlooringType } from "@/lib/ai";
import { fetchAdCreative } from "@/lib/facebook";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { createBooking, cancelClientBooking, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, getClientBookingSnapshot, visitDetailsMessage, isRealPhoneNumber, resolveClientName, reconcileBookingWeekday, clientConfirmedSlot, needSlotConfirmationMessage, isRealAddress, needAddressMessage, clientProvidedName, needNameMessage } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { trackConversationMetrics } from "@/lib/metrics";
import { funilOnInboundMessage, funilOnBookingConfirmed, maybeRunFunilSilenceCheck, persistirAnuncioDaConversa } from "@/lib/funil";
import { capturarRawFunil, capturarWebhookRaw } from "@/lib/funil-raw";
import { enviarEventoFunil } from "@/lib/plataforma";
import { findQuoteFollowupContext, composeQuoteReply } from "@/lib/quote-reply";

export const maxDuration = 60;

const RESPONSE_DELAY_MS = 10000;

// ─── Safety net: strip slot-conflict sentences and hard-fallback ──────────
function stripSlotConflictLanguage(text: string): string {
  let cleaned = text
    .replace(/[^.!?\n]*\b(?:slot|time\s*slot|appointment|visit|horário|hora)\b[^.!?\n]*\b(?:taken|unavailable|booked|not\s+available|no\s+longer\s+available|just\s+got\s+taken|already\s+(?:taken|booked)|foi\s+ocupad|ocupad)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/[^.!?\n]*\b(?:can|could|would)\b[^.!?\n]*\b(?:pick|choose|select|suggest|prefer)\b[^.!?\n]*\b(?:another|different|other)\b[^.!?\n]*\b(?:time|day|slot|date|hora|dia)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (
    /\b(?:slot|appointment|horário|hora)\b[^.!?\n]{0,60}\b(?:taken|unavailable|booked|not\s+available|no\s+longer)\b/i.test(cleaned) ||
    /\b(?:taken|unavailable|booked)\b[^.!?\n]{0,60}\b(?:slot|appointment|horário)\b/i.test(cleaned) ||
    /\bcan you (?:pick|choose|suggest|select) (?:another|a different)\b/i.test(cleaned)
  ) {
    cleaned = "You're welcome, see you then!";
  }

  return cleaned || "You're welcome, see you then!";
}

// ─── [BOOK:...] processor ─────────────────────────────────────────────────
async function processBookingCommand(
  aiResponse: string,
  waId: string,
  conversationId: string,
  isAlreadyBooked: boolean,
  lang: "es" | "en",
  isReschedule: boolean = false,
  history: Array<{ role: string; content: string }> = []
): Promise<{ response: string; booked: boolean }> {
  if (isAlreadyBooked && !isReschedule) {
    return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
  }
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return { response: aiResponse, booked: false };
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // DETERMINISTIC weekday↔date guard: the model sometimes writes the wrong
    // day's date for the weekday the client picked (a "Thursday" visit was
    // booked on Friday, 2026-07-16). Snap it back before anything is written.
    if (bookingData.date) {
      const rec = reconcileBookingWeekday(bookingData.date, history);
      if (rec.corrected) {
        console.warn(`[WA] booking date corrected: ${rec.reason}`);
        bookingData.date = rec.date;
      }
    }

    // SLOT CONFIRMATION guard: never book a day/time the client never picked
    // (RODOLFO, 2026-07-16: booked off a volunteered address+phone with no slot
    // chosen). Address and phone are not slot selections.
    if (bookingData.date && bookingData.time && !clientConfirmedSlot(history)) {
      console.warn(`[WA] booking blocked — client never picked a specific slot; asking to choose`);
      return { response: needSlotConfirmationMessage(lang), booked: false };
    }

    // ── Reschedule: move the existing visit to the new date/time. Address/phone
    //    are copied from the saved booking, so only the new date/time are needed. ──
    if (isReschedule) {
      if (!bookingData.date || !bookingData.time) {
        return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
      }
      const r = await rescheduleClientBooking(`wa_${waId}`, bookingData.date, bookingData.time, {
        name: bookingData.name,
        phone: (isRealPhoneNumber(bookingData.phone) ? bookingData.phone.trim() : waId),
        address: bookingData.address,
        notes: bookingData.notes,
      });
      if (r.success) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conversationId);
        // FUNIL: remarcação confirmada → agendamento_marcado com a NOVA data.
        waitUntil(funilOnBookingConfirmed(conversationId, `wa_${waId}`, {
          date: bookingData.date, time: bookingData.time, phone: bookingData.phone ?? waId, name: bookingData.name,
        }));
        return { response: rescheduleSuccessMessage(lang), booked: true };
      }
      // Do NOT pause: an automatic failure must never permanently silence the lead
      // (mode="human" is only for a deliberate owner takeover).
      console.warn(`[WA] Reschedule failed (${r.error}) for ${bookingData.date} ${bookingData.time} — handing off (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    }

    // On WhatsApp the client's phone number is ALWAYS known (it is the chat id),
    // so we only require the address. Use the number the client typed ONLY if it
    // is a real phone; otherwise fall back to the WhatsApp chat number so a stray
    // non-number (e.g. "Messenger") never overwrites the real, dialable number.
    const clientPhone = (isRealPhoneNumber(bookingData.phone) ? bookingData.phone.trim() : waId).slice(0, 30);
    // Address must be REAL — the model once wrote the literal "pending" to slip
    // past a bare empty-check (2026-07-17 review). Ask for it instead of
    // shipping a "confirmed" text without an actual booking behind it.
    if (!isRealAddress(bookingData.address)) {
      console.warn(`[WA] booking blocked — address not usable (${JSON.stringify(bookingData.address ?? null)}); asking for it`);
      return { response: needAddressMessage(lang), booked: false };
    }
    // Owner rule (2026-07-27): the visit is confirmed ONLY with the client's
    // NAME, address, and phone — all given by the client in the conversation
    // (on WhatsApp the phone is the chat id, so name + address are asked). A
    // profile pushname is not the client giving their name; if they never
    // typed it, ask for it instead of booking.
    if (!clientProvidedName(bookingData.name, history)) {
      console.warn(`[WA] booking blocked — client never gave their name (${JSON.stringify(bookingData.name ?? null)}); asking for it`);
      return { response: needNameMessage(lang), booked: false };
    }

    // Always book under the real client name: prefer a name the client typed,
    // then the saved WhatsApp contact name. Never just "Client".
    const { data: convName } = await supabaseAdmin
      .from("instagram_conversations")
      .select("name, username")
      .eq("id", conversationId)
      .single();
    const clientName = resolveClientName(
      [bookingData.name, convName?.name, convName?.username],
      "WhatsApp Client"
    );

    const result = await createBooking({
      clientName,
      clientPhone,
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: (bookingData.notes ?? "") + " | WhatsApp",
      creative: "WhatsApp",
      igsid: `wa_${waId}`,
    });

    if (result.success) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      // FUNIL: visita confirmada → agendamento_marcado (data_visita em ISO).
      waitUntil(funilOnBookingConfirmed(conversationId, `wa_${waId}`, {
        date: bookingData.date, time: bookingData.time, phone: clientPhone, name: bookingData.name,
      }));
      return { response: bookingSuccessMessage(lang), booked: true };
    } else if (result.error === "already_booked") {
      console.warn("[WA] Duplicate booking blocked by scheduler guard");
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
    }

    // Slot the client picked is full but OTHER slots may be open: offer the
    // soonest remaining one instead of handing off (never say it was "taken").
    // Keep the AI active so the client's next pick books normally.
    if (/^No availability/i.test(result.error ?? "")) {
      const recovery = await slotConflictRecoveryMessage(lang);
      if (recovery) {
        console.warn(`[WA] Slot ${bookingData.date} ${bookingData.time} full — offering alternative slots`);
        return { response: recovery, booked: false };
      }
    }

    // Booking genuinely failed (scheduler error, or nothing open at all). NEVER
    // tell the client a false "slot just taken". Hand the hot lead to Ozzi but do
    // NOT pause the bot: an automatic failure must never permanently silence the
    // lead (mode="human" is only for a deliberate owner takeover).
    console.warn(`[WA] Booking failed (${result.error}) for ${bookingData.date} ${bookingData.time} — handing off to owner (staying active)`);
    return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
  } catch (err) {
    console.error("WA booking error:", err);
    return { response: aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim(), booked: false };
  }
}

// ─── [NOTIFY_OWNER] processor ─────────────────────────────────────────────
async function processNotifyOwner(
  aiResponse: string,
  conversationId: string,
  clientName: string | null,
  clientId: string
): Promise<string> {
  if (!/\[NOTIFY_OWNER\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[NOTIFY_OWNER\]/gi, "").trim();
  try {
    const { data: recentMsgs } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(8);
    await notifyOwners({
      platform: "WhatsApp",
      clientName,
      clientId,
      recentMessages: (recentMsgs ?? []).reverse(),
    });
  } catch (err) {
    console.error("WA processNotifyOwner error:", err);
  }
  return clean;
}

// ─── [CANCEL_BOOKING] processor ──────────────────────────────────────────
async function processCancelCommand(
  aiResponse: string,
  waId: string,
  conversationId: string
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();
  try {
    const result = await cancelClientBooking(`wa_${waId}`);
    if (result.success) {
      console.log(`WA: Cancelled ${result.cancelled} booking(s) for ${waId}`);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: false })
        .eq("id", conversationId);
    }
  } catch (err) {
    console.error("WA cancel error:", err);
  }
  return clean;
}

// ─── Click-to-WhatsApp ad referral extraction ─────────────────────────────
// A lead that taps an Instagram/Facebook "Click to WhatsApp" ad arrives with the
// ad's referral context (Meta fields: source_id, headline, body, source_url,
// image/thumbnail). Z-API's wrapper key for this varies by version, so scan the
// likely locations defensively and never throw on a shape we don't recognize.
// Whatever we find feeds the type-first logic so a TILE ad never gets the vinyl
// $5 pitch. Returns null when there is no ad context (a normal organic message).
function extractWaAdReferral(
  body: Record<string, unknown>
): { adId?: string; adTitle?: string; adImage?: string; adVideo?: string; sourceUrl?: string; sourceType?: string; ctwaClid?: string } | null {
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const candidates = [
    body.referral, body.referralMessage, body.adReferral, body.conversionSource, body.ctwaContext,
    asObj(body.message)?.referral, asObj(body.text)?.referral, asObj(body.notification)?.referral,
  ]
    .map(asObj)
    .filter((x): x is Record<string, unknown> => !!x);
  for (const r of candidates) {
    const get = (...keys: string[]) => {
      for (const k of keys) {
        const v = r[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return undefined;
    };
    const adId = get("source_id", "sourceId", "ad_id", "adId", "id");
    const headline = get("headline", "title", "ad_title", "adTitle");
    const bodyTxt = get("body", "sourceBody", "description", "caption");
    const sourceUrl = get("source_url", "sourceUrl", "url");
    // source_type oficial da Meta: "ad" | "post" (Z-API pode renomear)
    const sourceType = get("source_type", "sourceType", "source");
    const adImage = get("image_url", "imageUrl", "thumbnail_url", "thumbnailUrl", "media_url", "mediaUrl", "thumbnail");
    const adVideo = get("video_url", "videoUrl");
    // ctwa_clid: id do clique CTWA (Cloud API oficial) — necessário p/ Conversions
    // API business_messaging; a Z-API pode repassar com nome próprio, então
    // cobrimos as variantes prováveis (auditoria 28/07).
    const ctwaClid = get("ctwa_clid", "ctwaClid", "ctwa_click_id", "ctwaClickId", "click_id", "clickId");
    const adTitle = [headline, bodyTxt].filter(Boolean).join(" ") || undefined;
    if (adId || adTitle || adImage || adVideo || sourceUrl || ctwaClid) return { adId, adTitle, adImage, adVideo, sourceUrl, sourceType, ctwaClid };
  }
  return null;
}

// Recursively collect every string value in a payload (bounded), so we can scan
// the WHOLE Z-API body for the ad's own text without guessing which wrapper key
// holds the Click-to-WhatsApp referral. A tile ad's headline ("1000 sq.ft. TILE
// INSTALLATION...") lands somewhere in that tree; this finds it wherever it is.
function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 4 || out.length > 300) return;
  if (typeof v === "string") { if (v.length < 600) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out, depth + 1); return; }
  if (v && typeof v === "object") { for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1); }
}

// ─── Main message handler ─────────────────────────────────────────────────
async function handleWaMessage(body: Record<string, unknown>) {
  try {
    const { data: waSetting } = await supabaseAdmin
      .from("platform_settings")
      .select("paused")
      .eq("platform", "whatsapp")
      .single();
    if (waSetting?.paused) return;

    if (body.type !== "ReceivedCallback") return;
    if (body.fromMe === true) {
      // A message sent FROM the business number (arrives when Z-API "notify
      // sent by me" is enabled). The bot's own API sends also come through
      // here — skip those via recent-history match. A HUMAN typing from the
      // business phone is an owner takeover: record it as [Treino] and pause
      // the conversation so the bot never contradicts the owner (same fix as
      // FB/IG, 2026-07-08: the bot re-offered slots right after the owner
      // manually offered one and the client accepted).
      const ownText = (body.text as { message?: string } | undefined)?.message;
      const peerPhone = body.phone as string | undefined;
      if (ownText && peerPhone) {
        const { data: ownConv } = await supabaseAdmin
          .from("instagram_conversations")
          .select("id")
          .eq("igsid", `wa_${peerPhone}`)
          .maybeSingle();
        if (ownConv?.id) {
          // RACE GUARD: the bot's own send can echo back BEFORE its history
          // insert commits (both happen within the same second). Check, and if
          // no match, wait and check AGAIN before declaring this a human reply
          // — wrongly pausing a conversation on the bot's own echo would
          // silence a live lead.
          const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const matchesRecentBot = async () => {
            const { data: recentBot } = await supabaseAdmin
              .from("instagram_messages")
              .select("content")
              .eq("conversation_id", ownConv.id)
              .eq("role", "assistant")
              .order("created_at", { ascending: false })
              .limit(5);
            return (recentBot ?? []).some((m) => norm(m.content) === norm(ownText));
          };
          let isOwnEcho = await matchesRecentBot();
          if (!isOwnEcho) {
            await new Promise((r) => setTimeout(r, 3000));
            isOwnEcho = await matchesRecentBot();
          }
          if (!isOwnEcho) {
            await supabaseAdmin.from("instagram_messages").insert({ conversation_id: ownConv.id, role: "assistant", content: `[Treino] ${ownText}` });
            await supabaseAdmin.from("instagram_conversations").update({ mode: "human" }).eq("id", ownConv.id);
            console.log(`[WA] owner manual reply captured — conversation ${ownConv.id} paused (mode=human)`);
          }
        }
      }
      return;
    }

    const phone = body.phone as string;
    if (!phone) return;

    const messageId = body.messageId as string;
    if (!messageId) return;

    // Deduplicate
    const { data: already } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("instagram_msg_id", messageId)
      .maybeSingle();
    if (already) return;

    // Find or create conversation (igsid = "wa_{phone}")
    const waIgsid = `wa_${phone}`;
    let { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", waIgsid)
      .single();

    const wasNewConv = !conv;

    if (!conv) {
      const { data: newConv, error: convErr } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: waIgsid, mode: "agent" })
        .select()
        .single();
      if (convErr) {
        // Two near-simultaneous messages from a new contact can race to create
        // the conversation; the loser hits the unique igsid constraint. Recover
        // the row instead of dropping the message.
        const { data: existing } = await supabaseAdmin
          .from("instagram_conversations")
          .select("*")
          .eq("igsid", waIgsid)
          .single();
        conv = existing ?? null;
      } else {
        conv = newConv;
      }
    }
    if (!conv) return;

    // Extract message content by type
    const textObj = body.text as Record<string, unknown> | undefined;
    const imageObj = body.image as Record<string, unknown> | undefined;
    const audioObj = body.audio as Record<string, unknown> | undefined;
    const videoObj = body.video as Record<string, unknown> | undefined;
    const documentObj = body.document as Record<string, unknown> | undefined;

    let rawText = "";
    let imageUrl: string | null = null;
    let audioUrl: string | null = null;

    if (textObj?.message) {
      rawText = textObj.message as string;
      if (rawText && !rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{1F900}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}]/gu, "").trim()) return;
    } else if (imageObj?.imageUrl) {
      imageUrl = imageObj.imageUrl as string;
      rawText = "[floor plan or photo]";
    } else if (audioObj?.audioUrl) {
      audioUrl = audioObj.audioUrl as string;
      rawText = "[voice message]";
    } else if (videoObj) {
      rawText = "[video]";
    } else if (documentObj) {
      rawText = "[document]";
    }

    if (!rawText) return;

    // Pre-fetch image
    let preFetchedImageBase64: string | null = null;
    if (imageUrl) {
      preFetchedImageBase64 = await downloadZApiImage(imageUrl).catch(() => null);
    }

    // Store message immediately
    const { data: insertedMsg, error: insertErr } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conv.id,
        role: "user",
        content: rawText,
        instagram_msg_id: messageId,
      })
      .select("id, created_at")
      .single();

    if (insertErr && insertErr.code !== "23505") return;
    const thisMessageId = insertedMsg?.id ?? "";

    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conv.id);

    // ── FUNIL → Ozzi Plataforma (fire-and-forget, nunca bloqueia) ──
    // lead_criado (1ª mensagem, canal whatsapp, telefone = próprio número),
    // conversando (1ª resposta real) e retomou_conversa. Antes do gate
    // mode=human de propósito: a resposta do cliente conta para o funil mesmo
    // com o dono no controle. Só quando ESTA instância inseriu a mensagem.
    // ATRIBUIÇÃO (auditoria 28/07): o referral do anúncio CTWA agora VAI JUNTO
    // — antes era extraído mais abaixo e nunca chegava ao lead da plataforma.
    const adRefFunil = extractWaAdReferral(body);
    const referralFunilWa = adRefFunil
      ? {
          ad_id: adRefFunil.adId, // source_id do WhatsApp = ad_id do contrato
          ctwa_clid: adRefFunil.ctwaClid,
          source: adRefFunil.sourceType, // source_type ("ad"/"post") → ad_source_type
          // clicked_at = momment do callback Z-API (ms) — proxy do clique CTWA
          clicked_at: new Date(Number(body.momment) || Date.now()).toISOString(),
          ads_context_data: { ad_title: adRefFunil.adTitle, photo_url: adRefFunil.adImage, video_url: adRefFunil.adVideo },
        }
      : undefined;
    if (adRefFunil) {
      console.log("[FUNIL] referral cru (wa):", JSON.stringify(adRefFunil).slice(0, 400));
      // P0: captura crua persistente (só os objetos de referral, sem texto do cliente)
      waitUntil(capturarRawFunil("wa", { extraido: adRefFunil, chaves_do_body: Object.keys(body).slice(0, 40) }));
    }
    if (insertedMsg?.id) {
      waitUntil(
        funilOnInboundMessage(
          { id: conv.id, igsid: conv.igsid, name: conv.name, username: conv.username, created_at: conv.created_at },
          rawText,
          insertedMsg.created_at ?? new Date().toISOString(),
          referralFunilWa
        )
      );
      waitUntil(maybeRunFunilSilenceCheck()); // sweep parou_de_responder, no máx. a cada 6h
    }

    if (conv.mode === "human") {
      // Cliente de FOLLOW-UP respondeu com a conversa em modo humano: a cadência
      // da plataforma PRECISA parar mesmo assim — o encerramento não pode
      // depender do bot estar ativo (caso Grittel 2026-07-25: mode=human desde
      // o handoff, ela respondeu 3x e o drip continuou D3/D7).
      waitUntil(
        (async () => {
          const quoteCtx = await findQuoteFollowupContext(conv.id);
          if (quoteCtx) await enviarEventoFunil("followup_respondeu", { telefone: phone });
        })().catch((e) => console.error("[WA] followup_respondeu (human mode) error:", e))
      );
      // Paused conversation black hole: ping the owner (throttled) if the
      // client keeps writing with nobody answering for over an hour.
      const pausedText = rawText;
      waitUntil(
        (async () => {
          const { data: lastBot } = await supabaseAdmin
            .from("instagram_messages")
            .select("created_at")
            .eq("conversation_id", conv.id)
            .eq("role", "assistant")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          await alertPausedBacklog({
            conversationId: conv.id,
            channel: "whatsapp",
            clientName: conv.name ?? conv.username ?? null,
            clientId: conv.igsid,
            lastHumanReplyAt: lastBot?.created_at ?? null,
            clientText: pausedText,
          });
        })().catch((e) => console.error("[WA] paused-backlog alert error:", e))
      );
      return;
    }

    // Debounce
    await new Promise((r) => setTimeout(r, RESPONSE_DELAY_MS));
    const { data: latestMsg } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .single();
    if (!latestMsg || latestMsg.id !== thisMessageId) return;

    // Re-fetch conversation BEFORE rate limit (catches booking_confirmed set by concurrent handler)
    const { data: freshConv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("id", conv.id)
      .single();
    if (freshConv) conv = freshConv;

    // ── Pause guard (post-debounce) ───────────────────────────────────────
    // Owner may have paused this conversation during the 10s debounce. freshConv
    // has the live mode — honor it before spending an AI call.
    if (conv.mode === "human") {
      console.log("[WA] Conversation paused during debounce — staying silent");
      return;
    }

    // Returning client who booked outside the bot (in person, manually): treat
    // as booked ONLY while a visit is actually upcoming. A client whose visit
    // is already behind us is a normal lead again — the old "never re-engage"
    // latch silenced quote requests and callbacks for WEEKS (2026-07-21 review).
    // Only checked for existing conversations to avoid slowing new leads.
    if (!wasNewConv && !(conv as Record<string, unknown>).booking_confirmed) {
      const served = await getClientBookingSnapshot(waIgsid);
      if (served?.upcoming) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conv.id);
        (conv as Record<string, unknown>).booking_confirmed = true;
      }
    }

    // ── Stale booked flag: booking_confirmed only means "stay out of the way"
    //    while the visit is UPCOMING. Once the scheduler shows no future visit,
    //    reset the flag and let the client flow normally (with a PAST VISIT note
    //    so the model doesn't cold-pitch). Scheduler unreachable → keep legacy
    //    booked behavior (fail safe, never fail chatty). The quote-followup
    //    intercept below still runs first for cadence clients (marker-based). ──
    let isBooked = !!(conv as Record<string, unknown>).booking_confirmed;
    let bookedVisit: { date: string; time: string } | null = null;
    let pastVisitNote: string | null = null;
    if (isBooked) {
      const snap = await getClientBookingSnapshot(waIgsid);
      if (snap && !snap.upcoming) {
        console.log("[WA] booked flag is stale (no upcoming visit) — re-engaging as a normal client");
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: false }).eq("id", conv.id);
        (conv as Record<string, unknown>).booking_confirmed = false;
        isBooked = false;
        pastVisitNote = pastVisitSystemNote(snap.lastPast);
      } else if (snap?.upcoming) {
        bookedVisit = snap.upcoming;
      }
    }

    // ── Reschedule intent: a booked client moving their visit is the one case we
    //    engage after a booking. Keep engaging while a reschedule is in progress
    //    (last assistant message offered slots), so the follow-up that just names
    //    the new day is still routed through the reschedule flow. ──
    let engageReschedule = isBooked && isRescheduleRequest(rawText);
    // Burst-aware: the 10s debounce means only the LAST bubble is judged, but
    // the reschedule intent may live in an earlier bubble of the same burst
    // (real IG silence 2026-07-20). Judge the whole un-answered burst.
    let gateBurst = "";
    if (isBooked && !engageReschedule) {
      const { data: burstMsgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(10);
      gateBurst = unansweredUserBurst((burstMsgs ?? []).reverse());
      if (gateBurst && isRescheduleRequest(gateBurst)) engageReschedule = true;
    }
    if (isBooked && !engageReschedule && !isPureClosing(rawText)) {
      const { data: lastAsst } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAsst?.content && containsSchedulingOffer(lastAsst.content)) engageReschedule = true;
    }

    // ── Cliente de FOLLOW-UP DE ORÇAMENTO respondeu ────────────────────────
    // A visita já aconteceu e a plataforma mandou follow-up (financiamento)
    // pelo /api/enviar — o histórico carrega o marcador [SYSTEM: QUOTE_FOLLOWUP].
    // INDEPENDE de booking_confirmed: a maior parte da carteira veio do Lovable
    // e nunca agendou pelo bot, então sem este bloco a resposta cairia no funil
    // de VENDA NOVA (o bot tentaria marcar outra visita do zero). Responde com
    // o cérebro estreito de quote-reply (financiamento, dúvidas do orçamento,
    // handoff pro Ozzi). Antes disso, quem era "booked" ouvia SILÊNCIO e quem
    // não era caía no funil errado — a campanha morria nos dois caminhos.
    if (!engageReschedule) {
      try {
        const quoteCtx = await findQuoteFollowupContext(conv.id);
        if (quoteCtx) {
          // Cliente de follow-up RESPONDEU (qualquer coisa): avisa a plataforma
          // para ENCERRAR a cadência automática deste telefone na hora — a
          // conversa agora é conduzida aqui/pelo Ozzi, nunca mais por drip.
          // (Caso real 2026-07-19: "I pay full" e o D7 continuava agendado.)
          await enviarEventoFunil("followup_respondeu", { telefone: phone });
          if (isPureClosing(rawText)) {
            console.log("[WA] quote-reply: fechamento puro, ficando em silêncio");
            return;
          }
          const { data: recentMsgs } = await supabaseAdmin
            .from("instagram_messages")
            .select("role, content")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(12);
          const historico = (recentMsgs ?? []).reverse();
          const reply = await composeQuoteReply({ ctx: quoteCtx, history: historico, clientText: rawText });
          const sent = await sendWhatsAppMessage(phone, reply.text);
          if (sent.ok) {
            await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: reply.text });
            await supabaseAdmin.from("instagram_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
            if (reply.notifyOwner) {
              await notifyOwners({
                platform: "WhatsApp",
                clientName: conv.username ?? null,
                clientId: phone,
                recentMessages: [...historico.slice(-7), { role: "assistant", content: reply.text }],
                alert: "Cliente de follow-up de orçamento precisa de você (negociação, dúvida ou quer fechar).",
              });
            }
            console.log(`[WA] quote-reply enviado (${reply.source}) notify=${reply.notifyOwner}`);
            return;
          }
          console.error(`[WA] quote-reply falhou no envio: ${sent.error} — avisando o dono`);
          await notifyOwners({
            platform: "WhatsApp",
            clientName: conv.username ?? null,
            clientId: phone,
            recentMessages: historico.slice(-8),
            alert: "Cliente de follow-up de orçamento respondeu e o envio da resposta falhou.",
          }).catch(() => {});
          return;
        }
      } catch (err) {
        console.error("WA quote-reply error (seguindo o fluxo normal):", err);
      }
    }

    // ── Booked client asking about their OWN visit ("Are you coming at 3?",
    //    "Which day, Tuesday?") → deterministic answer with the real booked
    //    date/time. No model call, so it can never invent a date; the owner is
    //    still notified. ──
    if (isBooked && !engageReschedule && bookedVisit && (isVisitDetailQuestion(rawText) || isVisitDetailQuestion(gateBurst))) {
      const details = visitDetailsMessage(detectLang(`${rawText} ${gateBurst}`), bookedVisit.date, bookedVisit.time);
      const { data: lastBotForDup } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!(lastBotForDup?.content && isConsecutiveDuplicate([{ role: "assistant", content: lastBotForDup.content }], details))) {
        const detailsSent = await sendWhatsAppMessage(phone, details);
        if (!detailsSent.ok) await reportSendFailure("whatsapp", phone, detailsSent.error ?? "unknown");
        else await supabaseAdmin.from("instagram_messages").insert({
          conversation_id: conv.id,
          role: "assistant",
          content: details,
        });
      }
      try {
        const { data: recentMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(8);
        await notifyOwners({
          platform: "WhatsApp",
          clientName: conv.username ?? null,
          clientId: phone,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("WA visit-details notify error:", err);
      }
      return;
    }

    // If already booked (and NOT rescheduling) → notify owner silently, no message
    if (isBooked && !engageReschedule) {
      try {
        const { data: recentMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(8);
        await notifyOwners({
          platform: "WhatsApp",
          clientName: conv.username ?? null,
          clientId: phone,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("WA post-booking notify error:", err);
      }
      return;
    }

    // Rate limit: 5s window prevents genuine duplicates without blocking fast
    // client replies. EXCEPTION: a message carrying booking info (a street address
    // or a phone number) may be the one that COMPLETES the booking, so it must
    // never be silently dropped. A redundant "what's the address?" reply sent
    // moments earlier (when the slot and address arrive as two separate turns)
    // would otherwise rate-limit this turn and leave the visit unbooked — the
    // exact screenshot bug.
    const carriesBookingInfo = containsBookingInfo(rawText);
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "assistant")
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .limit(1);
    if (recentReply && recentReply.length > 0 && !carriesBookingInfo) return;

    // Process media
    let enrichedText = rawText;
    let mediaProcessed = false;

    if (imageUrl && preFetchedImageBase64) {
      try {
        const analysis = await analyzeImageFromBase64(preFetchedImageBase64);
        if (analysis && !analysis.toLowerCase().includes("could not") && analysis.length > 20) {
          enrichedText = `[Floor plan analysis: ${analysis}]`;
          mediaProcessed = true;
        }
      } catch { /* ignore */ }
    }

    if (audioUrl) {
      try {
        const audioData = await downloadZApiAudio(audioUrl);
        if (audioData && audioData.buffer.byteLength > 1000) {
          const transcript = await transcribeAudioFromBuffer(audioData.buffer, audioData.contentType);
          if (transcript && !transcript.includes("please type") && !transcript.includes("no speech")) {
            enrichedText = transcript;
            mediaProcessed = true;
          }
        }
      } catch { /* ignore */ }
    }

    const isPlainText = !!textObj?.message;
    const hasRealContent = isPlainText || mediaProcessed;

    if (!hasRealContent) {
      const fallback = imageUrl
        ? "Got your photo! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need."
        : "Got your message! Could you type your question?";
      // Dedup: a client re-sending an unsupported attachment (e.g. two PDFs in a
      // row) used to get this identical canned line each time — a robotic repeat
      // (rule 29). Once is enough; stay silent on the repeat.
      const { data: lastBot } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1);
      if (lastBot?.[0] && isConsecutiveDuplicate([{ role: "assistant", content: lastBot[0].content }], fallback)) {
        console.log("[WA] no-content fallback identical to last reply — staying silent (no robotic repeat)");
        return;
      }
      const noContentSent = await sendWhatsAppMessage(phone, fallback);
      if (!noContentSent.ok) await reportSendFailure("whatsapp", phone, noContentSent.error ?? "unknown");
      else await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
      return;
    }

    // Job seeker / service provider → do not respond at all (message still stored).
    if (isJobSeeker(enrichedText)) {
      console.log("[WA] Job seeker / service offer — staying silent");
      return;
    }

    // Update stored message with enriched content
    await supabaseAdmin.from("instagram_messages").update({ content: enrichedText }).eq("instagram_msg_id", messageId);

    // Save contact name if available
    const senderName = body.senderName as string | undefined;
    const chatName = body.chatName as string | undefined;
    const contactName = senderName || chatName;
    if (contactName && !conv.username) {
      await supabaseAdmin.from("instagram_conversations").update({
        username: contactName,
        updated_at: new Date().toISOString(),
      }).eq("id", conv.id);
    }

    // Capture Click-to-WhatsApp ad context so the type-first logic below knows the
    // ad's flooring type (a TILE ad must never get the vinyl $5 pitch).
    // AUDITORIA 28/07: as colunas ad_id/ad_title/creative_url NÃO EXISTEM em
    // instagram_conversations (update falhava silencioso desde sempre) — a
    // persistência real é a chave funil_ad_ (mesmo canal usado pelo IG/FB);
    // o Object.assign local continua para a lógica type-first desta request.
    const adRef = adRefFunil;
    if (adRef) {
      const c = conv as Record<string, unknown>;
      const upd: Record<string, unknown> = {};
      if (adRef.adId && !c.ad_id) upd.ad_id = adRef.adId;
      if (adRef.adTitle && !c.ad_title) upd.ad_title = adRef.adTitle;
      if (adRef.adImage && !c.creative_url) upd.creative_url = adRef.adImage;
      if (Object.keys(upd).length) Object.assign(c, upd);
      waitUntil(persistirAnuncioDaConversa(conv.id, referralFunilWa ?? null));
    }

    // Robust type capture from the FIRST message's raw payload: the ad's own text
    // (e.g. a "TILE INSTALLATION" headline) may sit under a Z-API key we don't
    // recognize, so scan the whole body and persist a clearly-detected type. Only
    // on the opening message (before any bot reply), so a later quoted bubble that
    // lists all three options can never mis-tag the conversation.
    if (wasNewConv && !(conv as Record<string, unknown>).ad_title) {
      const strings: string[] = [];
      collectStrings(body, strings);
      const scannedType = detectAdFlooringType(strings.join(" "));
      if (scannedType) {
        // só em memória: a coluna ad_title não existe no banco (o update antigo
        // falhava silencioso) e o marcador [TIPO] não é nome de criativo
        Object.assign(conv as Record<string, unknown>, { ad_title: `[${scannedType}]` });
        console.log("[WA AD] flooring type from payload scan:", scannedType);
      }
    }

    // Load memories in parallel with timeout
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]).catch(() => null);

    const memoryStoreId: string | null = (conv as Record<string, unknown>).memory_store_id as string ?? null;
    let newMemoryStoreId = memoryStoreId;
    if (!newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      try {
        newMemoryStoreId = await createClientMemoryStore(waIgsid, conv.username ?? contactName);
        await supabaseAdmin.from("instagram_conversations").update({ memory_store_id: newMemoryStoreId }).eq("id", conv.id);
      } catch { /* ignore */ }
    }

    const [memoryContext, systemMemory] = await Promise.all([
      newMemoryStoreId ? withTimeout(readClientMemory(newMemoryStoreId), 3000) : Promise.resolve(null),
      process.env.ANTHROPIC_API_KEY
        ? withTimeout(getOrCreateSystemStore().then((id) => readSystemMemory(id)), 3000)
        : Promise.resolve(null),
    ]);

    // Load conversation history (created_at feeds the repeated-message
    // intercept so it can tell a double-tap from a genuine re-ask hours later)
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: false })
      .limit(15);
    const history = (historyRaw ?? []).reverse();

    // The 15-message window can be ALL client bubbles when a conversation
    // accumulated many un-answered messages (the pre-fix booked-silence). Every
    // guard that anchors on "the last assistant message" (first-contact opener,
    // duplicate-send, closing-burst walk-back) then sees a fake first contact —
    // a real client asking about her quote got the canned opener this way
    // (Rosy, 2026-07-21). Keep at least the latest assistant reply in context.
    if (history.length > 0 && !history.some((m: { role: string }) => m.role === "assistant")) {
      const { data: lastAsstMsg } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAsstMsg) history.unshift(lastAsstMsg);
    }

    // DB flag only — history fallback removed: it kept firing after cancellations
    // because "Appointment confirmed" stays in history even after booking_confirmed=false.
    // When a booked client is rescheduling, treat as NOT confirmed this turn so the
    // bot engages (offers new slots) instead of staying silent.
    const isRescheduling = isBooked && engageReschedule;
    const isBookingConfirmed = isBooked && !isRescheduling;

    // Date context — always Eastern (server runs UTC; see scheduler helpers)
    const dateContext = getEasternDateContext();

    // Detect conversation language so confirmation/recovery messages match it
    const lang = detectLang(history.map((m) => m.content).join(" "));

    type AiMsg = { role: "user" | "assistant"; content: string; at?: string };
    let messagesForAI: AiMsg[] = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content, at: m.created_at as string | undefined }));

    const lastIdx = messagesForAI.length - 1;
    if (lastIdx >= 0 && messagesForAI[lastIdx].role === "user") {
      // Only load availability when booking not yet confirmed
      const availability = isBookingConfirmed ? null : await getRealAvailabilityContext();
      const systemParts: string[] = availability ? [dateContext, availability] : [dateContext];
      const isOwnerHandled = !isBookingConfirmed && history.some((m: { role: string; content: string }) =>
        m.role === "assistant" && m.content?.startsWith("[Treino]") && !isStructuredCorrection(m.content)
      );
      if (isBookingConfirmed) {
        systemParts.push("[BOOKING ALREADY CONFIRMED: The appointment is set. Do NOT answer any question or continue the conversation. For ANY message the client sends — thank-you, question, or anything else — respond with EXACTLY ONE short sentence redirecting them to Ozzi, then add [NOTIFY_OWNER]. Example: 'I\\'ll connect you with Ozzi for anything else you need![NOTIFY_OWNER]' NEVER generate [BOOK:...]. NEVER say any slot is taken or unavailable. NEVER answer questions directly.]");
      }
      if (isOwnerHandled) {
        systemParts.push("[RETURNING CLIENT: This person already had work done or the owner personally handled them. Do not use the sales flow. Greet warmly and add [NOTIFY_OWNER].]");
      }
      if (pastVisitNote) {
        systemParts.push(pastVisitNote);
      }
      if (isRescheduling) {
        // CANCEL intent gets its own framing: routing "I need to cancel" into a
        // note that says the client "wants to MOVE the visit" made the model push
        // invented slots and never emit [CANCEL_BOOKING] (Priscilla, 2026-07-17).
        systemParts.push(isCancelRequest(rawText)
          ? "[RESCHEDULE MODE, CANCEL INTENT: This client has a confirmed visit and asked to CANCEL it. If they only want to cancel, acknowledge warmly in ONE sentence and end with [CANCEL_BOOKING]. You MAY lightly offer to pick another day instead, but NEVER push slots, NEVER state or assume a day or time they did not pick themselves, and NEVER claim any day works for them. Address them by name ONLY if certain it is the client's own name, otherwise use no name. If they clearly ask to move to a specific new day/time, treat it as a reschedule: offer slots from the schedule above and generate [BOOK:...] once they confirm.]"
          : "[RESCHEDULE MODE: This client already has a confirmed visit and wants to MOVE it to a different day or time. Acknowledge warmly, offer new open slots from the schedule above (or check the day they named), and the moment they confirm a new day and time, generate [BOOK:...] with the NEW date and time. Do NOT ask for the address or phone again, you already have them. Follow all date-integrity and availability rules.]");
      }
      if (!isBookingConfirmed && !isRescheduling) {
        // WhatsApp: the client's phone number is already known from the chat.
        systemParts.push(`[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the client's name and the property address. NEVER ask the client for their phone number. Once you have a confirmed day/time, the client's name, and the address, generate [BOOK:...] using "${phone}" as the phone.]`);
        const recentUserTexts = history
          .filter((m: { role: string; content: string }) => m.role === "user")
          .slice(-3)
          .map((m: { role: string; content: string }) => m.content);
        const detectedSqft = recentUserTexts.reduce<number | null>((found, t) => found ?? detectLargeLeadSqft(t), null);
        if (detectedSqft) {
          systemParts.push(`[LARGE LEAD ALERT: Client stated ${detectedSqft} sqft which is >= 500. This is a LARGE LEAD. You MUST propose the free in-person visit. Do NOT give any price or dollar amount by DM. Do NOT calculate "$X for this project". Respond with STEP 2B only.]`);
        }

        // ── TYPE FIRST (WhatsApp parity with IG/FB) ──────────────────────────
        // We advertise tile, vinyl, and hardwood at DIFFERENT rates, and the
        // worst error is pitching the $5 vinyl promo to a TILE-ad lead. So detect
        // the type from any captured ad data AND the client's own words; if known,
        // lock the bot to that product's terms; until it is known, inject the ad
        // note so the bot ASKS the type first and NEVER assumes vinyl.
        const convAny = conv as Record<string, unknown>;
        const userBlob = history
          .filter((m: { role: string; content: string }) => m.role === "user")
          .map((m: { role: string; content: string }) => m.content.split(/\n\n?\[SYSTEM:/)[0])
          .join(" ");
        const adSignals = [
          convAny.ad_title as string | undefined,
          convAny.creative_url as string | undefined,
          convAny.ad_id as string | undefined,
          userBlob,
        ];
        let adType = detectAdFlooringType(...adSignals);
        // Best-effort auto-detect from the ad creative (opening turn only, then
        // persisted so the tile answer survives later turns). Vision is trusted
        // only for a clear 'tile' verdict; ad TEXT is trusted for all three types.
        const adId = convAny.ad_id as string | undefined;
        if (!adType && adId && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          const ad = await withTimeout(fetchAdCreative(adId), 6000);
          if (ad?.text) resolved = detectAdFlooringType(ad.text);
          if (!resolved && ad?.imageUrl) {
            resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
          }
          if (!resolved && convAny.creative_url) {
            resolved = (await withTimeout(classifyAdCreativeType(convAny.creative_url as string), 6000)) === "tile" ? "tile" : null;
          }
          if (resolved) {
            adType = resolved;
            // só em memória: a coluna ad_title não existe (update falhava silencioso)
            Object.assign(convAny, { ad_title: `[${resolved}] ${(convAny.ad_title as string) ?? ""}`.trim() });
          }
        }
        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else {
          // Type unknown. Ask which type — but NEVER loop it: if the bot already
          // listed the three types 2+ times and the client still has not named
          // one (e.g. keeps replying "Ok"), STOP asking and pivot to the free
          // estimate. Repeating the identical question is the reported bug.
          const typeAskCount = history.filter(
            (m: { role: string; content: string }) =>
              m.role === "assistant" && /\btile\b/i.test(m.content) && /\bhardwood\b/i.test(m.content)
          ).length;
          if (typeAskCount >= 2) {
            systemParts.push("[TYPE STILL UNKNOWN, STOP ASKING: You already asked which flooring type (tile, vinyl, or hardwood) and the client has not answered. Do NOT ask the type again and do NOT assume vinyl or quote any price. Move forward warmly in ONE short sentence: offer a FREE in-person estimate so we confirm everything and give the exact price on site, and ask what day works. NEVER repeat the same type question again.]");
          } else {
            systemParts.push(AD_REPLY_NOTE);
          }
        }
      }
      const systemNote = `[SYSTEM: ${systemParts.join("\n\n")}]`;
      messagesForAI[lastIdx] = { ...messagesForAI[lastIdx], content: `${messagesForAI[lastIdx].content}\n\n${systemNote}` };
    }

    const ownerCorrections = isBookingConfirmed ? null : await loadGlobalCorrections();
    let rawAiResponse: string;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const aiResult = await getAIResponse(
        messagesForAI,
        memoryContext,
        systemMemory,
        ownerCorrections,
        isBookingConfirmed
      );
      rawAiResponse = aiResult.text;
      inputTokens = aiResult.inputTokens;
      outputTokens = aiResult.outputTokens;
    } catch (aiErr) {
      // AI down (credits exhausted, rate limit, timeout, network). Never leave the
      // client in silence: send a graceful holding reply, hand to a human, notify owner.
      console.error("[WA] AI generation failed — handing off to owner:", aiErr);
      // Burst guard: don't stack the "team will reach out" handoff on top of a
      // good reply that a parallel handler just sent for a rapid message burst.
      const { data: justReplied } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .gte("created_at", new Date(Date.now() - 30000).toISOString())
        .limit(1);
      if (justReplied && justReplied.length > 0) {
        console.log("[WA] AI failed but a reply was just sent — staying silent (no handoff)");
        return;
      }
      if (!isBookingConfirmed) {
        const fallback = aiOutageHandoffMessage(lang);
        // Outage dedup: during a sustained outage EVERY inbound hits this path —
        // one client once received this exact canned line 12 times in 90 minutes
        // (2026-07-06). If the last thing we sent is already this line, stay
        // silent; the client was told once and the owner was already notified.
        if (isConsecutiveDuplicate(messagesForAI, fallback)) {
          console.log("[WA] outage handoff already sent — staying silent (no repeat)");
          return;
        }
        try {
          const outageSent = await sendWhatsAppMessage(phone, fallback);
          if (!outageSent.ok) await reportSendFailure("whatsapp", phone, outageSent.error ?? "unknown");
          else await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
        } catch (sendErr) {
          console.error("[WA] Fallback send failed:", sendErr);
        }
        // Do NOT pause: an AI outage is transient. Leave the conversation in
        // "agent" mode so the next message retries once the API recovers.
        try {
          const { data: recentMsgs } = await supabaseAdmin
            .from("instagram_messages")
            .select("role, content")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(8);
          await notifyOwners({
            platform: "WhatsApp",
            clientName: conv.username ?? contactName ?? null,
            clientId: phone,
            recentMessages: (recentMsgs ?? []).reverse(),
            alert: isLowCreditError(aiErr) ? CREDIT_ALERT : null,
          });
        } catch (notifyErr) {
          console.error("[WA] AI-outage notify failed:", notifyErr);
        }
      }
      return;
    }

    // Pure closing / thanks with no new question → react to the message instead
    // of sending another text. Never overrides the post-booking flow. Burst-aware:
    // a trailing "thanks!" must NOT silence the model's answer to an earlier,
    // still-un-answered question that the 10s debounce folded into this turn.
    if (!isBookingConfirmed && (/\[REACT_ONLY\]/i.test(rawAiResponse) || isPureClosingBurst(history))) {
      await sendWhatsAppReaction(phone, messageId, "👍");
      console.log("[WA] React-only (closing/thanks) — reacted, no text sent");
      return;
    }

    let safeResponse = (isBookingConfirmed
      ? rawAiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim()
      : rawAiResponse
    ).replace(/\[REACT_ONLY\]/gi, "").trim();

    // Universal safety net: never tell a client a slot "just got taken" / "pick
    // another time" in any state. Skip only when a [BOOK] tag is present.
    if (!/\[BOOK:/i.test(safeResponse)) {
      safeResponse = stripSlotConflictLanguage(safeResponse);
    }

    // ── Final pause guard (pre-send) ──────────────────────────────────────
    // Generating the reply takes 10-20s; the owner may have paused this
    // conversation or the whole WhatsApp channel meanwhile. Re-check live state
    // before any outbound action so a mid-flight pause is respected.
    {
      const [{ data: liveConv }, { data: livePlatform }] = await Promise.all([
        supabaseAdmin.from("instagram_conversations").select("mode").eq("id", conv.id).single(),
        supabaseAdmin.from("platform_settings").select("paused").eq("platform", "whatsapp").single(),
      ]);
      if (liveConv?.mode === "human") {
        console.log("[WA] Paused mid-flight — aborting before send");
        return;
      }
      if (livePlatform?.paused) {
        console.log("[WA] WhatsApp channel paused mid-flight — aborting before send");
        return;
      }
    }

    // ── Stale-context guard (pre-send) ────────────────────────────────────
    // Rapid-fire client bubbles (slot, then phone, then address separately) can
    // let an earlier bubble's 10s debounce elapse just before the next lands, so
    // this reply was built on STALE context (asks for info already sent, or never
    // books). If a newer user message arrived since we started, discard this stale
    // reply and let the newest message's handler answer with the COMPLETE context.
    {
      const { data: newestUser } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conv.id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newestUser && newestUser.id !== thisMessageId) {
        console.log("[WA] Newer client message arrived during generation — discarding stale reply");
        return;
      }
    }

    // ── Grace window before a redundant booking-info re-ask ───────────────
    // The slot is confirmed but the brain is still asking for the address (on
    // WhatsApp the phone is already known). Clients routinely confirm the time
    // and then send the address as a SECOND message a few seconds later, just
    // past the 10s debounce — firing the re-ask the instant it lands is the
    // screenshot bug. Give that follow-up a short window: if a newer client
    // message arrives, discard this re-ask so the newest message's handler books
    // with the COMPLETE context (it always has the slot + the address).
    if (!isBookingConfirmed && isAskingForBookingInfo(safeResponse)) {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const { data: newer } = await supabaseAdmin
          .from("instagram_messages")
          .select("id")
          .eq("conversation_id", conv.id)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (newer && newer.id !== thisMessageId) {
          console.log("[WA] Booking-info follow-up arrived during grace window — discarding redundant re-ask");
          return;
        }
      }
    }

    const { response: afterBooking, booked } = await processBookingCommand(safeResponse, phone, conv.id, isBookingConfirmed, lang, isRescheduling, history);
    const afterCancel = await processCancelCommand(afterBooking, phone, conv.id);
    const afterNotify = await processNotifyOwner(afterCancel, conv.id, conv.username ?? null, phone);
    const finalResponse = stripForbiddenTags(afterNotify);

    // Never send an empty message: a tag-only reply (bare [NOTIFY_OWNER], etc.)
    // strips to "" and the Z-API send silently fails, leaving the client with no
    // reply. The owner was already notified above if needed, so stay silent.
    if (!finalResponse.trim()) {
      console.warn("[WA] Empty response after tag stripping — staying silent (no empty send)");
      return;
    }

    void trackConversationMetrics(conv.id, "whatsapp", inputTokens, outputTokens, booked);

    // Rule 29 backstop: never send the exact same message twice in a row. A
    // re-tapped FAQ button used to get the identical reply again (robotic
    // loop). The client already has this answer directly above — stay silent.
    // Booking turns are exempt: a [BOOK:] confirmation must always go out.
    if (!booked && isConsecutiveDuplicate(messagesForAI, finalResponse)) {
      console.log("[WA] reply identical to previous bot message — staying silent (no robotic repeat)");
      return;
    }

    // A failed send aborts the turn BEFORE the reply is stored — recording an
    // undelivered reply hides the outage and suppresses the re-send (see the
    // 2026-07-22 IG token incident). reportSendFailure alerts the owner.
    const mainSent = await sendWhatsAppMessage(phone, finalResponse);
    if (!mainSent.ok) {
      await reportSendFailure("whatsapp", phone, mainSent.error ?? "unknown");
      // Outbox: store marked as undelivered — retryFailedSends re-sends it for
      // up to 48h (the 2026-07-22 14:38 UTC transient blip on Messenger showed
      // a double-attempt failure still needs a later retry).
      console.error("[WA] final send FAILED — queued with SEND_FAILED for auto-retry");
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: finalResponse + SEND_FAILED_DB_SUFFIX,
      });
      return;
    }
    await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: finalResponse });

    // Update memory in background
    if (newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      const allMessages = [...messagesForAI, { role: "assistant" as const, content: finalResponse }];
      const memUpdate = extractMemoryUpdate(finalResponse, allMessages, {});
      if (memUpdate) {
        updateClientMemory(newMemoryStoreId, { ...memUpdate, client_name: conv.username || contactName || undefined })
          .catch((e) => console.error("WA memory update error:", e));
      }
    }
  } catch (err) {
    console.error("WA webhook error:", err);
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // CAIXA-PRETA (missão referral 28/07): body BRUTO de TODO POST gravado antes
  // de qualquer parsing/filtro/return (token inválido, JSON quebrado, delivery
  // — tudo fica registrado, com flag de autenticidade). Retenção 7 dias.
  const rawBody = await req.text();

  const zapiToken = process.env.ZAPI_WEBHOOK_TOKEN;
  let tokenOk = true;
  if (zapiToken) {
    const provided = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token");
    tokenOk = provided === zapiToken;
  }
  waitUntil(capturarWebhookRaw("wa", rawBody, { sigOk: tokenOk }));
  if (!tokenOk) return new NextResponse("Forbidden", { status: 403 });

  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(rawBody); } catch { body = null; }
  if (!body) return NextResponse.json({ status: "ignored" }, { status: 200 });

  // Defense-in-depth authenticity check (needs NO Z-API dashboard change): a
  // genuine Z-API callback carries this instance's id. Reject only when the
  // payload presents a DIFFERENT instanceId (a forged/foreign call). Absence is
  // tolerated so a Z-API payload-shape change never silently drops real client
  // messages. For the strong guard, set ZAPI_WEBHOOK_TOKEN (handled above) and
  // append ?token=... to the Z-API webhook URL.
  const expectedInstance = process.env.ZAPI_INSTANCE_ID;
  const bodyInstance = (body as Record<string, unknown>).instanceId;
  if (expectedInstance && typeof bodyInstance === "string" && bodyInstance !== expectedInstance) {
    console.warn("[WA webhook] instanceId mismatch — rejecting forged callback");
    return new NextResponse("Forbidden", { status: 403 });
  }

  waitUntil(handleWaMessage(body));
  // Outbox: webhook traffic doubles as the heartbeat for re-sending replies
  // whose delivery failed (self-throttled to 1 sweep / 10 min).
  waitUntil(retryFailedSends());
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── GET — Z-API webhook verification ─────────────────────────────────────
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
