import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import {
  getAIResponse,
  analyzeImageFromBase64,
  transcribeAudioFromBuffer,
  generateSpeech,
} from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";
import { createBooking, cancelClientBooking, getRealAvailabilityContext } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  ClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";

export const maxDuration = 60;

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

// ─── Parse and strip [BOOK:...] from AI response ──────────────────────────
async function processBookingCommand(aiResponse: string, conversationId: string, senderIgsid: string): Promise<string> {
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return aiResponse;
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // Require phone + address explicitly confirmed in last 15 min
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recentUserMsgs } = await supabaseAdmin
      .from("instagram_messages")
      .select("content")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gte("created_at", fifteenMinAgo);

    const recentText = (recentUserMsgs ?? []).map((m) => m.content).join(" ");
    const phonePattern = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/;
    const addressPattern = /\d+\s+\w+(?:\s+\w+){1,}/;

    if (!phonePattern.test(recentText) || !addressPattern.test(recentText)) {
      console.warn("Booking blocked — missing phone or address in recent messages");
      return aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
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

    const cleanResponse = aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
    if (result.success) {
      return `${cleanResponse}\n\nAppointment confirmed! I'll reach out 40 minutes before arriving. My name is ${result.sellerName} and I look forward to meeting you!`;
    } else {
      return `${cleanResponse}\n\nThat slot just got taken. Can you pick another time?`;
    }
  } catch (err) {
    console.error("Booking parse error:", err);
    return aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
  }
}

// ─── Cancel booking when AI generates [CANCEL_BOOKING] ────────────────────
async function processCancelCommand(
  aiResponse: string,
  senderIgsid: string
): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;

  const cleanResponse = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();

  try {
    const result = await cancelClientBooking(senderIgsid);
    if (result.success) {
      console.log(`Cancelled ${result.cancelled} booking(s) for igsid ${senderIgsid}`);
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
    if (body.object !== "instagram") return;
    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return;

    // Capture owner responses for training (echo OR agent_message from business)
    const isEcho = !!messaging.message?.is_echo;
    const senderIgsidRaw = messaging.sender?.id ?? "";
    const recipientIgsidRaw = messaging.recipient?.id ?? "";
    const BUSINESS_IGSID = "27383991237890869";
    const isBusinessSending = senderIgsidRaw === BUSINESS_IGSID || isEcho;

    if (isBusinessSending) {
      const ownerText = messaging.message?.text;
      // The customer is the recipient when business is sending
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
      const defaultMode = process.env.AGENT_PAUSED === "1" ? "human" : "agent";
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
    const shareAttachment = attachments.find((a) => a.type === "share");
    const audioAttachment = attachments.find((a) => a.type === "audio");
    const clientSentAudio = !!audioAttachment;

    let rawText = messaging.message?.text ?? "";
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

    // ── Debounce: wait 3s, then check if we're still the latest message ──
    await new Promise((r) => setTimeout(r, 3000));

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

    // Rate limit: skip if we already replied in the last 20s
    const twentySecsAgo = new Date(Date.now() - 20000).toISOString();
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("role", "assistant")
      .gte("created_at", twentySecsAgo)
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
    // Text always wins: phone-number popup and Reply-to-message both arrive as
    // share attachments alongside real text. If text is present, treat as plain text.
    const clientSentPlainText = !!messaging.message?.text && !audioUrl && !imageUrl;
    const clientActuallySentMedia = !!(audioUrl || imageUrl) || (!!shareUrl && !messaging.message?.text);
    const hasRealContent = clientSentPlainText || (mediaProcessed && enrichedText.trim().length > 0);

    if (!hasRealContent && clientActuallySentMedia) {
      const hadAudio = !!audioUrl;
      const hadImage = !!(imageUrl || shareUrl);
      let finalResponse: string;
      if (hadAudio && hadImage) {
        finalResponse = "Got your floor plan and voice message! I wasn't able to read the details — just type the total area (sqft or sqm) and I'll calculate right here.";
      } else if (hadAudio) {
        finalResponse = "Got your voice message but couldn't catch it — could you type what you need?";
      } else {
        finalResponse = "Got your floor plan! I wasn't able to read the details — just type the total area (sqft or sqm) and I'll calculate right here.";
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

    // ── Ensure memory store exists for this client (Phase 2) ─────────────
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

    // ── Load client memory for context ───────────────────────────────────
    // Load client memory + system memory in parallel, max 3s each
    // If either times out or fails, we proceed without it — never block the response
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

    // ── Load conversation history (last 15 messages, always) ─────────────
    // Fixed: use DESC + limit to get the LAST 15, then reverse for chronological order
    const { data: historyRaw } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false })
      .limit(15);

    const history = (historyRaw ?? []).reverse();

    // ── Detect if scheduling context is needed ───────────────────────────
    const lastUserMsg = enrichedText.toLowerCase();
    const schedulingKeywords = [
      "schedule", "appointment", "what day", "what time", "which day",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "tomorrow", "next week", "9am", "11am", "1pm", "3pm", "5pm", "7pm", "book", "slot",
      "cancel", "reschedule", "visit",
    ];
    const needsScheduling = schedulingKeywords.some((k) => lastUserMsg.includes(k));

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

    // Always inject date context; add full availability when scheduling topic detected
    const lastIdx = messagesForAI.length - 1;
    if (lastIdx >= 0 && messagesForAI[lastIdx].role === "user") {
      let systemNote = `[SYSTEM: ${dateContext}]`;
      if (needsScheduling) {
        const availability = await getRealAvailabilityContext();
        systemNote = `[SYSTEM: ${dateContext}\n\n${availability}]`;
      }
      messagesForAI[lastIdx] = {
        ...messagesForAI[lastIdx],
        content: `${messagesForAI[lastIdx].content}\n\n${systemNote}`,
      };
    }

    // ── Generate AI response ─────────────────────────────────────────────
    const rawAiResponse = await getAIResponse(messagesForAI, memoryContext, systemMemory);
    const afterBooking = await processBookingCommand(rawAiResponse, conversation.id, senderIgsid);
    const finalResponse = await processCancelCommand(afterBooking, senderIgsid);

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
  const body: WebhookPayload = await req.json().catch(() => null);
  if (!body || body.object !== "instagram") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messaging = body.entry?.[0]?.messaging?.[0];
  if (!messaging || messaging.message?.is_echo) {
    return NextResponse.json({ status: "skipped" }, { status: 200 });
  }

  // Return 200 immediately — process in background
  waitUntil(handleWebhook(body));
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
