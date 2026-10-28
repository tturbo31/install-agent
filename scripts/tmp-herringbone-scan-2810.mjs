// READ-ONLY (28/10/2026): structured [Treino] corrections mentioning herringbone
// + the real history of fb_28151851617823353 (the client who got the wrong price).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const since = new Date(Date.now() - 30 * 86400e3).toISOString();
const { data: treino, error: e1 } = await sb.from("instagram_messages").select("id,conversation_id,content,created_at").like("content", "[Treino]%").gte("created_at", since).limit(2000);
if (e1) console.error("treino error", e1);
const hits = (treino ?? []).filter((r) => /herring|harring|hearing bone|7\.50|11\.50|espiga|espinha/i.test(r.content));
console.log(`[Treino] rows last 30d: ${(treino ?? []).length}; herringbone-related: ${hits.length}`);
for (const h of hits) console.log(`  ${h.created_at} conv=${h.conversation_id}: ${h.content.replace(/\s+/g, " ").slice(0, 400)}`);
const { data: conv, error: e2 } = await sb.from("instagram_conversations").select("id,sender_id,mode,platform,created_at").eq("sender_id", "fb_28151851617823353").limit(3);
if (e2) console.error("conv error", e2);
console.log("conversations:", JSON.stringify(conv));
for (const c of conv ?? []) {
  const { data: msgs } = await sb.from("instagram_messages").select("role,content,created_at").eq("conversation_id", c.id).order("created_at", { ascending: true }).limit(50);
  for (const m of msgs ?? []) console.log(`  [${m.created_at}] ${m.role}: ${String(m.content).replace(/\s+/g, " ").slice(0, 500)}`);
}
