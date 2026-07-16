import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isDashboardAuthorized } from "@/lib/admin-auth";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// POST /api/resume?secret=TOKEN — re-enable agent on all conversations
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("instagram_conversations")
    .update({ mode: "agent" })
    .eq("mode", "human")
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    resumed: data?.length ?? 0,
    message: `Agent re-enabled on ${data?.length ?? 0} conversations. Set AGENT_PAUSED=0 in Vercel to complete.`,
  });
}
