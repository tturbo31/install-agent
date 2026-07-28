/**
 * BACKFILL RETROATIVO — anúncios CTWA na caixa-preta WA (missão Z-API 28/07):
 * varre os bodies brutos funil_raw_wa_ (7 dias de retenção), acha os que têm
 * externalAdReply de ANÚNCIO (sourceType "ad" ou sourceId/ctwaClid presentes),
 * persiste a atribuição no funil_adx_ da conversa (merge fill-if-empty — o
 * existente sempre vence) e reenvia lead_criado à plataforma só com identidade
 * + contrato (a plataforma faz merge fill-if-empty; não mexe em estágio nem
 * duplica — mesmo mecanismo do referral tardio).
 *
 * Rodar: npx tsx scripts/backfill-wa-ads.ts          (da raiz do projeto)
 *        npx tsx scripts/backfill-wa-ads.ts --dry    (só mostra, não envia)
 */
import { readFileSync } from "fs";
import { join } from "path";
try {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { /* sem .env.local */ }

const DRY = process.argv.includes("--dry");

type Ear = {
  title?: string; body?: string; thumbnailUrl?: string; originalImageUrl?: string;
  sourceType?: string; sourceId?: string; sourceUrl?: string; ctwaClid?: string;
};

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase");
  const { persistirAnuncioDaConversa, dadosDeAnuncioDaConversa, canalDe } = await import("@/lib/funil");
  const { enviarEventoFunil } = await import("@/lib/plataforma");

  // ── 1) Reagrupa a caixa-preta WA ──
  const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", "funil_raw_wa_%").limit(5000);
  const grupos = new Map<string, { epoch: number; partes: { i: number; chunk: string }[] }>();
  for (const row of data ?? []) {
    const m = (row.platform as string).match(/^funil_raw_wa_(\d{10,})_([a-z0-9]{4})_(\d+)of(\d+)(_s0)?(_trunc)?::([\s\S]*)$/);
    if (!m) continue;
    const chave = `${m[1]}_${m[2]}`;
    const g = grupos.get(chave) ?? { epoch: Number(m[1]), partes: [] };
    g.partes.push({ i: Number(m[3]), chunk: m[7] });
    grupos.set(chave, g);
  }
  console.log(`Caixa-preta WA: ${grupos.size} bodies`);

  // ── 2) Filtra externalAdReply de ANÚNCIO ──
  const alvos: { epoch: number; phone: string; momment: number; ear: Ear }[] = [];
  for (const [, g] of grupos) {
    let corpo = "";
    try { corpo = decodeURIComponent(g.partes.sort((a, b) => a.i - b.i).map((p) => p.chunk).join("")); } catch { continue; }
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(corpo); } catch { /* body truncado — tenta regex abaixo */ }
    let ear = (j?.externalAdReply ?? null) as Ear | null;
    if (!ear) {
      // captura truncada (_trunc): o externalAdReply é flat e vem antes do corte
      const m = corpo.match(/"externalAdReply":(\{[^{}]*\})/);
      if (m) { try { ear = JSON.parse(m[1]) as Ear; } catch { /* ilegível */ } }
    }
    if (!ear || typeof ear !== "object") continue;
    if (!(ear.sourceType === "ad" || ear.sourceId || ear.ctwaClid)) continue; // link comum
    const phone = String(j?.phone ?? corpo.match(/"phone":"?(\d{7,15})/)?.[1] ?? "").replace(/\D/g, "");
    if (!phone) { console.warn(`  ⚠️ ${new Date(g.epoch).toISOString()}: externalAdReply de anúncio SEM phone legível — pulado`); continue; }
    alvos.push({ epoch: g.epoch, phone, momment: Number(j?.momment) || g.epoch, ear });
  }
  console.log(`Com externalAdReply de anúncio: ${alvos.length}\n`);

  // ── 3) Por conversa: persiste (fill-if-empty) e reenvia lead_criado ──
  let enviados = 0, semConversa = 0;
  for (const alvo of alvos) {
    const igsid = `wa_${alvo.phone}`;
    const quando = new Date(alvo.epoch).toISOString();
    const { data: conv } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, name, username")
      .eq("igsid", igsid)
      .maybeSingle();
    if (!conv) {
      semConversa++;
      console.warn(`  ⚠️ ${quando} ${alvo.phone.slice(0, 5)}…: conversa ${igsid} não encontrada — pulado`);
      continue;
    }
    const referral = {
      ad_id: alvo.ear.sourceId,
      ctwa_clid: alvo.ear.ctwaClid,
      source: alvo.ear.sourceType,
      ref: alvo.ear.sourceUrl,
      clicked_at: new Date(alvo.momment).toISOString(),
      ads_context_data: {
        ad_title: [alvo.ear.title, alvo.ear.body].filter(Boolean).join(" ") || undefined,
        photo_url: alvo.ear.thumbnailUrl ?? alvo.ear.originalImageUrl,
      },
    };
    if (DRY) {
      console.log(`  [dry] ${quando} conv=${conv.id} ad_id=${alvo.ear.sourceId} ctwa=${(alvo.ear.ctwaClid ?? "").slice(0, 12)}…`);
      continue;
    }
    await persistirAnuncioDaConversa(conv.id, referral);
    const ad = await dadosDeAnuncioDaConversa(conv.id, referral);
    const r = await enviarEventoFunil("lead_criado", {
      telefone: `+${alvo.phone}`,
      nome: conv.name ?? conv.username ?? undefined,
      canal: canalDe(igsid),
      ...ad.contrato,
      ad_name: ad.ad_name ?? undefined,
      campanha: ad.campanha ?? undefined,
    });
    enviados++;
    console.log(`  ${r.ok ? "✅" : "❌"} ${quando} conv=${conv.id} ad_id=${alvo.ear.sourceId} → HTTP ${r.status}${r.ok ? "" : ` (${(r.body ?? "").slice(0, 120)})`}`);
  }
  console.log(`\nRETROATIVO: ${alvos.length} clique(s) de anúncio na caixa-preta · ${enviados} reenviado(s) à plataforma · ${semConversa} sem conversa`);
}

main().catch((e) => { console.error(e); process.exit(1); });
