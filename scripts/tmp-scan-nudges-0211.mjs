// SÓ LEITURA: nudges de follow-up dos últimos 14 dias (02/11/2026).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const desde = new Date(Date.now() - 14 * 864e5).toISOString();
let rows = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await app.from("instagram_messages").select("conversation_id, content, created_at")
    .eq("role", "assistant").gte("created_at", desde).ilike("content", "%FOLLOWUP_NUDGE%")
    .order("created_at", { ascending: true }).range(from, from + 999);
  if (error) { console.error(error.message); process.exit(1); }
  rows = rows.concat(data ?? []);
  if (!data || data.length < 1000) break;
}
const ids = [...new Set(rows.map((r) => r.conversation_id))];
const conv = new Map();
for (let i = 0; i < ids.length; i += 100) {
  const { data } = await app.from("instagram_conversations").select("id, igsid").in("id", ids.slice(i, i + 100));
  for (const c of data ?? []) conv.set(c.id, c.igsid);
}
// respostas do cliente depois do nudge
let replied = 0;
for (const r of rows) {
  const { data } = await app.from("instagram_messages").select("content, created_at").eq("conversation_id", r.conversation_id).eq("role", "user").gt("created_at", r.created_at).order("created_at").limit(1);
  const rep = data?.[0]?.content?.split(/\n\n?\[SYSTEM:/)[0]?.slice(0, 80) ?? "";
  if (rep) replied++;
  console.log(r.created_at.slice(0, 16), (conv.get(r.conversation_id) || "").slice(0, 3), "|", r.content.split("\n\n[SYSTEM")[0], rep ? "  → CLIENTE: " + rep : "");
}
console.log(`\ntotal=${rows.length} responderam=${replied} financ=${rows.filter((r) => /financ/i.test(r.content)).length}`);
