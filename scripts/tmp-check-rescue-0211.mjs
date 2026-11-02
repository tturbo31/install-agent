// SÓ LEITURA: confere se o replay gerou resposta (linha assistant depois da última msg do cliente)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {}; for (const l of readFileSync(".env.local","utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const ids = process.argv.slice(2);
const et = iso => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
for (let round = 1; round <= 6; round++) {
  let pending = 0; const lines = [];
  for (const igsid of ids) {
    const { data: c } = await app.from("instagram_conversations").select("id,name,username,mode,booking_confirmed").eq("igsid", igsid).maybeSingle();
    const { data: msgs } = await app.from("instagram_messages").select("role,content,created_at").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(2);
    const last = msgs?.[0];
    const ok = last?.role === "assistant";
    if (!ok) pending++;
    lines.push(`${ok ? "✅" : "⏳"} ${igsid} (${c.name || c.username || ""}) ${last ? et(last.created_at) + " " + (last.role === "user" ? "C" : "B") + ": " + last.content.replace(/\s+/g, " ").slice(0, 150) : ""}`);
  }
  console.log(`--- rodada ${round} (${pending} pendentes)`); for (const l of lines) console.log(l);
  if (!pending || round === 6) break;
  await new Promise(r => setTimeout(r, 25000));
}
