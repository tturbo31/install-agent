import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendFacebookMessage, fetchFacebookProfile, downloadFacebookAttachment, fetchAdCreative } from "@/lib/facebook";
import { notifyOwners } from "@/lib/whatsapp";
import { getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags, detectLargeLeadSqft, isPureClosing, isPureClosingBurst, isRescheduleRequest, containsSchedulingOffer, isJobSeeker, isLowCreditError, CREDIT_ALERT, containsBookingInfo, isAskingForBookingInfo, detectAdFlooringType, adFlooringTypeNote, classifyAdCreativeType, type AdFlooringType } from "@/lib/ai";
import { verifyMetaSignature } from "@/lib/verify-meta";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { trackConversationMetrics } from "@/lib/metrics";
import { createBooking, cancelClientBooking, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, hasExistingBooking, isRealPhoneNumber, needPhoneMessage, resolveClientName } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";

export const maxDuration = 60;

const RESPONSE_DELAY_MS = 10000;

const FB_PAGE_ID = process.env.FACEBOOK_PAGE_ID ?? "";

// ─── Webhook verification ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

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
  psid: string,
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
      const r = await rescheduleClientBooking(`fb_${psid}`, bookingData.date, bookingData.time, {
        name: bookingData.name,
        phone: bookingData.phone,
        address: bookingData.address,
        notes: bookingData.notes,
      });
      if (r.success) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conversationId);
        return { response: rescheduleSuccessMessage(lang), booked: true };
      }
      // Do NOT pause: an automatic failure must never permanently silence the lead
      // (mode="human" is only for a deliberate owner takeover).
      console.warn(`[FB] Reschedule failed (${r.error}) for ${bookingData.date} ${bookingData.time} — handing off (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    }

    if (!bookingData.address?.trim()) {
      console.warn("FB booking blocked — address missing from booking JSON");
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
    }
    // Require a REAL phone number — never book with a non-number like "Messenger"
    // (client said "Call me in Messenger"). Re-ask instead of confirming a visit
    // the team cannot call; the client's next message (the number) then books.
    if (!isRealPhoneNumber(bookingData.phone)) {
      console.warn(`[FB] Booking blocked — phone not a real number (${JSON.stringify(bookingData.phone)})`);
      return { response: needPhoneMessage(lang), booked: false };
    }

    // Always book under the real client name: prefer a name the client typed,
    // then the saved Messenger profile name, then the handle. Never just "Client".
    const { data: convName } = await supabaseAdmin
      .from("instagram_conversations")
      .select("name, username")
      .eq("id", conversationId)
      .single();
    const clientName = resolveClientName(
      [bookingData.name, convName?.name, convName?.username],
      "Facebook Client"
    );

    const result = await createBooking({
      clientName,
      clientPhone: bookingData.phone ?? "",
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: (bookingData.notes ?? "") + " | Facebook Messenger",
      creative: "Facebook Messenger",
      igsid: `fb_${psid}`,
    });

    if (result.success) {
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      return { response: bookingSuccessMessage(lang), booked: true };
    } else if (result.error === "already_booked") {
      console.warn("[FB] Duplicate booking blocked by scheduler guard");
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
        console.warn(`[FB] Slot ${bookingData.date} ${bookingData.time} full — offering alternative slots`);
        return { response: recovery, booked: false };
      }
    }

    // Booking genuinely failed (system error, or nothing open at all) — never
    // claim a false "slot just taken". Hand the hot lead to Ozzi but do NOT pause
    // the bot: an automatic failure must never permanently silence the lead
    // (mode="human" is only for a deliberate owner takeover).
    console.warn(`[FB] Booking failed (${result.error}) for ${bookingData.date} ${bookingData.time} — handing off to owner (staying active)`);
    return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
  } catch (err) {
    console.error("FB booking error:", err);
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
      platform: "Messenger",
      clientName,
      clientId,
      recentMessages: (recentMsgs ?? []).reverse(),
    });
  } catch (err) {
    console.error("FB processNotifyOwner error:", err);
  }
  return clean;
}

// ─── [CANCEL_BOOKING] processor ──────────────────────────────────────────
async function processCancelCommand(
  aiResponse: string,
  psid: string,
  conversationId: string
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();
  try {
    const result = await cancelClientBooking(`fb_${psid}`);
    if (result.success) {
      console.log(`FB: Cancelled ${result.cancelled} booking(s) for ${psid}`);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: false })
        .eq("id", conversationId);
    }
  } catch (err) {
    console.error("FB cancel error:", err);
  }
  return clean;
}

// ─── Main message handler ─────────────────────────────────────────────────
async function handleFbMessage(body: Record<string, unknown>) {
  try {
    const { data: fbSetting } = await supabaseAdmin
      .from("platform_settings")
      .select("paused")
      .eq("platform", "facebook")
      .single();
    if (fbSetting?.paused) return;

    const entry = (body.entry as Record<string, unknown>[])?.[0];
    const messaging = (entry?.messaging as Record<string, unknown>[])?.[0];
    if (!messaging) return;

    // Skip echoes — save as training examples
    if ((messaging.message as Record<string, unknown>)?.is_echo) {
      const echoText = (messaging.message as Record<string, unknown>)?.text as string;
      const echoSenderId = (messaging.sender as Record<string, unknown>)?.id as string;
      if (echoText && echoSenderId === FB_PAGE_ID) {
        const clientPsid = (messaging.recipient as Record<string, unknown>)?.id as string;
        if (clientPsid) {
          const { data: conv } = await supabaseAdmin
            .from("instagram_conversations")
            .select("id")
            .eq("igsid", `fb_${clientPsid}`)
            .maybeSingle();
          if (conv?.id) {
            void supabaseAdmin.from("instagram_messages").insert({
              conversation_id: conv.id,
              role: "assistant",
              content: `[Treino] ${echoText}`,
            });
          }
        }
      }
      return;
    }

    const psid = (messaging.sender as Record<string, unknown>)?.id as string;
    if (!psid || psid === FB_PAGE_ID) return;

    const msg = messaging.message as Record<string, unknown>;
    const msgId = msg?.mid as string;
    if (!msgId) return;

    // Deduplicate
    const { data: already } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("instagram_msg_id", msgId)
      .maybeSingle();
    if (already) return;

    // Find or create conversation (igsid = "fb_{psid}")
    const fbIgsid = `fb_${psid}`;
    let { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", fbIgsid)
      .single();

    const wasNewConv = !conv;

    if (!conv) {
      const { data: newConv, error: convErr } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: fbIgsid, mode: "agent" })
        .select()
        .single();
      if (convErr) {
        // Ad clicks fire two webhook events almost simultaneously (ad referral +
        // text). They race to create the conversation; the loser hits the unique
        // igsid constraint. Recover the row instead of dropping the message.
        const { data: existing } = await supabaseAdmin
          .from("instagram_conversations")
          .select("*")
          .eq("igsid", fbIgsid)
          .single();
        conv = existing ?? null;
      } else {
        conv = newConv;
      }
    }
    if (!conv) return;

    // Extract text and attachments
    const attachments = (msg?.attachments as Record<string, unknown>[]) ?? [];
    const imageAtt = attachments.find((a) => a.type === "image");

    if ((imageAtt?.payload as Record<string, unknown>)?.sticker_id) return;

    const audioAtt = attachments.find((a) => a.type === "audio");

    let rawText = (msg?.text as string) ?? "";

    if (rawText && !rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{1F900}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}]/gu, "").trim()) return;

    const imageUrl = (imageAtt?.payload as Record<string, unknown>)?.url as string ?? null;
    const audioUrl = (audioAtt?.payload as Record<string, unknown>)?.url as string ?? null;

    // Ad reply context: client replied to one of our ads. Meta delivers reels as a
    // video/share attachment we don't recognize, often with no text — never drop it.
    const isAdReferral = !!messaging.referral;
    const hasAnyAttachment = attachments.length > 0;

    if (imageUrl && !rawText) rawText = "[floor plan or photo]";
    if (audioUrl && !rawText) rawText = "[voice message]";
    if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]";
    if (!rawText) return;

    // Pre-fetch image
    let preFetchedImageBase64: string | null = null;
    if (imageUrl) {
      preFetchedImageBase64 = await downloadFacebookAttachment(imageUrl).catch(() => null);
    }

    // Store message immediately
    const { data: insertedMsg, error: insertErr } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conv.id,
        role: "user",
        content: rawText,
        instagram_msg_id: msgId,
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
      console.log("[FB] Conversation paused during debounce — staying silent");
      return;
    }

    // Returning client who already booked or was already served (visit done),
    // even if booked outside the bot — hand to the team, never re-engage.
    if (!wasNewConv && !(conv as Record<string, unknown>).booking_confirmed) {
      const served = await hasExistingBooking(fbIgsid).catch(() => false);
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
          platform: "Messenger",
          clientName: (conv as Record<string, unknown>).username as string ?? null,
          clientId: psid,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("FB post-booking notify error:", err);
      }
      return;
    }

    // Rate limit: 5s window prevents genuine duplicates without blocking fast
    // client replies. EXCEPTION: a message carrying booking info (a street address
    // or a phone number) may be the one that COMPLETES the booking, so it must
    // never be silently dropped. A redundant "what's the address?" reply sent
    // moments earlier (when the slot and address arrive as two separate turns)
    // would otherwise rate-limit this turn and leave the visit unbooked.
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
        const res = await fetch(audioUrl);
        if (res.ok) {
          const ct = res.headers.get("content-type") ?? "audio/mp4";
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 1000) {
            const transcript = await transcribeAudioFromBuffer(buf, ct);
            if (transcript && !transcript.includes("please type")) {
              enrichedText = transcript;
              mediaProcessed = true;
            }
          }
        }
      } catch { /* ignore */ }
    }

    // If the client typed real text (e.g. an ad reply with the pre-filled question),
    // always answer it even when an attached photo could not be analyzed.
    const clientHasText = !!(msg?.text as string)?.trim();
    const hasRealContent = clientHasText || mediaProcessed;

    if (!hasRealContent) {
      const fallback = imageUrl
        ? "Got your photo! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need."
        : "Got your message! Could you type your question?";
      await sendFacebookMessage(psid, fallback);
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
      return;
    }

    // Job seeker / service provider → do not respond at all (message still stored).
    if (isJobSeeker(enrichedText)) {
      console.log("[FB] Job seeker / service offer — staying silent");
      return;
    }

    // Update stored message with enriched content
    await supabaseAdmin.from("instagram_messages").update({ content: enrichedText }).eq("instagram_msg_id", msgId);

    // Fetch Facebook profile + capture the ad signals (ad_title / creative /
    // ad_id) just like Instagram does, so a later "what's included" turn still
    // knows which ad the lead came from (tile vs vinyl vs hardwood).
    try {
      const profile = await fetchFacebookProfile(psid);
      const fbRef = messaging.referral as { ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string } } | undefined;
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (profile.name || profile.profile_pic) {
        update.username = profile.name;
        update.profile_pic = profile.profile_pic;
      }
      if (fbRef?.ads_context_data?.ad_title) update.ad_title = fbRef.ads_context_data.ad_title;
      if (fbRef?.ads_context_data?.photo_url) update.creative_url = fbRef.ads_context_data.photo_url;
      if (fbRef?.ad_id) update.ad_id = fbRef.ad_id;
      await supabaseAdmin.from("instagram_conversations").update(update).eq("id", conv.id);
    } catch { /* ignore */ }

    // Load memories in parallel with timeout
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]).catch(() => null);

    const memoryStoreId: string | null = (conv as Record<string, unknown>).memory_store_id as string ?? null;
    let newMemoryStoreId = memoryStoreId;
    if (!newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      try {
        newMemoryStoreId = await createClientMemoryStore(fbIgsid, conv.username);
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

    // Date context
    // Date context — always Eastern (server runs UTC; see scheduler helpers)
    const dateContext = getEasternDateContext();

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
      // Detect the ad's flooring type so we answer with the RIGHT inclusions: a
      // TILE ad's promo is labor only (the client buys the tile), NOT the vinyl
      // "flooring + labor + quarter round" package. Detect from the ad signals
      // (ad_title / creative_url / ad_id — fresh or stored); if text is silent,
      // look at the ad creative image. Only when inconclusive do we ask the type
      // (the existing AD_REPLY_NOTE), so the working flows are never changed.
      if (!isBookingConfirmed) {
        const fbRef = messaging.referral as { ad_id?: string; ads_context_data?: { ad_title?: string; photo_url?: string } } | undefined;
        const convAny = conv as Record<string, unknown>;
        const adId = (fbRef?.ad_id ?? convAny.ad_id) as string | undefined;
        const adSignals = [
          fbRef?.ads_context_data?.ad_title, fbRef?.ad_id,
          convAny.ad_title as string | undefined,
          convAny.creative_url as string | undefined,
          convAny.ad_id as string | undefined,
        ];
        // Also true if ANY message in the thread carries the ad-reply / shared-reel
        // marker, so a reshared ad (no Meta referral, no stored ad columns) keeps
        // its ad note and the type-first guard on later turns.
        const isAdReply = isAdReferral || enrichedText.includes("[Client replied to our ad]") || adSignals.some(Boolean) ||
          messagesForAI.some((m) => m.role === "user" && /\[Client (?:replied to|shared a post\/reel from) our ad/i.test(m.content));
        let adType = detectAdFlooringType(...adSignals);
        // Still unknown? Actually SEE the ad: pull its creative (text + image)
        // from Meta by ad_id, then fall back to the creative thumbnail. Bounded to
        // the opening turn and persisted so the tile answer survives later turns.
        // Vision is conservative (only a clear 'tile' verdict is trusted); ad TEXT
        // is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adId) {
            const ad = await withTimeout(fetchAdCreative(adId), 6000);
            if (ad?.text) resolved = detectAdFlooringType(ad.text);
            if (!resolved && ad?.imageUrl) {
              resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
            }
          }
          if (!resolved) {
            const creative = fbRef?.ads_context_data?.photo_url ?? (convAny.creative_url as string | undefined);
            if (creative) resolved = (await withTimeout(classifyAdCreativeType(creative), 6000)) === "tile" ? "tile" : null;
          }
          if (resolved) {
            adType = resolved;
            const persisted = `[${resolved}] ${(convAny.ad_title as string) ?? ""}`.trim();
            await supabaseAdmin.from("instagram_conversations").update({ ad_title: persisted }).eq("id", conv.id);
          }
        }
        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
      }
      if (!isBookingConfirmed) {
        const recentUserTexts = history
          .filter((m: { role: string; content: string }) => m.role === "user")
          .slice(-3)
          .map((m: { role: string; content: string }) => m.content);
        const detectedSqft = recentUserTexts.reduce<number | null>((found, t) => found ?? detectLargeLeadSqft(t), null);
        if (detectedSqft) {
          systemParts.push(`[LARGE LEAD ALERT: Client stated ${detectedSqft} sqft which is >= 500. This is a LARGE LEAD. You MUST propose the free in-person visit. Do NOT give any price or dollar amount by DM. Do NOT calculate "$X for this project". Respond with STEP 2B only.]`);
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
      console.error("[FB] AI generation failed — handing off to owner:", aiErr);
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
        console.log("[FB] AI failed but a reply was just sent — staying silent (no handoff)");
        return;
      }
      if (!isBookingConfirmed) {
        const fallback = aiOutageHandoffMessage(lang);
        try {
          await sendFacebookMessage(psid, fallback);
          await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
        } catch (sendErr) {
          console.error("[FB] Fallback send failed:", sendErr);
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
            platform: "Facebook",
            clientName: (conv as Record<string, unknown>).username as string ?? null,
            clientId: psid,
            recentMessages: (recentMsgs ?? []).reverse(),
            alert: isLowCreditError(aiErr) ? CREDIT_ALERT : null,
          });
        } catch (notifyErr) {
          console.error("[FB] AI-outage notify failed:", notifyErr);
        }
      }
      return;
    }

    // Pure closing / thanks with no new question → stay silent instead of
    // sending another text (Messenger has no Page-side reaction API). Never
    // overrides the post-booking flow. Burst-aware: a trailing "thanks!" must NOT
    // silence the model's answer to an earlier, still-un-answered question that
    // the 10s debounce folded into this turn.
    if (!isBookingConfirmed && (/\[REACT_ONLY\]/i.test(rawAiResponse) || isPureClosingBurst(history))) {
      console.log("[FB] React-only (closing/thanks) — no text sent");
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
    // conversation or the whole Facebook channel meanwhile. Re-check live state
    // before any outbound action so a mid-flight pause is respected.
    {
      const [{ data: liveConv }, { data: livePlatform }] = await Promise.all([
        supabaseAdmin.from("instagram_conversations").select("mode").eq("id", conv.id).single(),
        supabaseAdmin.from("platform_settings").select("paused").eq("platform", "facebook").single(),
      ]);
      if (liveConv?.mode === "human") {
        console.log("[FB] Paused mid-flight — aborting before send");
        return;
      }
      if (livePlatform?.paused) {
        console.log("[FB] Facebook channel paused mid-flight — aborting before send");
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
        console.log("[FB] Newer client message arrived during generation — discarding stale reply");
        return;
      }
    }

    // ── Grace window before a redundant booking-info re-ask ───────────────
    // Clients routinely confirm the slot and then send the address (and phone)
    // as a SECOND message a few seconds later, just past the 10s debounce —
    // firing the re-ask the instant it lands looks like the bot ignored what was
    // just sent. Give that follow-up a short window: if a newer client message
    // arrives, discard this re-ask so the newest message's handler answers with
    // the COMPLETE context (slot + address + phone).
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
          console.log("[FB] Booking-info follow-up arrived during grace window — discarding redundant re-ask");
          return;
        }
      }
    }

    const { response: afterBooking, booked } = await processBookingCommand(safeResponse, psid, conv.id, isBookingConfirmed, lang, isRescheduling);
    const afterCancel = await processCancelCommand(afterBooking, psid, conv.id);
    const afterNotify = await processNotifyOwner(afterCancel, conv.id, (conv as Record<string, unknown>).username as string ?? null, psid);
    const finalResponse = stripForbiddenTags(afterNotify);

    // Never send an empty message: a tag-only reply (bare [NOTIFY_OWNER], etc.)
    // strips to "" and the Graph API send silently fails, leaving the client with
    // no reply. The owner was already notified above if needed, so stay silent.
    if (!finalResponse.trim()) {
      console.warn("[FB] Empty response after tag stripping — staying silent (no empty send)");
      return;
    }

    void trackConversationMetrics(conv.id, "facebook", inputTokens, outputTokens, booked);

    await sendFacebookMessage(psid, finalResponse);
    await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: finalResponse });

    // Update memory in background
    if (newMemoryStoreId && process.env.ANTHROPIC_API_KEY) {
      const allMessages = [...messagesForAI, { role: "assistant" as const, content: finalResponse }];
      const memUpdate = extractMemoryUpdate(finalResponse, allMessages, {});
      if (memUpdate) {
        updateClientMemory(newMemoryStoreId, { ...memUpdate, client_name: conv.username || undefined })
          .catch((e) => console.error("FB memory update error:", e));
      }
    }
  } catch (err) {
    console.error("FB webhook error:", err);
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  console.log("[FB webhook] POST received | size:", rawBody.length, "| sig present:", !!sig);

  if (!verifyMetaSignature(rawBody, sig)) {
    console.warn("[FB webhook] Signature verification FAILED — returning 403");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const body = JSON.parse(rawBody);
  if (!body || body.object !== "page") {
    console.log("[FB webhook] Ignored — object:", body?.object);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messaging = (body.entry as Record<string, unknown>[])?.[0];
  const sender = ((messaging?.messaging as Record<string, unknown>[])?.[0]?.sender as Record<string, unknown>)?.id;
  console.log("[FB webhook] Processing message from:", sender);
  waitUntil(handleFbMessage(body));
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
