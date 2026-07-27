import { NextRequest, NextResponse } from "next/server";
import { runFollowupSweep } from "@/lib/followup";
import { maybeRunFunilSilenceCheck } from "@/lib/funil";
import { refreshInstagramTokenIfDue } from "@/lib/ig-token";
import { retryFailedSends } from "@/lib/delivery";

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

  // Second daily shot at keeping the IG token fresh (see /api/dream — the
  // Hobby plan caps us at 2 cron jobs, so both piggyback the refresh).
  try {
    const tok = await refreshInstagramTokenIfDue();
    if (tok.attempted) console.log("[FOLLOWUP] IG token refresh:", tok.detail);
  } catch (e) {
    console.error("[FOLLOWUP] IG token refresh error:", e);
  }

  // Outbox: re-send replies whose delivery failed (second daily guaranteed
  // sweep; webhook traffic covers the rest of the day). Never throws.
  await retryFailedSends();

  try {
    const dry = req.nextUrl.searchParams.get("dry") === "1";
    const result = await runFollowupSweep({ dry });
    // FUNIL: o cron diário também garante ao menos 1 varredura de
    // parou_de_responder por dia, mesmo num dia sem tráfego de webhook.
    // maybeRunFunilSilenceCheck nunca lança e respeita o throttle de 6h.
    if (!dry) await maybeRunFunilSilenceCheck();
    // COBRANÇA DE DESFECHO (19h NY): pede à plataforma que mande ao dono a
    // lista das visitas de hoje sem Realizada/Não veio. Fire-and-forget com
    // timeout — a plataforma decide se há algo a enviar; falha nunca derruba
    // a varredura (o sweep é o trabalho principal deste cron).
    if (!dry && process.env.PLATAFORMA_WEBHOOK_TOKEN) {
      try {
        const base = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20_000);
        const r = await fetch(`${base}/api/followup/desfecho`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-webhook-token": process.env.PLATAFORMA_WEBHOOK_TOKEN },
          body: "{}",
          signal: ctrl.signal,
        }).finally(() => clearTimeout(timer));
        console.log("[FOLLOWUP] cobrança de desfecho:", r.status, (await r.text().catch(() => "")).slice(0, 200));
      } catch (e) {
        console.error("[FOLLOWUP] cobrança de desfecho falhou:", String(e).slice(0, 150));
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[FOLLOWUP] sweep crashed:", err);
    return NextResponse.json({ error: String(err).slice(0, 300) }, { status: 500 });
  }
}
