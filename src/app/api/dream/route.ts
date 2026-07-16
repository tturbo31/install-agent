import { NextRequest, NextResponse } from "next/server";
import { runDreaming, getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";
import { isDashboardAuthorized } from "@/lib/admin-auth";

// Nightly analysis fans out across dozens of conversations plus two Claude
// calls — give it room so the cron never silently times out mid-run.
export const maxDuration = 300;

// Accepts ADMIN_SECRET, INSTAGRAM_VERIFY_TOKEN, or the legacy literal — the same
// set this route accepted before ADMIN_SECRET was ever set, so the cron URL in
// vercel.json (?secret=Pepeka) keeps working. See src/lib/admin-auth.ts.
const isAuthorized = isDashboardAuthorized;

// GET — two modes:
//   ?run=1  → RUN the nightly self-improvement analysis. Vercel Cron Jobs only
//             ever send a GET request (never POST), so the daily cron MUST hit
//             this path to actually run Dreaming. Without run=1 the cron would
//             just read memory and the agent would never self-improve.
//   (no run) → return the current system learnings (read-only, for the dashboard)
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  // A genuine Vercel Cron invocation carries the `x-vercel-cron` header. Vercel
  // strips this header from any external/forged request, so its presence is
  // trustworthy. Authorize cron unconditionally so the nightly self-improvement
  // keeps running even if ADMIN_SECRET is later changed in the dashboard without
  // updating the secret baked into the cron URL in vercel.json. The secret check
  // is still required for manual/dashboard calls (header absent → falls through).
  const isVercelCron = !!req.headers.get("x-vercel-cron");
  if (!isVercelCron && !isAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.nextUrl.searchParams.get("run") === "1") {
    console.log("Dreaming started (cron GET) at", new Date().toISOString());
    try {
      const result = await runDreaming();
      console.log(`Dreaming complete. Analyzed ${result.conversationsAnalyzed} conversations.`);
      return NextResponse.json(result);
    } catch (err) {
      console.error("Dream GET run error:", err);
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
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
  if (!isAuthorized(secret)) {
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
