import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const envRaw = readFileSync(".env.local", "utf-8"); const env = {};
for (const line of envRaw.split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
const app = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const sched = createClient("https://wtyezgfzzetfrhoaqemt.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4",
  { auth: { persistSession: false } });
await sched.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });
const et = (iso) => new Date(new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" }));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const since = new Date(Date.now() - 4*24*3600e3).toISOString();
const { data: books, error } = await sched.from("bookings").select("id,name,email,seller_id,booking_date,booking_time,address,created_at,scheduled_by,notes").gte("created_at", since).order("created_at", { ascending: true });
if (error) console.log("ERR", error);
const { data: sellers } = await sched.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,active");
const sname = Object.fromEntries((sellers??[]).map(s=>[s.id,s.name]));
console.log("SELLERS:", (sellers??[]).map(s=>`${s.name}(p${s.priority},${s.active?'on':'off'}) slots=${s.time_slots.join('/')} wd=${s.enabled_weekdays.join('')}`).join("\n  "));
console.log(`\nBOOKINGS criados desde ${since.slice(0,10)} (${books?.length}):`);
let gaps = {};
for (const b of books ?? []) {
  const c = et(b.created_at); const cStr = ymd(c);
  const diff = Math.round((new Date(b.booking_date+"T12:00:00") - new Date(cStr+"T12:00:00"))/864e5);
  gaps[diff] = (gaps[diff]||0)+1;
  const ia = String(b.email||"").startsWith("ia-");
  console.log(`${ia?'IA ':'HUM'} criado ${cStr} ${pad(c.getHours())}:${pad(c.getMinutes())} → visita ${b.booking_date} ${b.booking_time} (+${diff}d) ${sname[b.seller_id]??'?'} | ${b.name} | ${String(b.address).slice(0,40)}`);
}
console.log("\nDIST +dias:", gaps);
// ocupação hoje / amanhã / depois
const today = ymd(et(new Date().toISOString()));
const days = [0,1,2,3].map(i=>{const d=new Date(today+"T12:00:00"); d.setDate(d.getDate()+i); return ymd(d);});
const { data: all } = await sched.from("bookings").select("seller_id,booking_date,booking_time").gte("booking_date", days[0]).lte("booking_date", days[3]);
const { data: off } = await sched.from("seller_days_off").select("seller_id,day_off").gte("day_off", days[0]).lte("day_off", days[3]);
for (const d of days) {
  const wd = new Date(d+"T12:00:00").getDay();
  const line = [];
  for (const s of sellers??[]) {
    if (!s.active || !s.enabled_weekdays.includes(wd) || (off??[]).some(o=>o.seller_id===s.id&&o.day_off===d)) { line.push(`${s.name}: folga/off`); continue; }
    const taken = (all??[]).filter(b=>b.seller_id===s.id&&b.booking_date===d).map(b=>b.booking_time.slice(0,5));
    const free = s.time_slots.filter(t=>!taken.includes(t.slice(0,5)));
    line.push(`${s.name}: ${taken.length}/${s.time_slots.length} ocupados, livres=${free.join(',')||'-'}`);
  }
  console.log(`\n${d} (wd${wd}):\n  ${line.join("\n  ")}`);
}
// rastros route|book
const { data: logs } = await app.from("platform_settings").select("platform").like("platform", "route|%").order("platform");
console.log(`\nROUTE LOGS (${logs?.length}):`); for (const l of (logs??[]).slice(-40)) console.log("  "+l.platform);
