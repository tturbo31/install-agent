// SÓ LEITURA (27/10/2026): criativo + page_welcome_message do anúncio de origem (Graph API).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await app.from("platform_settings").select("platform").like("platform", "adstok|%");
const rows = (data ?? []).map((r) => r.platform.split("|")).filter((p) => p[1] && p[2]).sort((a, b) => b[1].localeCompare(a[1]));
const token = rows[0]?.[2] ?? env.META_ADS_TOKEN;
console.log("token source:", rows[0] ? `db (set ${rows[0][1]})` : "env");
const adIds = process.argv.slice(2);
for (const adId of adIds) {
  const fields = "name,effective_status,creative{name,title,body,image_url,thumbnail_url,link_url,object_story_spec,asset_feed_spec}";
  const res = await fetch(`https://graph.facebook.com/v24.0/${adId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`);
  const j = await res.json();
  if (j.error) { console.log(adId, "ERR", JSON.stringify(j.error).slice(0, 300)); continue; }
  const c = j.creative ?? {};
  const oss = c.object_story_spec ?? {};
  const link = oss.link_data ?? oss.video_data ?? oss.template_data ?? {};
  const afs = c.asset_feed_spec ?? {};
  console.log(`\n=== ${adId} ${j.name} (${j.effective_status}) ===`);
  console.log("creative.name:", c.name); console.log("title:", c.title); console.log("body:", c.body);
  console.log("link.message:", link.message); console.log("link.name:", link.name); console.log("link.description:", link.description);
  console.log("afs.titles:", JSON.stringify(afs.titles ?? null).slice(0, 400)); console.log("afs.bodies:", JSON.stringify(afs.bodies ?? null).slice(0, 600));
  const pwmRaw = link.page_welcome_message ?? afs.additional_data?.page_welcome_message;
  console.log("page_welcome_message raw:", typeof pwmRaw === "string" ? pwmRaw.slice(0, 900) : JSON.stringify(pwmRaw ?? null).slice(0, 900));
  console.log("oss keys:", Object.keys(oss).join(","), "| link keys:", Object.keys(link).join(","));
}
