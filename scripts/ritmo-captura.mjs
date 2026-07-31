// RITMO DA CAPTURA POR CANAL E POR HORA (31/07/2026)
//
// Duas perguntas que o teto fixo de 12h não responde:
//   1) o silêncio de AGORA é normal para ESTA hora deste canal, ou é anomalia?
//   2) qual teto de silêncio faz sentido por canal e por faixa horária?
//
// Fonte: a caixa-preta (funil_raw_<canal>_<epochMs>_…), retenção de 7 dias.
// Fuso de referência America/New_York (a Flórida segue o mesmo).
//
// Uso: node --env-file=.env.local scripts/ritmo-captura.mjs [marcoISO]
//      marcoISO = instante a partir do qual medir o silêncio atual
//                 (padrão: a assinatura do messaging_referral, 31/07 22:56Z)
import { createClient } from "@supabase/supabase-js";

const ag = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MARCO = Date.parse(process.argv[2] ?? "2026-07-31T22:56:27Z");
const AGORA = Date.now();

// Faixa diurna x noturna na Flórida. O corte em 8h/22h não é arbitrário: é a
// janela em que o próprio sistema aceita mandar mensagem comercial (8h-20h59)
// mais a cauda de quem responde à noite.
const DIURNO_INICIO = 8;
const DIURNO_FIM = 22;
const horaNY = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ms)));
const faixaDe = (ms) => {
  const h = horaNY(ms);
  return h >= DIURNO_INICIO && h < DIURNO_FIM ? "diurno" : "noturno";
};

async function paginar(like) {
  const out = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await ag
      .from("platform_settings").select("platform").like("platform", like)
      .order("platform", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []).map((r) => r.platform));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// um POST = um grupo de chunks (canal, epoch, rand)
const eventos = { ig: [], fb: [], wa: [] };
const vistos = new Set();
for (const k of await paginar("funil_raw_%")) {
  const m = k.match(/^funil_raw_(ig|fb|wa)_(\d{10,})_([a-z0-9]{4})_/);
  if (!m) continue;
  const chave = `${m[1]}_${m[2]}_${m[3]}`;
  if (vistos.has(chave)) continue;
  vistos.add(chave);
  eventos[m[1]].push(Number(m[2]));
}
for (const c of Object.keys(eventos)) eventos[c].sort((a, b) => a - b);

const mediana = (arr) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 ? s[meio] : (s[meio - 1] + s[meio]) / 2;
};
const percentil = (arr, p) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`\n═══ RITMO DA CAPTURA — janela da caixa-preta (retenção 7d) ═══`);
console.log(`agora: ${new Date(AGORA).toISOString()} (${horaNY(AGORA)}h na Flórida, faixa ${faixaDe(AGORA)})\n`);

const resumo = {};
for (const canal of ["ig", "fb", "wa"]) {
  const ev = eventos[canal];
  console.log(`── ${canal.toUpperCase()}: ${ev.length} webhooks capturados`);
  if (ev.length === 0) { console.log("   (nada na janela)\n"); continue; }
  const primeiro = ev[0], ultimo = ev[ev.length - 1];
  const horasJanela = (ultimo - primeiro) / 3600e3;
  console.log(`   de ${new Date(primeiro).toISOString()} a ${new Date(ultimo).toISOString()} (${horasJanela.toFixed(1)}h)`);
  console.log(`   média: ${(ev.length / horasJanela).toFixed(1)} webhooks/hora`);

  // intervalos entre capturas consecutivas, separados pela faixa em que o
  // intervalo COMEÇOU (é a faixa que determina se aquele silêncio é esperado)
  const gaps = { diurno: [], noturno: [] };
  for (let i = 1; i < ev.length; i++) {
    const dt = (ev[i] - ev[i - 1]) / 60000; // minutos
    gaps[faixaDe(ev[i - 1])].push(dt);
  }
  resumo[canal] = {};
  for (const faixa of ["diurno", "noturno"]) {
    const g = gaps[faixa];
    const med = mediana(g), p90 = percentil(g, 90), p99 = percentil(g, 99);
    const maior = g.length ? Math.max(...g) : null;
    resumo[canal][faixa] = { n: g.length, medianaMin: med, p90, p99, maiorMin: maior };
    console.log(
      `   ${faixa.padEnd(8)} n=${String(g.length).padStart(4)} · mediana ${med === null ? "-" : med.toFixed(1) + "min"}` +
      ` · p90 ${p90 === null ? "-" : p90.toFixed(0) + "min"} · p99 ${p99 === null ? "-" : p99.toFixed(0) + "min"}` +
      ` · MAIOR silêncio real ${maior === null ? "-" : (maior / 60).toFixed(1) + "h"}`
    );
  }

  // distribuição por hora do dia (NY)
  const porHora = new Array(24).fill(0);
  for (const t of ev) porHora[horaNY(t)]++;
  const dias = Math.max(1, horasJanela / 24);
  console.log(`   por hora (NY, média/dia): ${porHora.map((n, h) => `${String(h).padStart(2, "0")}h:${(n / dias).toFixed(1)}`).join(" ")}`);
  console.log("");
}

// ─── o silêncio de AGORA é anômalo? ─────────────────────────────────────────
console.log(`═══ O SILÊNCIO DESDE ${new Date(MARCO).toISOString()} ═══\n`);
for (const canal of ["ig", "fb", "wa"]) {
  const ev = eventos[canal];
  const desde = ev.filter((t) => t >= MARCO);
  const ultimo = ev.length ? ev[ev.length - 1] : null;
  const silencioMin = ultimo ? (AGORA - ultimo) / 60000 : null;
  const faixa = faixaDe(AGORA);
  const r = resumo[canal]?.[faixa];
  const med = r?.medianaMin ?? null;
  const vezes = med && silencioMin ? silencioMin / med : null;
  const maiorReal = r?.maiorMin ?? null;

  console.log(`${canal.toUpperCase()}:`);
  console.log(`  capturas desde o marco : ${desde.length}`);
  console.log(`  última captura         : ${ultimo ? new Date(ultimo).toISOString() : "-"} (${silencioMin ? (silencioMin / 60).toFixed(1) : "?"}h atrás)`);
  console.log(`  mediana ${faixa} deste canal: ${med === null ? "-" : med.toFixed(1) + "min"}`);
  console.log(`  silêncio atual         : ${vezes === null ? "?" : vezes.toFixed(1)}× a mediana da faixa`);
  console.log(
    `  maior silêncio ${faixa} JÁ VISTO nos 7 dias: ${maiorReal === null ? "-" : (maiorReal / 60).toFixed(1) + "h"}` +
    (maiorReal && silencioMin ? ` → o de agora é ${silencioMin > maiorReal ? "MAIOR que qualquer um já visto ⚠️" : "menor que o recorde (normal)"}` : "")
  );
  console.log("");
}
