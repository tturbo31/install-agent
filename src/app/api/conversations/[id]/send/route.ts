import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";

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

  // Send via Instagram API
  const igResult = await sendInstagramMessage(conversation.igsid, body.text);
  if (igResult.error) {
    return NextResponse.json({ error: igResult.error.message }, { status: 500 });
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

  // Update conversation updated_at
  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json(message);
}
