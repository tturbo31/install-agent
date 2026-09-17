import { NextRequest, NextResponse } from "next/server";
import { runFollowupSweep } from "@/lib/followup";
import { maybeRunFunilSilenceCheck } from "@/lib/funil";
import { refreshInstagramTokenIfDue } from "@/lib/ig-token";
import { retryFailedSends, watchWaQueue } from "@/lib/delivery";

// One-shot follow-up sweep for hot leads that went quiet mid-scheduling.
// Triggered by the daily Vercel Cron (see vercel.json) and manually:
//   GET /api/followup?secret=...&run=1        → live sweep (sends, capped at 25)
//   GET /api/followup?secret=...&run=1&dry=1  → dry run (lists candidates, sends NOTHING)
// Same auth model as /api/dream: the x-vercel-cron header (unforgeable — Vercel
// strips it from external requests) or the admin/verify secret.

// 120 → 300 em 17/09/2026: até 60 envios por varredura (fantasma do botão +
// sumiu após o preço), com a IA escrevendo a nudge de quem conversou.
export const maxDuration = 300;

function isAuthorized(secret: string | null): boolean {
  const adminSecret = process.env.ADMIN_SECRET;
  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;
  return (!!adminSecret && secret === adminSecret) || (!!verifyToken && secret === verifyToken);
}

// A CADA 30 MIN (17/09/2026): além do cron diário da Vercel (limite de 2 crons
// no plano), o pg_cron da PLATAFORMA chama esta rota de meia em meia hora
// durante o dia da Flórida. Ele se identifica com o token compartilhado dos
// webhooks da plataforma (header x-webhook-token = PLATAFORMA_WEBHOOK_TOKEN,
// que este projeto já tem para chamar a plataforma), guardado no Vault do
// Supabase dela. Fora de 9h–20h ET a varredura responde quietHours.
function isPlatformCron(req: NextRequest): boolean {
  const token = process.env.PLATAFORMA_WEBHOOK_TOKEN;
  const enviado = req.headers.get("x-webhook-token");
  return !!token && !!enviado && enviado === token;
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const isVercelCron = !!req.headers.get("x-vercel-cron");
  if (!isVercelCron && !isPlatformCron(req) && !isAuthorized(secret)) {
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
  await watchWaQueue();

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
