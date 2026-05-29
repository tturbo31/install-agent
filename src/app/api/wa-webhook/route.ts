import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { sendWhatsAppMessage, downloadZApiImage, downloadZApiAudio, notifyOwners } from "@/lib/whatsapp";
import { getAIResponse, analyzeImageFromBase64, transcribeAudioFromBuffer, stripForbiddenTags } from "@/lib/ai";
import { createBooking, cancelClientBooking, getRealAvailabilityContext } from "@/lib/scheduler";
import {
  createClientMemoryStore,
  readClientMemory,
  extractMemoryUpdate,
  updateClientMemory,
} from "@/lib/anthropic-memory";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";

export const maxDuration = 60;

// ─── [BOOK:...] processor ─────────────────────────────────────────────────
async function processBookingCommand(aiResponse: string, waId: string): Promise<string> {
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return aiResponse;
  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // Trust the AI extraction: require phone and address fields to be non-empty
    if (!bookingData.phone?.trim() || !bookingData.address?.trim()) {
      console.warn("WA booking blocked — phone or address missing from booking JSON");
      return aiResponse.replace(/\[BOOK:[\s\S]*?\]/, "").trim();
    }

    const result = await createBooking({
      clientName: bookingData.name ?? "WhatsApp Client",
      clientPhone: bookingData.phone ?? waId,
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: (bookingData.notes ?? "") + " | WhatsApp",
      creative: "WhatsApp",
      igsid: `wa_${waId}`,
    });

    const clean = aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
    return result.success
      ? `${clean}\n\nAppointment confirmed! I'll reach out 40 minutes before arriving. My name is ${result.sellerName} and I look forward to meeting you!`
      : `${clean}\n\nThat slot just got taken. Can you pick another time?`;
  } catch (err) {
    console.error("WA booking error:", err);
    return aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
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
async function processCancelCommand(aiResponse: string, waId: string): Promise<string> {
  if (!/\[CANCEL_BOOKING\]/i.test(aiResponse)) return aiResponse;
  const clean = aiResponse.replace(/\[CANCEL_BOOKING\]/gi, "").trim();
  try {
    const result = await cancelClientBooking(`wa_${waId}`);
    if (result.success) console.log(`WA: Cancelled ${result.cancelled} booking(s) for ${waId}`);
  } catch (err) {
    console.error("WA cancel error:", err);
  }
  return clean;
}

// ─── Main message handler ─────────────────────────────────────────────────
async function handleWaMessage(body: Record<string, unknown>) {
  try {
    // Z-API only sends ReceivedCallback for incoming messages
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

    if (!conv) {
      const defaultMode = process.env.AGENT_PAUSED === "1" ? "human" : "agent";
      const { data: newConv } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: waIgsid, mode: defaultMode })
        .select()
        .single();
      conv = newConv;
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

    // Debounce 3s
    await new Promise((r) => setTimeout(r, 3000));
    const { data: latestMsg } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!latestMsg || latestMsg.id !== thisMessageId) return;

    // Rate limit: 5s window prevents genuine duplicates without blocking fast client replies
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conv.id)
      .eq("role", "assistant")
      .gte("created_at", new Date(Date.now() - 5000).toISOString())
      .limit(1);
    if (recentReply && recentReply.length > 0) return;

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
        ? "Got your floor plan! I wasn't able to read the details — just type the total area (sqft or sqm) and I'll calculate right here."
        : "Got your message! Could you type your question?";
      await sendWhatsAppMessage(phone, fallback);
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: fallback });
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

    // Date context
    const now = new Date();
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
    const dateContext = `TODAY: ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}. TOMORROW: ${days[tomorrow.getDay()]} ${tomorrowStr}. Current time: ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")} Eastern.`;

    type AiMsg = { role: "user" | "assistant"; content: string };
    let messagesForAI: AiMsg[] = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const lastUserMsg = enrichedText.toLowerCase();
    const schedulingKeywords = [
      "schedule", "appointment", "what day", "what time",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "tomorrow", "next week", "book", "slot", "cancel", "reschedule", "visit",
      // Large-lead confirmations — AI will immediately propose real slots in its response
      "entire house", "whole house", "all rooms", "all the rooms", "every room",
      "multiple rooms", "full apartment", "entire home", "the whole",
    ];
    // Also load availability if the last AI message was already in scheduling mode
    const lastAiMsg = history.filter((m) => m.role === "assistant").slice(-1)[0]?.content?.toLowerCase() ?? "";
    const aiWasScheduling = /when would work|which works better|available|availability|what day|what time|works for you/i.test(lastAiMsg);
    const needsScheduling = schedulingKeywords.some((k) => lastUserMsg.includes(k)) || aiWasScheduling;

    const lastIdx = messagesForAI.length - 1;
    if (lastIdx >= 0 && messagesForAI[lastIdx].role === "user") {
      let systemNote = `[SYSTEM: ${dateContext}]`;
      if (needsScheduling) {
        const availability = await getRealAvailabilityContext();
        systemNote = `[SYSTEM: ${dateContext}\n\n${availability}]`;
      }
      messagesForAI[lastIdx] = { ...messagesForAI[lastIdx], content: `${messagesForAI[lastIdx].content}\n\n${systemNote}` };
    }

    const rawAiResponse = await getAIResponse(messagesForAI, memoryContext, systemMemory);
    const afterBooking = await processBookingCommand(rawAiResponse, phone);
    const afterCancel = await processCancelCommand(afterBooking, phone);
    const afterNotify = await processNotifyOwner(afterCancel, conv.id, conv.username ?? null, phone);
    const finalResponse = stripForbiddenTags(afterNotify);

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
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ status: "ignored" }, { status: 200 });

  waitUntil(handleWaMessage(body));
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── GET — Z-API webhook verification (not required but safe to have) ─────
export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
