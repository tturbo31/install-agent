import { NextRequest, NextResponse } from "next/server";
import { runFunilSilenceCheck } from "@/lib/funil";

// Sweep manual/externo do evento "parou_de_responder" (funil → plataforma).
// A cadência normal de ~6h já acontece sozinha: cada mensagem recebida no
// webhook chama maybeRunFunilSilenceCheck() (throttle persistido), e o cron
// diário do followup garante ao menos 1 varredura mesmo num dia sem tráfego.
// Esta rota existe para: disparo manual, testes, e um cron externo opcional
// (ex.: cron-job.org a cada 6h em ponto) sem gastar os 2 slots de cron da Vercel.
//   GET /api/funil-check?secret=...&run=1
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
    return NextResponse.json({ ok: true, usage: "add &run=1 to run the parou_de_responder sweep now" });
  }
  // Modo de teste (secret-gated): &now=<epoch ms> simula o relógio, mas SÓ com
  // &conv=<conversation_id> junto — um relógio adiantado contra a base inteira
  // dispararia parou_de_responder prematuro para leads reais.
  const nowParam = req.nextUrl.searchParams.get("now");
  const convParam = req.nextUrl.searchParams.get("conv");
  if (nowParam && !convParam) {
    return NextResponse.json({ error: "now requires conv (isolated test only)" }, { status: 400 });
  }
  const result = await runFunilSilenceCheck(
    nowParam ? Number(nowParam) : undefined,
    convParam ?? undefined
  );
  return NextResponse.json(result);
}
