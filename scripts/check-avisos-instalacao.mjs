// Auditoria do aviso de véspera de instalação (POST /api/confirmar-instalacao).
// Rodar de dentro do repo do agente:  node scripts/check-avisos-instalacao.mjs [dias]
//
// Três provas, nesta ordem:
//   1. O que o Lovable CHAMOU (registro instalacao_log_* em platform_settings):
//      ok / duplicado / 400 / 401 / zapi / dry — por dia, com telefone e motivo.
//      (Só existe desde 21/10/2026; antes disso a única prova eram os logs da Vercel.)
//   2. O que SAIU para o cliente (instagram_messages, role assistant, "starts tomorrow").
//   3. Cobertura: obras CONCLUÍDAS na plataforma (jobs.data_conclusao) × aviso
//      para o telefone do quote. "SEM aviso" = o Lovable nunca chamou o agente
//      para esse telefone (ou chamou com dado inválido — aparece na prova 1).
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";

const loadEnv = (p) => {
  const e = {};
  for (const l of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
};
const DIAS = Math.max(1, Number(process.argv[2] ?? 14));
const ea = loadEnv(".env.local");
const ag = createClient(ea.NEXT_PUBLIC_SUPABASE_URL, ea.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PLAT_ENV = "C:/Users/vicam/Downloads/Funil Ozzi/ozzi-plataforma/.env.local";
const pl = existsSync(PLAT_ENV)
  ? (() => { const ep = loadEnv(PLAT_ENV); return createClient(ep.NEXT_PUBLIC_SUPABASE_URL, ep.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }); })()
  : null;
const desdeMs = Date.now() - DIAS * 86400000;
const desdeIso = new Date(desdeMs).toISOString();
const tel10 = (s) => String(s ?? "").replace(/\D/g, "").slice(-10);

// ── 1. Registro das chamadas ─────────────────────────────────────────────────
const PREFIX = "instalacao_log_";
const { data: regs, error: e1 } = await ag
  .from("platform_settings")
  .select("platform")
  .gte("platform", PREFIX + String(desdeMs).padStart(13, "0"))
  .lt("platform", PREFIX + "9999999999999")
  .order("platform", { ascending: true })
  .limit(5000);
if (e1) console.log("ERRO lendo registro:", e1.message);
const chamadas = [];
for (const r of regs ?? []) {
  const m = r.platform.slice(PREFIX.length).match(/^(\d{13})_[a-z0-9]+::([\s\S]*)$/);
  if (!m) continue;
  try { chamadas.push({ epoch: Number(m[1]), ...JSON.parse(decodeURIComponent(m[2])) }); } catch { /* chave corrompida */ }
}
console.log(`\n═══ 1. CHAMADAS DO LOVABLE registradas nos últimos ${DIAS} dias: ${chamadas.length} (registro existe desde 21/10/2026)`);
const porDiaSt = {};
for (const c of chamadas) { const d = c.t.slice(0, 10); (porDiaSt[d] ??= {})[c.st] = ((porDiaSt[d] ??= {})[c.st] ?? 0) + 1; }
for (const [d, st] of Object.entries(porDiaSt).sort()) console.log(`  ${d}: ${Object.entries(st).map(([k, v]) => `${k}=${v}`).join("  ")}`);
const problemas = chamadas.filter((c) => c.st !== "ok" && c.st !== "dry");
if (problemas.length) {
  console.log("  CHAMADAS QUE NÃO VIRARAM AVISO (bloqueado = data não é amanhã ou obra já concluída na plataforma; verif = plataforma não respondeu; nos dois NADA saiu e o dono foi avisado):");
  for (const c of problemas) console.log(`    ${c.t.replace("T", " ").slice(0, 16)}Z ${c.st.padEnd(9)} tel=${c.tel ?? "-"} nome=${c.nome ?? "-"} data=${c.rec ?? "-"} | ${c.err ?? ""}`);
}
const oks = chamadas.filter((c) => c.st === "ok");
if (oks.length) {
  console.log("  AVISOS ENVIADOS (registro):");
  for (const c of oks) console.log(`    ${c.t.replace("T", " ").slice(0, 16)}Z tel=${c.tel} nome=${c.nome ?? "-"} data="${c.data}" vendedor=${c.vend ?? "-"} ${c.tv ?? ""}${c.hs ? " HORARIO_SUSPEITO=" + c.hs : ""}`);
}

// ── 2. O que saiu para o cliente ─────────────────────────────────────────────
const { data: avisos, error: e2 } = await ag
  .from("instagram_messages")
  .select("conversation_id, content, created_at")
  .eq("role", "assistant")
  .gte("created_at", desdeIso)
  .or("content.ilike.%installation starts tomorrow%,content.ilike.%installation is confirmed for%")
  .order("created_at", { ascending: true });
if (e2) console.log("ERRO lendo avisos:", e2.message);
const convIds = [...new Set((avisos ?? []).map((a) => a.conversation_id))];
const igsidBy = {};
for (let i = 0; i < convIds.length; i += 150) {
  const { data } = await ag.from("instagram_conversations").select("id, igsid").in("id", convIds.slice(i, i + 150));
  for (const c of data ?? []) igsidBy[c.id] = c.igsid;
}
console.log(`\n═══ 2. AVISOS QUE SAÍRAM para clientes nos últimos ${DIAS} dias: ${(avisos ?? []).length}`);
const avisosPorTel = {};
for (const a of avisos ?? []) {
  const ig = igsidBy[a.conversation_id] ?? "";
  const nome = (a.content.match(/^Hi ([^!]+)!/) || [])[1] ?? "-";
  const data = (a.content.match(/starts tomorrow, ([^.]+)\./) || a.content.match(/confirmed for ([^.]+)\./) || [])[1] ?? "(sem data!)";
  const vend = (a.content.match(/reach out directly to ([^,]+),/) || [])[1] ?? "-";
  const tv = (a.content.match(/estimate, at ([^.]+)\./) || [])[1] ?? "-";
  const temHorario = /\bat \d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(a.content.replace(/between 10am and 11am/, ""));
  // Aviso enviado por engano e retratado depois (22/10/2026, caso Dayana): fica na lista, marcado.
  const retratado = /^\s*\[RETRATADO/.test(a.content);
  const nomeR = retratado ? ((a.content.match(/\] Hi ([^!]+)!/) || [])[1] ?? nome) : nome;
  console.log(`  ${a.created_at.replace("T", " ").slice(0, 16)}Z ${ig.padEnd(16)} ${nomeR.padEnd(26)} ${data.padEnd(28)} vendedor: ${vend} ${tv}${temHorario ? "  ⚠ HORÁRIO NO TEXTO" : ""}${retratado ? "  ⚠ RETRATADO (enviado por engano — cliente sem obra)" : ""}`);
  const d = tel10(ig);
  if (d) (avisosPorTel[d] ??= []).push(a.created_at.slice(0, 10) + " → " + data);
}
const dup = Object.entries(avisosPorTel).filter(([, v]) => new Set(v.map((x) => x.slice(0, 10))).size < v.length);
console.log(`  duplicados (mesmo telefone, mesmo dia): ${dup.length}${dup.length ? " → " + dup.map(([t, v]) => t + " " + v.join("; ")).join(" | ") : ""}`);

// ── 3. Cobertura: obras concluídas na plataforma × aviso ─────────────────────
if (!pl) {
  console.log("\n═══ 3. COBERTURA: .env.local da plataforma não encontrado — pulado");
} else {
  const { data: avisosTodos } = await ag
    .from("instagram_messages")
    .select("conversation_id, content, created_at")
    .eq("role", "assistant")
    .gte("created_at", new Date(desdeMs - 21 * 86400000).toISOString())
    .or("content.ilike.%installation starts tomorrow%,content.ilike.%installation is confirmed for%");
  const ids2 = [...new Set((avisosTodos ?? []).map((a) => a.conversation_id))];
  for (let i = 0; i < ids2.length; i += 150) {
    const { data } = await ag.from("instagram_conversations").select("id, igsid").in("id", ids2.slice(i, i + 150));
    for (const c of data ?? []) igsidBy[c.id] = c.igsid;
  }
  const avisosTodosPorTel = {};
  for (const a of avisosTodos ?? []) { const d = tel10(igsidBy[a.conversation_id]); if (d) (avisosTodosPorTel[d] ??= []).push(a.created_at.slice(0, 10)); }
  const { data: jobs, error: e3 } = await pl.from("jobs").select("id, quote_id, receita, instalador, data_conclusao").gte("data_conclusao", desdeIso.slice(0, 10)).order("data_conclusao", { ascending: true });
  if (e3) console.log("ERRO jobs:", e3.message);
  const qids = [...new Set((jobs ?? []).map((j) => j.quote_id).filter(Boolean))];
  const qb = {};
  for (let i = 0; i < qids.length; i += 150) {
    const { data, error } = await pl.from("quotes").select("id, nome_cliente, telefone, status").in("id", qids.slice(i, i + 150));
    if (error) console.log("ERRO quotes:", error.message);
    for (const q of data ?? []) qb[q.id] = q;
  }
  let com = 0, sem = 0, semTel = 0;
  console.log(`\n═══ 3. COBERTURA: obras CONCLUÍDAS na plataforma nos últimos ${DIAS} dias: ${(jobs ?? []).length}`);
  for (const j of jobs ?? []) {
    const q = qb[j.quote_id];
    const t = tel10(q?.telefone);
    if (!t) { semTel++; console.log(`  ${j.data_conclusao} ${(q?.nome_cliente ?? "?").padEnd(26)} SEM TELEFONE no quote`); continue; }
    const av = avisosTodosPorTel[t] ?? [];
    if (av.length) com++; else sem++;
    console.log(`  ${j.data_conclusao} ${(q?.nome_cliente ?? "?").padEnd(26)} tel=${t} $${j.receita} inst=${j.instalador ?? "-"} | aviso: ${av.length ? av.join(", ") : "NENHUM ← Lovable não chamou o agente para este telefone"}`);
  }
  console.log(`  com aviso: ${com} | SEM aviso: ${sem} | sem telefone: ${semTel}`);
}
console.log("");
