// Retrata no historico o aviso de vespera enviado por engano a Dayana (22/10/2026):
// a linha ganha o prefixo [RETRATADO ...] e deixa de valer como etapa de
// instalacao / duplicidade / contexto do cerebro. O texto original e preservado.
//   node scripts/tmp-retratar-dayana-2210.mjs            -> mostra o que faria
//   node scripts/tmp-retratar-dayana-2210.mjs --aplicar
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
const env = {}; for (const l of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const ag = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TEL = "17868770477";
const { data: conv } = await ag.from("instagram_conversations").select("id, mode").eq("igsid", `wa_${TEL}`).maybeSingle();
if (!conv) { console.log("conversa nao encontrada"); process.exit(1); }
const { data: rows } = await ag.from("instagram_messages").select("id, role, content, created_at").eq("conversation_id", conv.id).eq("role", "assistant").gte("created_at", "2026-10-22T00:00:00Z").ilike("content", "%installation starts tomorrow%");
console.log("conversa", conv.id, "mode", conv.mode, "| avisos de hoje:", rows?.length ?? 0);
for (const r of rows ?? []) {
  if (/^\s*\[RETRATADO/.test(r.content)) { console.log("  ja retratado:", r.id); continue; }
  const novo = `[RETRATADO 22/10/2026: aviso de instalacao enviado por engano - cliente sem obra marcada (job ja constava concluido em 20/10); a cliente respondeu "wrong number"] ${r.content}`;
  console.log("  ", r.created_at, r.id, "\n   ->", novo.slice(0, 200));
  if (process.argv.includes("--aplicar")) {
    const { error } = await ag.from("instagram_messages").update({ content: novo }).eq("id", r.id);
    console.log(error ? "   ERRO: " + error.message : "   aplicado");
  }
}
