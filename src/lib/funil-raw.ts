// ─── Captura DIAGNÓSTICA de referral/anexo/postback (P0 da auditoria 28/07) ──
// Grava o payload cru (enxuto, sem texto do cliente) em platform_settings para
// PROVARMOS o formato real que a Meta/Z-API entregam em cliques de anúncio —
// os logs da Vercel truncam e expiram; isto fica no banco até apagarmos.
// Chave: funil_raw_<canal>_<epochMs>::<json url-encoded, cortado>.
// Fire-and-forget: NUNCA lança para o atendimento. Leitura/limpeza: script
// avulso (select like 'funil_raw_%'). Remover esta captura quando a atribuição
// estiver comprovada nos 3 canais.
import { supabaseAdmin } from "@/lib/supabase";

export async function capturarRawFunil(canal: "ig" | "fb" | "wa", dados: unknown): Promise<void> {
  try {
    const json = encodeURIComponent(JSON.stringify(dados)).slice(0, 1500);
    const key = `funil_raw_${canal}_${Date.now()}::${json}`;
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: key, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
  } catch {
    // diagnóstico nunca derruba o webhook
  }
}
