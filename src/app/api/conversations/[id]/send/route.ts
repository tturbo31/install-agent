import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { sendInstagramMessage } from "@/lib/instagram";
import { sendFacebookMessage } from "@/lib/facebook";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";

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

  // Route to the correct platform based on igsid prefix. A failed send returns
  // 500 and stores NOTHING — the panel must never show a reply the client
  // didn't receive (that lie hid the 2026-07-22 IG token outage for 19h).
  if (igsid.startsWith("wa_")) {
    const waId = igsid.slice(3);
    const waResult = await sendWhatsAppMessage(waId, body.text);
    if (!waResult.ok) {
      return NextResponse.json({ error: `WhatsApp send failed: ${waResult.error ?? waResult.status}` }, { status: 500 });
    }
  } else if (igsid.startsWith("fb_")) {
    const psid = igsid.slice(3);
    const fbResult = await sendFacebookMessage(psid, body.text);
    if (!fbResult.ok) {
      return NextResponse.json({ error: `Messenger send failed: ${fbResult.error ?? "unknown"}` }, { status: 500 });
    }
  } else {
    const igResult = await sendInstagramMessage(igsid, body.text);
    if (!igResult.ok) {
      return NextResponse.json({ error: `Instagram send failed: ${igResult.error ?? "unknown"}` }, { status: 500 });
    }
  }

  // Store in DB
  const { data: message, error: msgError } = await supabaseAdmin
    .from("instagram_messages")
    .insert({
      // O dono pode digitar "¿" no painel; o envio limpa (regra 28/08), então o
      // banco tem que guardar o texto limpo — senão o eco do Messenger/IG não
      // bate com esta linha e a própria resposta dele vira "[Treino]".
      conversation_id: id,
      role: "assistant",
      content: stripInvertedPunctuation(body.text),
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
