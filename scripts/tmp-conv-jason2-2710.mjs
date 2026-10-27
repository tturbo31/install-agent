// SÓ LEITURA (27/10/2026): acha a conversa pelo texto "775 SF over plywood" e lista conversas FB recentes com ad_id.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: hits, error } = await app.from("instagram_messages").select("conversation_id,role,content,created_at").ilike("content", "%775 SF%").order("created_at", { ascending: false }).limit(5);
if (error) { console.log("ERR", error); process.exit(1); }
console.log("HITS:", (hits ?? []).length);
for (const h of hits ?? []) {
  const { data: c } = await app.from("instagram_conversations").select("*").eq("id", h.conversation_id).single();
  console.log("\nCOLUMNS:", Object.keys(c).join(","));
  const slim = Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && !/^(memory|summary|learn|notes|last_)/.test(k)));
  console.log("CONV:", JSON.stringify(slim).slice(0, 1500));
  const { data: msgs } = await app.from("instagram_messages").select("role,content,created_at").eq("conversation_id", c.id).order("created_at", { ascending: true });
  for (const m of msgs ?? []) {
    const et = new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log(`[${et} ET] ${m.role.toUpperCase()}: ${String(m.content).replace(/\n/g, " ⏎ ").slice(0, 700)}`);
  }
}
// Conversas FB dos últimos 10 dias: quantas têm ad_id / ad_title / creative_url
const since = new Date(Date.now() - 10 * 86400e3).toISOString();
const { data: fb } = await app.from("instagram_conversations").select("igsid,name,ad_id,ad_title,creative_url,created_at").like("igsid", "fb_%").gte("created_at", since).order("created_at", { ascending: false }).limit(60);
console.log("\nFB convs 10d:", (fb ?? []).length, "with ad_id:", (fb ?? []).filter((c) => c.ad_id).length, "with ad_title:", (fb ?? []).filter((c) => c.ad_title).length, "with creative_url:", (fb ?? []).filter((c) => c.creative_url).length);
for (const c of (fb ?? []).slice(0, 25)) console.log(`${c.created_at.slice(0, 16)} ${c.igsid} ${c.name ?? ""} | ad_id=${c.ad_id ?? "-"} | ad_title=${(c.ad_title ?? "-").slice(0, 80)} | creative=${c.creative_url ? "yes" : "-"}`);
