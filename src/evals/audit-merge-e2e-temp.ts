/**
 * AUDITORIA 29/07 — teste TEMPORÁRIO de merge do referral (apagar após rodar).
 * Cenários (b) e (c) da verificação geral, nos 3 canais e formatos reais:
 *   (b) REFERRAL TARDIO: 1ª msg SEM referral → lead_criado sem ad_*;
 *       2ª msg COM referral → RE-ENVIO de lead_criado com o contrato;
 *   (c) NÃO SOBRESCREVE: 3ª msg sem referral → nada muda; 4ª msg com referral
 *       de OUTRO anúncio → funil_adx_ mantém o 1º (fill-if-empty).
 * (O cenário (a) — referral na 1ª mensagem — é o smoke referral-smoke-e2e.)
 * Mesma infra do smoke: next dev local + sink HTTP no lugar da plataforma;
 * convs mode=human (IA nunca roda); limpeza total no final.
 * Rodar: npx tsx src/evals/audit-merge-e2e-temp.ts
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
const TAG = `MERGE${Date.now()}`;
let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 220)}»`); }
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
        if (req.method === "POST") { try { eventosSink.push(JSON.parse(body)); } catch { eventosSink.push({ raw: body }); } }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    srv.listen(SINK_PORT, "127.0.0.1", () => resolve(srv));
  });
}

function assinar(rawBody: string): string {
  return "sha256=" + createHmac("sha256", process.env.FACEBOOK_APP_SECRET ?? "").update(rawBody, "utf8").digest("hex");
}

async function esperar(filtro: (e: Evento) => boolean, timeoutMs = 20000): Promise<Evento | null> {
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    const hit = eventosSink.find(filtro);
    if (hit) return hit;
    await sleep(500);
  }
  return null;
}

const SEM_AD = (e: Evento) => ["ad_id", "ctwa_clid", "ad_source_type", "ad_title", "ad_media_url", "ad_post_id", "ad_ref", "ad_clicked_at", "ad_name"].every((k) => !(k in e));

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase");

  const IG_ID = `97${Date.now()}`.slice(0, 16);
  const FB_PSID = `56${Date.now()}`.slice(0, 16);
  const WA_FONE = `1555013${String(Date.now()).slice(-4)}`;
  const igsids = [IG_ID, `fb_${FB_PSID}`, `wa_${WA_FONE}`];
  const AD_A = "120299911111110001";
  const AD_B = "120299911111110002";

  console.log(`═══ AUDIT MERGE E2E — tag ${TAG} ═══`);

  const convIds: Record<string, string> = {};
  for (const igsid of igsids) {
    const { data, error } = await supabaseAdmin.from("instagram_conversations").insert({ igsid, mode: "human" }).select("id").single();
    if (error || !data) throw new Error(`criar conv ${igsid}: ${error?.message}`);
    convIds[igsid] = data.id;
    await supabaseAdmin.from("platform_settings").insert({ platform: `pausealert|${data.id}|${new Date().toISOString()}`, paused: false });
  }
  await supabaseAdmin.from("platform_settings").upsert({ platform: `funil_check_${Date.now()}`, paused: false }, { ignoreDuplicates: true, onConflict: "platform" });

  const sink = await subirSink();
  const dev: ChildProcess = spawn("npx", ["next", "dev", "-p", String(DEV_PORT)], {
    cwd: process.cwd(), shell: true,
    env: { ...process.env, PLATAFORMA_URL: `http://127.0.0.1:${SINK_PORT}`, PLATAFORMA_WEBHOOK_TOKEN: "audittoken", NODE_ENV: "development" },
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
      const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_raw_%${TAG}%`);
      for (const r of data ?? []) await supabaseAdmin.from("platform_settings").delete().eq("platform", r.platform);
    } catch (e) { console.warn("limpeza falhou:", e); }
  };

  const lerAdx = async (convId: string): Promise<Record<string, unknown> | null> => {
    const { data } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", `funil_adx_${convId}%`).limit(1);
    const key = data?.[0]?.platform as string | undefined;
    if (!key) return null;
    try { return JSON.parse(decodeURIComponent(key.split("::")[1] ?? "")); } catch { return null; }
  };

  // POST por canal, com/sem referral do anúncio dado
  const postIg = async (n: number, adId?: string) => {
    const body = JSON.stringify({
      object: "instagram",
      entry: [{ id: "17841400000000000", time: Date.now(), messaging: [{
        sender: { id: IG_ID }, recipient: { id: "1940528653163182" }, timestamp: Date.now(),
        message: { mid: `mid_${TAG}_ig${n}`, text: `msg ${n}`,
          ...(adId ? { referral: { ref: `ref_${TAG}`, source: "ADS", type: "OPEN_THREAD", ad_id: adId, ads_context_data: { ad_title: `IG Promo ${TAG}`, photo_url: "https://example.com/a.jpg" } } } : {}) },
      }] }],
    });
    return fetch(`http://127.0.0.1:${DEV_PORT}/api/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinar(body) }, body });
  };
  const postFb = async (n: number, adId?: string) => {
    const body = JSON.stringify({
      object: "page",
      entry: [{ id: "1234567890", time: Date.now(), messaging: [{
        sender: { id: FB_PSID }, recipient: { id: "1234567890" }, timestamp: Date.now(),
        message: { mid: `mid_${TAG}_fb${n}`, text: `msg ${n}` },
        ...(adId ? { referral: { ref: `reffb_${TAG}`, source: "ADS", type: "OPEN_THREAD", ad_id: adId, ads_context_data: { ad_title: `FB Promo ${TAG}`, photo_url: "https://example.com/b.jpg" } } } : {}),
      }] }],
    });
    return fetch(`http://127.0.0.1:${DEV_PORT}/api/fb-webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": assinar(body) }, body });
  };
  const waToken = process.env.ZAPI_WEBHOOK_TOKEN;
  const waUrl = `http://127.0.0.1:${DEV_PORT}/api/wa-webhook${waToken ? `?token=${encodeURIComponent(waToken)}` : ""}`;
  const postWa = async (n: number, adId?: string) => {
    const body = JSON.stringify({
      type: "ReceivedCallback", instanceId: process.env.ZAPI_INSTANCE_ID ?? undefined,
      phone: WA_FONE, fromMe: false, momment: Date.now(), messageId: `mid_${TAG}_wa${n}`,
      text: { message: `msg ${n}` },
      ...(adId ? { externalAdReply: { title: `WA Promo ${TAG}`, body: "Special", mediaType: "VIDEO", thumbnailUrl: "https://example.com/c.jpg", sourceType: "ad", sourceId: adId, sourceUrl: "https://fb.me/audit", ctwaClid: `clid_${TAG}_${n}` } } : {}),
    });
    return fetch(waUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  };

  try {
    let pronto = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${DEV_PORT}/api/wa-webhook`); if (r.status === 200) { pronto = true; break; } } catch { /* subindo */ }
      await sleep(2000);
    }
    if (!pronto) throw new Error(`dev server não subiu ou porta ocupada por outro processo:\n${devLog.slice(-1200)}`);
    console.log("dev server no ar.\n");

    const canais = [
      { rotulo: "IG", post: postIg, achar: (e: Evento) => e.ig_id === IG_ID, igsid: IG_ID },
      { rotulo: "FB", post: postFb, achar: (e: Evento) => e.ig_id === FB_PSID, igsid: `fb_${FB_PSID}` },
      { rotulo: "WA", post: postWa, achar: (e: Evento) => typeof e.telefone === "string" && (e.telefone as string).includes(WA_FONE), igsid: `wa_${WA_FONE}` },
    ] as const;

    for (const c of canais) {
      console.log(`── ${c.rotulo} ──`);
      const convId = convIds[c.igsid];

      // (b1) 1ª msg SEM referral
      let r = await c.post(1);
      ck(`${c.rotulo}: msg1 sem referral aceita (200)`, r.status === 200, `HTTP ${r.status}`);
      const ev1 = await esperar((e) => e.evento === "lead_criado" && c.achar(e));
      ck(`${c.rotulo}: lead_criado inicial SEM ad_*`, !!ev1 && SEM_AD(ev1), JSON.stringify(ev1 ?? "timeout"));
      ck(`${c.rotulo}: sem funil_adx_ ainda`, (await lerAdx(convId)) === null, "");

      // (b2) 2ª msg COM referral (AD_A) → tardio re-envia lead_criado com contrato
      r = await c.post(2, AD_A);
      ck(`${c.rotulo}: msg2 com referral aceita (200)`, r.status === 200, `HTTP ${r.status}`);
      const ev2 = await esperar((e) => e.evento === "lead_criado" && c.achar(e) && e.ad_id === AD_A);
      ck(`${c.rotulo}: TARDIO re-enviou lead_criado com ad_id A + clicked_at`, !!ev2 && typeof ev2.ad_clicked_at === "string", JSON.stringify(eventosSink.filter(c.achar)).slice(0, 300));
      const adx2 = await lerAdx(convId);
      ck(`${c.rotulo}: funil_adx_ persistido com A`, adx2?.ad_id === AD_A, JSON.stringify(adx2));

      // (c1) 3ª msg SEM referral → nada muda
      const antes = eventosSink.filter((e) => c.achar(e) && !SEM_AD(e)).length;
      r = await c.post(3);
      ck(`${c.rotulo}: msg3 sem referral aceita (200)`, r.status === 200, `HTTP ${r.status}`);
      await sleep(6000);
      const depois = eventosSink.filter((e) => c.achar(e) && !SEM_AD(e)).length;
      ck(`${c.rotulo}: msg3 NÃO gerou novo evento com ad_*`, depois === antes, `antes=${antes} depois=${depois}`);
      const adx3 = await lerAdx(convId);
      ck(`${c.rotulo}: funil_adx_ intacto (A)`, adx3?.ad_id === AD_A, JSON.stringify(adx3));

      // (c2) 4ª msg com OUTRO anúncio (B) → 1º anúncio vence no funil_adx_
      r = await c.post(4, AD_B);
      ck(`${c.rotulo}: msg4 com referral B aceita (200)`, r.status === 200, `HTTP ${r.status}`);
      await sleep(8000);
      const adx4 = await lerAdx(convId);
      ck(`${c.rotulo}: funil_adx_ MANTÉM A (1º anúncio vence; B não sobrescreve)`, adx4?.ad_id === AD_A, JSON.stringify(adx4));
      console.log("");
    }
  } finally {
    try { dev.kill(); } catch { /* já morreu */ }
    if (process.platform === "win32" && dev.pid) {
      try { spawn("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { shell: true }); } catch { /* ok */ }
    }
    sink.close();
    await sleep(1500);
    await limpar();
  }

  console.log(`\n===== AUDIT-MERGE-E2E: ${pass} passed, ${fail} failed =====`);
  if (fail > 0) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
