// Dump das conversas dos últimos 2 dias dos 3 canais (SÓ LEITURA). 29/09/2026.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const dias = Number(process.env.DIAS || 2);
const desde = process.env.DESDE || new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();

let msgs = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await app
    .from("instagram_messages").select("*")
    .gte("created_at", desde).order("created_at", { ascending: true })
    .range(from, from + 999);
  if (error) { console.error("ERR msgs:", error.message); process.exit(1); }
  msgs = msgs.concat(data ?? []);
  if (!data || data.length < 1000) break;
}

const convIds = [...new Set(msgs.map((m) => m.conversation_id))];
let convs = [];
for (let i = 0; i < convIds.length; i += 100) {
  const { data, error } = await app.from("instagram_conversations").select("*").in("id", convIds.slice(i, i + 100));
  if (error) { console.error("ERR convs:", error.message); process.exit(1); }
  convs = convs.concat(data ?? []);
}

let full = [];
for (let i = 0; i < convIds.length; i += 40) {
  for (let from = 0; ; from += 1000) {
    const { data, error } = await app.from("instagram_messages")
      .select("conversation_id,role,content,created_at,id")
      .in("conversation_id", convIds.slice(i, i + 40))
      .order("created_at", { ascending: true }).range(from, from + 999);
    if (error) { console.error("ERR full:", error.message); process.exit(1); }
    full = full.concat(data ?? []);
    if (!data || data.length < 1000) break;
  }
}

// platform_settings: rastro (booktrail|, sendfail|, adstok etc.)
const { data: ps } = await app.from("platform_settings").select("*");

const out = { dumpedAt: new Date().toISOString(), desde, nMsgs: msgs.length, nConvs: convs.length, convs, msgs, full, platform_settings: ps ?? [] };
const file = process.env.OUT || "dump-2d-2909.json";
writeFileSync(file, JSON.stringify(out));
console.log(`OK: ${msgs.length} msgs (janela) / ${full.length} msgs (histórico) em ${convIds.length} conversas → ${file}`);
const porCanal = {};
const ch = x => String(x).startsWith("wa_") ? "WA" : String(x).startsWith("fb_") ? "FB" : "IG";
for (const c of convs) porCanal[ch(c.igsid)] = (porCanal[ch(c.igsid)] ?? 0) + 1;
console.log("conversas por canal:", JSON.stringify(porCanal));
