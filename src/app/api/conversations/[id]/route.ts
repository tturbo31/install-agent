import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// GET: a conversa como está AGORA no banco. O painel relê ao abrir uma
// conversa e antes/depois de pausar/reativar: o estado guardado no navegador
// envelhecia (o webhook pausa sozinho quando o dono responde pelo app, o
// "Reativar todas" reativa tudo) e o cabeçalho mostrava "IA pausada" com a IA
// ativa no banco (04/11/2026).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
  return NextResponse.json(data);
}

// PATCH { mode: "agent" | "human" }: grava e devolve a linha RELIDA do banco.
// Só responde 200 quando o banco confirma o modo pedido.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  if (!["agent", "human"].includes(body.mode)) {
    return NextResponse.json({ error: "Modo inválido" }, { status: 400 });
  }

  const { error: upErr } = await supabaseAdmin
    .from("instagram_conversations")
    .update({ mode: body.mode })
    .eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Conversa não encontrada" }, { status: 404 });
  if (data.mode !== body.mode) {
    return NextResponse.json({ error: `O banco ficou em "${data.mode}" em vez de "${body.mode}"`, conversation: data }, { status: 409 });
  }
  return NextResponse.json(data);
}
