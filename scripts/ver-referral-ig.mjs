// A ASSINATURA DO INSTAGRAM ESTÁ ENTREGANDO? (31/07/2026)
//
// Em 31/07 a conta @ozzi.floors foi assinada em `messaging_referral`, que
// faltava (ver scripts/assinatura-ig.mjs). A prova de que a correção pegou é
// simples: eventos de referral AVULSOS — sem `message.mid` — passando a chegar
// na caixa-preta. Antes da assinatura eles não existiam: o único referral que
// aparecia vinha DENTRO de uma mensagem.
//
// Lê direto a caixa-preta (retenção 7 dias), então serve para conferir nos dias
// seguintes à correção. A conclusão de negócio (a taxa do Instagram subiu?) sai
// da comparação automática da auditoria (config.ig_referral_marco).
//
// Uso: node --env-file=.env.local scripts/ver-referral-ig.mjs [marco-ISO]
//      (padrão: o instante da correção, 2026-07-31T22:56Z)
import { createClient } from "@supabase/supabase-js";
const ag = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MARCO = Date.parse(process.argv[2] ?? "2026-07-31T22:56:27Z");

async function paginar(like) {
  const out = [];
  for (let p = 0; p < 60; p++) {
    const { data } = await ag.from("platform_settings").select("platform").like("platform", like)
      .order("platform", { ascending: true }).range(p * 1000, p * 1000 + 999);
    out.push(...(data ?? []).map((r) => r.platform));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const grupos = new Map();
for (const k of await paginar("funil_raw_%")) {
  const m = k.match(/^funil_raw_(ig|fb|wa)_(\d{10,})_([a-z0-9]{4})_(\d+)of(\d+)(_s0)?(_trunc)?::([\s\S]*)$/);
  if (!m) continue;
  const chave = `${m[1]}_${m[2]}_${m[3]}`;
  const g = grupos.get(chave) ?? { canal: m[1], epoch: Number(m[2]), partes: [] };
  g.partes.push({ i: Number(m[4]), c: m[8] });
  grupos.set(chave, g);
}

let igDepois = 0, comRef = 0, standalone = 0;
const amostras = [];
for (const [, g] of grupos) {
  if (g.canal !== "ig" || g.epoch < MARCO) continue;
  igDepois++;
  let corpo = g.partes.sort((a, b) => a.i - b.i).map((p) => p.c).join("");
  try { corpo = decodeURIComponent(corpo); } catch {}
  if (!/"referral"/.test(corpo)) continue;
  comRef++;
  const temMid = /"mid"\s*:/.test(corpo);
  if (!temMid) standalone++;
  if (amostras.length < 4) amostras.push({ quando: new Date(g.epoch).toISOString(), standalone: !temMid, corpo: corpo.slice(0, 700) });
}

console.log(`Capturas IG desde ${new Date(MARCO).toISOString()}: ${igDepois}`);
console.log(`  com "referral": ${comRef}   (destes, AVULSOS sem message.mid: ${standalone})`);
for (const a of amostras) {
  console.log(`\n── ${a.quando} ${a.standalone ? "[AVULSO — messaging_referral]" : "[dentro da mensagem]"}`);
  console.log(a.corpo);
}

// contratos de anúncio criados desde o marco
const adx = await paginar("funil_adx_%");
console.log(`\nContratos funil_adx_ no total: ${adx.length}`);
