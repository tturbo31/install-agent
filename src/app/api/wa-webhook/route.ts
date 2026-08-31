import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage, sendWhatsAppReaction, downloadZApiImage, downloadZApiAudio, notifyOwners } from "@/lib/whatsapp";
import { alertPausedBacklog, reportSendFailure, retryFailedSends, watchWaQueue, recoverLostReplies } from "@/lib/delivery";
import { SEND_FAILED_DB_SUFFIX } from "@/lib/outbound-text";
import { isBarePreBookingText, getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags, detectLargeLeadSqft, isPureClosing, isPureClosingBurst, isAckOnlyBurst, isAckClosingBurst, isRescheduleRequest, questionSwallowedByBooking, isCancelRequest, containsSchedulingOffer, isOpenSlotOffer, isReminderRequest, isJobSeeker, isLowCreditError, CREDIT_ALERT, containsBookingInfo, isAskingForBookingInfo, detectAdFlooringType, adFlooringTypeNote, classifyAdCreativeType, isConsecutiveDuplicate, recapForDuplicateReply, promisesOwnerContact, unansweredUserBurst, isVisitDetailQuestion, pastVisitSystemNote, assertsExistingAppointment, repairRequestActive, repairVisitOfferLeak, hasInstallationConfirmation, isHostileRejection, isFirstContactRejection, type AdFlooringType } from "@/lib/ai";
import { fetchAdCreative } from "@/lib/facebook";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { reconcileBookingPhone, bookingUnverifiedHandoffMessage, createBooking, sameDayBookingAlert, cancelClientBooking, type Lang, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, getClientBookingSnapshot, visitDetailsMessage, reminderAckMessage, appendUpcomingBookingNote, appointmentMismatchHandoffMessage, isRealPhoneNumber, resolveClientName, reconcileBookingWeekday, reconcileOfferedDates, clientConfirmedSlot, needSlotConfirmationMessage, bookedTimeSeenInConversation, needTimeChoiceMessage, bookedSlotMismatchesPromise, isRealAddress, needAddressMessage, addressHasStreetNumber, bookingAddressHasZip, needZipMessage, clientProvidedName, needNameMessage, applyPostBookingAddressCorrection, addressCorrectedMessage, addressChangeHandoffMessage, postBookingAddressAlert, recentClientText, cancellationConfirmedMessage, cancellationHandoffMessage, cancellationAlert, repairDeclineMessage, getUpcomingBookingRecord } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { trackConversationMetrics } from "@/lib/metrics";
import { funilOnInboundMessage, funilOnBookingConfirmed, maybeRunFunilSilenceCheck, persistirAnuncioDaConversa, dadosDeAnuncioDaConversa } from "@/lib/funil";
import { capturarRawFunil, capturarWebhookRaw } from "@/lib/funil-raw";
import { enviarEventoFunil } from "@/lib/plataforma";
import { findQuoteFollowupContext, composeQuoteReply, isQuoteRefusal, quoteHandoffActive, isTalkToOzziRequest, talkToOzziLang, talkToOzziMessage, QUOTE_HANDOFF_SUFFIX, QUOTE_TALK_TO_OZZI_ALERT, QUOTE_AFTER_HANDOFF_ALERT } from "@/lib/quote-reply";
import { findRecentInstallationConfirmation, isInstallAck, installHandoffMessage, INSTALL_STAGE_ALERT } from "@/lib/instalacao";

// 60s killed slow turns MID-FLIGHT (debounce 10s + audio download/transcription
// + vision + AI + send retries): message stored, reply never generated, zero
// alerts — a WA voice note died exactly this way (Kathe, 2026-08-10 five-day
// review). Fluid Compute bills active CPU, so 300 is safe.
export const maxDuration = 300;

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
  lang: Lang,
  isReschedule: boolean = false,
  history: Array<{ role: string; content: string }> = []
): Promise<{ response: string; booked: boolean }> {
  if (isAlreadyBooked && !isReschedule) {
    return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
  }
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return { response: aiResponse, booked: false };

  // REPAIR guard: we do NOT do repairs of any kind, so a [BOOK] while the
  // client's standing request is a repair is always wrong (PRITI BUDHRANI, IG
  // 2026-08-24: "These tiles are damaged so we would like to replace them" was
  // booked as a tile visit). Decline instead of booking; the flag clears only
  // when the client pivots to a whole new floor.
  if (repairRequestActive(history)) {
    console.warn(`[WA] booking blocked — the client asked for a REPAIR (we do not do repairs); sending the decline`);
    return { response: repairDeclineMessage(lang), booked: false };
  }
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // PHONE-DIGITS guard: the number must be one the client typed — the model
    // re-types digits and transposes them (Shaeleen replay, 2026-08-27).
    {
      const rp = reconcileBookingPhone(bookingData.phone, history);
      if (rp.corrected) {
        console.warn("[WA] booking phone corrected: " + rp.reason);
        bookingData.phone = rp.phone;
      }
    }

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

    // TIME-INVENTION guard: the client picked a DAY but the booked HOUR never
    // appeared in the conversation → the model invented it (AXEL, 2026-07-30,
    // Messenger). Block and re-offer with that day's real open times.
    if (bookingData.date && bookingData.time && !bookedTimeSeenInConversation(history, bookingData.time)) {
      console.warn(`[WA] booking blocked — time ${bookingData.time} never appeared in the conversation; asking client to choose`);
      return { response: await needTimeChoiceMessage(lang, bookingData.date, bookingData.address), booked: false };
    }

    // PROMISE-MATCH guard: the [BOOK] must honor the LAST concrete slot promise
    // in the conversation (MARIA HERNANDEZ, FB 2026-08-23: the bot echoed
    // "Perfecto, tengo hoy a las 11am" and the model silently booked Tuesday the
    // 25th at 1pm — a day+time the offer list contained, so every other guard
    // passed; the client waited all Sunday for a visit sitting two days later).
    if (bookingData.date && bookingData.time) {
      const pm = bookedSlotMismatchesPromise(history, bookingData.date, bookingData.time);
      if (pm.mismatch) {
        console.warn(`[WA] booking blocked — ${pm.reason}; re-offering real times`);
        return { response: await needTimeChoiceMessage(lang, pm.promisedDate ?? bookingData.date, bookingData.address), booked: false };
      }
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
        clientBurst: recentClientText(history),
      });
      if (r.success && r.unchanged) {
        // The [BOOK] named the slot the client already holds — nothing moved.
        // Restate the real visit instead of "I couldn't lock in that exact time".
        console.log("[WA] [BOOK] repeats the existing visit — restating it (nothing to move)");
        return { response: visitDetailsMessage(lang, r.date ?? bookingData.date, r.time ?? bookingData.time), booked: false };
      }
      if (r.success) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conversationId);
        // FUNIL: remarcação confirmada → agendamento_marcado com a NOVA data.
        waitUntil(funilOnBookingConfirmed(conversationId, `wa_${waId}`, {
          date: bookingData.date, time: bookingData.time, phone: bookingData.phone ?? waId, name: bookingData.name, address: bookingData.address,
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
    // The address must be COMPLETE: street number + street, not just a city.
    if (!isRealAddress(bookingData.address) || !addressHasStreetNumber(bookingData.address)) {
      console.warn(`[WA] booking blocked — address not usable (${JSON.stringify(bookingData.address ?? null)}); asking for it`);
      return { response: needAddressMessage(lang), booked: false };
    }
    // ZIP guard (owner rule 2026-08-01): the address is only complete with the
    // ZIP CODE, and it must be one the CLIENT typed — never one the model
    // inferred from the city. Ask for it instead of booking a guessed route.
    if (!bookingAddressHasZip(bookingData.address, history)) {
      console.warn(`[WA] booking blocked — address without a client-given zip (${JSON.stringify(bookingData.address ?? null)}); asking for it`);
      return { response: needZipMessage(lang), booked: false };
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

    // O ANÚNCIO VAI JUNTO PARA O CALENDÁRIO (01/08/2026) — mesma correção do
    // Messenger: só o Instagram resolvia o criativo persistido da conversa.
    const adPersistido = await dadosDeAnuncioDaConversa(conversationId).catch(() => null);
    const creativeRef =
      adPersistido?.contrato.ad_title ?? adPersistido?.ad_name ?? adPersistido?.ad_id ?? "WhatsApp";
    const creativeImage = adPersistido?.contrato.ad_media_url ?? undefined;

    const result = await createBooking({
      clientName,
      clientPhone,
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: [bookingData.notes ?? "", "WhatsApp", creativeRef !== "WhatsApp" ? `Ad: ${creativeRef}` : ""]
        .filter(Boolean)
        .join(" | "),
      creative: creativeRef,
      creativeImage,
      channel: "whatsapp",
      igsid: `wa_${waId}`,
    });

    if (result.success) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      // FUNIL: visita confirmada → agendamento_marcado (data_visita em ISO).
      waitUntil(funilOnBookingConfirmed(conversationId, `wa_${waId}`, {
        date: bookingData.date, time: bookingData.time, phone: clientPhone, name: bookingData.name, address: bookingData.address,
      }));
      // A question asked in the SAME burst as the booking details is answered
      // first — the canned confirmation used to discard it, and booking_confirmed
      // then silenced the client for good (Meylan Marrero, 2026-07-31).
      // VISITA HOJE (2026-08-25): a same-day booking needs a human to see it
      // right now — the platform reminder may never fire this close.
      const urgent = sameDayBookingAlert(bookingData.date, bookingData.time, result.sellerName);
      if (urgent) {
        waitUntil(notifyOwners({ platform: "WhatsApp", clientName: bookingData.name ?? null, clientId: `wa_${waId}`, recentMessages: history.slice(-6), alert: urgent }).catch((e) => console.error("same-day alert error:", e)));
      }
      const pending = questionSwallowedByBooking(aiResponse, history);
      if (pending) console.log("[WA] answering the question sent with the booking details before confirming");
      return { response: pending ? `${pending}\n\n${bookingSuccessMessage(lang, bookingData.date, bookingData.time)}` : bookingSuccessMessage(lang, bookingData.date, bookingData.time), booked: true };
    } else if (result.error === "already_booked") {
      console.warn("[WA] Duplicate booking blocked by scheduler guard");
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      // NUNCA enviar o texto do próprio modelo aqui: numa corrida de debounce o
      // outro turno grava a visita real e ESTE turno pode carregar uma confirmação
      // com OUTRA data (Raul Gallon, WA 28/08/2026: a visita gravou terça 01/09
      // 13:00 e o cliente leu "viernes 28 de agosto a la 1pm" — e depois ficou
      // sem saber da visita real). Restata a visita REAL lida do scheduler.
      const realVisit = await getUpcomingBookingRecord(`wa_${waId}`).catch(() => null);
      if (realVisit?.date) return { response: visitDetailsMessage(lang, realVisit.date, realVisit.time), booked: false };
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
    }

    // Slot the client picked is full but OTHER slots may be open: offer the
    // soonest remaining one instead of handing off (never say it was "taken").
    // Keep the AI active so the client's next pick books normally.
    if (/^No availability/i.test(result.error ?? "")) {
      const recovery = await slotConflictRecoveryMessage(lang, bookingData.date, history, bookingData.time, bookingData.address);
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
    // A [BOOK] tag WAS here (the model was booking) and it could not be used.
    // Shipping the bare pre-booking line ("Perfect, see you then!") would tell
    // the client the visit is set when nothing was written (Shaeleen, IG
    // 2026-08-26). Hand it to Ozzi instead, with the owner alert.
    console.error("WA booking error — [BOOK] unusable, handing off to owner:", err);
    return { response: bookingFailureHandoffMessage(lang) + "[NOTIFY_OWNER]", booked: false };
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
// The cancellation is executed in the scheduler and CONFIRMED before the client
// hears anything: on success the reply is the deterministic confirmation naming
// the real cancelled date/time (never the model's free text, which used to be
// sent even when the delete failed), on failure it is an honest handoff. The
// owner is alerted either way so a cancellation is never invisible.
async function processCancelCommand(
  aiResponse: string,
  waId: string,
  conversationId: string,
  clientName: string | null,
  lang: Lang
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();
  let result: Awaited<ReturnType<typeof cancelClientBooking>>;
  try {
    result = await cancelClientBooking(`wa_${waId}`);
  } catch (err) {
    console.error("WA cancel error:", err);
    result = { success: false, error: String(err) };
  }
  if (result.success || result.error === "no_booking_found") {
    // no_booking_found = stale flag (visit already gone); clear it so the
    // conversation flows normally when the client comes back to rebook.
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ booking_confirmed: false })
      .eq("id", conversationId);
  }
  if (result.success) console.log(`WA: Cancelled ${result.cancelled} booking(s) for ${waId}`);
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
      clientId: waId,
      recentMessages: (recentMsgs ?? []).reverse(),
      alert: cancellationAlert(result),
    });
  } catch (err) {
    console.error("WA cancel notify error:", err);
  }
  if (result.success && result.visits && result.visits.length > 0) {
    return cancellationConfirmedMessage(lang, result.visits[0].date, result.visits[0].time);
  }
  if (result.error === "no_booking_found") return clean;
  return cancellationHandoffMessage(lang);
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

  // FORMATO REAL DA Z-API (confirmado na caixa-preta em 28/07 e documentado em
  // developer.z-api.io/webhooks/on-message-received-examples): o clique num
  // anúncio CTWA chega como objeto "externalAdReply" no NÍVEL RAIZ do webhook
  // "Ao receber" — nunca como "referral" da Cloud API. O mesmo objeto também
  // aparece em compartilhamentos de link comuns, então só conta como ANÚNCIO
  // quando sourceType é "ad" ou quando há sourceId/ctwaClid.
  const ear = asObj(body.externalAdReply);
  if (ear) {
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const sourceType = s(ear.sourceType)?.toLowerCase();
    const adId = s(ear.sourceId);
    const ctwaClid = s(ear.ctwaClid);
    if (sourceType === "ad" || adId || ctwaClid) {
      return {
        adId,
        adTitle: [s(ear.title), s(ear.body)].filter(Boolean).join(" ") || undefined,
        // thumbnailUrl = imagem do criativo pronta (mesmo em anúncio de VÍDEO)
        adImage: s(ear.thumbnailUrl) ?? s(ear.originalImageUrl),
        adVideo: undefined,
        sourceUrl: s(ear.sourceUrl),
        sourceType,
        ctwaClid,
      };
    }
    // externalAdReply de link comum (compartilhamento): NUNCA vira atribuição
    // — segue para os formatos legados, que não conhecem essa chave.
  }

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

    // ── ATRIBUIÇÃO DE ANÚNCIO (CTWA) — extraída ANTES da triagem por tipo ──
    // AUDITORIA RASTREIO 04/08: a extração ficava depois do insert, então um
    // callback de tipo não reconhecido (reaction, location, sticker...) ou um
    // texto só-emoji dava return ANTES de olhar o externalAdReply — a atribuição
    // daquele clique morria ali. Agora extrai primeiro e persiste antes de
    // qualquer descarte. (Nos payloads reais o externalAdReply vem na RAIZ do
    // callback, independente do tipo da mensagem — 15/15 na caixa-preta.)
    const adRefFunil = extractWaAdReferral(body);
    const referralFunilWa = adRefFunil
      ? {
          ad_id: adRefFunil.adId, // sourceId/source_id do WhatsApp = ad_id do contrato
          ctwa_clid: adRefFunil.ctwaClid,
          source: adRefFunil.sourceType, // sourceType ("ad"/"post") → ad_source_type
          ref: adRefFunil.sourceUrl, // sourceUrl (fb.me/…) → ad_ref do contrato
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
      if (rawText && !rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{1F900}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}]/gu, "").trim()) {
        if (referralFunilWa) waitUntil(persistirAnuncioDaConversa(conv.id, referralFunilWa));
        return;
      }
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

    if (!rawText) {
      // Tipo de callback não reconhecido (reaction, location, sticker, chamada):
      // a bolha é descartada, mas a atribuição do clique NUNCA morre junto.
      if (referralFunilWa) waitUntil(persistirAnuncioDaConversa(conv.id, referralFunilWa));
      return;
    }

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
    // ATRIBUIÇÃO (auditoria 28/07): o referral do anúncio CTWA VAI JUNTO no
    // funil. (adRefFunil/referralFunilWa agora são extraídos no topo do handler,
    // ANTES da triagem por tipo — auditoria rastreio 04/08.)
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
          // recusou=true ("not interested", "stop") → a plataforma marca o
          // telefone para NUNCA mais receber follow-up (nem manual).
          if (quoteCtx)
            await enviarEventoFunil(
              "followup_respondeu",
              isQuoteRefusal(rawText) ? { telefone: phone, recusou: true } : { telefone: phone }
            );
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
        // GUARDA VISITA AFIRMADA (caso Msleo, 2026-08-05, IG): se a rajada
        // não-respondida AFIRMA uma visita já combinada (gate code, "we had a
        // confirmed appointment", aceite de horário sem oferta em aberto), o
        // acordo pode ter sido feito pelo dono FORA do bot e o scheduler estar
        // desatualizado — nunca re-engajar vendas nem afirmar disponibilidade:
        // ack neutro + dono. A flag NÃO é resetada.
        const { data: staleBurstMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(10);
        const staleRows = (staleBurstMsgs ?? []).reverse();
        const staleBurst = unansweredUserBurst(staleRows) || rawText;
        const staleLastAsst = [...staleRows].reverse().find((m) => m.role === "assistant")?.content ?? null;
        // EXCEÇÃO (2026-08-11): se o histórico recente tem a confirmação de
        // instalação que NÓS enviamos (/api/confirmar-instalacao), a "visita"
        // que o cliente afirma é essa instalação — não é acordo por fora. A
        // guarda não dispara e o modelo segue pelo INSTALLATION CONFIRMED.
        if (!hasInstallationConfirmation(staleRows) && assertsExistingAppointment(staleBurst, staleLastAsst)) {
          console.log("[WA] stale booked flag BUT client asserts an existing appointment — owner handoff, no re-engage");
          const handoff = appointmentMismatchHandoffMessage(detectLang(staleBurst));
          if (!(staleLastAsst && isConsecutiveDuplicate([{ role: "assistant", content: staleLastAsst }], handoff))) {
            const handoffSent = await sendWhatsAppMessage(phone, handoff);
            if (handoffSent.ok) {
              await supabaseAdmin.from("instagram_messages").insert({
                conversation_id: conv.id,
                role: "assistant",
                content: handoff,
              });
            }
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
              clientName: (conv as Record<string, unknown>).username as string ?? null,
              clientId: phone,
              recentMessages: (recentMsgs ?? []).reverse(),
            });
          } catch (err) {
            console.error("[WA] appointment-mismatch notify error:", err);
          }
          return;
        }
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
      // isOpenSlotOffer, not containsSchedulingOffer: since 2026-08-25 the booking
      // confirmation restates the day and time, and reading it as an offer put
      // every post-booking message into RESCHEDULE MODE (Prince Cambow, FB 26/08).
      if (lastAsst?.content && isOpenSlotOffer(lastAsst.content)) engageReschedule = true;
    }

    // ── ETAPA DE INSTALAÇÃO: cliente respondeu ao aviso de véspera ─────────
    // Regra do dono (25/08/2026, caso Sarah McKnight): depois da confirmação
    // de instalação enviada por /api/confirmar-instalacao, o bot NÃO conversa.
    //   • agradecimento / "ok" / "see you tomorrow" / 👍 → só um 👍 de volta;
    //   • qualquer outra coisa (dúvida, "5am???", pedido) → UMA frase dizendo
    //     que vai repassar ao Ozzi, que entra em contato — e o dono é avisado.
    // Determinístico, sem modelo: o bot nunca responde a dúvida sozinho nessa
    // etapa (foi o "Ha, that does sound early!" que o dono apagou). Roda ANTES
    // do cérebro de follow-up de orçamento e da lógica de visita marcada porque
    // a venda já fechou — nenhum dos dois faz sentido aqui. Só vale enquanto a
    // confirmação for recente (INSTALL_STAGE_MAX_DAYS); depois a conversa volta
    // ao fluxo normal.
    {
      const { data: instMsgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: false })
        .limit(15);
      const instRows = (instMsgs ?? []).reverse();
      const instConf = findRecentInstallationConfirmation(instRows);
      if (instConf) {
        const instBurst = unansweredUserBurst(instRows) || rawText;
        // A cadência de follow-up de orçamento (se houver) precisa parar do
        // mesmo jeito: a conversa agora é do Ozzi.
        try {
          if (await findQuoteFollowupContext(conv.id)) {
            await enviarEventoFunil("followup_respondeu", { telefone: phone });
          }
        } catch (err) {
          console.error("[WA] instalacao: followup_respondeu error:", err);
        }
        if (isHostileRejection(instBurst)) {
          console.log("[WA] instalacao: rejeição hostil — silêncio total, avisando o dono");
        } else if (isInstallAck(instBurst)) {
          await sendWhatsAppReaction(phone, messageId, "👍");
          console.log("[WA] instalacao: agradecimento/ack — só 👍, nada de texto");
          return;
        } else {
          const reply = installHandoffMessage(detectLang(instBurst));
          const lastAsst = [...instRows].reverse().find((m) => m.role === "assistant")?.content ?? null;
          const repetido = !!(lastAsst && isConsecutiveDuplicate([{ role: "assistant", content: lastAsst }], reply));
          if (repetido) {
            console.log("[WA] instalacao: handoff já enviado na mensagem anterior — não repete, só avisa o dono");
          } else {
            const sent = await sendWhatsAppMessage(phone, reply);
            if (!sent.ok) await reportSendFailure("whatsapp", phone, sent.error ?? "unknown");
            else await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: reply });
            console.log(`[WA] instalacao: dúvida → handoff ao Ozzi enviado=${sent.ok}`);
          }
        }
        try {
          await notifyOwners({
            platform: "WhatsApp",
            clientName: conv.name ?? conv.username ?? null,
            clientId: phone,
            recentMessages: instRows.slice(-8).map((m) => ({ role: m.role, content: m.content })),
            alert: INSTALL_STAGE_ALERT,
          });
        } catch (err) {
          console.error("[WA] instalacao: notify error:", err);
        }
        return;
      }
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
          // Recusa explícita ("not interested", "stop") ganha recusou=true: a
          // plataforma marca o telefone para nunca mais sugerir/enviar nada.
          await enviarEventoFunil(
            "followup_respondeu",
            isQuoteRefusal(rawText) ? { telefone: phone, recusou: true } : { telefone: phone }
          );
          const { data: recentMsgs } = await supabaseAdmin
            .from("instagram_messages")
            .select("role, content")
            .eq("conversation_id", conv.id)
            .order("created_at", { ascending: false })
            .limit(12);
          const historico = (recentMsgs ?? []).reverse();
          const quoteBurst = unansweredUserBurst(historico) || rawText;
          // REGRA DO DONO (26/08/2026): "ok" / obrigado / 👍 ENCERRA a conversa
          // na hora — só um 👍 de volta, nenhuma frase. Era o loop "Ok" →
          // "Sounds good, Ozzi will be in touch!" → "Okay" → "Sounds good,
          // we'll be in touch!" (Dary, Edna, Burt, Jale, Angie: 5 clientes de
          // follow-up em 10 dias). Vale para o burst inteiro não respondido.
          if (isAckOnlyBurst(historico) || isPureClosing(rawText)) {
            await sendWhatsAppReaction(phone, messageId, "👍");
            console.log("[WA] quote-reply: ack/fechamento — só 👍, nada de texto");
            return;
          }
          // Depois do repasse ao Ozzi ("vou repassar para o Ozzi") a conversa é
          // dele: o bot NÃO responde mais nada, só avisa o dono do que chegou.
          if (quoteHandoffActive(historico)) {
            console.log("[WA] quote-reply: repasse ao Ozzi já feito — silêncio, avisando o dono");
            await notifyOwners({
              platform: "WhatsApp",
              clientName: conv.name ?? conv.username ?? null,
              clientId: phone,
              recentMessages: historico.slice(-8),
              alert: QUOTE_AFTER_HANDOFF_ALERT,
            }).catch((e) => console.error("[WA] quote-reply notify (pós-repasse) error:", e));
            return;
          }
          // "Quero falar com o Ozzi" / "me liga": UMA frase fixa (sem modelo) e
          // o dono é avisado. O que o cliente mandar depois cai no silêncio acima.
          const reply = isTalkToOzziRequest(quoteBurst)
            ? { text: talkToOzziMessage(talkToOzziLang(quoteBurst, quoteCtx.idioma)), notifyOwner: true, source: "talk-to-ozzi" as const }
            : await composeQuoteReply({ ctx: quoteCtx, history: historico, clientText: rawText });
          if (reply.reactOnly) {
            await sendWhatsAppReaction(phone, messageId, "👍");
            console.log("[WA] quote-reply: modelo pediu [REACT_ONLY] — só 👍");
            return;
          }
          const sent = await sendWhatsAppMessage(phone, reply.text);
          if (sent.ok) {
            // Repasse ao Ozzi fica marcado no banco (sufixo nunca enviado) para
            // o silêncio pós-repasse não depender de regex sobre o texto.
            await supabaseAdmin.from("instagram_messages").insert({
              conversation_id: conv.id,
              role: "assistant",
              content: reply.notifyOwner ? reply.text + QUOTE_HANDOFF_SUFFIX : reply.text,
            });
            await supabaseAdmin.from("instagram_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
            if (reply.notifyOwner) {
              await notifyOwners({
                platform: "WhatsApp",
                clientName: conv.username ?? null,
                clientId: phone,
                recentMessages: [...historico.slice(-7), { role: "assistant", content: reply.text }],
                alert:
                  reply.source === "talk-to-ozzi"
                    ? QUOTE_TALK_TO_OZZI_ALERT
                    : "Cliente de follow-up de orçamento precisa de você (negociação, dúvida ou quer fechar). O agente NAO vai responder mais nada nesta conversa depois do repasse.",
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

    // ── Correção de ENDEREÇO depois da visita marcada (caso Kristina, IG,
    //    2026-08-13): mesma rua, outro apartamento. A correção morria no fluxo
    //    silencioso de booked e o vendedor ia para a unidade errada. Troca de
    //    unidade na MESMA rua é gravada aqui (detecção determinística, o modelo
    //    não opina); rua diferente pode ser outro imóvel e só vai para o dono. ──
    if (isBooked && !engageReschedule) {
      const addrBurst = [gateBurst, rawText].filter(Boolean).join("\n");
      const corr = await applyPostBookingAddressCorrection(waIgsid, addrBurst);
      if (corr) {
        const lang = detectLang(addrBurst);
        const reply =
          corr.kind === "unit"
            ? addressCorrectedMessage(lang, corr.unit)
            : addressChangeHandoffMessage(lang);
        const { data: lastBotAddr } = await supabaseAdmin
          .from("instagram_messages")
          .select("content")
          .eq("conversation_id", conv.id)
          .eq("role", "assistant")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!(lastBotAddr?.content && isConsecutiveDuplicate([{ role: "assistant", content: lastBotAddr.content }], reply))) {
          const addrSent = await sendWhatsAppMessage(phone, reply);
          if (!addrSent.ok) await reportSendFailure("whatsapp", phone, addrSent.error ?? "unknown");
          else await supabaseAdmin.from("instagram_messages").insert({
            conversation_id: conv.id,
            role: "assistant",
            content: reply,
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
            alert: postBookingAddressAlert(corr),
          });
        } catch (err) {
          console.error("WA address-correction notify error:", err);
        }
        return;
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

    // ── Booked client asking to be warned before the visit ("Text me or call
    //    me please 40 mins before") → ONE fixed line promising the 40-minute
    //    text (owner rule 2026-08-26, Prince Cambow). The ask is noted on the
    //    booking for the seller and the owner is notified. Runs after the
    //    reschedule and visit-question checks, before the silent path. ──
    if (isBooked && !engageReschedule && (isReminderRequest(rawText) || isReminderRequest(gateBurst))) {
      const ack = reminderAckMessage(detectLang(`${rawText} ${gateBurst}`));
      const { data: lastBotForAck } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conv.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!(lastBotForAck?.content && isConsecutiveDuplicate([{ role: "assistant", content: lastBotForAck.content }], ack))) {
        const ackSent = await sendWhatsAppMessage(phone, ack);
        if (!ackSent.ok) await reportSendFailure("whatsapp", phone, ackSent.error ?? "unknown");
        else await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: ack });
      }
      waitUntil(appendUpcomingBookingNote(waIgsid, `Cliente pediu aviso antes da visita: "${(gateBurst || rawText).replace(/\s+/g, " ").slice(0, 100)}"`).catch(() => false));
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
        console.error("WA reminder-ack notify error:", err);
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
      // Voice notes get their own line (parity with IG): "could you type your
      // question" after a voice message reads like we ignored it (Kathe,
      // 2026-08-10 review — the reply never went out at all back then).
      const fallback = imageUrl
        ? "Got your photo! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need."
        : audioUrl
          ? "Got your voice message but could not catch it. Could you type what you need?"
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
      // Failed send → outbox row (SEND_FAILED) so the retry sweep re-delivers
      // instead of dropping the reply invisibly (2026-08-10 review).
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: noContentSent.ok ? fallback : fallback + SEND_FAILED_DB_SUFFIX,
      });
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
      // Rota (27/08/2026): o histórico deixa a agenda ordenar os horários pela
      // localização do cliente (ou pedir o ZIP antes da oferta). Sem mudar o script.
      const availability = isBookingConfirmed ? null : await getRealAvailabilityContext({ history, igsid: waIgsid, rescheduling: isRescheduling });
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
    // "ok"/"perfect"/👍 after a message of ours that asked nothing (or a second
    // bare ack in a row) is the client closing the conversation — owner rule
    // 26/08/2026, isAckClosingBurst: no more "Sounds good, Ozzi will be in touch".
    if (!isBookingConfirmed && (/\[REACT_ONLY\]/i.test(rawAiResponse) || isPureClosingBurst(history) || isAckClosingBurst(history))) {
      // A rejection ("stop messaging me", "get away from me") gets NO 👍
      // either — a thumbs-up on a go-away message reads as mockery and still
      // notifies the client (2026-08-22). Total silence for those; the
      // friendly-closing thumb stays for everyone else.
      const rejectionBurst = unansweredUserBurst(history);
      const clientRejected = history.some((m) => m.role === "assistant")
        ? isHostileRejection(rejectionBurst)
        : isFirstContactRejection(rejectionBurst);
      if (clientRejected) {
        console.log("[WA] React-only (client rejection) — total silence, no reaction");
        return;
      }
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

    // Weekday↔date guard for the SENTENCE the client reads. reconcileBookingWeekday
    // only ever protected the [BOOK] payload, so "Thursday July 31" (a Friday) went
    // out to the client unchecked — they write the wrong date down (5-day review,
    // 2026-08-01). The weekday word wins; the day number is snapped to it.
    {
      const fixed = reconcileOfferedDates(safeResponse);
      if (fixed.corrections.length) {
        console.warn(`[WA] offered date corrected in outbound text: ${fixed.corrections.join("; ")}`);
        safeResponse = fixed.text;
      }
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

    // REPAIR backstop (Priti Budhrani, IG 2026-08-24): while the client's
    // standing request is a repair, a visit offer, a booking-details ask or a
    // [BOOK] from the model is replaced by the deterministic decline.
    if (!isBookingConfirmed && repairVisitOfferLeak(history, safeResponse)) {
      console.warn("[WA] repair request — model offered a visit / asked for booking details; replacing with the repair decline");
      safeResponse = repairDeclineMessage(lang);
    }

    const bookingStep = await processBookingCommand(safeResponse, phone, conv.id, isBookingConfirmed, lang, isRescheduling, history);
    let afterBooking = bookingStep.response;
    const booked = bookingStep.booked;
    // BARE-CONFIRMATION backstop (Shaeleen Herrera-Garcia, IG 2026-08-26): the
    // model's pre-booking line ("Perfect, see you then!") only means something
    // when a visit was actually written. About to go out ALONE — the [BOOK] tag
    // lost, stripped or never emitted — it must never ship: the client waited
    // at home for a 7pm visit nobody had in the system. A booked client in
    // RESCHEDULE MODE gets the real visit restated; anyone else gets the neutral
    // Ozzi-confirms line, and the owner is alerted to set the visit by hand.
    if (!booked && !isBookingConfirmed && isBarePreBookingText(afterBooking)) {
      console.warn("[WA] bare confirmation with no booking behind it (" + JSON.stringify(afterBooking) + ") — replacing with the owner handoff");
      afterBooking = isRescheduling && bookedVisit
        ? visitDetailsMessage(lang, bookedVisit.date, bookedVisit.time) + "[NOTIFY_OWNER]"
        : bookingUnverifiedHandoffMessage(lang) + "[NOTIFY_OWNER]";
    }
    const afterCancel = await processCancelCommand(afterBooking, phone, conv.id, conv.username ?? null, lang);
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
    // loop). But pure silence on an explicit re-ask is dead air (3 cases in the
    // 2026-08-10 review) — so send the SAME answer behind a short rotating
    // "as I mentioned" prefix instead, capped at 2 recaps per conversation.
    // Booking turns are exempt: a [BOOK:] confirmation must always go out.
    let outboundResponse = finalResponse;
    if (!booked && isConsecutiveDuplicate(messagesForAI, finalResponse)) {
      const recap = recapForDuplicateReply(messagesForAI, finalResponse);
      if (!recap) {
        console.log("[WA] reply identical to previous bot message — staying silent (recap cap reached)");
        return;
      }
      console.log("[WA] reply identical to previous bot message — sending recap instead of silence");
      outboundResponse = recap;
    }

    // A failed send aborts the turn BEFORE the reply is stored — recording an
    // undelivered reply hides the outage and suppresses the re-send (see the
    // 2026-07-22 IG token incident). reportSendFailure alerts the owner.
    let mainSent: { ok: boolean; error?: string };
    try {
      mainSent = await sendWhatsAppMessage(phone, outboundResponse);
    } catch (sendErr) {
      // A throw here used to skip BOTH the send and the outbox row — the client
      // saw silence and nothing recorded it (lost-reply review, 2026-08-26).
      console.error("[WA] final send THREW — treating as failed:", sendErr);
      mainSent = { ok: false, error: String(sendErr).slice(0, 200) };
    }
    if (!mainSent.ok) {
      await reportSendFailure("whatsapp", phone, mainSent.error ?? "unknown");
      // Outbox: store marked as undelivered — retryFailedSends re-sends it for
      // up to 48h (the 2026-07-22 14:38 UTC transient blip on Messenger showed
      // a double-attempt failure still needs a later retry).
      console.error("[WA] final send FAILED — queued with SEND_FAILED for auto-retry");
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conv.id,
        role: "assistant",
        content: outboundResponse + SEND_FAILED_DB_SUFFIX,
      });
      return;
    }
    await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: outboundResponse });

    // ── Empty-promise backstop ────────────────────────────────────────────
    // "Ozzi will reach out to you" only pings the owner when the model ALSO
    // emitted [NOTIFY_OWNER]; without the tag the promise is empty — Jorge
    // (wa_13059155997) waited weeks through five such replies and a $16,625
    // job walked (2026-08-10 review). If the delivered reply promises owner
    // contact and the tag never fired this turn, notify the owner anyway.
    if (!/\[NOTIFY_OWNER\]/i.test(afterCancel) && promisesOwnerContact(outboundResponse)) {
      console.log("[WA] reply promises owner contact without [NOTIFY_OWNER] — forcing owner notification");
      waitUntil(
        (async () => {
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
        })().catch((e) => console.error("[WA] promise-backstop notify error:", e))
      );
    }

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
  // Lost-reply net: a turn that reached the send stage but left no reply behind
  // is replayed / reported (self-throttled to 1 sweep / 5 min).
  waitUntil(recoverLostReplies());
  // Z-API queue watchdog (Olimpia 2026-08-25): the only external proof that
  // WhatsApp replies actually leave Z-API. Self-throttled to 1 probe / 5 min.
  waitUntil(watchWaQueue());
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── GET — Z-API webhook verification ─────────────────────────────────────
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
