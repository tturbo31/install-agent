/**
 * SMOKE E2E da missão REFERRAL (2026-07-28) — rota COMPLETA, nos 3 canais:
 * POST real no webhook (dev server local) → captura raw no banco → extração →
 * persistência (funil_adx_) → repasse lead_criado com o contrato de 8 campos,
 * recebido por um SINK HTTP local no lugar da ozzi-plataforma (nenhum evento
 * de teste vaza para a plataforma real). + 1 mensagem SEM referral (nada quebra).
 *
 * Segurança do teste (nenhum efeito fora do banco de dev/prod compartilhado,
 * todo artefato é apagado no final):
 *  • conversas de teste criadas em mode=human → IA/debounce/envio nunca rodam;
 *  • marcador pausealert| pré-inserido → nenhum WhatsApp de alerta pro dono;
 *  • marcador funil_check_ fresco → o sweep parou_de_responder NÃO roda local
 *    (rodar local mandaria eventos de conversas REAIS para o sink = perdidos);
 *  • PLATAFORMA_URL aponta para o sink 127.0.0.1:5599.
 *
 * Rodar: npx tsx src/evals/referral-smoke-e2e.ts   (sobe next dev na porta 3210)
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createHmac } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawn, type ChildProcess } from "child_process";

try {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { /* sem .env.local */ }

const DEV_PORT = 3210;
const SINK_PORT = 5599;
const TAG = `SMOKE${Date.now()}`;
let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Evento = Record<string, unknown>;
const eventosSink: Evento[] = [];

function subirSink(): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.method === "POST") {
          try { eventosSink.push(JSON.parse(body)); } catch { eventosSink.push({ raw: body }); }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    srv.listen(SINK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

function assinar(rawBody: string): string {
  const secret = process.env.FACEBOOK_APP_SECRET ?? "";
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

async function esperarEvento(filtro: (e: Evento) => boolean, timeoutMs = 20000): Promise<Evento | null> {
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    const hit = eventosSink.find(filtro);
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase");

  // IDs de teste únicos por execução
  const IG_ID = `99${Date.now()}`.slice(0, 16);
  const IG_ORG_ID = `98${Date.now()}`.slice(0, 16);
  const FB_PSID = `55${Date.now()}`.slice(0, 16);
  const WA_FONE = `1555010${String(Date.now()).slice(-4)}`;
  const WA_FONE_LINK = `1555011${String(Date.now()).slice(-4)}`; // externalAdReply de link comum
  const WA_FONE_ORG = `1555012${String(Date.now()).slice(-4)}`; // sem externalAdReply
  const igsids = [IG_ID, IG_ORG_ID, `fb_${FB_PSID}`, `wa_${WA_FONE}`, `wa_${WA_FONE_LINK}`, `wa_${WA_FONE_ORG}`];

  console.log(`═══ SMOKE E2E REFERRAL — tag ${TAG} | dev :${DEV_PORT} | sink :${SINK_PORT} ═══`);

  // ── Preparação: convs mode=human + marcadores anti-efeito-colateral ──
  const convIds: Record<string, string> = {};
  for (const igsid of igsids) {
    const { data, error } = await supabaseAdmin
      .from("instagram_conversations")
      .insert({ igsid, mode: "human" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`criar conv ${igsid}: ${error?.message}`);
    convIds[igsid] = data.id;
    await supabaseAdmin.from("platform_settings").insert({ platform: `pausealert|${data.id}|${new Date().toISOString()}`, paused: false });
  }
  // trava o sweep de silêncio por 6h (não deixar o dev local "roubar" o sweep)
  await supabaseAdmin.from("platform_settings").upsert({ platform: `funil_check_${Date.now()}`, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });

  const sink = await subirSink();
  const dev: ChildProcess = spawn("npx", ["next", "dev", "-p", String(DEV_PORT)], {
    cwd: process.cwd(),
    shell: true,
    env: {
      ...process.env,
      PLATAFORMA_URL: `http://127.0.0.1:${SINK_PORT}`,
      PLATAFORMA_WEBHOOK_TOKEN: "smoketoken",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let devLog = "";
  dev.stdout?.on("data", (c) => (devLog += c));
  dev.stderr?.on("data", (c) => (devLog += c));

  const limpar = async () => {
    try {
      for (const igsid of igsids) {
        const id = convIds[igsid];
        if (id) {
          await supabaseAdmin.from("instagram_messages").delete().eq("conversation_id", id);
          for (const like of [`funil_ad_${id}%`, `funil_adx_${id}%`, `funil_sumido_${id}`, `pausealert|${id}|%`]) {
            await supabaseAdmin.from("platform_settings").delete().like("platform", like);
          }
        }
        await supabaseAdmin.from("instagram_conversations").delete().eq("igsid", igsid);
      }
      // capturas raw do teste (o TAG aparece no body encodado)
      const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_raw_%${TAG}%`);
      for (const r of data ?? []) await supabaseAdmin.from("platform_settings").delete().eq("platform", r.platform);
    } catch (e) { console.warn("limpeza falhou:", e); }
  };

  try {
    // ── Espera o dev server responder ──
    let pronto = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${DEV_PORT}/api/wa-webhook`);
        if (r.status < 500) { pronto = true; break; }
      } catch { /* ainda subindo */ }
      await sleep(2000);
    }
    if (!pronto) throw new Error(`dev server não subiu:\n${devLog.slice(-1500)}`);
    console.log("dev server no ar.\n");

    const agora = Date.now();

    // ── 1) INSTAGRAM: referral DENTRO da mensagem (message.referral) ──
    console.log("[1/4] IG com referral (message.referral)");
    const igBody = JSON.stringify({
      object: "instagram",
      entry: [{ id: "17841400000000000", time: agora, messaging: [{
        sender: { id: IG_ID }, recipient: { id: "1940528653163182" }, timestamp: agora,
        message: {
          mid: `mid_${TAG}_ig`, text: "How much for vinyl floors?",
          referral: { ref: `ref_${TAG}`, source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000000001",
            ads_context_data: { ad_title: `Vinyl Promo ${TAG}`, photo_url: "https://example.com/smoke.jpg", post_id: "17900000000000001" } },
        },
      }] }],
    });
    let r = await fetch(`http://127.0.0.1:${DEV_PORT}/api/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinar(igBody) }, body: igBody,
    });
    ck("IG: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evIg = await esperarEvento((e) => e.evento === "lead_criado" && e.ig_id === IG_ID);
    ck("IG: lead_criado chegou ao sink", !!evIg, JSON.stringify(eventosSink).slice(0, 300));
    if (evIg) {
      ck("IG: contrato completo no repasse", evIg.ad_id === "120200000000000001" && evIg.ad_source_type === "ADS" && evIg.ad_title === `Vinyl Promo ${TAG}` && evIg.ad_media_url === "https://example.com/smoke.jpg" && evIg.ad_post_id === "17900000000000001" && evIg.ad_ref === `ref_${TAG}` && typeof evIg.ad_clicked_at === "string", JSON.stringify(evIg));
      ck("IG: legado ad_name mantido", evIg.ad_name === `Vinyl Promo ${TAG}`, String(evIg.ad_name));
      ck("IG: canal=instagram", evIg.canal === "instagram", String(evIg.canal));
    }

    // ── 2) MESSENGER: referral no nível do evento (messaging.referral) ──
    console.log("\n[2/4] FB com referral (messaging.referral)");
    const fbBody = JSON.stringify({
      object: "page",
      entry: [{ id: "1234567890", time: agora, messaging: [{
        sender: { id: FB_PSID }, recipient: { id: "1234567890" }, timestamp: agora,
        message: { mid: `mid_${TAG}_fb`, text: "Is labor included?" },
        referral: { ref: `reffb_${TAG}`, source: "ADS", type: "OPEN_THREAD", ad_id: "120200000000000002",
          ads_context_data: { ad_title: `Tile Promo ${TAG}`, video_url: "https://example.com/smoke.mp4", post_id: "17900000000000002" } },
      }] }],
    });
    r = await fetch(`http://127.0.0.1:${DEV_PORT}/api/fb-webhook`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinar(fbBody) }, body: fbBody,
    });
    ck("FB: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evFb = await esperarEvento((e) => e.evento === "lead_criado" && e.ig_id === FB_PSID);
    ck("FB: lead_criado chegou ao sink", !!evFb, "");
    if (evFb) {
      ck("FB: contrato completo (media_url do video_url)", evFb.ad_id === "120200000000000002" && evFb.ad_source_type === "ADS" && evFb.ad_title === `Tile Promo ${TAG}` && evFb.ad_media_url === "https://example.com/smoke.mp4" && evFb.ad_post_id === "17900000000000002" && evFb.ad_ref === `reffb_${TAG}` && typeof evFb.ad_clicked_at === "string", JSON.stringify(evFb));
      ck("FB: canal=facebook", evFb.canal === "facebook", String(evFb.canal));
    }

    // ── 3) WHATSAPP: clique de anúncio CTWA no formato REAL da Z-API ──
    // externalAdReply no NÍVEL RAIZ (developer.z-api.io/webhooks/
    // on-message-received-examples + payload real da caixa-preta 28/07).
    console.log("\n[3/6] WA com externalAdReply de ANÚNCIO (formato Z-API)");
    const waBody = JSON.stringify({
      type: "ReceivedCallback",
      instanceId: process.env.ZAPI_INSTANCE_ID ?? undefined,
      phone: WA_FONE, fromMe: false, momment: agora, messageId: `mid_${TAG}_wa`,
      text: { message: "Hi, I saw your ad" },
      externalAdReply: {
        title: `TILE 1000 sqft ${TAG}`, body: "Installation special", mediaType: "VIDEO",
        thumbnailUrl: "https://example.com/smoke-wa.jpg",
        mediaUrl: "https://www.facebook.com/story.php?story_fbid=1",
        sourceType: "ad", sourceId: "120200000000000003", sourceUrl: "https://fb.me/smokewa",
        ctwaClid: `clid_${TAG}`, showAdAttribution: true,
      },
    });
    const waToken = process.env.ZAPI_WEBHOOK_TOKEN;
    const waUrl = `http://127.0.0.1:${DEV_PORT}/api/wa-webhook${waToken ? `?token=${encodeURIComponent(waToken)}` : ""}`;
    r = await fetch(waUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: waBody });
    ck("WA: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evWa = await esperarEvento((e) => e.evento === "lead_criado" && typeof e.telefone === "string" && (e.telefone as string).includes(WA_FONE));
    ck("WA: lead_criado chegou ao sink", !!evWa, "");
    if (evWa) {
      ck("WA: contrato (sourceId→ad_id, ctwaClid, sourceType, title+body→ad_title, thumbnailUrl→media, sourceUrl→ad_ref)", evWa.ad_id === "120200000000000003" && evWa.ctwa_clid === `clid_${TAG}` && evWa.ad_source_type === "ad" && evWa.ad_title === `TILE 1000 sqft ${TAG} Installation special` && evWa.ad_media_url === "https://example.com/smoke-wa.jpg" && evWa.ad_ref === "https://fb.me/smokewa" && typeof evWa.ad_clicked_at === "string", JSON.stringify(evWa));
      ck("WA: canal=whatsapp", evWa.canal === "whatsapp", String(evWa.canal));
    }

    // ── 3b) WHATSAPP: externalAdReply de LINK COMUM (compartilhamento) ──
    // sourceType ausente e sem sourceId/ctwaClid → NUNCA vira atribuição.
    console.log("\n[4/6] WA com externalAdReply de link comum (não-anúncio)");
    const waLinkBody = JSON.stringify({
      type: "ReceivedCallback",
      instanceId: process.env.ZAPI_INSTANCE_ID ?? undefined,
      phone: WA_FONE_LINK, fromMe: false, momment: agora, messageId: `mid_${TAG}_walink`,
      text: { message: "Look at this article" },
      externalAdReply: {
        title: "Some news article", body: "Shared link preview", mediaType: 1,
        thumbnailUrl: "https://example.com/article.jpg", sourceUrl: "https://news.example.com/post",
      },
    });
    r = await fetch(waUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: waLinkBody });
    ck("WA-LINK: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evWaLink = await esperarEvento((e) => e.evento === "lead_criado" && typeof e.telefone === "string" && (e.telefone as string).includes(WA_FONE_LINK));
    ck("WA-LINK: lead_criado chegou ao sink", !!evWaLink, "");
    if (evWaLink) {
      const semAdLink = ["ad_id", "ctwa_clid", "ad_source_type", "ad_title", "ad_media_url", "ad_post_id", "ad_ref", "ad_clicked_at", "ad_name"].every((k) => !(k in evWaLink));
      ck("WA-LINK: payload SEM campos ad_* (sem falsa atribuição)", semAdLink, JSON.stringify(evWaLink));
    }

    // ── 3c) WHATSAPP: mensagem comum, sem externalAdReply ──
    console.log("\n[5/6] WA sem externalAdReply (orgânico)");
    const waOrgBody = JSON.stringify({
      type: "ReceivedCallback",
      instanceId: process.env.ZAPI_INSTANCE_ID ?? undefined,
      phone: WA_FONE_ORG, fromMe: false, momment: agora, messageId: `mid_${TAG}_waorg`,
      text: { message: "Do you install baseboards?" },
    });
    r = await fetch(waUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: waOrgBody });
    ck("WA-ORG: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evWaOrg = await esperarEvento((e) => e.evento === "lead_criado" && typeof e.telefone === "string" && (e.telefone as string).includes(WA_FONE_ORG));
    ck("WA-ORG: lead_criado chegou ao sink", !!evWaOrg, "");
    if (evWaOrg) {
      const semAdOrg = ["ad_id", "ctwa_clid", "ad_source_type", "ad_title", "ad_media_url", "ad_post_id", "ad_ref", "ad_clicked_at", "ad_name"].every((k) => !(k in evWaOrg));
      ck("WA-ORG: payload SEM campos ad_*", semAdOrg, JSON.stringify(evWaOrg));
    }

    // ── 4) SEM referral: nada quebra, nada de ad_* no payload ──
    console.log("\n[6/6] IG orgânico (sem referral)");
    const orgBody = JSON.stringify({
      object: "instagram",
      entry: [{ id: "17841400000000000", time: agora, messaging: [{
        sender: { id: IG_ORG_ID }, recipient: { id: "1940528653163182" }, timestamp: agora,
        message: { mid: `mid_${TAG}_org`, text: "Do you do stairs?" },
      }] }],
    });
    r = await fetch(`http://127.0.0.1:${DEV_PORT}/api/webhook`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinar(orgBody) }, body: orgBody,
    });
    ck("ORG: webhook aceitou (200)", r.status === 200, `HTTP ${r.status}`);
    const evOrg = await esperarEvento((e) => e.evento === "lead_criado" && e.ig_id === IG_ORG_ID);
    ck("ORG: lead_criado chegou ao sink", !!evOrg, "");
    if (evOrg) {
      const semAd = ["ad_id", "ctwa_clid", "ad_source_type", "ad_title", "ad_media_url", "ad_post_id", "ad_ref", "ad_clicked_at", "ad_name"].every((k) => !(k in evOrg));
      ck("ORG: payload SEM campos ad_*", semAd, JSON.stringify(evOrg));
    }

    // ── Persistência + captura raw no banco ──
    console.log("\n[verificações no banco]");
    await sleep(2000);
    for (const [rotulo, igsid, esperadoAdId] of [
      ["IG", IG_ID, "120200000000000001"],
      ["FB", `fb_${FB_PSID}`, "120200000000000002"],
      ["WA", `wa_${WA_FONE}`, "120200000000000003"],
    ] as const) {
      const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_adx_${convIds[igsid]}%`).limit(1);
      const key = data?.[0]?.platform as string | undefined;
      let contrato: Record<string, unknown> = {};
      try { contrato = JSON.parse(decodeURIComponent((key ?? "").split("::")[1] ?? "")); } catch { /* sem linha */ }
      ck(`${rotulo}: funil_adx_ persistido com ad_id + clicked_at`, contrato.ad_id === esperadoAdId && typeof contrato.ad_clicked_at === "string", key ?? "linha ausente");
    }
    const { data: orgAdx } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_adx_${convIds[IG_ORG_ID]}%`).limit(1);
    ck("ORG: NENHUM funil_adx_ criado", !orgAdx || orgAdx.length === 0, orgAdx?.[0]?.platform ?? "");
    for (const [rotulo, igsid] of [["WA-LINK", `wa_${WA_FONE_LINK}`], ["WA-ORG", `wa_${WA_FONE_ORG}`]] as const) {
      const { data: adx } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_adx_${convIds[igsid]}%`).limit(1);
      ck(`${rotulo}: NENHUM funil_adx_ criado`, !adx || adx.length === 0, adx?.[0]?.platform ?? "");
    }
    for (const canal of ["ig", "fb", "wa"] as const) {
      const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_raw_${canal}_%${TAG}%`).limit(5);
      ck(`${canal}: captura RAW do body completo no banco`, (data ?? []).length > 0, "nenhuma linha funil_raw_ com o TAG");
    }
  } finally {
    try { dev.kill(); } catch { /* já morreu */ }
    // mata a árvore no Windows (next dev spawna filhos)
    if (process.platform === "win32" && dev.pid) {
      try { spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { shell: true }); } catch { /* ok */ }
    }
    sink.close();
    await sleep(1500);
    await limpar();
  }

  console.log(`\n===== REFERRAL-SMOKE-E2E: ${pass} passed, ${fail} failed =====`);
  if (fail > 0) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
