import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import {
  getAIResponse,
  analyzeImageFromBase64,
  transcribeAudioFromBuffer,
  generateSpeech,
  stripForbiddenTags,
  detectLargeLeadSqft,
} from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";
import { verifyMetaSignature } from "@/lib/verify-meta";
import { createBooking, cancelClientBooking, getRealAvailabilityContext } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { notifyOwners } from "@/lib/whatsapp";

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

// ─── Track token usage and conversion in Supabase ─────────────────────────
async function trackConversationMetrics(
  conversationId: string,
  platform: string,
  inputTokens: number,
  outputTokens: number,
  converted: boolean
): Promise<void> {
  try {
    await supabaseAdmin.rpc("increment_conversation_metrics", {
      p_conversation_id: conversationId,
      p_platform: platform,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_converted: converted,
    });
  } catch (err) {
    console.error("Metrics tracking error:", err);
  }
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
  isAlreadyBooked: boolean
): Promise<{ response: string; booked: boolean }> {
  // Never attempt a second booking for an already-confirmed appointment
  if (isAlreadyBooked) {
    return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").trim(), booked: false };
  }

  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return { response: aiResponse, booked: false };
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    if (!bookingData.phone?.trim() || !bookingData.address?.trim()) {
      console.warn("Booking blocked — phone or address missing from booking JSON");
      return { response: aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim(), booked: false };
    }

    const { data: convData } = await supabaseAdmin
      .from("instagram_conversations")
      .select("creative_url, ad_id, ad_title, username, igsid")
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

    const result = await createBooking({
      clientName: bookingData.name ?? "Instagram Client",
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
      return {
        response: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.",
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
    } else {
      return { response: "That slot was just taken. Can you suggest another day and time?", booked: false };
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
          void supabaseAdmin.from("instagram_messages").insert({
            conversation_id: conv.id,
            role: "assistant",
            content: `[Treino] ${ownerText}`,
          });
          console.log("Training response saved for conversation", conv.id);
        }
      }
      return;
    }

    const senderIgsid = messaging.sender.id;
    const messageMid = messaging.message.mid;

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

    if (!conversation) {
      const defaultMode = "agent";
      const { data: newConv } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: senderIgsid, mode: defaultMode })
        .select()
        .single();
      conversation = newConv;
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

    if (imageUrl && !rawText) rawText = "[floor plan or photo]";
    if (shareUrl && !rawText) rawText = `[shared link: ${shareUrl}]`;
    if (audioUrl && !rawText) rawText = "[voice message]";
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

    // ── If already booked → notify owner silently, no message to client ──
    if ((conversation as Record<string, unknown>).booking_confirmed) {
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

    // Rate limit: 5s window prevents genuine duplicates without blocking fast client replies
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("role", "assistant")
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .limit(1);
    if (recentReply && recentReply.length > 0) return;

    // ── Process media ────────────────────────────────────────────────────
    let enrichedText = rawText;
    let mediaProcessed = false;

    if (shareAttachment) {
      const shareTitle = shareAttachment.payload?.title ?? null;
      if (shareTitle) {
        const isFloorPlan = /planta|floor.?plan|blueprint|casa|apartamento|projeto/i.test(shareTitle);
        enrichedText = isFloorPlan
          ? `[Client shared a floor plan: "${shareTitle}"]`
          : `[Client shared: "${shareTitle}"]`;
        mediaProcessed = true;
      }
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

    // Fallback for media that failed to process
    const clientSentPlainText = !!messaging.message?.text && !audioUrl && !imageUrl;
    const clientActuallySentMedia = !!(audioUrl || imageUrl) || (!!shareUrl && !messaging.message?.text);
    const hasRealContent = clientSentPlainText || (mediaProcessed && enrichedText.trim().length > 0);

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
      await sendInstagramMessage(senderIgsid, finalResponse);
      await supabaseAdmin.from("instagram_messages").insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: finalResponse,
      });
      return;
    }

    if (!enrichedText.trim()) return;

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

    // ── Load conversation history (last 15 messages) ──────────────────────
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(15);

    const history = (historyRaw ?? []).reverse();

    // ── Determine booking status (DB flag is authoritative; history is fallback) ──
    const isBookingConfirmed =
      !!(conversation as Record<string, unknown>).booking_confirmed ||
      history.some(
        (m) => m.role === "assistant" && m.content?.includes("Appointment confirmed")
      );

    const lastUserMsg = enrichedText.toLowerCase();
    const partnershipKeywords = ["partnership", "parceria", "exchange", "troca", "barter", "collab", "collaboration", "influencer", "promote", "shoutout", "stories", "reels", "post exchange"];
    const isPartnershipRequest = partnershipKeywords.some((k) => lastUserMsg.includes(k));

    // Always build current date context so the agent never confuses days
    const now = new Date();
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const todayName = dayNames[now.getDay()];
    const tomorrowDate = new Date(now); tomorrowDate.setDate(now.getDate() + 1);
    const tomorrowName = dayNames[tomorrowDate.getDay()];
    const tomorrowStr = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth()+1).padStart(2,"0")}-${String(tomorrowDate.getDate()).padStart(2,"0")}`;
    const dateContext = `TODAY: ${todayName}, ${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}. TOMORROW: ${tomorrowName} ${tomorrowStr}. Current time: ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")} Eastern.`;

    type AiMsg = { role: "user" | "assistant"; content: string };

    let messagesForAI: AiMsg[] = history.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
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
        m.role === "assistant" && m.content?.startsWith("[Treino]")
      );
      if (isBookingConfirmed) {
        systemParts.push("[BOOKING ALREADY CONFIRMED: The appointment is set. Do NOT answer any question or continue the conversation. For ANY message the client sends — thank-you, question, or anything else — respond with EXACTLY ONE short sentence redirecting them to Ozzi, then add [NOTIFY_OWNER]. Example: 'I\\'ll connect you with Ozzi for anything else you need![NOTIFY_OWNER]' NEVER generate [BOOK:...]. NEVER say any slot is taken or unavailable. NEVER answer questions directly.]");
      }
      if (isOwnerHandled) {
        systemParts.push("[RETURNING CLIENT: This person already had work done or the owner personally handled them. Do not use the sales flow. Greet warmly and add [NOTIFY_OWNER].]");
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
    // Pass isBookingConfirmed so the system prompt gets the CRITICAL block injected
    const { text: rawAiText, inputTokens, outputTokens } = await getAIResponse(
      messagesForAI,
      memoryContext,
      systemMemory,
      undefined,
      isBookingConfirmed
    );

    // Strip any [BOOK:...] if booking already confirmed
    let safeAiText = isBookingConfirmed
      ? rawAiText.replace(/\[BOOK:[\s\S]*?\]/g, "").trim()
      : rawAiText;

    // Safety net: remove any slot-conflict language the AI may still generate after booking
    if (isBookingConfirmed) {
      safeAiText = stripSlotConflictLanguage(safeAiText);
    }

    const { response: afterBookingText, booked } = await processBookingCommand(
      safeAiText,
      conversation.id,
      senderIgsid,
      isBookingConfirmed
    );
    const afterCancel = await processCancelCommand(afterBookingText, senderIgsid, conversation.id);
    const afterNotify = await processNotifyOwner(afterCancel, conversation.id, conversation.username ?? null, senderIgsid);
    const finalResponse = stripForbiddenTags(afterNotify);

    void trackConversationMetrics(conversation.id, "instagram", inputTokens, outputTokens, booked);

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
