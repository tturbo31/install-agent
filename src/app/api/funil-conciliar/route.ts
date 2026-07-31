import { NextRequest, NextResponse } from "next/server";
import { isDashboardAuthorized } from "@/lib/admin-auth";
import { conciliarContratos } from "@/lib/funil-conciliar";

// Conciliação contrato → lead com reparo automático, chamada pela auditoria de
// criativos da Ozzi Plataforma nas duas rodadas do dia (9h e meia-noite da
// Flórida). Só o agente enxerga os contratos funil_adx_; só a plataforma
// enxerga os leads — por isso o cruzamento acontece aqui e a plataforma
// responde a pergunta "esse já tem ad_id?" pela rede.
//
//   GET  /api/funil-conciliar?secret=...          → simulação (não repara)
//   POST /api/funil-conciliar?secret=...          → repara de verdade
//   ...&dry=1                                     → força simulação no POST
//   ...&teto=N                                    → limite de reparos na rodada
//
// Também devolve a saúde da caixa-preta (última captura por canal e idade da
// marca do GC): é o dado que a auditoria usa para alarmar "webhook caiu" sem
// precisar de acesso a este banco.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function executar(req: NextRequest, dryPadrao: boolean) {
  const secret = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-admin-secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = req.nextUrl.searchParams.get("dry") === "1" ? true : dryPadrao;
  const tetoParam = Number(req.nextUrl.searchParams.get("teto"));
  const resumo = await conciliarContratos({
    dry,
    ...(Number.isFinite(tetoParam) && tetoParam > 0 ? { teto: tetoParam } : {}),
  });
  return NextResponse.json(resumo, { status: resumo.ok ? 200 : 500 });
}

export async function GET(req: NextRequest) {
  return executar(req, true);
}

export async function POST(req: NextRequest) {
  return executar(req, false);
}
