import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { stripInvertedPunctuation } from "@/lib/outbound-text";
import { panelSend } from "@/lib/panel-send";

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
  // Instagram: the owner typing here keeps his links (the no-link rule of
  // 2026-10-17 is about the AI), but a 508 link block still delivers a
  // link-free version (ig-link-policy.ts): the DB keeps what the client saw.
  // 02/11/2026: Instagram/Messenger fecham a janela de resposta 24h depois da
  // última mensagem do cliente; o painel manda com a etiqueta HUMAN_AGENT
  // nesse caso e devolve um erro em português quando nem isso passa
  // (panel-send.ts). O painel mostra esse erro — antes ele sumia.
  const result = await panelSend({ conversationId: id, igsid, text: body.text });
  if (!result.ok) {
    console.error(`[PANEL] send failed conv=${id} ${result.channel}: ${result.rawError}`);
    return NextResponse.json(
      { error: result.error ?? `Falha no envio pelo ${result.channel}.`, rawError: result.rawError, channel: result.channel },
      { status: 500 }
    );
  }
  const storedText = result.sentText ?? body.text;

  // Store in DB
  const { data: message, error: msgError } = await supabaseAdmin
    .from("instagram_messages")
    .insert({
      // O dono pode digitar "¿" no painel; o envio limpa (regra 28/08), então o
      // banco tem que guardar o texto limpo — senão o eco do Messenger/IG não
      // bate com esta linha e a própria resposta dele vira "[Treino]".
      conversation_id: id,
      role: "assistant",
      content: stripInvertedPunctuation(storedText),
    })
    .select()
    .single();

  if (msgError) {
    // O cliente JÁ recebeu: avisar, sem fingir que não saiu.
    return NextResponse.json(
      { error: `A mensagem foi entregue ao cliente, mas não consegui gravar no painel (${msgError.message}). Ela aparece quando a conversa for reaberta ou no eco do canal.`, delivered: true },
      { status: 500 }
    );
  }

  await supabaseAdmin
    .from("instagram_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ...message, via: result.via });
}
