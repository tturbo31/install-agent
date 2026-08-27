// Relatório das decisões de rota persistidas (platform_settings: route|...)
// cruzadas com os bookings reais da agenda. Uso: node scripts/rotas-relatorio.mjs [dias=7]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const sched = createClient(
  "https://wtyezgfzzetfrhoaqemt.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4",
  { auth: { persistSession: false } }
);
await sched.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });

const days = Number(process.argv[2] ?? 7);
const since = new Date(Date.now() - days * 86400000).toISOString();
const { data: rows, error } = await app.from("platform_settings").select("platform").like("platform", "route|%");
if (error) { console.error("erro:", error.message); process.exit(1); }
const decisions = (rows ?? [])
  .map((r) => {
    const [, kind, igsid, when, seller, score, tier, provider, zip, ts] = r.platform.split("|");
    return { kind, igsid, when, seller, score, tier, provider, zip, ts };
  })
  .filter((d) => d.ts && d.ts >= since)
  .sort((a, b) => a.ts.localeCompare(b.ts));

console.log(`\nDecisões de rota (últimos ${days} dias): ${decisions.length}`);
const byTier = {};
const bySeller = {};
for (const d of decisions) {
  byTier[d.tier] = (byTier[d.tier] ?? 0) + 1;
  bySeller[d.seller] = (bySeller[d.seller] ?? 0) + 1;
  console.log(`  ${d.ts.slice(0, 16)} ${d.kind.padEnd(10)} ${d.when.padEnd(17)} ${String(d.seller).padEnd(10)} score=${String(d.score).padEnd(4)} ${String(d.tier).padEnd(10)} via=${d.provider.padEnd(8)} zip=${d.zip} ${d.igsid}`);
}
console.log("\nPor faixa:", JSON.stringify(byTier));
console.log("Por vendedor:", JSON.stringify(bySeller));

// Cruzamento: bookings do agente no período, por vendedor, com endereço.
const from = since.slice(0, 10);
const { data: books } = await sched
  .from("bookings")
  .select("booking_date,booking_time,seller_id,address,created_at,scheduled_by")
  .gte("created_at", since)
  .order("booking_date")
  .order("booking_time");
const { data: sellers } = await sched.from("sellers").select("id,name");
const name = (id) => sellers?.find((s) => s.id === id)?.name ?? String(id).slice(0, 8);
console.log(`\nBookings criados desde ${from}: ${(books ?? []).length}`);
let lastDay = "";
for (const b of books ?? []) {
  if (b.booking_date !== lastDay) { console.log(`\n  ${b.booking_date}`); lastDay = b.booking_date; }
  const zip = String(b.address ?? "").match(/\b3[34]\d{3}\b/)?.[0] ?? "?";
  console.log(`    ${b.booking_time.slice(0, 5)} ${name(b.seller_id).padEnd(10)} zip=${zip} ${String(b.address ?? "").slice(0, 50)}`);
}
