// SÓ LEITURA (27/10/2026): todos os anúncios ATIVOS da conta: corpo + saudação (page_welcome_message), p/ saber quais preços o cliente vê.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data } = await app.from("platform_settings").select("platform").like("platform", "adstok|%");
const rows = (data ?? []).map((r) => r.platform.split("|")).filter((p) => p[1] && p[2]).sort((a, b) => b[1].localeCompare(a[1]));
const token = rows[0]?.[2] ?? env.META_ADS_TOKEN;
const G = "https://graph.facebook.com/v24.0";
const acc = await (await fetch(`${G}/120251004555670443?fields=account_id&access_token=${encodeURIComponent(token)}`)).json();
console.log("account:", acc.account_id);
let url = `${G}/act_${acc.account_id}/ads?fields=id,name,effective_status,creative{title,body,object_story_spec}&limit=100&access_token=${encodeURIComponent(token)}`;
const seen = new Map();
let total = 0, active = 0;
for (let p = 0; p < 8 && url; p++) {
  const j = await (await fetch(url)).json();
  if (j.error) { console.log("ERR", JSON.stringify(j.error).slice(0, 300)); break; }
  for (const a of j.data ?? []) {
    total++;
    if (a.effective_status !== "ACTIVE") continue;
    active++;
    const oss = a.creative?.object_story_spec ?? {};
    const link = oss.video_data ?? oss.link_data ?? oss.template_data ?? {};
    let greet = "";
    try { greet = JSON.parse(link.page_welcome_message ?? "{}")?.text_format?.message?.text ?? ""; } catch {}
    const body = (a.creative?.body ?? link.message ?? "").replace(/\s+/g, " ");
    const k = `BODY: ${body} || GREETING: ${greet} || TITLE: ${a.creative?.title ?? ""}`;
    seen.set(k, [...(seen.get(k) ?? []), a.name]);
  }
  url = j.paging?.next ?? null;
}
console.log(`ads total ${total}, active ${active}\n`);
for (const [k, names] of seen) console.log(`${names.length}x ${names.slice(0, 4).join(" | ")}\n   ${k}\n`);
// impacto: quantas vezes a enlatada ASK_TYPE saiu nos últimos 14 dias
const since = new Date(Date.now() - 14 * 86400e3).toISOString();
const { count } = await app.from("instagram_messages").select("id", { count: "exact", head: true }).eq("role", "assistant").gte("created_at", since).like("content", "Hi, our vinyl promo includes the floor, the installation and the quarter round%");
console.log("ASK_TYPE enlatada enviada nos últimos 14d:", count);
