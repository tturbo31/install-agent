import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";
import { sendFacebookMessage } from "@/lib/facebook";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  if (!body.text || typeof body.text !== "string") {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("instagram_conversations")
    .select("igsid")
    .eq("id", id)
    .single();

  if (convError || !conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const { igsid } = conversation;

  // Route to the correct platform based on igsid prefix
  if (igsid.startsWith("wa_")) {
    const waId = igsid.slice(3);
    await sendWhatsAppMessage(waId, body.text);
  } else if (igsid.startsWith("fb_")) {
    const psid = igsid.slice(3);
    await sendFacebookMessage(psid, body.text);
  } else {
    const igResult = await sendInstagramMessage(igsid, body.text);
    if (igResult.error) {
      return NextResponse.json({ error: igResult.error.message }, { status: 500 });
    }
  }

  // Store in DB
  const { data: message, error: msgError } = await supabaseAdmin
    .from("instagram_messages")
    .insert({
      conversation_id: id,
      role: "assistant",
      content: body.text,
    })
    .select()
    .single();

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json(message);
}
