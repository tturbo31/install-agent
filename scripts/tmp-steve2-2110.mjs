// SÓ LEITURA (21/10/2026): nome do vendedor da visita de Windermere + learnings que falem de Orlando/Windermere/área.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8");
const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const sched = createClient("https://wtyezgfzzetfrhoaqemt.supabase.co", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4", { auth: { persistSession: false } });
await sched.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });
const { data: sellers } = await sched.from("sellers").select("id,name").eq("id", "35f950e6-c1dd-4742-b77f-5071dbc3508b");
console.log("vendedor da visita:", JSON.stringify(sellers));
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: ps } = await app.from("platform_settings").select("*");
for (const p of ps ?? []) {
  const txt = JSON.stringify(p);
  const hits = txt.match(/[^.\n]{0,160}(?:Windermere|Orlando|Central Florida|34786|starts? with 34|Kissimmee|Clermont)[^.\n]{0,160}/gi);
  if (hits) { console.log(`\n--- platform_settings ${p.key ?? p.id} ---`); for (const h of hits.slice(0, 10)) console.log("  •", h.replace(/\n/g, " ")); }
}
// bookings fora da área (ZIP não 330-334) nos últimos 60 dias criados pela IA
const desde = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
const { data: books } = await sched.from("bookings").select("id,address,booking_date,booking_time,created_at,email,cancelled_at").gte("created_at", desde).like("email", "ia-%");
const out = (books ?? []).filter(b => { const m = String(b.address ?? "").match(/\b(\d{5})(?:-\d{4})?\s*$/) || String(b.address ?? "").match(/\b(3\d{4})\b(?!.*\b3\d{4}\b)/); const z = m?.[1]; return z && !/^33[0-4]\d\d$/.test(z); });
console.log(`\nbookings da IA (60d): ${(books ?? []).length}; com ZIP fora de 330-334: ${out.length}`);
for (const b of out) console.log("  •", b.booking_date, b.booking_time, "|", b.address, "| cancelado:", b.cancelled_at ?? "não", "|", b.email);
