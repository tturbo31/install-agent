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
  const result = await runFunilSilenceCheck();
  return NextResponse.json(result);
}
