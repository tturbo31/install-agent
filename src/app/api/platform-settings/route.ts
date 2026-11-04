import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("platform, paused")
    // O funil usa linhas técnicas nesta tabela ("funil_sumido_*", "funil_check_*")
    // como flags atômicas — o painel só deve exibir os 3 canais reais.
    .in("platform", ["instagram", "facebook", "whatsapp"])
    .order("platform");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest) {
  const { platform, paused } = await req.json();
  if (!platform || typeof paused !== "boolean") {
    return NextResponse.json({ error: "platform and paused required" }, { status: 400 });
  }

  if (!["instagram", "facebook", "whatsapp"].includes(platform)) {
    return NextResponse.json({ error: "canal inválido" }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .update({ paused })
    .eq("platform", platform)
    .select("platform, paused")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: `canal "${platform}" não encontrado` }, { status: 404 });
  // Confirmação: o painel mostra o estado que o banco devolveu, não o pedido.
  if (data.paused !== paused) return NextResponse.json({ error: "o banco não gravou a mudança", ...data }, { status: 409 });
  return NextResponse.json(data);
}
