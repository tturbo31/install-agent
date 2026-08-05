// ─── Captura RAW dos webhooks + captura diagnóstica de referral ──────────────
// Duas camadas (auditoria 28/07 + missão referral 28/07):
//
// 1) capturarWebhookRaw — a CAIXA-PRETA: grava o body BRUTO COMPLETO de TODO
//    POST recebido nos 3 webhooks (ig/fb/wa), ANTES de qualquer parsing/filtro/
//    return (echo, delivery, assinatura inválida — tudo fica registrado). É a
//    prova definitiva do que a Meta/Z-API entregam ou não em cliques de anúncio.
//    Retenção: 7 dias (limparCapturasAntigas, GC automático 1x/dia).
//
// 2) capturarRawFunil — captura ENXUTA já existente (só referral/postback/
//    anexos), mantida por compatibilidade com os evals e por ser barata.
//
// ARMAZENAMENTO: tenta a tabela dedicada funil_capturas (migração
// supabase/migrations/003_funil_capturas.sql — o token de gerenciamento do
// Supabase está morto, DDL indisponível; quando a migração for aplicada o
// código passa a usá-la sozinho). Fallback SEM DDL: linhas em platform_settings
// com o JSON url-encodado embutido na chave, em CHUNKS de ~1600 chars (o PK
// text tem índice btree ~2.7KB por entrada):
//   funil_raw_<canal>_<epochMs>_<rand>_<i>of<n>[_s0][_trunc]::<chunk>
//   (_s0 = assinatura/token INVÁLIDO no POST; _trunc = body passou de ~12.8KB)
// Leitura: script avulso — select platform like 'funil_raw_%', agrupar por
// <canal>_<epochMs>_<rand>, ordenar por <i>, concatenar e decodeURIComponent.
// Fire-and-forget: NUNCA lança para o atendimento.
import { supabaseAdmin } from "@/lib/supabase";

const CHUNK = 1600; // chars ENCODADOS por linha (chave < ~1.7KB, longe do limite btree)
const MAX_CHUNKS = 8; // ~12.8KB encodados; bodies reais de webhook têm <3KB
const RETENCAO_MS = 7 * 24 * 3600_000; // 7 dias
const GC_GAP_MS = 24 * 3600_000; // GC no máximo 1x/dia

let tabelaCapturasExiste: boolean | null = null; // memo por instância

// Caixa-preta: grava o body bruto completo do POST. Chamar via waitUntil no
// PRIMEIRO ponto do handler, antes de qualquer parsing/filtro/return.
export async function capturarWebhookRaw(
  canal: "ig" | "fb" | "wa",
  rawBody: string,
  opts?: { sigOk?: boolean }
): Promise<void> {
  try {
    const agora = Date.now();
    // 1) Tabela dedicada, se a migração 003 já tiver sido aplicada.
    if (tabelaCapturasExiste !== false) {
      const { error } = await supabaseAdmin.from("funil_capturas").insert({
        canal,
        sig_ok: opts?.sigOk ?? null,
        body: rawBody.slice(0, 100_000),
      });
      if (!error) { tabelaCapturasExiste = true; void gcSeForHora(agora); return; }
      // PGRST205 = tabela não existe (fallback); outros erros também caem no fallback.
      tabelaCapturasExiste = false;
    }
    // 2) Fallback sem DDL: chunks na chave de platform_settings.
    const rand = Math.random().toString(36).slice(2, 6);
    const enc = encodeURIComponent(rawBody);
    const total = Math.min(Math.ceil(enc.length / CHUNK) || 1, MAX_CHUNKS);
    const truncado = enc.length > CHUNK * MAX_CHUNKS;
    const rows = [];
    for (let i = 0; i < total; i++) {
      const flag = `${opts?.sigOk === false ? "_s0" : ""}${truncado ? "_trunc" : ""}`;
      rows.push({
        platform: `funil_raw_${canal}_${agora}_${rand}_${i + 1}of${total}${flag}::${enc.slice(i * CHUNK, (i + 1) * CHUNK)}`,
        paused: false,
      });
    }
    await supabaseAdmin
      .from("platform_settings")
      .upsert(rows, { ignoreDuplicates: true, onConflict: "platform" });
    void gcSeForHora(agora);
  } catch {
    // diagnóstico nunca derruba o webhook
  }
}

// ─── Retenção de 7 dias (GC automático, no máximo 1x/dia) ────────────────────
// Marca de última execução: linha funil_rawgc_<epochMs>. Mesmo padrão do
// funil_check_: quem trocar a marca primeiro roda; corrida dupla é inofensiva
// (deletes idempotentes).
async function gcSeForHora(agora: number): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", "funil_rawgc_%");
    const marcas = (data ?? []).map((r) => Number(r.platform.replace("funil_rawgc_", ""))).filter(Number.isFinite);
    const ultima = marcas.length ? Math.max(...marcas) : 0;
    if (agora - ultima < GC_GAP_MS) return;
    for (const m of marcas) await supabaseAdmin.from("platform_settings").delete().eq("platform", `funil_rawgc_${m}`);
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: `funil_rawgc_${agora}`, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
    await limparCapturasAntigas(agora);
  } catch {
    // GC é best-effort
  }
}

// Apaga capturas com mais de 7 dias — na tabela dedicada E no fallback.
export async function limparCapturasAntigas(agoraMs?: number): Promise<number> {
  const agora = agoraMs ?? Date.now();
  const corte = agora - RETENCAO_MS;
  let apagadas = 0;
  // Tabela dedicada (se existir)
  try {
    await supabaseAdmin.from("funil_capturas").delete().lt("recebido_em", new Date(corte).toISOString());
  } catch { /* tabela pode não existir */ }
  // Fallback em platform_settings: epoch embutido na chave com 13 dígitos fixos
  // (até 2286), então ordem LEXICOGRÁFICA da chave = ordem numérica do epoch.
  //
  // RANGE DELETE por canal (auditoria rastreio 04/08): a versão anterior juntava
  // as chaves velhas num `.in()` de 100 por lote — cada chave tem até ~1.7KB,
  // a URL do PostgREST estourava o limite e o delete FALHAVA SILENCIOSO (o erro
  // nunca era checado e o log dizia "N apagadas" mesmo com 0 apagadas): a
  // caixa-preta crescia para sempre. Agora é 1 requisição curta por canal,
  // com erro checado e contagem real.
  try {
    for (const canal of ["ig", "fb", "wa"] as const) {
      const { error, count } = await supabaseAdmin
        .from("platform_settings")
        .delete({ count: "exact" })
        .gte("platform", `funil_raw_${canal}_`)
        .lt("platform", `funil_raw_${canal}_${corte}`);
      if (error) {
        console.warn(`[FUNIL] GC capturas raw (${canal}) falhou:`, (error.message || JSON.stringify(error)).slice(0, 120));
        continue;
      }
      apagadas += count ?? 0;
    }
    if (apagadas) console.log(`[FUNIL] GC capturas raw: ${apagadas} linhas com mais de 7 dias apagadas`);
  } catch (err) {
    console.warn("[FUNIL] GC capturas raw falhou:", String(err).slice(0, 150));
  }
  return apagadas;
}

// ─── Captura diagnóstica enxuta (P0 da auditoria 28/07 — mantida) ────────────
// Grava só os objetos de referral/postback/anexos (sem texto do cliente) para
// diagnóstico direcionado. Chave: funil_raw_<canal>_<epochMs>::<json cortado>.
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
