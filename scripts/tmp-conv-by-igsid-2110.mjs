// SÓ LEITURA (21/10/2026): imprime a conversa de um igsid. uso: node scripts/tmp-conv-by-igsid-2110.mjs <igsid>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const igsid = process.argv[2];
const { data: conv } = await app.from("instagram_conversations").select("id,igsid,name,mode,booking_confirmed,created_at").eq("igsid", igsid).single();
console.log("CONV:", JSON.stringify(conv));
const { data: msgs } = await app.from("instagram_messages").select("role,content,created_at").eq("conversation_id", conv.id).order("created_at", { ascending: true });
for (const m of msgs ?? []) {
  const et = new Date(m.created_at).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  console.log(`[${et} ET] ${m.role.toUpperCase()}: ${String(m.content).replace(/\n/g, " ⏎ ").slice(0, 400)}`);
}
