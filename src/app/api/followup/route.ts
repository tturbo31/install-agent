import { NextRequest, NextResponse } from "next/server";
import { runFollowupSweep } from "@/lib/followup";
import { maybeRunFunilSilenceCheck } from "@/lib/funil";

// One-shot follow-up sweep for hot leads that went quiet mid-scheduling.
// Triggered by the daily Vercel Cron (see vercel.json) and manually:
//   GET /api/followup?secret=...&run=1        → live sweep (sends, capped at 25)
//   GET /api/followup?secret=...&run=1&dry=1  → dry run (lists candidates, sends NOTHING)
// Same auth model as /api/dream: the x-vercel-cron header (unforgeable — Vercel
// strips it from external requests) or the admin/verify secret.

export const maxDuration = 120;

function isAuthorized(secret: string | null): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;
  return (!!adminSecret && secret === adminSecret) || (!!verifyToken && secret === verifyToken);
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = !!req.headers.get("x-vercel-cron");
  if (!isVercelCron && !isAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (req.nextUrl.searchParams.get("run") !== "1") {
    return NextResponse.json({ ok: true, usage: "add &run=1 to sweep, &dry=1 to preview without sending" });
  }

  try {
    const dry = req.nextUrl.searchParams.get("dry") === "1";
    const result = await runFollowupSweep({ dry });
    // FUNIL: o cron diário também garante ao menos 1 varredura de
    // parou_de_responder por dia, mesmo num dia sem tráfego de webhook.
    // maybeRunFunilSilenceCheck nunca lança e respeita o throttle de 6h.
    if (!dry) await maybeRunFunilSilenceCheck();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[FOLLOWUP] sweep crashed:", err);
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
