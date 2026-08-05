/**
 * GUARDA da missão REFERRAL (2026-07-28): captura raw incondicional, extração
 * dos 3 formatos, persistência sem sobrescrita e repasse do contrato de
 * atribuição à ozzi-plataforma com NOMES EXATOS.
 *
 * Parte A — inspeção de fonte (zero API): a caixa-preta precisa estar no TOPO
 * dos 3 POSTs (antes de assinatura/parsing), os 3 lugares do referral precisam
 * ser lidos, o contrato precisa existir com os 8 nomes, e as colunas-fantasma
 * (ad_id/ad_title/creative_url em instagram_conversations) não podem voltar.
 *
 * Parte B — funcional contra o banco REAL (sem AI, sem plataforma): mapeamento
 * contratoAnuncio, merge do persistirAnuncioDaConversa (existente vence, vazio
 * nunca sobrescreve), leitura via dadosDeAnuncioDaConversa e GC de 7 dias
 * (linha forjada com epoch antigo é apagada; recentes ficam).
 *
 * Rodar: npx tsx src/evals/referral-contract-verify.ts
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

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 140)}»`); }
}

const CAMPOS = ["ad_id", "ctwa_clid", "ad_source_type", "ad_title", "ad_media_url", "ad_post_id", "ad_ref", "ad_clicked_at"] as const;

async function main() {
  // ── Parte A: inspeção de fonte ─────────────────────────────────────────────
  const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf8");
  const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf8");
  const wa = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf8");
  const funil = readFileSync(join(process.cwd(), "src/lib/funil.ts"), "utf8");
  const raw = readFileSync(join(process.cwd(), "src/lib/funil-raw.ts"), "utf8");

  console.log("\n[A1 caixa-preta no topo dos 3 POSTs]");
  for (const [nome, src, canal] of [["IG", ig, "ig"], ["FB", fb, "fb"], ["WA", wa, "wa"]] as const) {
    ck(`${nome}: capturarWebhookRaw("${canal}") presente no POST`, new RegExp(`capturarWebhookRaw\\("${canal}", rawBody`).test(src), "captura raw ausente");
  }
  // A captura precisa vir ANTES do return de assinatura/token inválido.
  ck("IG: captura antes do return 403 de assinatura", ig.indexOf('capturarWebhookRaw("ig"') < ig.indexOf('console.warn("[IG webhook] Signature verification FAILED'), "ordem errada");
  ck("FB: captura antes do return 403 de assinatura", fb.indexOf('capturarWebhookRaw("fb"') < fb.indexOf('console.warn("[FB webhook] Signature verification FAILED'), "ordem errada");
  ck("WA: captura antes do return 403 de token", wa.indexOf('capturarWebhookRaw("wa"') < wa.indexOf("if (!tokenOk) return new NextResponse"), "ordem errada");
  ck("Retenção: GC de 7 dias existe (limparCapturasAntigas)", /RETENCAO_MS = 7 \* 24/.test(raw) && /limparCapturasAntigas/.test(raw), "");
  ck("Migração 003_funil_capturas.sql existe", (() => { try { return /funil_capturas/.test(readFileSync(join(process.cwd(), "supabase/migrations/003_funil_capturas.sql"), "utf8")); } catch { return false; } })(), "");

  console.log("\n[A2 extração — 3 lugares do referral]");
  ck("IG: lê message.referral + messaging.referral + postback.referral", /messaging\.message\?\.referral \?\? messaging\.referral \?\? postbackIG\?\.referral/.test(ig), "");
  ck("IG: clicked_at do timestamp do evento (normalizado s→ms)", /tsRef = messaging\.timestamp/.test(ig) && /clicked_at: new Date\(tsRef < 1e12 \? tsRef \* 1000 : tsRef\)/.test(ig), "");
  ck("FB: lê msg.referral + messaging.referral", /msg\?\.referral as RefFbMsg \| undefined\) \?\? \(messaging\.referral/.test(fb), "");
  ck("FB: standalone (sem mid) enriquecido com clicked_at", /refSoloBruto[\s\S]{0,200}clicked_at/.test(fb), "");
  ck("WA: extrai source_type", /"source_type", "sourceType"/.test(wa), "");
  ck("WA: extrai video_url", /"video_url", "videoUrl"/.test(wa), "");
  ck("WA: clicked_at do momment", /clicked_at: new Date\(Number\(body\.momment\)/.test(wa), "");
  ck("WA: source_id vira ad_id do contrato", /ad_id: adRefFunil\.adId/.test(wa), "");
  // Formato REAL da Z-API (missão 28/07, 2ª rodada): externalAdReply na raiz.
  ck("WA: lê externalAdReply no nível raiz (formato Z-API)", /asObj\(body\.externalAdReply\)/.test(wa), "");
  ck("WA: externalAdReply só vira anúncio com sourceType=ad ou sourceId/ctwaClid", /sourceType === "ad" \|\| adId \|\| ctwaClid/.test(wa), "");
  ck("WA: sourceUrl vira ad_ref do contrato", /ref: adRefFunil\.sourceUrl/.test(wa), "");

  console.log("\n[A3 colunas-fantasma banidas]");
  ck("IG: profile update sem ad_id/ad_title/creative_url", !/updateData\.(ad_id|ad_title|creative_url)/.test(ig), "gravação fantasma voltou");
  ck("FB: profile update sem ad_id/ad_title/creative_url", !/update\.(ad_id|ad_title|creative_url) =/.test(fb), "gravação fantasma voltou");
  ck("IG/FB: nenhum .update({ ad_title", !/\.update\(\{ ad_title/.test(ig) && !/\.update\(\{ ad_title/.test(fb), "update em coluna inexistente");
  ck("IG: booking select só com colunas reais", !/select\("creative_url/.test(ig), "select em coluna inexistente");

  console.log("\n[A4 contrato no repasse]");
  for (const c of CAMPOS) ck(`funil.ts: campo ${c} no contrato`, new RegExp(`${c}`).test(funil), "");
  ck("lead_criado espalha ...ad.contrato", /\.\.\.ad\.contrato/.test(funil), "");
  ck("legado ad_name/campanha mantidos no lead_criado", /ad_name: ad\.ad_name \?\? undefined,\s*\n\s*campanha: ad\.campanha \?\? undefined/.test(funil), "");

  // Clique de anúncio em conversa PRÉ-MARCO (31/07/2026): o gate do marco zero
  // segurava o lead_criado mesmo quando o clique era de hoje — 13 de 221
  // contratos ficaram presos e a visita dessas pessoas nasceria sem criativo.
  console.log("\n[A5 clique novo em conversa antiga não pode ficar preso no marco zero]");
  ck("pré-marco com referral dispara lead_criado", /if \(!convNoFunil\(conv\)\) \{[\s\S]{0,900}if \(referral\) await enviarLeadCriadoDeCliqueAntigo\(conv, rawText\);/.test(funil), "gate do marco zero engole o clique novo");
  ck("só dispara com contrato de verdade (nunca reabre histórico sozinho)", /async function enviarLeadCriadoDeCliqueAntigo[\s\S]{0,400}if \(!contratoTemDados\(ad\.contrato\)\) return;/.test(funil), "falta a guarda contratoTemDados");
  ck("o clique antigo leva o contrato completo", /enviarLeadCriadoDeCliqueAntigo[\s\S]{0,700}\.\.\.ad\.contrato/.test(funil), "");
  // GC da caixa-preta (auditoria 04/08): o `.in()` de 100 chaves de ~1.7KB
  // estourava a URL do PostgREST e o delete falhava SILENCIOSO (0 apagadas com
  // log de sucesso). O GC precisa usar range delete por canal e checar o erro.
  ck("GC da caixa-preta usa range delete por canal (URL curta)", /\.gte\("platform", `funil_raw_\$\{canal\}_`\)\s*\n\s*\.lt\("platform", `funil_raw_\$\{canal\}_\$\{corte\}`\)/.test(raw), "range delete sumiu — .in() gigante falha silencioso");
  ck("GC da caixa-preta checa o erro do delete e conta de verdade", /delete\(\{ count: "exact" \}\)/.test(raw) && /GC capturas raw \(\$\{canal\}\) falhou/.test(raw), "erro do delete não é checado");

  // AUDITORIA RASTREIO 04/08: returns antecipados (sticker, emoji-only, tipo de
  // callback não reconhecido) NÃO podem engolir a atribuição — o referral é
  // extraído no topo do handler e persistido antes de qualquer descarte.
  console.log("\n[A6 returns antecipados não engolem referral (auditoria 04/08)]");
  const igPersistDescarte = (ig.match(/if \(refComClique\) waitUntil\(persistirAnuncioDaConversa\(conversation\.id, refComClique\)\);/g) ?? []).length;
  ck("IG: persiste atribuição nos returns de sticker E emoji-only", igPersistDescarte >= 2, `encontrados ${igPersistDescarte} de 2`);
  ck("IG: extração do referral vem ANTES do return de sticker", ig.indexOf("const refBruto = messaging.message?.referral") !== -1 && ig.indexOf("const refBruto = messaging.message?.referral") < ig.indexOf("sticker_id) {"), "extração depois do descarte");
  const fbPersistDescarte = (fb.match(/if \(refComClique\) waitUntil\(persistirAnuncioDaConversa\(conv\.id, refComClique\)\);/g) ?? []).length;
  ck("FB: persiste atribuição nos returns de sticker E emoji-only", fbPersistDescarte >= 2, `encontrados ${fbPersistDescarte} de 2`);
  ck("FB: extração do referral vem ANTES do return de sticker", fb.indexOf("const refBruto =") !== -1 && fb.indexOf("const refBruto =") < fb.indexOf("sticker_id) {"), "extração depois do descarte");
  const waPersistDescarte = (wa.match(/if \(referralFunilWa\) waitUntil\(persistirAnuncioDaConversa\(conv\.id, referralFunilWa\)\);/g) ?? []).length;
  ck("WA: persiste atribuição nos descartes (emoji-only E tipo não reconhecido)", waPersistDescarte >= 2, `encontrados ${waPersistDescarte} de 2`);
  ck("WA: extractWaAdReferral vem ANTES da triagem por tipo de mensagem", wa.indexOf("const adRefFunil = extractWaAdReferral(body)") < wa.indexOf("// Extract message content by type"), "extração depois da triagem");
  // Paridade standalone: referral só com ref/source também persiste (o caminho
  // de mensagem já persistia ad_ref/ad_source_type; o standalone descartava).
  ck("IG: standalone persiste referral só com ref/source", /refSoloBruto\?\.ref \|\| refSoloBruto\?\.source/.test(ig), "");
  ck("FB: standalone persiste referral só com ref/source", /refSolo\?\.ref \|\| refSolo\?\.source/.test(fb), "");

  // ── Parte B: funcional (banco real; sem AI, sem plataforma) ────────────────
  const { supabaseAdmin } = await import("@/lib/supabase");
  const { contratoAnuncio, persistirAnuncioDaConversa, dadosDeAnuncioDaConversa } = await import("@/lib/funil");
  const { capturarWebhookRaw, limparCapturasAntigas } = await import("@/lib/funil-raw");

  console.log("\n[B1 contratoAnuncio — mapeamento]");
  const cIG = contratoAnuncio({
    ref: "promo-julho", source: "ADS", type: "OPEN_THREAD", ad_id: "1200",
    clicked_at: "2026-07-28T10:00:00.000Z",
    ads_context_data: { ad_title: "Vinyl Promo", photo_url: "https://cdn/x.jpg", video_url: "https://cdn/x.mp4", post_id: "17900" },
  });
  ck("IG/FB → contrato completo", cIG.ad_id === "1200" && cIG.ad_source_type === "ADS" && cIG.ad_title === "Vinyl Promo" && cIG.ad_media_url === "https://cdn/x.jpg" && cIG.ad_post_id === "17900" && cIG.ad_ref === "promo-julho" && cIG.ad_clicked_at === "2026-07-28T10:00:00.000Z", JSON.stringify(cIG));
  const cVid = contratoAnuncio({ ads_context_data: { video_url: "https://cdn/v.mp4" } });
  ck("media_url cai para video_url sem photo", cVid.ad_media_url === "https://cdn/v.mp4", JSON.stringify(cVid));
  const cWa = contratoAnuncio({ ad_id: "6001", ctwa_clid: "AbCd123", source: "ad", clicked_at: "2026-07-28T11:00:00.000Z", ads_context_data: { ad_title: "TILE 1000 sqft", photo_url: "https://cdn/t.jpg" } });
  ck("WA → source_id/ctwa_clid/source_type mapeados", cWa.ad_id === "6001" && cWa.ctwa_clid === "AbCd123" && cWa.ad_source_type === "ad", JSON.stringify(cWa));
  ck("referral null → contrato vazio", Object.values(contratoAnuncio(null)).every((v) => v === undefined), "");

  console.log("\n[B2 persistência — merge sem sobrescrita]");
  const convId = `reftest_${Date.now()}`;
  const limpar = async () => {
    for (const like of [`funil_ad_${convId}%`, `funil_adx_${convId}%`]) {
      await supabaseAdmin.from("platform_settings").delete().like("platform", like);
    }
  };
  try {
    // 1ª gravação (parcial: sem título)
    await persistirAnuncioDaConversa(convId, { ad_id: "111", source: "ADS", clicked_at: "2026-07-28T10:00:00.000Z" });
    let lido = await dadosDeAnuncioDaConversa(convId);
    ck("grava 1º referral (ad_id/source/clicked_at)", lido.contrato.ad_id === "111" && lido.contrato.ad_source_type === "ADS" && lido.contrato.ad_clicked_at === "2026-07-28T10:00:00.000Z", JSON.stringify(lido.contrato));
    // 2º evento: preenche o que falta, NÃO sobrescreve o que existe
    await persistirAnuncioDaConversa(convId, { ad_id: "999-DIFERENTE", ads_context_data: { ad_title: "Titulo Novo" } });
    lido = await dadosDeAnuncioDaConversa(convId);
    ck("preenche faltante (ad_title) sem sobrescrever ad_id", lido.contrato.ad_id === "111" && lido.contrato.ad_title === "Titulo Novo", JSON.stringify(lido.contrato));
    // referral vazio nunca apaga nada
    await persistirAnuncioDaConversa(convId, null);
    await persistirAnuncioDaConversa(convId, {});
    lido = await dadosDeAnuncioDaConversa(convId);
    ck("vazio nunca sobrescreve", lido.contrato.ad_id === "111" && lido.contrato.ad_title === "Titulo Novo", JSON.stringify(lido.contrato));
    ck("ad_name legado continua saindo (compat plataforma atual)", lido.ad_name === "Titulo Novo", String(lido.ad_name));
  } finally {
    await limpar();
  }

  console.log("\n[B3 caixa-preta — grava, lê e GC 7 dias]");
  const corpo = JSON.stringify({ object: "instagram", entry: [{ id: "t", messaging: [{ sender: { id: "smoke" }, referral: { ad_id: "777" } }] }] });
  await capturarWebhookRaw("ig", corpo, { sigOk: true });
  const { data: capturas } = await supabaseAdmin
    .from("platform_settings").select("platform").like("platform", "funil_raw_ig_%").order("platform", { ascending: false }).limit(50);
  const minha = (capturas ?? []).map((r) => r.platform as string).find((k) => k.includes("smoke") || decodeURIComponent(k.split("::")[1] ?? "").includes("smoke"));
  ck("captura raw gravada e legível (body completo)", !!minha && decodeURIComponent(minha.split("::")[1]).includes('"ad_id":"777"'), (minha ?? "nenhuma").slice(0, 80));
  // GC: forja uma captura com epoch de 8 dias atrás e confirma que SÓ ela morre
  const epochVelho = Date.now() - 8 * 24 * 3600_000;
  const chaveVelha = `funil_raw_ig_${epochVelho}_gcgc_1of1::${encodeURIComponent('{"gc":"teste"}')}`;
  await supabaseAdmin.from("platform_settings").upsert({ platform: chaveVelha, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });
  await limparCapturasAntigas();
  const { data: aposGc } = await supabaseAdmin.from("platform_settings").select("platform").in("platform", [chaveVelha, minha ?? "x"]);
  const sobraram = (aposGc ?? []).map((r) => r.platform as string);
  ck("GC apaga captura de 8 dias e preserva a recente", !sobraram.includes(chaveVelha) && (!minha || sobraram.includes(minha)), JSON.stringify(sobraram.map((s) => s.slice(0, 40))));
  // limpeza do artefato recente do teste
  if (minha) await supabaseAdmin.from("platform_settings").delete().eq("platform", minha);

  console.log(`\n===== REFERRAL-CONTRACT: ${pass} passed, ${fail} failed =====`);
  if (fail > 0) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
