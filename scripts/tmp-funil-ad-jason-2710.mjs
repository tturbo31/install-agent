// SÓ LEITURA (27/10/2026): dados de anúncio do funil (platform_settings.platform) para a conversa do Jason + nomes de anúncios recentes.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const convId = "1ac24a2f-13e6-4b9e-a023-fbec9b68841d";
const { data: rows, error } = await app.from("platform_settings").select("*").like("platform", `funil_ad%${convId}%`);
console.log("JASON funil_ad* rows:", error ?? (rows ?? []).map((r) => JSON.stringify(r).slice(0, 900)));
const { data: all } = await app.from("platform_settings").select("platform").like("platform", "funil_ad_%").limit(3000);
const freq = new Map();
for (const r of all ?? []) {
  const [, rawId, rawTitle] = r.platform.slice("funil_ad_".length).split("::");
  const k = `${rawId ?? ""} :: ${rawTitle ? decodeURIComponent(rawTitle) : ""}`; freq.set(k, (freq.get(k) ?? 0) + 1);
}
console.log(`\nAD NAMES em funil_ad_ (${(all ?? []).length} linhas):`);
for (const [k, n] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${n}x  ${k.slice(0, 200)}`);
const { data: adx } = await app.from("platform_settings").select("platform").like("platform", "funil_adx_%").limit(5);
console.log("\nEXEMPLO funil_adx_:", (adx ?? []).map((r) => r.platform.slice(0, 500)));
