import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import { getAIResponse, analyzeImage, transcribeAudio, generateSpeech } from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";
import { createBooking, getRealAvailabilityContext } from "@/lib/scheduler";

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

// Intercept [BOOK:{...}] command from AI response
async function processBookingCommand(
  aiResponse: string,
  conversationId: string
): Promise<string> {
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return aiResponse;

  try {
    const bookingData = JSON.parse(bookingMatch[1]);

    // Get stored creative from Instagram ad referral (auto-captured on first message)
    const { data: convData } = await supabaseAdmin
      .from("instagram_conversations")
      .select("creative_url, ad_id, ad_title")
      .eq("id", conversationId)
      .single();

    const creativeRef =
      convData?.ad_title ??
      convData?.creative_url ??
      convData?.ad_id ??
      bookingData.creative ??
      "Instagram DM";

    const result = await createBooking({
      clientName: bookingData.name ?? "Instagram Client",
      clientPhone: bookingData.phone ?? "",
      clientAddress: bookingData.address ?? "",
      bookingDate: bookingData.date,
      bookingTime: bookingData.time,
      notes: bookingData.notes ?? "",
      creative: creativeRef,
    });

    const cleanResponse = aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();

    if (result.success) {
      return `${cleanResponse}\n\n✅ Appointment confirmed! 40 minutes before arriving at your home, I'll send you a heads up. My name is ${result.sellerName} and I'm looking forward to meeting you and helping with your project! 🏠`;
    } else {
      return `${cleanResponse}\n\nI'm sorry, that time slot is no longer available. Could you choose another time? Available slots are: 9am, 11am, 1pm, 3pm, 5pm, or 7pm.`;
    }
  } catch (err) {
    console.error("Booking command parse error:", err);
    return aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
  }
}

export async function POST(req: NextRequest) {
  try {
    const body: WebhookPayload = await req.json();

    if (body.object !== "instagram") {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return NextResponse.json({ status: "ok" }, { status: 200 });

    if (messaging.message?.is_echo) {
      return NextResponse.json({ status: "echo_skipped" }, { status: 200 });
    }

    const senderIgsid = messaging.sender.id;
    const messageMid = messaging.message.mid;

    // Auto-detect creative from Instagram ad referral
    const referral = messaging.referral;
    const adCreativeUrl =
      referral?.ads_context_data?.photo_url ??
      referral?.ads_context_data?.video_url ??
      null;
    const adId = referral?.ad_id ?? null;
    const adTitle = referral?.ads_context_data?.ad_title ?? null;

    // Detect attachments
    const attachments = messaging.message?.attachments ?? [];
    const imageAttachment = attachments.find((a) => a.type === "image" || a.type === "share");
    const audioAttachment = attachments.find((a) => a.type === "audio");
    const clientSentAudio = !!audioAttachment;

    let messageText = messaging.message?.text ?? "";

    // Analyze image if client sent a photo (floor or house plan)
    if (imageAttachment?.payload?.url) {
      try {
        const imageAnalysis = await analyzeImage(imageAttachment.payload.url);
        messageText = messageText
          ? `${messageText}\n[Client sent a photo. Analysis: ${imageAnalysis}]`
          : `[Client sent a photo. Analysis: ${imageAnalysis}]`;
      } catch {
        messageText = messageText || "[Client sent a photo — could not analyze]";
      }
    }

    // Transcribe audio if client sent a voice message
    if (audioAttachment?.payload?.url) {
      try {
        const transcript = await transcribeAudio(audioAttachment.payload.url);
        messageText = messageText
          ? `${messageText}\n[Voice message: ${transcript}]`
          : `[Voice message: ${transcript}]`;
      } catch {
        messageText = messageText || "[Voice message received — could not transcribe]";
      }
    }

    if (!messageText) {
      return NextResponse.json({ status: "non_text_skipped" }, { status: 200 });
    }

    if (!messageText) {
      return NextResponse.json({ status: "non_text_skipped" }, { status: 200 });
    }

    let { data: conversation } = await supabaseAdmin
      .from("instagram_conversations")
      .select("*")
      .eq("igsid", senderIgsid)
      .single();

    if (!conversation) {
      const { data: newConv } = await supabaseAdmin
        .from("instagram_conversations")
        .insert({ igsid: senderIgsid, mode: "agent" })
        .select()
        .single();
      conversation = newConv;
    }

    if (!conversation) {
      return NextResponse.json({ status: "error" }, { status: 200 });
    }

    try {
      const profile = await fetchInstagramProfile(senderIgsid);
      // Save profile + creative data from Instagram ad referral
      const updateData: Record<string, unknown> = {
        ...profile,
        updated_at: new Date().toISOString(),
      };
      if (adCreativeUrl) updateData.creative_url = adCreativeUrl;
      if (adId) updateData.ad_id = adId;
      if (adTitle) updateData.ad_title = adTitle;

      await supabaseAdmin
        .from("instagram_conversations")
        .update(updateData)
        .eq("igsid", senderIgsid);
    } catch (err) {
      console.warn("Failed to fetch Instagram profile:", err);
    }

    const { error: msgError } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conversation.id,
        role: "user",
        content: messageText,
        instagram_msg_id: messageMid,
      });

    if (msgError && msgError.code !== "23505") {
      return NextResponse.json({ status: "error" }, { status: 200 });
    }

    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (conversation.mode === "human") {
      return NextResponse.json({ status: "human_mode" }, { status: 200 });
    }

    const { data: history } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true })
      .limit(20);

    const aiMessages = (history ?? []).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Always inject real-time availability so AI never mentions a taken slot
    const availabilityContext = await getRealAvailabilityContext();
    const aiMessagesWithAvailability = [
      ...aiMessages,
      {
        role: "system" as const,
        content: availabilityContext,
      },
    ];

    const rawAiResponse = await getAIResponse(aiMessagesWithAvailability);

    // Process booking command if AI included one
    const finalResponse = await processBookingCommand(rawAiResponse, conversation.id);

    // If client sent audio → respond with audio (TTS) + text
    // If client sent image or text → respond with text only
    if (clientSentAudio && process.env.OPENAI_API_KEY) {
      const audioBuffer = await generateSpeech(finalResponse);
      if (audioBuffer) {
        await sendInstagramAudio(senderIgsid, audioBuffer);
      } else {
        await sendInstagramMessage(senderIgsid, finalResponse);
      }
    } else {
      await sendInstagramMessage(senderIgsid, finalResponse);
    }

    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: finalResponse,
    });

    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}
