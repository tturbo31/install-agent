import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import { getAIResponse, analyzeImage, transcribeAudio, generateSpeech } from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";
import { createBooking, getRealAvailabilityContext } from "@/lib/scheduler";

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

async function processBookingCommand(aiResponse: string, conversationId: string): Promise<string> {
  const bookingMatch = aiResponse.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (!bookingMatch) return aiResponse;
  try {
    const bookingData = JSON.parse(bookingMatch[1]);
    const { data: convData } = await supabaseAdmin
      .from("instagram_conversations")
      .select("creative_url, ad_id, ad_title, username, igsid")
      .eq("id", conversationId)
      .single();

    const creativeRef =
      convData?.ad_title ?? convData?.creative_url ?? convData?.ad_id ?? bookingData.creative ?? "Instagram DM";
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

export async function POST(req: NextRequest) {
  try {
    const body: WebhookPayload = await req.json();
    if (body.object !== "instagram") return NextResponse.json({ status: "ignored" }, { status: 200 });

    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return NextResponse.json({ status: "ok" }, { status: 200 });
    if (messaging.message?.is_echo) return NextResponse.json({ status: "echo_skipped" }, { status: 200 });

    const senderIgsid = messaging.sender.id;
    const messageMid = messaging.message.mid;

    // Skip already processed messages
    const { data: alreadyProcessed } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("instagram_msg_id", messageMid)
      .maybeSingle();
    if (alreadyProcessed) return NextResponse.json({ status: "duplicate_skipped" }, { status: 200 });

    // === STEP 1: Find or create conversation IMMEDIATELY ===
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
    if (!conversation) return NextResponse.json({ status: "error" }, { status: 200 });

    // === STEP 2: Detect attachments ===
    const attachments = messaging.message?.attachments ?? [];
    const imageAttachment = attachments.find((a) => a.type === "image");
    const shareAttachment = attachments.find((a) => a.type === "share");
    const audioAttachment = attachments.find((a) => a.type === "audio");
    const clientSentAudio = !!audioAttachment;

    // Build raw message text to store immediately
    let rawText = messaging.message?.text ?? "";
    const imageUrl = imageAttachment?.payload?.url ?? null;
    const shareUrl = shareAttachment?.payload?.url ?? null;
    const audioUrl = audioAttachment?.payload?.url ?? null;

    // Note image/audio/share in raw text for context
    if (imageUrl && !rawText) rawText = "[floor plan or photo]";
    if (shareUrl && !rawText) rawText = `[shared link: ${shareUrl}]`;
    if (audioUrl && !rawText) rawText = "[voice message]";
    if (!rawText) return NextResponse.json({ status: "non_text_skipped" }, { status: 200 });

    // === STEP 3: Store message IMMEDIATELY (before debounce) — capture exact timestamp ===
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

    if (insertErr && insertErr.code !== "23505") {
      return NextResponse.json({ status: "error" }, { status: 200 });
    }

    // Get this message's exact created_at and id for tiebreaking
    const thisMessageCreatedAt = insertedMsg?.created_at ?? new Date().toISOString();
    const thisMessageId = insertedMsg?.id ?? "";

    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    if (conversation.mode === "human") return NextResponse.json({ status: "human_mode" }, { status: 200 });

    // === STEP 4: DEBOUNCE — wait 10s for more messages to arrive ===
    await new Promise((r) => setTimeout(r, 10000));

    // SIMPLE RELIABLE CHECK: after waiting, am I still the latest user message?
    // Order by created_at DESC, then id DESC (tiebreaker for same timestamp)
    // If the latest message ID is not mine → skip, let the latest handle it
    const { data: latestMsg } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .single();

    if (!latestMsg || latestMsg.id !== thisMessageId) {
      return NextResponse.json({ status: "not_latest_skip" }, { status: 200 });
    }

    // === STEP 5: Process ALL pending media from the last 15 seconds ===
    // After debounce, this message is the "champion" — collect all recent messages
    // and enrich them with transcriptions and image analysis
    let enrichedText = rawText;

    // Process image/share from THIS message
    const urlToAnalyze = imageUrl ?? shareUrl;
    if (urlToAnalyze) {
      try {
        console.log("Analyzing image:", urlToAnalyze.slice(0, 80));
        const analysis = await analyzeImage(urlToAnalyze);
        console.log("Image analysis result:", analysis?.slice(0, 100));
        enrichedText = enrichedText
          .replace("[floor plan or photo]", "")
          .replace(`[shared link: ${urlToAnalyze}]`, "")
          .trim();
        enrichedText = enrichedText
          ? `${enrichedText}\n[Floor plan/photo analysis: ${analysis}]`
          : `[Floor plan/photo analysis: ${analysis}]`;
      } catch (err) {
        console.warn("Image analysis failed:", err);
      }
    }

    // Transcribe audio from THIS message
    if (audioUrl) {
      try {
        console.log("Transcribing audio...");
        const transcript = await transcribeAudio(audioUrl);
        console.log("Transcript:", transcript?.slice(0, 100));
        enrichedText = enrichedText.replace("[voice message]", "").trim();
        enrichedText = enrichedText ? `${enrichedText}\n[Voice: ${transcript}]` : transcript;
      } catch (err) {
        console.warn("Transcription failed:", err);
      }
    }

    // === STEP 6: Update ALL recent unanalyzed messages in the conversation ===
    // Enrich other recent messages (images/audios sent together) in DB
    const fifteenSecsAgo = new Date(Date.now() - 15000).toISOString();
    const { data: recentMsgs } = await supabaseAdmin
      .from("instagram_messages")
      .select("id, content, instagram_msg_id")
      .eq("conversation_id", conversation.id)
      .eq("role", "user")
      .gte("created_at", fifteenSecsAgo)
      .neq("instagram_msg_id", messageMid);

    // Collect all context from recent messages for a combined enriched text
    const recentContents = (recentMsgs ?? []).map((m) => m.content).filter(Boolean);
    if (recentContents.length > 0) {
      enrichedText = [...recentContents, enrichedText].join("\n");
    }

    // Update this message with all enriched content
    await supabaseAdmin
      .from("instagram_messages")
      .update({ content: enrichedText })
      .eq("instagram_msg_id", messageMid);

    // === STEP 7: Fetch profile ===
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

    // === STEP 8: Load history and call AI ===
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

    // Inject availability only when scheduling is relevant
    const schedulingKeywords = [
      "schedule", "appointment", "visit", "quote", "available", "availability",
      "what day", "what time", "which day", "which time",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "tomorrow", "next week", "9am", "11am", "1pm", "3pm", "5pm", "7pm",
      "book", "slot", "free quote", "schedule a", "set up a",
    ];
    const lastMsg = enrichedText.toLowerCase();
    const recentAiSchedule = (history ?? []).slice(-3).some(
      (m) => m.role === "assistant" &&
        ["what day", "what time", "schedule", "book", "works best"].some((k) => m.content.toLowerCase().includes(k))
    );
    const isScheduling = schedulingKeywords.some((k) => lastMsg.includes(k)) || recentAiSchedule;

    type AiMsg = { role: "system" | "user" | "assistant"; content: string };
    let messagesForAI: AiMsg[] = [...aiMessages];
    if (isScheduling) {
      const availability = await getRealAvailabilityContext();
      messagesForAI = [...aiMessages, { role: "system" as const, content: availability }];
    }

    const rawAiResponse = await getAIResponse(messagesForAI);
    const finalResponse = await processBookingCommand(rawAiResponse, conversation.id);

    // === STEP 9: Send response ===
    await sendInstagramMessage(senderIgsid, finalResponse);

    if (clientSentAudio && process.env.OPENAI_API_KEY) {
      generateSpeech(finalResponse)
        .then(async (buf) => { if (buf) await sendInstagramAudio(senderIgsid, buf); })
        .catch((e) => console.error("TTS error:", e));
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
