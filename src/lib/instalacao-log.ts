import { supabaseAdmin } from "@/lib/supabase";

// ─── Registro de TODA chamada ao POST /api/confirmar-instalacao (21/10/2026) ─
// O aviso de véspera é disparado pelo app do Lovable (13:00 UTC). Quando um
// cliente fica sem aviso, a única prova do que o Lovable mandou (ou não mandou)
// eram os logs da Vercel, que somem em ~45 min. Em outubro/2026, 5 de 14 obras
// concluídas nunca tiveram aviso e não dava para dizer se o Lovable não chamou
// ou se chamou com telefone/data inválidos (400). Agora cada chamada — 401,
// 400, duplicada, ok, falha do Z-API e dry — vira uma linha legível no banco.
//
// ARMAZENAMENTO sem DDL (o acesso DDL ao Supabase do agente está morto; mesmo
// padrão de funil-raw.ts): linha em platform_settings com o JSON url-encodado
// embutido na própria chave:
//   instalacao_log_<epochMs 13 dígitos>_<rand>::<json encodado>
// Epoch com 13 dígitos fixos → ordem lexicográfica da chave = ordem no tempo,
// então leitura e GC são um range na chave.
// Leitura: scripts/check-avisos-instalacao.mjs (select like 'instalacao_log_%').
// Retenção: 180 dias (GC no máximo 1x/dia, marca instalacao_loggc_<epochMs>).
// Fire-and-forget: NUNCA lança nem atrasa a resposta ao integrador.

export const INSTALACAO_LOG_PREFIX = "instalacao_log_";
const GC_PREFIX = "instalacao_loggc_";
const RETENCAO_MS = 180 * 24 * 3600_000;
const GC_GAP_MS = 24 * 3600_000;
const MAX_KEY = 1500; // chave < ~1.7KB (índice btree do PK text)

export type InstalacaoLogStatus =
  | "ok" // WhatsApp enviado
  | "duplicado" // mesmo telefone já avisado há <20h — nada enviado
  | "dry" // preview (dry:true) — nada enviado
  | "400" // telefone_cliente/data_instalacao ausentes ou inválidos
  | "401" // token errado/ausente
  | "zapi"; // Z-API recusou o envio

export type InstalacaoLogRecord = {
  t: string; // ISO da chamada
  st: InstalacaoLogStatus;
  tel: string | null; // telefone normalizado (dígitos)
  nome: string | null;
  data: string | null; // data que foi (ou iria) na mensagem
  rec: string | null; // data_instalacao como veio do integrador
  vend: string | null;
  tv: string | null; // telefone do vendedor como veio
  hs: string | null; // horário suspeito removido
  iso: boolean; // veio data_instalacao_iso válido?
  err: string | null; // motivo (400/401/zapi)
};

function corta(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Chave = prefixo + epoch(13) + rand + "::" + JSON url-encodado. Campos longos
// são cortados para a chave nunca passar de MAX_KEY.
export function encodeInstalacaoLogKey(rec: InstalacaoLogRecord, agoraMs: number, rand: string): string {
  const compacto: InstalacaoLogRecord = {
    t: rec.t,
    st: rec.st,
    tel: corta(rec.tel, 20),
    nome: corta(rec.nome, 60),
    data: corta(rec.data, 80),
    rec: corta(rec.rec, 80),
    vend: corta(rec.vend, 60),
    tv: corta(rec.tv, 30),
    hs: corta(rec.hs, 20),
    iso: !!rec.iso,
    err: corta(rec.err, 160),
  };
  const head = `${INSTALACAO_LOG_PREFIX}${String(agoraMs).padStart(13, "0")}_${rand}::`;
  let enc = encodeURIComponent(JSON.stringify(compacto));
  if (head.length + enc.length > MAX_KEY) {
    // Os cortes acima já garantem folga; isto é só cinto.
    compacto.err = corta(compacto.err, 40);
    enc = encodeURIComponent(JSON.stringify(compacto)).slice(0, MAX_KEY - head.length);
  }
  return head + enc;
}

export function decodeInstalacaoLogKey(key: string): { epoch: number; rec: InstalacaoLogRecord } | null {
  if (typeof key !== "string" || !key.startsWith(INSTALACAO_LOG_PREFIX)) return null;
  const m = key.slice(INSTALACAO_LOG_PREFIX.length).match(/^(\d{13})_[a-z0-9]+::([\s\S]*)$/);
  if (!m) return null;
  try {
    const rec = JSON.parse(decodeURIComponent(m[2])) as InstalacaoLogRecord;
    if (!rec || typeof rec !== "object" || typeof rec.st !== "string") return null;
    return { epoch: Number(m[1]), rec };
  } catch {
    return null;
  }
}

// `bucketMs`: colapsa as chamadas de uma mesma janela numa linha só (epoch
// arredondado ao começo da janela + rand fixo → o upsert ignora a repetição).
// Usado no 401, que qualquer um na internet consegue provocar: sem isso um
// scanner encheria platform_settings. Uma linha por hora basta para provar
// "o Lovable está chamando com token errado".
// Onde a chamada cai: epoch/rand/t da chave. Em modo janela TUDO que entra na
// chave (inclusive o carimbo `t`, que está dentro do JSON) é o início da
// janela — senão dois 401 a 1s de distância viram duas linhas (aconteceu no
// E2E de 21/10: o `t` com milissegundos diferenciava as chaves).
export function instalacaoLogSlot(agoraMs: number, bucketMs?: number): { epoch: number; rand: string; t: string } {
  if (bucketMs && bucketMs > 0) {
    const epoch = Math.floor(agoraMs / bucketMs) * bucketMs;
    return { epoch, rand: "bucket", t: new Date(epoch).toISOString() };
  }
  return { epoch: agoraMs, rand: Math.random().toString(36).slice(2, 6), t: new Date(agoraMs).toISOString() };
}

export async function registrarChamadaInstalacao(
  rec: Omit<InstalacaoLogRecord, "t"> & { t?: string },
  opts?: { bucketMs?: number }
): Promise<void> {
  try {
    const agora = Date.now();
    const slot = instalacaoLogSlot(agora, opts?.bucketMs);
    const t = opts?.bucketMs ? slot.t : (rec.t ?? slot.t);
    const key = encodeInstalacaoLogKey({ ...rec, t }, slot.epoch, slot.rand);
    const { error } = await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: key, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
    if (error) console.error("[INSTALACAO] registro da chamada falhou:", error.message);
    void gcSeForHora(agora);
  } catch (err) {
    console.error("[INSTALACAO] registro da chamada exception:", err);
  }
}

// Lê as chamadas registradas desde `desdeMs` (ordem cronológica).
export async function lerChamadasInstalacao(desdeMs: number): Promise<Array<{ epoch: number; rec: InstalacaoLogRecord }>> {
  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .gte("platform", `${INSTALACAO_LOG_PREFIX}${String(desdeMs).padStart(13, "0")}`)
    .lt("platform", `${INSTALACAO_LOG_PREFIX}9999999999999`)
    .order("platform", { ascending: true })
    .limit(5000);
  if (error) {
    console.error("[INSTALACAO] leitura do registro falhou:", error.message);
    return [];
  }
  const out: Array<{ epoch: number; rec: InstalacaoLogRecord }> = [];
  for (const r of data ?? []) {
    const d = decodeInstalacaoLogKey(r.platform);
    if (d) out.push(d);
  }
  return out;
}

async function gcSeForHora(agora: number): Promise<void> {
  try {
    const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `${GC_PREFIX}%`);
    const marcas = (data ?? []).map((r) => Number(r.platform.replace(GC_PREFIX, ""))).filter(Number.isFinite);
    const ultima = marcas.length ? Math.max(...marcas) : 0;
    if (agora - ultima < GC_GAP_MS) return;
    for (const m of marcas) await supabaseAdmin.from("platform_settings").delete().eq("platform", `${GC_PREFIX}${m}`);
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ platform: `${GC_PREFIX}${agora}`, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
    const corte = agora - RETENCAO_MS;
    const { error, count } = await supabaseAdmin
      .from("platform_settings")
      .delete({ count: "exact" })
      .gte("platform", INSTALACAO_LOG_PREFIX)
      .lt("platform", `${INSTALACAO_LOG_PREFIX}${String(corte).padStart(13, "0")}`);
    if (error) console.warn("[INSTALACAO] GC do registro falhou:", error.message.slice(0, 120));
    else if (count) console.log(`[INSTALACAO] GC do registro: ${count} linhas com mais de 180 dias apagadas`);
  } catch {
    // GC é best-effort
  }
}
