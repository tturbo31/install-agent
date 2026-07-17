import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import { fetchAdCreative } from "@/lib/facebook";
import { funilOnInboundMessage, funilOnBookingConfirmed, maybeRunFunilSilenceCheck } from "@/lib/funil";
import {
  getAIResponse,
  analyzeImageFromBase64,
  transcribeAudioFromBuffer,
  generateSpeech,
  stripForbiddenTags,
  detectLargeLeadSqft,
  isPureClosing,
  isRescheduleRequest,
  containsSchedulingOffer,
  isJobSeeker,
  isLowCreditError,
  CREDIT_ALERT,
  containsBookingInfo,
  isAskingForBookingInfo,
  isPureClosingBurst,
  detectAdFlooringType,
  adFlooringTypeNote,
  classifyAdCreativeType,
  isConsecutiveDuplicate,
  type AdFlooringType,
} from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";
import { verifyMetaSignature } from "@/lib/verify-meta";
import { AD_REPLY_NOTE } from "@/lib/system-prompt";
import { createBooking, cancelClientBooking, rescheduleClientBooking, getRealAvailabilityContext, getEasternDateContext, detectLang, bookingSuccessMessage, bookingFailureHandoffMessage, slotConflictRecoveryMessage, rescheduleSuccessMessage, aiOutageHandoffMessage, hasExistingBooking, isRealPhoneNumber, needPhoneMessage, resolveClientName, reconcileBookingWeekday, clientConfirmedSlot, needSlotConfirmationMessage } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { loadGlobalCorrections, isStructuredCorrection } from "@/lib/corrections";
import { notifyOwners } from "@/lib/whatsapp";
import { trackConversationMetrics } from "@/lib/metrics";

export const maxDuration = 60;

const RESPONSE_DELAY_MS = 10000;

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
    // "That slot just got taken.", "that time is unavailable", etc.
    .replace(/[^.!?\n]*\b(?:slot|time\s*slot|appointment|visit|horário|hora)\b[^.!?\n]*\b(?:taken|unavailable|booked|not\s+available|no\s+longer\s+available|just\s+got\s+taken|already\s+(?:taken|booked)|foi\s+ocupad|ocupad)\b[^.!?\n]*[.!?]/gi, "")
    // "Can you pick/choose/suggest another time/day/slot?"
    .replace(/[^.!?\n]*\b(?:can|could|would)\b[^.!?\n]*\b(?:pick|choose|select|suggest|prefer)\b[^.!?\n]*\b(?:another|different|other)\b[^.!?\n]*\b(?:time|day|slot|date|hora|dia)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Hard fallback: any remaining booking-conflict language → replace entire response
  if (
    /\b(?:slot|appointment|horário|hora)\b[^.!?\n]{0,60}\b(?:taken|unavailable|booked|not\s+available|no\s+longer)\b/i.test(cleaned) ||
    /\b(?:taken|unavailable|booked)\b[^.!?\n]{0,60}\b(?:slot|appointment|horário)\b/i.test(cleaned) ||
    /\bcan you (?:pick|choose|suggest|select) (?:another|a different)\b/i.test(cleaned)
  ) {
    cleaned = "You're welcome, see you then!";
  }

  return cleaned || "You're welcome, see you then!";
}

// ─── Parse and strip [BOOK:...] from AI response ──────────────────────────
async function processBookingCommand(
  aiResponse: string,
  conversationId: string,
  senderIgsid: string,
  isAlreadyBooked: boolean,
  lang: "es" | "en",
  isReschedule: boolean = false,
  history: Array<{ role: string; content: string }> = []
): Promise<{ response: string; booked: boolean }> {
  // Never attempt a second booking for an already-confirmed appointment
  // (unless this is an explicit reschedule of that same appointment).
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
        console.warn(`[IG] booking date corrected: ${rec.reason}`);
        bookingData.date = rec.date;
      }
    }

    // SLOT CONFIRMATION guard: never book a day/time the client never picked
    // (RODOLFO, 2026-07-16: booked off a volunteered address+phone with no slot
    // chosen). Address and phone are not slot selections.
    if (bookingData.date && bookingData.time && !clientConfirmedSlot(history)) {
      console.warn(`[IG] booking blocked — client never picked a specific slot; asking to choose`);
      return { response: needSlotConfirmationMessage(lang), booked: false };
    }

    // ── Reschedule: move the existing visit to the new date/time. Address and
    //    phone are copied from the saved booking, so only date/time are required.
    if (isReschedule) {
      if (!bookingData.date || !bookingData.time) {
        return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
      }
      const r = await rescheduleClientBooking(senderIgsid, bookingData.date, bookingData.time, {
        name: bookingData.name,
        phone: bookingData.phone,
        address: bookingData.address,
        notes: bookingData.notes,
      });
      if (r.success) {
        await supabaseAdmin
          .from("instagram_conversations")
          .update({ booking_confirmed: true })
          .eq("id", conversationId);
        // FUNIL: remarcação confirmada → agendamento_marcado com a NOVA data.
        waitUntil(funilOnBookingConfirmed(conversationId, senderIgsid, {
          date: bookingData.date, time: bookingData.time, phone: bookingData.phone, name: bookingData.name,
        }));
        return { response: rescheduleSuccessMessage(lang), booked: true };
      }
      // Could not move it — old booking is left intact, hand the change to Ozzi.
      // Do NOT pause the bot: an automatic failure must never permanently silence
      // the lead (mode="human" is only for a deliberate owner takeover).
      console.warn(`[IG] Reschedule failed (${r.error}) for ${bookingData.date} ${bookingData.time} — handing off (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    }

    if (!bookingData.address?.trim()) {
      console.warn("Booking blocked — address missing from booking JSON");
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
    }
    // Require a REAL phone number. The model sometimes books with a non-number
    // (e.g. client says "Call me in Messenger" and it sets phone="Messenger"),
    // producing a confirmed visit the team cannot call. Re-ask instead of booking
    // junk; do NOT set booking_confirmed, so the client's next message (the real
    // number) completes the booking normally.
    if (!isRealPhoneNumber(bookingData.phone)) {
      console.warn(`[IG] Booking blocked — phone not a real number (${JSON.stringify(bookingData.phone)})`);
      return { response: needPhoneMessage(lang), booked: false };
    }

    const { data: convData } = await supabaseAdmin
      .from("instagram_conversations")
      .select("creative_url, ad_id, ad_title, name, username, igsid")
      .eq("id", conversationId)
      .single();

    const creativeRef =
      convData?.ad_title ?? convData?.creative_url ?? convData?.ad_id ?? "Instagram DM";
    const instagramHandle = convData?.username ? `@${convData.username}` : convData?.igsid ?? "";
    const noteParts = [
      bookingData.notes ?? "",
      instagramHandle ? `Instagram: ${instagramHandle}` : "",
      creativeRef !== "Instagram DM" ? `Ad: ${creativeRef}` : "",
    ].filter(Boolean);

    // Always book under the real client name: prefer a name the client typed,
    // then the saved Instagram profile name, then the @handle. Never just "Client".
    const clientName = resolveClientName(
      [bookingData.name, convData?.name, convData?.username],
      "Instagram Client"
    );

    const result = await createBooking({
      clientName,
      clientPhone: bookingData.phone ?? "",
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: noteParts.join(" | "),
      creative: creativeRef,
      instagramHandle: convData?.username ?? undefined,
      igsid: senderIgsid,
    });

    if (result.success) {
      // Persist flag immediately so follow-up messages detect it even before history is stored
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      // FUNIL: visita confirmada → agendamento_marcado (data_visita em ISO com
      // o horário combinado). Fire-and-forget: nunca atrasa a confirmação.
      waitUntil(funilOnBookingConfirmed(conversationId, senderIgsid, {
        date: bookingData.date, time: bookingData.time, phone: bookingData.phone, name: bookingData.name,
      }));
      return {
        response: bookingSuccessMessage(lang),
        booked: true,
      };
    } else if (result.error === "already_booked") {
      // Duplicate blocked at scheduler level — ensure DB flag is set and swallow silently
      console.warn("[IG] Duplicate booking blocked by scheduler guard");
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: true })
        .eq("id", conversationId);
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
    } else if (/^No availability/i.test(result.error ?? "")) {
      // Slot the client picked is full but OTHER slots may be open: offer the
      // soonest remaining one instead of handing off (never say it was "taken").
      // Keep the AI active so the client's next pick books normally.
      const recovery = await slotConflictRecoveryMessage(lang);
      if (recovery) {
        console.warn(`[IG] Slot ${bookingData.date} ${bookingData.time} full — offering alternative slots`);
        return { response: recovery, booked: false };
      }
      console.warn(`[IG] Booking failed (${result.error}) for ${bookingData.date} ${bookingData.time}, no open slots — handing off (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    } else {
      // Booking genuinely failed — never claim a false "slot just taken". Hand the
      // hot lead to Ozzi but do NOT pause the bot: an automatic failure must never
      // permanently silence the lead (mode="human" is only for a deliberate owner
      // takeover). The owner is notified and the AI stays active to re-engage.
      console.warn(`[IG] Booking failed (${result.error}) for ${bookingData.date} ${bookingData.time} — handing off to owner (staying active)`);
      return { response: `${bookingFailureHandoffMessage(lang)}[NOTIFY_OWNER]`, booked: false };
    }
  } catch (err) {
    console.error("Booking parse error:", err);
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
      platform: "Instagram",
      clientName,
      clientId,
      recentMessages: (recentMsgs ?? []).reverse(),
    });
  } catch (err) {
    console.error("IG processNotifyOwner error:", err);
  }
  return clean;
}

// ─── Cancel booking when AI generates [CANCEL_BOOKING] ────────────────────
async function processCancelCommand(
  aiResponse: string,
  senderIgsid: string,
  conversationId: string
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;

  const cleanResponse = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();

  try {
    const result = await cancelClientBooking(senderIgsid);
    if (result.success) {
      console.log(`Cancelled ${result.cancelled} booking(s) for igsid ${senderIgsid}`);
      // Reset the DB flag so the conversation flows normally after cancellation
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ booking_confirmed: false })
        .eq("id", conversationId);
    } else {
      console.warn(`Cancel for igsid ${senderIgsid}: ${result.error}`);
    }
  } catch (err) {
    console.error("processCancelCommand error:", err);
  }

  return cleanResponse;
}

// ─── Core webhook handler ──────────────────────────────────────────────────
async function handleWebhook(body: WebhookPayload) {
  try {
    const { data: igSetting } = await supabaseAdmin
      .from("platform_settings")
      .select("paused")
      .eq("platform", "instagram")
      .single();
    if (igSetting?.paused) return;

    if (body.object !== "instagram") return;
    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return;

    // Capture owner responses for training (echo OR agent_message from business)
    const isEcho = !!messaging.message?.is_echo;
    const senderIgsidRaw = messaging.sender?.id ?? "";
    const recipientIgsidRaw = messaging.recipient?.id ?? "";
    const BUSINESS_IGSID = "1940528653163182";
    const isBusinessSending = senderIgsidRaw === BUSINESS_IGSID || isEcho;

    if (isBusinessSending) {
      const ownerText = messaging.message?.text;
      const customerIgsid = isEcho ? recipientIgsidRaw : recipientIgsidRaw;
      console.log("Owner message detected:", isEcho ? "echo" : "agent_message", "| customer:", customerIgsid, "| text:", ownerText?.slice(0, 50));

      if (ownerText && customerIgsid && customerIgsid !== BUSINESS_IGSID) {
        const { data: conv } = await supabaseAdmin
          .from("instagram_conversations")
          .select("id")
          .eq("igsid", customerIgsid)
          .maybeSingle();
        if (conv?.id) {
          // Bot-own echo? The bot saves every reply to history right after
          // sending, so an identical recent assistant message means this echo
          // is our own send — skip it (recording it as [Treino] would poison
          // the owner corrections with every bot reply). A HUMAN typing from
          // the business inbox is a genuine owner takeover: record it and
          // pause the conversation so the bot never contradicts the owner
          // (2026-07-08: bot re-offered slots right after the owner manually
          // offered Saturday 3pm and the client accepted). RACE GUARD: the
          // echo can arrive BEFORE the bot's history insert commits, so on a
          // miss wait and re-check before declaring this a human reply.
          const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
          const matchesRecentBot = async () => {
            const { data: recentBot } = await supabaseAdmin
              .from("instagram_messages")
              .select("content")
              .eq("conversation_id", conv.id)
              .eq("role", "assistant")
              .order("created_at", { ascending: false })
              .limit(5);
            return (recentBot ?? []).some((m) => norm(m.content) === norm(ownerText));
          };
          let isOwnEcho = await matchesRecentBot();
          if (!isOwnEcho) {
            await new Promise((r) => setTimeout(r, 3000));
            isOwnEcho = await matchesRecentBot();
          }
          if (!isOwnEcho) {
            await supabaseAdmin.from("instagram_messages").insert({
              conversation_id: conv.id,
              role: "assistant",
              content: `[Treino] ${ownerText}`,
            });
            await supabaseAdmin.from("instagram_conversations").update({ mode: "human" }).eq("id", conv.id);
            console.log(`[IG] owner manual reply captured — conversation ${conv.id} paused (mode=human)`);
          }
        }
      }
      return;
    }

    const senderIgsid = messaging.sender.id;
    // Ad-click / referral events can arrive without a normal message.mid. Never let
    // a missing mid throw (the outer try/catch would silently drop the whole message,
    // which is why ad replies often went unanswered). Synthesize a unique id so dedup,
    // storage, and the later enrichment update still target the right row.
    const messageMid = messaging.message?.mid ?? `syn_${senderIgsid}_${Date.now()}`;

    // Skip duplicates
    const { data: alreadyProcessed } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("instagram_msg_id", messageMid)
      .maybeSingle();
    if (alreadyProcessed) return;

    // ── Find or create conversation ──────────────────────────────────────
    let { data: conversation } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", senderIgsid)
      .single();

    const wasNewConv = !conversation;

    if (!conversation) {
      const defaultMode = "agent";
      const { data: newConv, error: convErr } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: senderIgsid, mode: defaultMode })
        .select()
        .single();
      if (convErr) {
        // Ad clicks fire two webhook events almost simultaneously (ad referral +
        // the text message). They race to create the conversation; the loser hits
        // the unique igsid constraint. Recover the row instead of dropping the
        // message — otherwise the client's question is silently lost.
        const { data: existing } = await supabaseAdmin
          .from("instagram_conversations")
          .select("*")
          .eq("igsid", senderIgsid)
          .single();
        conversation = existing ?? null;
      } else {
        conversation = newConv;
      }
    }
    if (!conversation) return;

    // ── Detect attachments ───────────────────────────────────────────────
    const attachments = messaging.message?.attachments ?? [];
    const imageAttachment = attachments.find((a) => a.type === "image");

    // Ignore Instagram stickers (thumbs up and emoji stickers arrive as image with sticker_id)
    if ((imageAttachment?.payload as Record<string, unknown>)?.sticker_id) return;

    const shareAttachment = attachments.find((a) => a.type === "share");
    const audioAttachment = attachments.find((a) => a.type === "audio");
    const clientSentAudio = !!audioAttachment;

    let rawText = messaging.message?.text ?? "";

    // Ignore emoji-only messages (end-of-conversation reactions like 👍 ❤️)
    if (rawText && !rawText.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F2FF}\u{1F900}-\u{1FAFF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}]/gu, "").trim()) return;

    const imageUrl = imageAttachment?.payload?.url ?? null;
    const shareUrl = shareAttachment?.payload?.url ?? null;
    const audioUrl = audioAttachment?.payload?.url ?? null;

    // Ad reply context: the client clicked/replied to one of our ads. Meta delivers
    // these as a referral and/or a reel attachment whose type we don't recognize
    // (video / ig_reel / story), often with NO text in this event. That used to fall
    // through to `if (!rawText) return` below — creating an empty conversation with no
    // reply (exactly the "No messages yet" + raw IGSID we saw). Treat it as a hot lead.
    const isAdReferral = !!messaging.referral;
    const hasAnyAttachment = attachments.length > 0;

    if (imageUrl && !rawText) rawText = "[floor plan or photo]";
    if (shareUrl && !rawText) rawText = `[shared link: ${shareUrl}]`;
    if (audioUrl && !rawText) rawText = "[voice message]";
    // Never drop an ad reply or an attachment-bearing event just because this event
    // carried no readable text — store it and engage instead of going silent.
    if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]";

    console.log(`[IG] msg from ${senderIgsid} | text:${!!messaging.message?.text} | attachments:[${attachments.map((a) => a.type).join(",")}] | adReferral:${isAdReferral}`);

    if (!rawText) return;

    // ── Pre-fetch media BEFORE debounce (URLs expire fast) ───────────────
    const igToken = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
    let preFetchedAudioBuffer: ArrayBuffer | null = null;
    let preFetchedAudioType = "audio/mp4";
    let preFetchedImageBase64: string | null = null;

    if (audioUrl) {
      const urlWithToken = audioUrl.includes("?")
        ? `${audioUrl}&access_token=${igToken}`
        : `${audioUrl}?access_token=${igToken}`;
      for (const [u, opts] of [
        [urlWithToken, {}],
        [audioUrl, { headers: { Authorization: `Bearer ${igToken}` } }],
        [audioUrl, {}],
      ] as [string, RequestInit][]) {
        try {
          const r = await fetch(u, { ...opts, redirect: "follow" });
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (!ct.startsWith("audio/") && !ct.startsWith("video/") && !ct.includes("octet-stream")) continue;
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 1000) {
            preFetchedAudioBuffer = buf;
            preFetchedAudioType = ct.split(";")[0] || "audio/mp4";
            break;
          }
        } catch { continue; }
      }
    }

    if (imageUrl) {
      // Try Graph API first (most reliable for authenticated Instagram images)
      try {
        const graphRes = await fetch(
          `https://graph.instagram.com/v24.0/${messageMid}?fields=attachments&access_token=${igToken}`
        );
        if (graphRes.ok) {
          const graphData = await graphRes.json();
          const attachmentUrl =
            graphData?.attachments?.data?.[0]?.image_data?.url ??
            graphData?.attachments?.data?.[0]?.file_url ?? null;
          if (attachmentUrl) {
            const imgRes = await fetch(attachmentUrl, { redirect: "follow" });
            if (imgRes.ok) {
              const ct = imgRes.headers.get("content-type") || "image/jpeg";
              const buf = await imgRes.arrayBuffer();
              if (buf.byteLength > 3000) {
                preFetchedImageBase64 = `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`;
              }
            }
          }
        }
      } catch { /* fallthrough to CDN */ }

      if (!preFetchedImageBase64) {
        const urlWithToken = imageUrl.includes("?")
          ? `${imageUrl}&access_token=${igToken}`
          : `${imageUrl}?access_token=${igToken}`;
        for (const [u, opts] of [
          [urlWithToken, {}],
          [imageUrl, { headers: { Authorization: `Bearer ${igToken}` } }],
          [imageUrl, {}],
        ] as [string, RequestInit][]) {
          try {
            const r = await fetch(u, { ...opts, redirect: "follow" });
            if (!r.ok) continue;
            const ct = r.headers.get("content-type") || "";
            if (!ct.startsWith("image/")) continue;
            const buf = await r.arrayBuffer();
            if (buf.byteLength > 3000) {
              preFetchedImageBase64 = `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`;
              break;
            }
          } catch { continue; }
        }
      }
    }

    // ── Store message immediately ────────────────────────────────────────
    const { data: insertedMsg, error: insertErr } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conversation.id,
        role: "user",
        content: rawText,
        instagram_msg_id: messageMid,
      })
      .select("id, created_at")
      .single();

    if (insertErr && insertErr.code !== "23505") return;
    const thisMessageId = insertedMsg?.id ?? "";

    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // ── FUNIL → Ozzi Plataforma (fire-and-forget, nunca bloqueia) ──
    // Só quando ESTA instância inseriu a mensagem (dedup de webhook repetido).
    // Cobre: lead_criado (1ª mensagem de contato novo, com atribuição do
    // anúncio via referral CTWA), conversando (1ª resposta real) e
    // retomou_conversa (lead sumido voltou). Roda antes do gate mode=human de
    // propósito: a resposta do cliente conta para o funil mesmo com o dono no
    // controle da conversa.
    if (insertedMsg?.id) {
      waitUntil(
        funilOnInboundMessage(
          { id: conversation.id, igsid: senderIgsid, name: conversation.name, username: conversation.username, created_at: conversation.created_at },
          rawText,
          insertedMsg.created_at ?? new Date().toISOString(),
          messaging.referral ?? null
        )
      );
      waitUntil(maybeRunFunilSilenceCheck()); // sweep parou_de_responder, no máx. a cada 6h
    }

    if (conversation.mode === "human") return;

    // ── Debounce: wait 10s, then check if we're still the latest message ──
    await new Promise((r) => setTimeout(r, RESPONSE_DELAY_MS));

    const { data: latestMsg } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (!latestMsg || latestMsg.id !== thisMessageId) return;

    // ── Re-fetch conversation BEFORE rate limit ───────────────────────────
    // A concurrent handler may have set booking_confirmed while we were waiting
    const { data: freshConv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("id", conversation.id)
      .single();
    if (freshConv) conversation = freshConv;

    // ── Pause guard (post-debounce) ───────────────────────────────────────
    // The owner may have paused this conversation ("Pausar IA") during the 10s
    // debounce. The freshConv re-fetch above already has the live mode, so honor
    // it now — before spending an AI call. Without this the bot kept replying
    // even after the owner paused.
    if (conversation.mode === "human") {
      console.log("[IG] Conversation paused during debounce — staying silent");
      return;
    }

    // Returning client who already booked or was already served (visit done),
    // even if booked outside the bot — hand to the team, never re-engage.
    if (!wasNewConv && !(conversation as Record<string, unknown>).booking_confirmed) {
      const served = await hasExistingBooking(senderIgsid).catch(() => false);
      if (served) {
        await supabaseAdmin.from("instagram_conversations").update({ booking_confirmed: true }).eq("id", conversation.id);
        (conversation as Record<string, unknown>).booking_confirmed = true;
      }
    }

    // ── Reschedule intent: a booked client asking to MOVE their visit is the one
    //    case where we engage after a booking, instead of the silent owner-notify.
    //    The intent appears in the FIRST reschedule message ("can we move it?");
    //    the follow-up that just names the new day ("Friday at 3pm") won't match,
    //    so we also keep engaging while a reschedule is already in progress (the
    //    last assistant message offered slots). ──
    const isBooked = !!(conversation as Record<string, unknown>).booking_confirmed;
    let engageReschedule = isBooked && isRescheduleRequest(rawText);
    if (isBooked && !engageReschedule && !isPureClosing(rawText)) {
      const { data: lastAsst } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conversation.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAsst?.content && containsSchedulingOffer(lastAsst.content)) engageReschedule = true;
    }

    // ── If already booked (and NOT rescheduling) → notify owner silently, no message ──
    if (isBooked && !engageReschedule) {
      try {
        const { data: recentMsgs } = await supabaseAdmin
          .from("instagram_messages")
          .select("role, content")
          .eq("conversation_id", conversation.id)
          .order("created_at", { ascending: false })
          .limit(8);
        await notifyOwners({
          platform: "Instagram",
          clientName: conversation.username ?? null,
          clientId: senderIgsid,
          recentMessages: (recentMsgs ?? []).reverse(),
        });
      } catch (err) {
        console.error("Post-booking notify error:", err);
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
      .eq("conversation_id", conversation.id)
      .eq("role", "assistant")
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .limit(1);
    if (recentReply && recentReply.length > 0 && !carriesBookingInfo) return;

    // ── Process media ────────────────────────────────────────────────────
    let enrichedText = rawText;
    let mediaProcessed = false;

    if (shareAttachment) {
      const shareTitle = shareAttachment.payload?.title ?? null;
      const isFloorPlan = shareTitle ? /planta|floor.?plan|blueprint|casa|apartamento|projeto/i.test(shareTitle) : false;
      const shareNote = isFloorPlan
        ? `[Client shared a floor plan${shareTitle ? `: "${shareTitle}"` : ""}]`
        : `[Client shared a post/reel from our ad${shareTitle ? `: "${shareTitle}"` : ""}]`;
      // CRITICAL: when the client replies to an ad, the reel arrives as a share
      // attachment AND the pre-filled question arrives as text. NEVER overwrite the
      // real text with the share note — keep the question and append the context, so
      // the AI actually answers ("What is included in the materials package?").
      const realText = (messaging.message?.text ?? "").trim();
      enrichedText = realText ? `${realText}\n${shareNote}` : shareNote;
      mediaProcessed = true;
    }

    if (imageUrl || shareUrl) {
      try {
        const analysis = preFetchedImageBase64
          ? await analyzeImageFromBase64(preFetchedImageBase64)
          : null;

        if (
          analysis &&
          !analysis.toLowerCase().includes("could not") &&
          !analysis.toLowerCase().includes("unavailable") &&
          analysis.length > 20
        ) {
          enrichedText = enrichedText
            .replace("[floor plan or photo]", "")
            .replace(`[shared link: ${shareUrl ?? imageUrl}]`, "")
            .trim();
          enrichedText = enrichedText
            ? `${enrichedText}\n[Floor plan analysis: ${analysis}]`
            : `[Floor plan analysis: ${analysis}]`;
          mediaProcessed = true;
        }
      } catch (err) {
        console.warn("Image analysis failed:", err);
      }
    }

    if (audioUrl) {
      try {
        const transcript = preFetchedAudioBuffer
          ? await transcribeAudioFromBuffer(preFetchedAudioBuffer, preFetchedAudioType)
          : null;

        const nonLatinCount = (transcript || "").split("").filter((c) => c.charCodeAt(0) > 1000).length;
        const wordCount = (transcript || "").trim().split(/\s+/).length;
        const isUseful =
          !!transcript &&
          nonLatinCount < 5 &&
          wordCount >= 2 &&
          transcript.length > 5 &&
          !transcript.includes("please type") &&
          !transcript.includes("could not") &&
          !transcript.includes("no speech");

        if (isUseful) {
          enrichedText = enrichedText.replace("[voice message]", "").trim();
          enrichedText = enrichedText ? `${enrichedText}\n[Voice: ${transcript}]` : transcript;
          mediaProcessed = true;
        } else {
          enrichedText = enrichedText.replace("[voice message]", "").trim();
        }
      } catch (err) {
        console.warn("Transcription failed:", err);
      }
    }

    // Fallback for media that failed to process. If the client typed real text
    // (e.g. an ad reply with the pre-filled question), ALWAYS answer it — even when
    // an attached reel/photo could not be analyzed. The "Got your photo" fallback is
    // only for messages that are media-only with no usable text.
    const clientHasText = !!messaging.message?.text?.trim();
    const clientActuallySentMedia = !!(audioUrl || imageUrl) || (!!shareUrl && !clientHasText);
    const hasRealContent = clientHasText || (mediaProcessed && enrichedText.trim().length > 0);

    if (!hasRealContent && clientActuallySentMedia) {
      const hadAudio = !!audioUrl;
      const hadImage = !!(imageUrl || shareUrl);
      let finalResponse: string;
      if (hadAudio && hadImage) {
        finalResponse = "Got your photo and voice message! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need.";
      } else if (hadAudio) {
        finalResponse = "Got your voice message but could not catch it. Could you type what you need?";
      } else {
        finalResponse = "Got your photo! If it is a floor plan, just type the total area in sqft or sqm and I will calculate right here. If it is a photo of your current floors, just describe what you need.";
      }
      // Dedup: a client re-sending an unsupported attachment (e.g. two files in
      // a row) used to get this identical canned line each time — a robotic
      // repeat (rule 29). Once is enough; stay silent on the repeat.
      const { data: lastBot } = await supabaseAdmin
        .from("instagram_messages")
        .select("content")
        .eq("conversation_id", conversation.id)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1);
      if (lastBot?.[0] && isConsecutiveDuplicate([{ role: "assistant", content: lastBot[0].content }], finalResponse)) {
        console.log("[IG] no-content fallback identical to last reply — staying silent (no robotic repeat)");
        return;
      }
      await sendInstagramMessage(senderIgsid, finalResponse);
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: finalResponse,
      });
      return;
    }

    if (!enrichedText.trim()) return;

    // ── Job seeker / service provider → do not respond at all ────────────
    // Someone looking for work or offering their labor (installer, painter, etc.)
    // is not a customer. Stay completely silent (message is still stored for the
    // owner to see). Never silences a real client asking about our service.
    if (isJobSeeker(enrichedText)) {
      console.log("[IG] Job seeker / service offer — staying silent");
      return;
    }

    // ── Update stored message with enriched content ──────────────────────
    await supabaseAdmin
      .from("instagram_messages")
      .update({ content: enrichedText })
      .eq("instagram_msg_id", messageMid);

    // ── Fetch profile ────────────────────────────────────────────────────
    try {
      const profile = await fetchInstagramProfile(senderIgsid);
      const referral = messaging.referral;
      const updateData: Record<string, unknown> = {
        ...profile,
        updated_at: new Date().toISOString(),
      };
      if (referral?.ads_context_data?.photo_url) updateData.creative_url = referral.ads_context_data.photo_url;
      if (referral?.ad_id) updateData.ad_id = referral.ad_id;
      if (referral?.ads_context_data?.ad_title) updateData.ad_title = referral.ads_context_data.ad_title;
      await supabaseAdmin.from("instagram_conversations").update(updateData).eq("igsid", senderIgsid);
    } catch (err) {
      console.warn("Profile fetch failed:", err);
    }

    // ── Ensure memory store exists for this client ────────────────────────
    let memoryStoreId: string | null = conversation.memory_store_id ?? null;
    if (!memoryStoreId && process.env.ANTHROPIC_API_KEY) {
      try {
        memoryStoreId = await createClientMemoryStore(senderIgsid, conversation.username);
        await supabaseAdmin
          .from("instagram_conversations")
          .update({ memory_store_id: memoryStoreId })
          .eq("id", conversation.id);
        conversation = { ...conversation, memory_store_id: memoryStoreId };
      } catch (err) {
        console.warn("Memory store creation failed:", err);
      }
    }

    // ── Load client memory + system memory (parallel, max 3s each) ───────
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]).catch(() => null);

    const [memoryContext, systemMemory] = await Promise.all([
      memoryStoreId && process.env.ANTHROPIC_API_KEY
        ? withTimeout(readClientMemory(memoryStoreId), 3000)
        : Promise.resolve(null),
      process.env.ANTHROPIC_API_KEY
        ? withTimeout(
            getOrCreateSystemStore().then((id) => readSystemMemory(id)),
            3000
          )
        : Promise.resolve(null),
    ]);

    // ── Load conversation history (last 15 messages; created_at feeds the
    //    repeated-message intercept so it can tell a double-tap from a genuine
    //    re-ask hours later) ───────────────────────────────────────────────
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(15);

    const history = (historyRaw ?? []).reverse();

    // ── Determine booking status — DB flag only (history fallback removed:
    //    it kept triggering after cancellations because "Appointment confirmed"
    //    remains in history even after booking_confirmed is reset to false) ──
    // When a booked client is rescheduling, treat as NOT confirmed for this turn so
    // the bot engages (offers new slots) instead of staying silent.
    const isRescheduling = isBooked && engageReschedule;
    const isBookingConfirmed = isBooked && !isRescheduling;

    const lastUserMsg = enrichedText.toLowerCase();
    const partnershipKeywords = ["partnership", "parceria", "exchange", "troca", "barter", "collab", "collaboration", "influencer", "promote", "shoutout", "stories", "reels", "post exchange"];
    const isPartnershipRequest = partnershipKeywords.some((k) => lastUserMsg.includes(k));

    // Always build current date context so the agent never confuses days.
    // Always Eastern (server runs UTC; see scheduler helpers).
    const dateContext = getEasternDateContext();

    const lang = detectLang(history.map((m) => m.content).join(" "));

    type AiMsg = { role: "user" | "assistant"; content: string; at?: string };

    let messagesForAI: AiMsg[] = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      at: m.created_at as string | undefined,
    }));

    const lastIdx = messagesForAI.length - 1;
    if (lastIdx >= 0 && messagesForAI[lastIdx].role === "user") {
      // Only fetch availability when no booking is confirmed yet.
      // After booking, showing availability causes the AI to see the booked slot as
      // "taken" and generate "that slot just got taken" on follow-up messages.
      const availability = isBookingConfirmed ? null : await getRealAvailabilityContext();
      const systemParts: string[] = availability ? [dateContext, availability] : [dateContext];
      const followerCount = (conversation as Record<string, unknown>).follower_count as number | null;
      if (isPartnershipRequest && followerCount != null) {
        systemParts.push(`[FOLLOWER_COUNT: ${followerCount}]`);
      }
      const isOwnerHandled = !isBookingConfirmed && history.some(m =>
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
      // "flooring + labor + quarter round" package. Detect from the ad signals we
      // already capture (ad_title / creative_url / ad_id — fresh from this event
      // or stored on the conversation). If text is silent, look at the ad creative
      // image (vision). Only if everything is inconclusive do we ask the client
      // the type (the existing AD_REPLY_NOTE) — so the working vinyl flow and the
      // unknown-ad flow are never changed; we ONLY add correctness when we know.
      if (!isBookingConfirmed) {
        const ref = messaging.referral;
        const convAny = conversation as Record<string, unknown>;
        const adId = (ref?.ad_id ?? convAny.ad_id) as string | undefined;
        const adSignals = [
          ref?.ads_context_data?.ad_title, ref?.ad_id,
          convAny.ad_title as string | undefined,
          convAny.creative_url as string | undefined,
          convAny.ad_id as string | undefined,
        ];
        // Also true if ANY message in the thread carries the ad-reply / shared-reel
        // marker — a reshared ad reel has no Meta referral and stores no ad columns,
        // so without the history scan the ad note would vanish on turn 2 and the
        // type-first guard would be lost.
        const isAdReply = isAdReferral || enrichedText.includes("[Client replied to our ad]") || adSignals.some(Boolean) ||
          messagesForAI.some((m) => m.role === "user" && /\[Client (?:replied to|shared a post\/reel from) our ad/i.test(m.content));
        let adType = detectAdFlooringType(...adSignals);
        // Still unknown? Actually SEE the ad: pull its creative (text + image)
        // from Meta by ad_id, then fall back to the creative thumbnail we already
        // have. Bounded to the opening turn and persisted so it never re-runs and
        // the tile answer survives later turns. Vision is conservative (only a
        // clear 'tile' verdict is trusted, since this advertiser's vinyl mimics
        // wood/stone/marble); ad TEXT is trusted for all three types.
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
            const creative = ref?.ads_context_data?.photo_url ?? (convAny.creative_url as string | undefined);
            if (creative) resolved = (await withTimeout(classifyAdCreativeType(creative), 6000)) === "tile" ? "tile" : null;
          }
          if (resolved) {
            adType = resolved;
            const persisted = `[${resolved}] ${(convAny.ad_title as string) ?? ""}`.trim();
            await supabaseAdmin.from("instagram_conversations").update({ ad_title: persisted }).eq("id", conversation.id);
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
      // Scan last 3 user messages for a large-lead sqft mention
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
      messagesForAI[lastIdx] = {
        ...messagesForAI[lastIdx],
        content: `${messagesForAI[lastIdx].content}\n\n${systemNote}`,
      };
    }

    // ── Generate AI response ─────────────────────────────────────────────
    // Owner corrections are loaded live so a dashboard fix applies instantly,
    // without waiting for the nightly Dreaming pass.
    const ownerCorrections = isBookingConfirmed ? null : await loadGlobalCorrections();
    // Pass isBookingConfirmed so the system prompt gets the CRITICAL block injected
    let rawAiText: string;
    let inputTokens: number;
    let outputTokens: number;
    try {
      const aiResult = await getAIResponse(
        messagesForAI,
        memoryContext,
        systemMemory,
        ownerCorrections,
        isBookingConfirmed
      );
      rawAiText = aiResult.text;
      inputTokens = aiResult.inputTokens;
      outputTokens = aiResult.outputTokens;
    } catch (aiErr) {
      // AI is down (credits exhausted, rate limit, timeout, network). Never leave
      // the client in silence: send a graceful holding reply, hand the lead to a
      // human, and notify the owner so the conversation is never lost.
      console.error("[IG] AI generation failed — handing off to owner:", aiErr);
      // Burst guard: rapid client messages spawn parallel handlers. If another
      // one already answered this conversation in the last 30s, a transient
      // failure here must NOT send the contradictory "team will reach out"
      // handoff on top of a good reply. Stay silent instead.
      const { data: justReplied } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conversation.id)
        .eq("role", "assistant")
        .gte("created_at", new Date(Date.now() - 30000).toISOString())
        .limit(1);
      if (justReplied && justReplied.length > 0) {
        console.log("[IG] AI failed but a reply was just sent — staying silent (no handoff)");
        return;
      }
      if (!isBookingConfirmed) {
        const fallback = aiOutageHandoffMessage(lang);
        // Outage dedup: during a sustained outage EVERY inbound hits this path —
        // one client once received this exact canned line 12 times in 90 minutes
        // (2026-07-06). If the last thing we sent is already this line, stay
        // silent; the client was told once and the owner was already notified.
        if (isConsecutiveDuplicate(messagesForAI, fallback)) {
          console.log("[IG] outage handoff already sent — staying silent (no repeat)");
          return;
        }
        try {
          await sendInstagramMessage(senderIgsid, fallback);
          await supabaseAdmin.from("instagram_messages").insert({
            conversation_id: conversation.id,
            role: "assistant",
            content: fallback,
          });
        } catch (sendErr) {
          console.error("[IG] Fallback send failed:", sendErr);
        }
        // Do NOT pause: an AI outage is transient (overload, timeout, or credits
        // being topped up). Leave the conversation in "agent" mode so the next
        // message retries once the API recovers — permanently flipping to "human"
        // here is what left leads silent forever.
        try {
          const { data: recentMsgs } = await supabaseAdmin
            .from("instagram_messages")
            .select("role, content")
            .eq("conversation_id", conversation.id)
            .order("created_at", { ascending: false })
            .limit(8);
          await notifyOwners({
            platform: "Instagram",
            clientName: conversation.username ?? null,
            clientId: senderIgsid,
            recentMessages: (recentMsgs ?? []).reverse(),
            alert: isLowCreditError(aiErr) ? CREDIT_ALERT : null,
          });
        } catch (notifyErr) {
          console.error("[IG] AI-outage notify failed:", notifyErr);
        }
      }
      return;
    }

    // Pure closing / thanks with no new question → stay silent instead of
    // sending another text. Never overrides the post-booking flow. Burst-aware:
    // a trailing "thanks!" must NOT silence the model's answer to an earlier,
    // still-un-answered question that the 10s debounce folded into this turn.
    if (!isBookingConfirmed && (/\[REACT_ONLY\]/i.test(rawAiText) || isPureClosingBurst(history))) {
      console.log("[IG] React-only (closing/thanks) — no text sent");
      return;
    }

    // Strip any [BOOK:...] if booking already confirmed
    let safeAiText = (isBookingConfirmed
      ? rawAiText.replace(/\[BOOK:[\s\S]*?\]/g, "").trim()
      : rawAiText
    ).replace(/\[REACT_ONLY\]/gi, "").trim();

    // Safety net: the bot must NEVER tell a client a slot "just got taken" or to
    // "pick another time" — in ANY state (this hallucination appeared on a post-
    // confirmation follow-up). Strip it universally; skip only when a [BOOK] tag is
    // present so a real booking is never clobbered.
    if (!/\[BOOK:/i.test(safeAiText)) {
      safeAiText = stripSlotConflictLanguage(safeAiText);
    }

    // ── Final pause guard (pre-send) ──────────────────────────────────────
    // Generating the reply takes 10-20s. The owner may have paused this
    // conversation or the whole Instagram channel in that window. Re-check the
    // LIVE state right before any outbound action (send, booking, notify) so a
    // pause that lands mid-flight is respected. This is the fix for "I paused
    // but the AI kept talking".
    {
      const [{ data: liveConv }, { data: livePlatform }] = await Promise.all([
        supabaseAdmin.from("instagram_conversations").select("mode").eq("id", conversation.id).single(),
        supabaseAdmin.from("platform_settings").select("paused").eq("platform", "instagram").single(),
      ]);
      if (liveConv?.mode === "human") {
        console.log("[IG] Paused mid-flight — aborting before send");
        return;
      }
      if (livePlatform?.paused) {
        console.log("[IG] Instagram channel paused mid-flight — aborting before send");
        return;
      }
    }

    // ── Stale-context guard (pre-send) ────────────────────────────────────
    // The client often sends rapid-fire bubbles (slot, then phone, then address
    // in separate messages). The 10s debounce can elapse for an earlier bubble
    // just before the next one lands, so this reply was built on STALE context
    // (e.g. it asks for the address the client already sent in the next bubble,
    // or it never books because the address was not yet in history). If a newer
    // user message has arrived since we started, discard this stale reply and let
    // the newest message's handler answer with the COMPLETE context. The last
    // message's handler always passes this guard, so no reply is ever lost.
    {
      const { data: newestUser } = await supabaseAdmin
        .from("instagram_messages")
        .select("id")
        .eq("conversation_id", conversation.id)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (newestUser && newestUser.id !== thisMessageId) {
        console.log("[IG] Newer client message arrived during generation — discarding stale reply");
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
    if (!isBookingConfirmed && isAskingForBookingInfo(safeAiText)) {
      for (let i = 0; i < 2; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const { data: newer } = await supabaseAdmin
          .from("instagram_messages")
          .select("id")
          .eq("conversation_id", conversation.id)
          .eq("role", "user")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (newer && newer.id !== thisMessageId) {
          console.log("[IG] Booking-info follow-up arrived during grace window — discarding redundant re-ask");
          return;
        }
      }
    }

    const { response: afterBookingText, booked } = await processBookingCommand(
      safeAiText,
      conversation.id,
      senderIgsid,
      isBookingConfirmed,
      lang,
      isRescheduling,
      history
    );
    const afterCancel = await processCancelCommand(afterBookingText, senderIgsid, conversation.id);
    const afterNotify = await processNotifyOwner(afterCancel, conversation.id, conversation.username ?? null, senderIgsid);
    const finalResponse = stripForbiddenTags(afterNotify);

    // Never send an empty message. When the model emits only a tag (a bare
    // [NOTIFY_OWNER], or a [BOOK]/[REACT_ONLY] that strips to nothing), the text
    // becomes "" and the Graph API send silently fails — the client sees no reply
    // at all. The owner was already notified above if needed, so stay silent.
    if (!finalResponse.trim()) {
      console.warn("[IG] Empty response after tag stripping — staying silent (no empty send)");
      return;
    }

    void trackConversationMetrics(conversation.id, "instagram", inputTokens, outputTokens, booked);

    // Rule 29 backstop: never send the exact same message twice in a row. A
    // re-tapped FAQ button used to get the identical reply again (robotic
    // loop). The client already has this answer directly above — stay silent.
    // Booking turns are exempt: a [BOOK:] confirmation must always go out.
    if (!booked && isConsecutiveDuplicate(messagesForAI, finalResponse)) {
      console.log("[IG] reply identical to previous bot message — staying silent (no robotic repeat)");
      return;
    }

    // ── Send response ────────────────────────────────────────────────────
    await sendInstagramMessage(senderIgsid, finalResponse);

    if (clientSentAudio && process.env.OPENAI_API_KEY) {
      generateSpeech(finalResponse)
        .then(async (buf) => {
          if (buf) await sendInstagramAudio(senderIgsid, buf);
        })
        .catch((e) => console.error("TTS error:", e));
    }

    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: finalResponse,
    });

    // ── Update memory in background (no latency impact) ──────────────────
    if (memoryStoreId && process.env.ANTHROPIC_API_KEY) {
      const allMessages = [...messagesForAI, { role: "assistant" as const, content: finalResponse }];
      const memUpdate = extractMemoryUpdate(finalResponse, allMessages, {});
      if (memUpdate) {
        updateClientMemory(memoryStoreId, {
          ...memUpdate,
          client_name: conversation.username || undefined,
        }).catch((e) => console.error("Memory update error:", e));
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-hub-signature-256");
  console.log("[IG webhook] POST received | size:", rawBody.length, "| sig present:", !!sig);

  if (!verifyMetaSignature(rawBody, sig)) {
    console.warn("[IG webhook] Signature verification FAILED — returning 403");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const body: WebhookPayload = JSON.parse(rawBody);
  if (!body || body.object !== "instagram") {
    console.log("[IG webhook] Ignored — object:", body?.object);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messaging = body.entry?.[0]?.messaging?.[0];
  if (!messaging || messaging.message?.is_echo) {
    return NextResponse.json({ status: "skipped" }, { status: 200 });
  }

  console.log("[IG webhook] Processing message from:", messaging.sender?.id);
  waitUntil(handleWebhook(body));
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
