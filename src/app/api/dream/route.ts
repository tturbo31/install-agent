import { NextRequest, NextResponse } from "next/server";
import { runDreaming, getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";

// GET — return current system learnings (for dashboard)
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.INSTAGRAM_VERIFY_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const storeId = await getOrCreateSystemStore();
    const learnings = await readSystemMemory(storeId);
    return NextResponse.json({ storeId, learnings, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Dream GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST — run dreaming analysis (called by cron or manually)
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.INSTAGRAM_VERIFY_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("Dreaming started at", new Date().toISOString());

  try {
    const result = await runDreaming();
    console.log(`Dreaming complete. Analyzed ${result.conversationsAnalyzed} conversations.`);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Dream POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
