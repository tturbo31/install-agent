import { NextRequest, NextResponse } from "next/server";
import { isDashboardAuthorized } from "@/lib/admin-auth";
import { recuperarCriativosRecentes } from "@/lib/funil";

// Varredura de recuperação de criativos (20/08/2026), chamada 2x/dia pela
// auditoria da Ozzi Plataforma. Para conversas recentes SEM contrato de
// anúncio: resolve a peça pelo template do criativo (saudação do Messenger /
// botão de FAQ — só com candidato único entre os anúncios ativos) e, sem
// peça, envia a prova "veio de anúncio" (ad_evidencia). Os achados seguem o
// pipeline oficial (lead_criado com merge fill-if-empty na plataforma).
//
//   GET  /api/recuperar-criativos?secret=...   → simulação (não grava/envia)
//   POST /api/recuperar-criativos?secret=...   → recupera de verdade
//   ...&dias=N (padrão 10) · &teto=N (orçamento de threads do Messenger, 30)
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function executar(req: NextRequest, dryPadrao: boolean) {
  const secret = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-admin-secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dias = Number(req.nextUrl.searchParams.get("dias"));
  const teto = Number(req.nextUrl.searchParams.get("teto"));
  const dry = req.nextUrl.searchParams.get("dry") === "1" ? true : dryPadrao;
  const resumo = await recuperarCriativosRecentes({
    dry,
    ...(Number.isFinite(dias) && dias > 0 ? { dias } : {}),
    ...(Number.isFinite(teto) && teto >= 0 ? { teto } : {}),
  });
  return NextResponse.json(resumo, { status: resumo.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return executar(req, true);
}

export async function POST(req: NextRequest) {
  return executar(req, false);
}
