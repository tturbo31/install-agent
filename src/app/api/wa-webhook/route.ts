import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage, sendWhatsAppReaction, downloadZApiImage, downloadZApiAudio, notifyOwners } from "@/lib/whatsapp";
import { getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags, detectLargeLeadSqft, isPureClosing, isPureClosingBurst, isRescheduleRequest, containsSchedulingOffer, isJobSeeker, isLowCreditError, CREDIT_ALERT, containsBookingInfo, isAskingForBookingInfo, detectAdFlooringType, adFlooringTypeNote, classifyAdCreativeType, isConsecutiveDuplicate, type AdFlooringType } from "@/lib/ai";
import { fetchAdCreative } from "@/lib/facebook";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { createBooking, cancelClientBooking, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, hasExistingBooking, isRealPhoneNumber, resolveClientName } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { trackConversationMetrics } from "@/lib/metrics";

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
  isReschedule: boolean = false
): Promise<{ response: string; booked: boolean }> {
  if (isAlreadyBooked && !isReschedule) {
    return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
  }
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return { response: aiResponse, booked: false };
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

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
    if (!bookingData.address?.trim()) {
      console.warn("WA booking blocked — address missing from booking JSON");
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
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
): { adId?: string; adTitle?: string; adImage?: string; sourceUrl?: string } | null {
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
    const adImage = get("image_url", "imageUrl", "thumbnail_url", "thumbnailUrl", "media_url", "mediaUrl", "thumbnail");
    const adTitle = [headline, bodyTxt].filter(Boolean).join(" ") || undefined;
    if (adId || adTitle || adImage || sourceUrl) return { adId, adTitle, adImage, sourceUrl };
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
    if (body.fromMe === true) return;

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

    if (conv.mode === "human") return;

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

    // Returning client who already booked or was already served (visit done) —
    // even if the booking was made outside the bot. Hand them to the team, never
    // re-engage. Only checked for existing conversations to avoid slowing new leads.
    if (!wasNewConv && !(conv as Record<string, unknown>).booking_confirmed) {
      const served = await hasExistingBooking(waIgsid).catch(() => false);
      if (served) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conv.id);
        (conv as Record<string, unknown>).booking_confirmed = true;
      }
    }

    // ── Reschedule intent: a booked client moving their visit is the one case we
    //    engage after a booking. Keep engaging while a reschedule is in progress
    //    (last assistant message offered slots), so the follow-up that just names
    //    the new day is still routed through the reschedule flow. ──
    const isBooked = !!(conv as Record<string, unknown>).booking_confirmed;
    let engageReschedule = isBooked && isRescheduleRequest(rawText);
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
      await sendWhatsAppMessage(phone, fallback);
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
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
    // ad's flooring type (a TILE ad must never get the vinyl $5 pitch). Defensive:
    // stores only what Z-API actually provides; absence is fine (we then ask).
    const adRef = extractWaAdReferral(body);
    if (adRef) {
      console.log("[WA AD] referral detected:", JSON.stringify(adRef).slice(0, 300));
      const c = conv as Record<string, unknown>;
      const upd: Record<string, unknown> = {};
      if (adRef.adId && !c.ad_id) upd.ad_id = adRef.adId;
      if (adRef.adTitle && !c.ad_title) upd.ad_title = adRef.adTitle;
      if (adRef.adImage && !c.creative_url) upd.creative_url = adRef.adImage;
      if (Object.keys(upd).length) {
        await supabaseAdmin.from("instagram_conversations").update(upd).eq("id", conv.id);
        Object.assign(c, upd);
      }
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
        const persisted = `[${scannedType}]`;
        await supabaseAdmin.from("instagram_conversations").update({ ad_title: persisted }).eq("id", conv.id);
        Object.assign(conv as Record<string, unknown>, { ad_title: persisted });
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

    // Load conversation history
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conv.id)
      .order("created_at", { ascending: false })
      .limit(15);
    const history = (historyRaw ?? []).reverse();

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

    type AiMsg = { role: "user" | "assistant"; content: string };
    let messagesForAI: AiMsg[] = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

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
      if (isRescheduling) {
        systemParts.push("[RESCHEDULE MODE: This client already has a confirmed visit and wants to MOVE it to a different day or time. Acknowledge warmly, offer new open slots from the schedule above (or check the day they named), and the moment they confirm a new day and time, generate [BOOK:...] with the NEW date and time. Do NOT ask for the address or phone again, you already have them. Follow all date-integrity and availability rules.]");
      }
      if (!isBookingConfirmed && !isRescheduling) {
        // WhatsApp: the client's phone number is already known from the chat.
        systemParts.push(`[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the property address. NEVER ask the client for their phone number. Once you have a confirmed day/time and the address, generate [BOOK:...] using "${phone}" as the phone.]`);
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
            const persisted = `[${resolved}] ${(convAny.ad_title as string) ?? ""}`.trim();
            await supabaseAdmin.from("instagram_conversations").update({ ad_title: persisted }).eq("id", conv.id);
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
          await sendWhatsAppMessage(phone, fallback);
          await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
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

    const { response: afterBooking, booked } = await processBookingCommand(safeResponse, phone, conv.id, isBookingConfirmed, lang, isRescheduling);
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

    await sendWhatsAppMessage(phone, finalResponse);
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
  const zapiToken = process.env.ZAPI_WEBHOOK_TOKEN;
  if (zapiToken) {
    const provided = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token");
    if (provided !== zapiToken) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  const body = await req.json().catch(() => null);
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
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── GET — Z-API webhook verification ─────────────────────────────────────
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
