import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { buildCorrectionContent } from "@/lib/corrections";
import { isDashboardAuthorized } from "@/lib/admin-auth";

// POST /api/conversations/[id]/correct
// Saves an owner correction for an AI message. The correction is stored as a
// structured `[Treino] PERGUNTA → RESPOSTA CORRETA` row, which every webhook
// loads on the NEXT message — so it is active instantly, with no nightly wait.
// It does NOT send anything to the client ("só aprender").
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Same admin gate as the training endpoints.
  const secret =
    req.headers.get("x-admin-secret") ?? req.nextUrl.searchParams.get("secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const correction: string | undefined = body.correction;
  const originalQuestion: string = body.originalQuestion ?? "";

  if (!correction || !correction.trim()) {
    return NextResponse.json({ error: "correction is required" }, { status: 400 });
  }

  // Confirm the conversation exists.
  const { data: conversation, error: convError } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id")
    .eq("id", id)
    .single();

  if (convError || !conversation) {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }

  const content = buildCorrectionContent(originalQuestion, correction);

  const { error: insertError } = await supabaseAdmin
    .from("instagram_messages")
    .insert({ conversation_id: id, role: "assistant", content });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
