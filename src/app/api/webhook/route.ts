import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage, sendInstagramAudio } from "@/lib/instagram";
import { getAIResponse, analyzeImage, analyzeImageFromBase64, transcribeAudio, transcribeAudioFromBuffer, generateSpeech } from "@/lib/ai";
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

    // --- Hard validation: require phone AND address-like text in the last 15 min ---
    // This prevents the AI from booking using stale profile data the client never
    // explicitly provided in the current session.
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recentUserMsgs } = await supabaseAdmin
      .from("instagram_messages")
      .select("content")
      .eq("conversation_id", conversationId)
      .eq("role", "user")
      .gte("created_at", fifteenMinAgo);

    const recentText = (recentUserMsgs ?? []).map((m) => m.content).join(" ");

    const phonePattern = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/;
    // Address: at least 3 words with a leading number (e.g. "123 Main St")
    const addressPattern = /\d+\s+\w+(?:\s+\w+){1,}/;

    const hasPhone = phonePattern.test(recentText);
    const hasAddress = addressPattern.test(recentText);

    if (!hasPhone || !hasAddress) {
      console.warn(
        `Booking blocked — missing explicit confirmation in recent messages. ` +
          `hasPhone=${hasPhone}, hasAddress=${hasAddress}`
      );
      return aiResponse.replace(/\[BOOK:\{[\s\S]*?\}\]/, "").trim();
    }
    // --- End validation ---

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

async function handleWebhook(body: WebhookPayload) {
  try {
    if (body.object !== "instagram") return;

    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return;
    if (messaging.message?.is_echo) return;

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

    // === PRE-DEBOUNCE: Download audio/image NOW while URL is still fresh ===
    // Instagram CDN URLs expire quickly (~60s). We download before the 3s debounce wait.
    let preFetchedAudioBuffer: ArrayBuffer | null = null;
    let preFetchedAudioType = "audio/mp4";
    let preFetchedImageBase64: string | null = null;

    const igToken = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";

    if (audioUrl) {
      const urlWithToken = audioUrl.includes("?") ? `${audioUrl}&access_token=${igToken}` : `${audioUrl}?access_token=${igToken}`;
      for (const [u, opts] of [[urlWithToken, {}], [audioUrl, { headers: { Authorization: `Bearer ${igToken}` } }], [audioUrl, {}]] as [string, RequestInit][]) {
        try {
          const r = await fetch(u, { ...opts, redirect: "follow" });
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (!ct.startsWith("audio/") && !ct.startsWith("video/") && !ct.includes("octet-stream")) continue;
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 1000) { preFetchedAudioBuffer = buf; preFetchedAudioType = ct.split(";")[0] || "audio/mp4"; break; }
        } catch { continue; }
      }
      console.log(`Audio pre-fetch: ${preFetchedAudioBuffer ? `${preFetchedAudioBuffer.byteLength} bytes` : "FAILED"}`);
    }

    if (imageUrl) {
      // First try: Graph API with message ID to get authenticated URL (most reliable)
      try {
        const graphRes = await fetch(
          `https://graph.instagram.com/v24.0/${messageMid}?fields=attachments&access_token=${igToken}`
        );
        if (graphRes.ok) {
          const graphData = await graphRes.json();
          const attachmentUrl = graphData?.attachments?.data?.[0]?.image_data?.url
            ?? graphData?.attachments?.data?.[0]?.file_url
            ?? null;
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
      } catch { /* graph api attempt failed */ }

      // Fallback: try CDN URL directly (various auth methods)
      if (!preFetchedImageBase64) {
        const urlWithToken = imageUrl.includes("?") ? `${imageUrl}&access_token=${igToken}` : `${imageUrl}?access_token=${igToken}`;
        for (const [u, opts] of [[urlWithToken, {}], [imageUrl, { headers: { Authorization: `Bearer ${igToken}` } }], [imageUrl, {}]] as [string, RequestInit][]) {
          try {
            const r = await fetch(u, { ...opts, redirect: "follow" });
            if (!r.ok) continue;
            const ct = r.headers.get("content-type") || "";
            if (!ct.startsWith("image/")) continue;
            const buf = await r.arrayBuffer();
            if (buf.byteLength > 3000) { preFetchedImageBase64 = `data:${ct.split(";")[0]};base64,${Buffer.from(buf).toString("base64")}`; break; }
          } catch { continue; }
        }
      }
      console.log(`Image pre-fetch: ${preFetchedImageBase64 ? `${Math.round(preFetchedImageBase64.length / 1000)}KB` : "FAILED"}`);
    }

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

    // === STEP 4: DEBOUNCE — wait 3s for more messages to arrive ===
    // NOTE: 3 s keeps us well under Vercel Hobby's 10 s function timeout.
    await new Promise((r) => setTimeout(r, 3000));

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
      return;
    }

    // RATE LIMIT: if we already sent a response in the last 20 seconds, skip
    // This catches cases where the debounce window is too tight (e.g. share arrives late)
    const twentySecsAgo = new Date(Date.now() - 20000).toISOString();
    const { data: recentReply } = await supabaseAdmin
      .from("instagram_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("role", "assistant")
      .gte("created_at", twentySecsAgo)
      .limit(1);

    if (recentReply && recentReply.length > 0) {
      return; // Already responded recently — skip duplicate
    }

    // === STEP 5: Process media with fallback intelligence ===
    let enrichedText = rawText;
    let mediaProcessed = false;

    // Include share title as context — don't ask for measurements yet, image analysis comes next
    if (shareAttachment) {
      const shareTitle = shareAttachment.payload?.title ?? null;
      if (shareTitle) {
        const isFloorPlan = /planta|floor.?plan|blueprint|casa|apartamento|projeto/i.test(shareTitle);
        enrichedText = isFloorPlan
          ? `[Client shared a floor plan image: "${shareTitle}"]`
          : `[Client shared: "${shareTitle}"]`;
        mediaProcessed = true;
      }
    }

    // Analyze image — use pre-fetched base64 if available (avoids re-downloading expired URL)
    if (imageUrl || shareUrl) {
      try {
        let analysis: string;
        if (preFetchedImageBase64) {
          // Use already-downloaded image data
          analysis = await analyzeImageFromBase64(preFetchedImageBase64);
        } else {
          analysis = await analyzeImage(shareUrl ?? imageUrl ?? "");
        }
        // Image analysis is useful if it mentions rooms, areas, or flooring
        const hasFlooringContext = /sqm|sqft|m²|room|floor|bedroom|bathroom|kitchen|sala|quarto|cozinha|meter|area|\d+x\d+/i.test(analysis);
        const isUseful = !analysis.toLowerCase().includes("could not") &&
                         !analysis.toLowerCase().includes("unavailable") &&
                         !analysis.toLowerCase().includes("cannot analyze") &&
                         !analysis.toLowerCase().includes("not a floor") &&
                         analysis.length > 20;
        if (isUseful) {
          enrichedText = enrichedText
            .replace("[floor plan or photo]", "")
            .replace(`[shared link: ${shareUrl ?? imageUrl}]`, "")
            .trim();
          enrichedText = enrichedText
            ? `${enrichedText}\n[Floor plan/photo analysis: ${analysis}]`
            : `[Floor plan/photo analysis: ${analysis}]`;
          mediaProcessed = true;
          console.log("Image analysis OK:", analysis.slice(0, 80));
        }
      } catch (err) {
        console.warn("Image analysis failed:", err);
      }
    }

    // Transcribe audio — use pre-fetched buffer (avoids re-downloading expired URL)
    if (audioUrl) {
      try {
        const transcript = preFetchedAudioBuffer
          ? await transcribeAudioFromBuffer(preFetchedAudioBuffer, preFetchedAudioType)
          : await transcribeAudio(audioUrl);

        // Validate transcript quality:
        // - Must be mostly ASCII/Latin chars (filters Kannada, Arabic, CJK garbage from bad audio)
        // - Must have at least 3 real words
        // - Must not be a fallback message
        const nonLatinCount = (transcript || "").split("").filter(c => c.charCodeAt(0) > 1000).length;
        const wordCount = (transcript || "").trim().split(/\s+/).length;
        const isUseful = !!transcript &&
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
          console.log("Transcription OK:", transcript.slice(0, 80));
        } else {
          console.warn("Transcription not useful:", transcript);
          enrichedText = enrichedText.replace("[voice message]", "").trim();
        }
      } catch (err) {
        console.warn("Transcription failed:", err);
      }
    }

    // If we have NO useful content at all — ask client to type
    if (!enrichedText.trim()) {
      enrichedText = "[SYSTEM: Client sent media but content could not be processed. Ask them to type their message. Do NOT use old scheduling context.]";
      mediaProcessed = false;
    }

    // === STEP 6: Update ALL recent unanalyzed messages in the conversation ===
    // Enrich other recent messages (images/audios sent together) in DB
    // Window matches debounce period (3 s) plus a small buffer
    const fifteenSecsAgo = new Date(Date.now() - 3500).toISOString();
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
    // (aiMessages kept for reference; actual context selection happens below)

    const lastMsg = enrichedText.toLowerCase().trim();

    // Detect greetings — treat as fresh start, ignore old scheduling context
    const greetings = ["hi", "hello", "hey", "oi", "olá", "ola", "bom dia", "boa tarde", "good morning", "good afternoon", "what's up", "sup"];
    const isJustGreeting = greetings.some((g) => lastMsg === g || lastMsg === g + "!" || lastMsg === g + ".");

    // Detect if client is resetting / starting a new project
    const resetKeywords = [
      "cancel", "forget", "different", "new project", "new apartment", "new house",
      "instead", "actually", "change", "another", "start over", "not that",
    ];
    const clientResetting = isJustGreeting || resetKeywords.some((k) => lastMsg.includes(k));

    // Detect if current message has real content or just placeholder text from failed media
    const MEDIA_PLACEHOLDERS = ["[voice message]", "[floor plan or photo]", "[shared link:"];
    // Count how many lines are just placeholders
    const lines = enrichedText.trim().split("\n").filter(Boolean);
    const realLines = lines.filter(l => !MEDIA_PLACEHOLDERS.some(p => l.trim() === p || l.trim().startsWith(p)));
    const hasRealContent = mediaProcessed && realLines.length > 0;

    // Inject availability ONLY when scheduling is relevant AND client is NOT resetting AND has real content
    const schedulingKeywords = [
      "schedule", "appointment", "what day", "what time", "which day",
      "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
      "tomorrow", "next week", "9am", "11am", "1pm", "3pm", "5pm", "7pm",
      "book", "slot", "set up a",
    ];
    const recentAiSchedule = !clientResetting && hasRealContent && (history ?? []).slice(-3).some(
      (m) => m.role === "assistant" &&
        ["what day", "what time", "schedule", "book", "works best"].some((k) => m.content.toLowerCase().includes(k))
    );
    const isScheduling = !clientResetting && hasRealContent &&
      (schedulingKeywords.some((k) => lastMsg.includes(k)) || recentAiSchedule);

    type AiMsg = { role: "system" | "user" | "assistant"; content: string };

    let finalResponse: string;

    // Detect if client mentioned sending an image in text
    const clientMentionsImage = /imag|foto|plant|floor.?plan|projeto|here.?is|this.?is|consegue calcular/i.test(enrichedText);

    // When ALL media failed → bypass AI, send specific helpful message
    if (!hasRealContent && !isJustGreeting) {
      const hadImage = !!(imageUrl || shareUrl) || clientMentionsImage;
      const hadAudio = !!audioUrl;
      if (hadAudio && hadImage) {
        finalResponse = "Got your floor plan and voice message! I wasn't able to read the details automatically — just type the total area shown on the floor plan (in square meters or sqft) and I'll calculate the quote right here.";
      } else if (hadAudio) {
        finalResponse = "Got your voice message but couldn't catch it — could you type what you need? I'll take care of you right here!";
      } else if (hadImage) {
        finalResponse = "Got your floor plan! I wasn't able to read the details from it automatically — just type the total area (in square meters or sqft) and I'll calculate the exact price right here.";
      } else {
        finalResponse = "Hey! What can I help you with today?";
      }
    } else {
      // Normal AI flow with appropriate history
      const historyToUse = isJustGreeting
        ? []
        : clientResetting
          ? (history ?? []).slice(-2)
          : (history ?? []);
      let messagesForAI: AiMsg[] = historyToUse.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      if (isScheduling) {
        const availability = await getRealAvailabilityContext();
        messagesForAI = [...messagesForAI, { role: "system" as const, content: availability }];
      }
      const rawAiResponse = await getAIResponse(messagesForAI);
      finalResponse = await processBookingCommand(rawAiResponse, conversation.id);
    }

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

  } catch (err) {
    console.error("Webhook processing error:", err);
  }
}

export async function POST(req: NextRequest) {
  // Parse body first for quick validation
  const body: WebhookPayload = await req.json().catch(() => null);
  if (!body || body.object !== "instagram") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messaging = body.entry?.[0]?.messaging?.[0];
  if (!messaging || messaging.message?.is_echo) {
    return NextResponse.json({ status: "skipped" }, { status: 200 });
  }

  // Return 200 to Instagram IMMEDIATELY (prevents retries from slow processing)
  // Then process everything in background via waitUntil
  waitUntil(handleWebhook(body));

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
