// SÓ LEITURA (26/10/2026): conversa WA +1 773 899-5511 — por que não ofereceu horários após o ZIP.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: convs, error } = await app.from("instagram_conversations").select("*").ilike("igsid", "%7738995511%");
if (error) { console.error("ERR", error.message); process.exit(1); }
console.log("convs:", convs.length);
for (const c of convs) {
  console.log(JSON.stringify(c, null, 1));
  const { data: msgs } = await app.from("instagram_messages").select("*").eq("conversation_id", c.id).order("created_at", { ascending: true });
  for (const m of msgs ?? []) console.log(`\n[${m.created_at}] ${m.role} (${m.id}):\n${m.content}`);
  writeFileSync("dump-conv-7738995511-2610.json", JSON.stringify({ conv: c, msgs }, null, 1));
}
