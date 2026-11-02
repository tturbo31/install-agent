// SÓ LEITURA: mids das últimas bolhas dos candidatos + rastro lostreply-result|
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const env = {}; for (const l of readFileSync(".env.local","utf-8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const ids = ["fb_28627844636843945","fb_39744886518491771","fb_29041074258868193","1460216699322947","4248873928731775","1077270032008368","1596331535132399","1917845309179701","1128667816279672","4416361431959997","1686939692999286","2927595040951684","2193150358244926","1140970348511730","1533026522206190","1098203949876734","1664687045160203","1393174615935876","1147861254348191","1058440480557320","3361106207581491"];
const { data: convs } = await app.from("instagram_conversations").select("id,igsid,name,username,mode,booking_confirmed").in("igsid", ids);
const out = [];
for (const c of convs) {
  const { data: msgs } = await app.from("instagram_messages").select("id,role,content,created_at,instagram_msg_id").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(3);
  const newest = msgs?.[0];
  const { data: met } = await app.from("conversation_metrics").select("total_turns,last_updated").eq("conversation_id", c.id).maybeSingle();
  const { data: lr } = await app.from("platform_settings").select("platform").like("platform", `lostreply-result|${newest?.id}%`);
  out.push({ igsid: c.igsid, conv: c.id, name: c.name || c.username, mode: c.mode, booked: c.booking_confirmed, newest_at: newest?.created_at, newest_role: newest?.role, mid: newest?.instagram_msg_id, text: (newest?.content||"").split("\n\n[SYSTEM:")[0].slice(0,60), total_turns: met?.total_turns, lost: (lr||[]).map(r=>r.platform).join(";") });
}
for (const o of out.sort((a,b)=>String(a.newest_at).localeCompare(String(b.newest_at)))) console.log(JSON.stringify(o));
const { data: lrAll } = await app.from("platform_settings").select("platform").like("platform", "lostreply-result|%").order("platform").limit(400);
console.log("lostreply-result rows:", (lrAll||[]).length);
for (const r of (lrAll||[]).slice(-25)) console.log("  ", r.platform);
