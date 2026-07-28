// MONITOR DE REFERRAL (missão FB/WA 28/07/2026): lê a caixa-preta dos webhooks
// (funil_capturas ou chunks funil_raw_ em platform_settings) e mostra, para as
// últimas N horas, quantos webhooks chegaram por canal, quantos trouxeram
// "referral" de anúncio e o detalhe de cada um.
//
// QUANDO RODAR: depois do clique de teste nos anúncios (TESTE CRIATIVO FB/WA)
// ou depois de algumas horas de tráfego pago. A assinatura da página foi
// corrigida via API em 28/07 (~22:40 UTC) — referrals de Messenger só podem
// aparecer DEPOIS disso, e dependem de alguém clicar num anúncio.
//
// Uso: node --env-file=.env.local scripts/monitor-referral-fb.mjs [horas]
//      (padrão 24h; rodar da raiz do projeto do agente)

import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const HORAS = Number(process.argv[2] ?? 24);
const DESDE = Date.now() - HORAS * 3600e3;
const MARCO_FIX = Date.UTC(2026, 6, 28, 22, 40); // correção da assinatura da página

const capturas = [];

// 1) tabela dedicada (se a migração 003 estiver aplicada)
const t = await admin
  .from("funil_capturas")
  .select("canal, criado_em, body")
  .gte("criado_em", new Date(DESDE).toISOString())
  .order("criado_em");
if (!t.error) {
  for (const r of t.data ?? []) capturas.push({ canal: r.canal, epoch: Date.parse(r.criado_em), corpo: r.body });
} else {
  // 2) fallback: chunks na chave de platform_settings
  const { data } = await admin.from("platform_settings").select("platform").like("platform", "funil_raw_%").limit(5000);
  const grupos = new Map();
  for (const row of data ?? []) {
    const m = row.platform.match(/^funil_raw_(ig|fb|wa)_(\d{10,})_([a-z0-9]{4})_(\d+)of(\d+)(_s0)?(_trunc)?::([\s\S]*)$/);
    if (!m || Number(m[2]) < DESDE) continue;
    const chave = `${m[1]}_${m[2]}_${m[3]}`;
    const g = grupos.get(chave) ?? { canal: m[1], epoch: Number(m[2]), partes: [] };
    g.partes.push({ i: Number(m[4]), chunk: m[8] });
    grupos.set(chave, g);
  }
  for (const [, g] of grupos) {
    try {
      capturas.push({ canal: g.canal, epoch: g.epoch, corpo: decodeURIComponent(g.partes.sort((a, b) => a.i - b.i).map((p) => p.chunk).join("")) });
    } catch { /* chunk corrompido */ }
  }
}

capturas.sort((a, b) => a.epoch - b.epoch);
const cont = { ig: { t: 0, ref: 0 }, fb: { t: 0, ref: 0 }, wa: { t: 0, ref: 0 } };
const refs = [];
for (const c of capturas) {
  cont[c.canal] = cont[c.canal] ?? { t: 0, ref: 0 };
  cont[c.canal].t++;

  // WA (Z-API): o clique de anúncio chega como "externalAdReply" no NÍVEL RAIZ
  // (formato suportado desde 28/07, 2ª rodada) — só conta como anúncio quando
  // sourceType é "ad" ou há sourceId/ctwaClid (link comum também traz o objeto).
  let j = null;
  try { j = JSON.parse(c.corpo); } catch { /* body não-JSON */ }
  let ear = j?.externalAdReply;
  if (!ear) {
    // Payload real TRUNCADO pela captura (o adContext com Buffer serializado
    // estoura o teto de ~12,8KB e corta o fim do JSON — caso real 28/07): o
    // externalAdReply é flat e vem antes do corte, então regex recupera.
    const m = c.corpo.match(/"externalAdReply":(\{[^{}]*\})/);
    if (m) { try { ear = JSON.parse(m[1]); } catch { /* ilegível */ } }
  }
  if (ear && typeof ear === "object" && (ear.sourceType === "ad" || ear.sourceId || ear.ctwaClid)) {
    cont[c.canal].ref++;
    refs.push({
      canal: c.canal, quando: new Date(c.epoch).toISOString(),
      ad_id: ear.sourceId ?? null, titulo: String(ear.title ?? "").slice(0, 80) || null,
      ctwa: ear.ctwaClid ? `${String(ear.ctwaClid).slice(0, 12)}…` : null,
      source: ear.sourceType ?? null, posFix: c.epoch > MARCO_FIX,
    });
    continue;
  }

  if (!/"referral"/.test(c.corpo)) continue;
  cont[c.canal].ref++;
  const ad_id = c.corpo.match(/"ad_id":"?(\d+)/)?.[1] ?? null;
  const titulo = c.corpo.match(/"ad_title":"([^"]{0,80})/)?.[1] ?? null;
  const ctwa = c.corpo.match(/"ctwa_clid":"([^"]{0,40})/)?.[1] ?? null;
  const source = c.corpo.match(/"source":"([^"]{0,20})/)?.[1] ?? null;
  refs.push({ canal: c.canal, quando: new Date(c.epoch).toISOString(), ad_id, titulo, ctwa: ctwa ? `${ctwa.slice(0, 12)}…` : null, source, posFix: c.epoch > MARCO_FIX });
}

console.log(`\n═══ MONITOR REFERRAL — últimas ${HORAS}h ═══`);
console.log(`Webhooks: IG ${cont.ig.t} (${cont.ig.ref} c/ referral) · FB ${cont.fb.t} (${cont.fb.ref} c/ referral) · WA ${cont.wa.t} (${cont.wa.ref} c/ referral)`);
console.log(`\nReferrals encontrados: ${refs.length}`);
for (const r of refs) {
  console.log(` - [${r.canal.toUpperCase()}] ${r.quando} ad_id=${r.ad_id ?? "?"} "${r.titulo ?? "?"}"${r.ctwa ? ` ctwa=${r.ctwa}` : ""}${r.posFix ? "" : " (antes da correção da assinatura)"}`);
}

const fbPos = refs.filter((r) => r.canal === "fb" && r.posFix).length;
console.log(`\n═══ VEREDITO ═══`);
if (fbPos > 0) {
  console.log(`✅ FB DESTRAVADO: ${fbPos} referral(s) de Messenger após a correção da assinatura (28/07 22:40 UTC).`);
} else {
  console.log(`⏳ FB: nenhum referral de Messenger após a correção ainda — precisa de um CLIQUE em anúncio indo ao Messenger (teste: "TESTE CRIATIVO FB"). Sem clique, nada aparece mesmo com tudo certo.`);
}
if (cont.wa.ref > 0) {
  console.log(`✅ WA: ${cont.wa.ref} clique(s) de anúncio via externalAdReply — formato Z-API SUPORTADO (extração + repasse ativos desde 28/07).`);
} else {
  console.log(`⏳ WA: nenhum externalAdReply de anúncio nas últimas ${HORAS}h — o formato Z-API é SUPORTADO; precisa de um CLIQUE em anúncio de WhatsApp (teste: "TESTE CRIATIVO WA"). Se um clique de teste não aparecer aqui, conferir no painel da Z-API se o webhook "Ao receber" está na versão que envia externalAdReply.`);
}
