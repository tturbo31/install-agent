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

  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .update({ paused })
    .eq("platform", platform)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
