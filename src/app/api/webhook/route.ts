import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchInstagramProfile, sendInstagramMessage } from "@/lib/instagram";
import { getAIResponse } from "@/lib/ai";
import { WebhookPayload } from "@/lib/types";

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

export async function POST(req: NextRequest) {
  try {
    const body: WebhookPayload = await req.json();

    if (body.object !== "instagram") {
      return NextResponse.json({ status: "ignored" }, { status: 200 });
    }

    const messaging = body.entry?.[0]?.messaging?.[0];
    if (!messaging) return NextResponse.json({ status: "ok" }, { status: 200 });

    // Skip echo messages (sent by our own page)
    if (messaging.message?.is_echo) {
      return NextResponse.json({ status: "echo_skipped" }, { status: 200 });
    }

    // Skip non-text messages
    if (!messaging.message?.text) {
      return NextResponse.json({ status: "non_text_skipped" }, { status: 200 });
    }

    const senderIgsid = messaging.sender.id;
    const messageText = messaging.message.text;
    const messageMid = messaging.message.mid;

    // Find or create conversation
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
      console.error("Failed to find or create conversation");
      return NextResponse.json({ status: "error" }, { status: 200 });
    }

    // Fetch and upsert Instagram profile
    try {
      const profile = await fetchInstagramProfile(senderIgsid);
      await supabaseAdmin
        .from("instagram_conversations")
        .update({ ...profile, updated_at: new Date().toISOString() })
        .eq("igsid", senderIgsid);
    } catch (err) {
      console.warn("Failed to fetch Instagram profile:", err);
    }

    // Store user message (skip on duplicate mid)
    const { error: msgError } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: conversation.id,
        role: "user",
        content: messageText,
        instagram_msg_id: messageMid,
      });

    if (msgError && msgError.code !== "23505") {
      console.error("Failed to store message:", msgError);
      return NextResponse.json({ status: "error" }, { status: 200 });
    }

    // Update conversation updated_at
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);

    // If human mode, stop here
    if (conversation.mode === "human") {
      return NextResponse.json({ status: "human_mode" }, { status: 200 });
    }

    // Fetch last 20 messages for AI context
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

    // Get AI response
    const aiResponse = await getAIResponse(aiMessages);

    // Send response back to Instagram
    await sendInstagramMessage(senderIgsid, aiResponse);

    // Store AI response in DB
    await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: aiResponse,
    });

    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    // Always return 200 to Meta to avoid retries
    return NextResponse.json({ status: "error" }, { status: 200 });
  }
}
