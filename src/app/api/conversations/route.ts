import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select(`
      *,
      instagram_messages (
        content,
        created_at,
        role
      )
    `)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const conversations = (data ?? []).map((conv) => {
    const messages = conv.instagram_messages as Array<{
      content: string;
      created_at: string;
      role: string;
    }>;
    const sorted = [...messages].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const last = sorted[0];
    return {
      ...conv,
      instagram_messages: undefined,
      last_message: last?.content ?? null,
      last_message_at: last?.created_at ?? null,
    };
  });

  return NextResponse.json(conversations);
}
