// SÓ LEITURA (28/10/2026): conversa do Jesus Rivera ("1500 S/F??? in Port St Lucie") e outros leads de Port St. Lucie.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: hits, error } = await app.from("instagram_messages").select("conversation_id,role,content,created_at").ilike("content", "%Port St%").order("created_at", { ascending: false }).limit(60);
if (error) { console.log("ERR", error); process.exit(1); }
const ids = [...new Set((hits ?? []).map((h) => h.conversation_id))];
console.log("CONVS mentioning Port St:", ids.length);
for (const id of ids.slice(0, 12)) {
  const { data: c, error: ce } = await app.from("instagram_conversations").select("*").eq("id", id).single();
  console.log(`\n### ${c.igsid} ${c.name ?? c.username ?? ""} mode=${c.mode ?? c.ai_mode ?? c.status} created=${c.created_at}`);
  const { data: msgs } = await app.from("instagram_messages").select("role,content,created_at").eq("conversation_id", c.id).order("created_at", { ascending: true });
  for (const m of (msgs ?? []).slice(-14)) {
    const et = new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
    console.log(`[${et} ET] ${m.role.toUpperCase()}: ${String(m.content).replace(/\n/g, " ⏎ ").slice(0, 400)}`);
  }
}
