// BACKFILL DO CLIQUE DE ANÚNCIO EM CONVERSA PRÉ-FUNIL (31/07/2026)
//
// O gate do marco zero (FUNIL_DESDE) segurava o lead_criado de conversas
// anteriores a 09/07 — inclusive quando a pessoa clicava num anúncio HOJE. O
// contrato funil_adx_ era gravado e a plataforma nunca ficava sabendo: 13 de
// 221 contratos (5,9%) presos, 12 no Messenger. O código já foi corrigido
// (src/lib/funil.ts); este script repõe os que ficaram para trás.
//
// Manda o MESMO payload que o webhook mandaria (identidade + contrato de 8
// campos). A plataforma faz merge fill-if-empty — nunca sobrescreve nem duplica.
// Só entra conversa COM mensagem do cliente (clique sem mensagem não é lead).
//
// Uso: node --env-file=.env.local scripts/backfill-clique-antigo.mjs [--gravar]
import { createClient } from "@supabase/supabase-js";

const GRAVAR = process.argv.includes("--gravar");
const MARCO = process.env.FUNIL_DESDE || "2026-07-09T19:00:00Z";
const ad = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const URL_PLAT = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");

const FONE_US = /(?<!\d)(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?!\d)/;
const FONE_E164 = /(?<!\d)\+(\d{10,15})(?!\d)/;
const stripSys = (c) => (c || "").split(/\n\n?\[SYSTEM:/)[0];
function extrairTelefone(texto) {
  const t = stripSys(texto);
  const e = t.match(FONE_E164); if (e) return `+${e[1]}`;
  const u = t.match(FONE_US); if (u) return `+1${u[1]}${u[2]}${u[3]}`;
  return null;
}
const canalDe = (igsid) => (igsid.startsWith("wa_") ? "whatsapp" : igsid.startsWith("fb_") ? "facebook" : "instagram");

const linhas = [];
for (let p = 0; p < 40; p++) {
  const { data, error } = await ad.from("platform_settings").select("platform").like("platform", "funil_adx_%")
    .order("platform", { ascending: false }).range(p * 1000, p * 1000 + 999);
  if (error) throw new Error(error.message);
  linhas.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
}
const contratos = new Map();
for (const r of linhas) {
  const m = r.platform.match(/^funil_adx_([0-9a-f-]{36})::([\s\S]*)$/); if (!m) continue;
  try {
    const ct = JSON.parse(decodeURIComponent(m[2]));
    const antigo = contratos.get(m[1]);
    // se a conversa tem mais de um contrato, vale o do clique mais ANTIGO
    if (!antigo || (ct.ad_clicked_at ?? "") < (antigo.ad_clicked_at ?? "")) contratos.set(m[1], ct);
  } catch { /* chave ilegível */ }
}

const ids = [...contratos.keys()];
const convs = [];
for (let i = 0; i < ids.length; i += 100) {
  const { data } = await ad.from("instagram_conversations").select("id, igsid, name, username, created_at").in("id", ids.slice(i, i + 100));
  convs.push(...(data ?? []));
}
const alvos = convs.filter((c) => c.created_at < MARCO);
console.log(`Contratos: ${contratos.size} · conversas anteriores ao marco (${MARCO}): ${alvos.length}`);

let enviados = 0, pulados = 0;
for (const c of alvos) {
  const ct = contratos.get(c.id);
  const { data: msgs } = await ad.from("instagram_messages").select("role, content, created_at")
    .eq("conversation_id", c.id).order("created_at").limit(400);
  const doCliente = (msgs ?? []).filter((m) => m.role === "user");
  if (doCliente.length === 0) { pulados++; console.log(`  ⏭  ${c.igsid}: clique sem mensagem — não vira lead`); continue; }

  const canal = canalDe(c.igsid);
  let telefone;
  if (canal === "whatsapp") telefone = `+${c.igsid.slice(3).replace(/\D/g, "")}`;
  else for (const m of doCliente) { const t = extrairTelefone(m.content); if (t) { telefone = t; break; } }

  const payload = { evento: "lead_criado", canal,
    ig_id: canal === "whatsapp" ? undefined : canal === "facebook" ? c.igsid.slice(3) : c.igsid,
    ig_username: canal === "instagram" ? c.username ?? undefined : undefined,
    telefone, nome: c.name ?? c.username ?? undefined,
    ...ct, ad_name: ct.ad_title ?? undefined };
  for (const k of Object.keys(payload)) if (payload[k] === undefined || payload[k] === null || payload[k] === "") delete payload[k];

  if (!GRAVAR) { console.log(`  [dry] ${c.igsid} ad=${ct.ad_id} "${String(ct.ad_title ?? "").slice(0,40)}" tel=${telefone ?? "-"} msgs=${doCliente.length}`); enviados++; continue; }
  const res = await fetch(`${URL_PLAT}/api/webhooks/atendimento`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-webhook-token": process.env.PLATAFORMA_WEBHOOK_TOKEN },
    body: JSON.stringify(payload) });
  const body = (await res.text()).slice(0, 200);
  console.log(`  ${res.ok ? "✅" : "❌"} ${c.igsid} ad=${ct.ad_id} → HTTP ${res.status} ${body}`);
  if (res.ok) enviados++;
}
console.log(`\n${GRAVAR ? "Enviados" : "Enviariam"}: ${enviados} · pulados (clique sem mensagem): ${pulados}`);
if (!GRAVAR) console.log("Rode com --gravar para aplicar.");
