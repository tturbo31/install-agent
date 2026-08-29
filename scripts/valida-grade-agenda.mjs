// Confere se a disponibilidade que o agente oferece bate com a regra REAL da
// Ozzi Plataforma — SEM ESCREVER NADA na agenda.
//
// NUNCA valide isso com insert+delete de visita de teste. Em 29/08/2026 eu criei
// e apaguei 84 visitas de sonda para descobrir a regra do trigger; a equipe viu
// aquilo como uma enxurrada de agendamentos aparecendo e sendo cancelados e
// achou que era um bug em producao. A regra do trigger ja e conhecida e esta
// reproduzida aqui a partir das MESMAS colunas que ele le:
//
//   1. sellers.active
//   2. sellers.enabled_weekdays contem o dia da semana
//      ("Vendedor nao atende neste dia da semana", P0001)
//   3. o horario esta na grade DAQUELE dia:
//      sellers.weekday_time_slots["<dia>"] quando existe, senao sellers.time_slots
//      ("Horario HH:MM indisponivel para este vendedor neste dia", P0001)
//   4. seller_days_off nao tem (vendedor, dia)  (23514)
//   5. o vendedor nao tem outra visita no mesmo dia+horario
//
// Uso: node scripts/valida-grade-agenda.mjs [dias]   (padrao 14)
import { createClient } from "@supabase/supabase-js";

const URL = "https://wtyezgfzzetfrhoaqemt.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4";

const DIAS = Number(process.argv[2] ?? 14);
const DIA_NOME = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const { error: authErr } = await db.auth.signInWithPassword({ email: "ia@ozzifloors.com", password: "OzziIA2026!" });
if (authErr) { console.error("auth falhou:", authErr.message); process.exit(1); }

const hoje = new Date().toISOString().slice(0, 10);
const datas = Array.from({ length: DIAS }, (_, i) => new Date(Date.parse(hoje + "T12:00:00Z") + i * 86400000).toISOString().slice(0, 10));

const [{ data: sellers }, { data: booked }, { data: off }] = await Promise.all([
  db.from("sellers").select("id,name,priority,active,enabled_weekdays,time_slots,weekday_time_slots").eq("active", true).order("priority"),
  db.rpc("get_booked_slots", { _from: datas[0], _to: datas[datas.length - 1] }),
  db.from("seller_days_off").select("seller_id,day").gte("day", datas[0]).lte("day", datas[datas.length - 1]),
]);

const ocupado = new Set((booked ?? []).map((b) => `${b.seller_id}|${b.booking_date}|${String(b.booking_time).slice(0, 5)}`));
const folga = new Set((off ?? []).map((o) => `${o.seller_id}|${o.day}`));

// a grade do dia: o override por dia da semana SUBSTITUI a grade padrao
const gradeDoDia = (s, wd) => {
  const o = s.weekday_time_slots?.[String(wd)];
  return (Array.isArray(o) ? o : s.time_slots ?? []).map((t) => String(t).slice(0, 5));
};

let fantasma = 0, total = 0;
for (const data of datas) {
  const wd = new Date(data + "T12:00:00").getDay();
  const abertos = new Set();
  const foraDaGrade = [];
  for (const s of sellers ?? []) {
    if (!s.enabled_weekdays.includes(wd) || folga.has(`${s.id}|${data}`)) continue;
    for (const slot of gradeDoDia(s, wd)) {
      if (!ocupado.has(`${s.id}|${data}|${slot}`)) abertos.add(slot);
    }
    // horario da grade PADRAO que o dia nao tem: e exatamente o que virava
    // horario fantasma antes do fix de 28/08 (caso Chanju / Gilberto)
    for (const slot of (s.time_slots ?? []).map((t) => String(t).slice(0, 5))) {
      if (!gradeDoDia(s, wd).includes(slot)) foraDaGrade.push(`${s.name} ${slot}`);
    }
  }
  total += abertos.size;
  const oferecidos = [...abertos].sort();
  const risco = oferecidos.filter((slot) => (sellers ?? []).every((s) => !s.enabled_weekdays.includes(wd) || !gradeDoDia(s, wd).includes(slot)));
  fantasma += risco.length;
  const nota = foraDaGrade.length ? `   [grade propria do dia: ${foraDaGrade.join(", ")} nao valem hoje]` : "";
  console.log(`${data} ${DIA_NOME[wd]} -> ${oferecidos.join(", ") || "(nada)"}${risco.length ? "  ❌ FANTASMA: " + risco.join(", ") : ""}${nota}`);
}

console.log(`\n${DIAS} dias | ${total} horarios ofertaveis | ${fantasma} fantasma`);
process.exit(fantasma > 0 ? 1 : 0);
