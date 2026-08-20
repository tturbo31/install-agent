// PEÇA PELO TEMPLATE DO ANÚNCIO — 20/08/2026
//
// A saudação automática ("Hi Fulano! Need new floors?...") e os botões de
// pergunta que aparecem na conversa são DEFINIDOS DENTRO do criativo
// (page_welcome_message do object_story_spec). Logo, o texto que está na
// conversa identifica a peça — sem chute:
//   • Messenger: a saudação real está na thread (via API, token da página);
//   • IG/FB: a 1ª mensagem sendo um botão de FAQ aponta os anúncios cujo
//     template contém aquela pergunta.
// O candidato só vira atribuição quando, filtrando por QUAIS anúncios
// veiculavam no dia da conversa (ad_spend da plataforma), sobra EXATAMENTE UM
// nome de anúncio. Ambíguo = descartado com log (regra da casa: sem prova
// única, sem atribuição).
//
// Grava fill-if-empty: leads.ad_id / ad_name / ad_source_type
// ('msg_greeting' | 'faq_icebreaker'). Rodar com --aplicar para gravar.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const APLICAR = process.argv.includes("--aplicar");
const lerEnv = (caminho) => {
  const env = {};
  for (const line of readFileSync(caminho, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
};
const envApp = lerEnv("C:/Users/vicam/Downloads/Ozzi floors/instagram-dm-agent/.env.local");
const envPl = lerEnv("C:/Users/vicam/Downloads/Funil Ozzi/ozzi-plataforma/.env.local");
const app = createClient(envApp.NEXT_PUBLIC_SUPABASE_URL, envApp.SUPABASE_SERVICE_ROLE_KEY);
const pl = createClient(envPl.NEXT_PUBLIC_SUPABASE_URL, envPl.SUPABASE_SERVICE_ROLE_KEY);

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
// a parte que identifica: tudo DEPOIS da primeira "!" (o "Hi {{nome}}!" sai)
const cauda = (s) => {
  const n = norm(s);
  const i = n.indexOf("!");
  return i >= 0 && /^(hi|hello|olá|ola|oi)\b/.test(n) ? n.slice(i + 1).trim() : n;
};
const nomeBase = (n) => String(n ?? "").replace(/_Group_\d+$/i, "").trim();

// ── 1) mapa de templates: greeting/icebreakers → anúncios ──
const acct = envPl.META_AD_ACCOUNT_ID.startsWith("act_") ? envPl.META_AD_ACCOUNT_ID : "act_" + envPl.META_AD_ACCOUNT_ID;
const adsMeta = [];
{
  let url = `https://graph.facebook.com/v24.0/${acct}/ads?fields=id,name,effective_status,creative{object_story_spec}&limit=100&access_token=${envPl.META_ACCESS_TOKEN}`;
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) { console.log("!! ads:", JSON.stringify(j.error).slice(0, 120)); break; }
    adsMeta.push(...(j.data ?? []));
    url = j.paging?.next ?? null;
  }
}
const porSaudacao = new Map(); // cauda(greeting) → [{ad_id, nome}]
const porPergunta = new Map(); // norm(pergunta FAQ) → [{ad_id, nome}]
for (const a of adsMeta) {
  const oss = a.creative?.object_story_spec ?? {};
  const raw = (oss.video_data ?? oss.link_data ?? oss.template_data ?? {}).page_welcome_message;
  if (!raw) continue;
  let pwm; try { pwm = JSON.parse(raw); } catch { continue; }
  const tf = pwm.text_format?.message ?? {};
  const item = { ad_id: a.id, nome: a.name };
  const g = cauda(tf.text ?? "");
  if (g) porSaudacao.set(g, [...(porSaudacao.get(g) ?? []), item]);
  for (const ice of tf.ice_breakers ?? []) {
    const q = norm(ice.title);
    if (q) porPergunta.set(q, [...(porPergunta.get(q) ?? []), item]);
  }
}
console.log(`templates: ${adsMeta.length} ads · ${porSaudacao.size} saudações · ${porPergunta.size} perguntas (aplicar=${APLICAR})`);

// ── 2) gasto por dia (quem veiculava quando) ──
const veiculacao = new Map(); // `${data}` → Map(ad_id → valor)
{
  let de = 0;
  for (;;) {
    const { data, error } = await pl.from("ad_spend").select("data, ad_id, valor, impressoes").range(de, de + 999);
    if (error) { console.log("!! ad_spend:", error.message); break; }
    for (const r of data ?? []) {
      if (!(Number(r.valor) > 0 || Number(r.impressoes) > 0)) continue;
      const d = String(r.data).slice(0, 10);
      const m = veiculacao.get(d) ?? new Map();
      m.set(String(r.ad_id), Number(r.valor) || 0);
      veiculacao.set(d, m);
    }
    if (!data || data.length < 1000) break;
    de += 1000;
  }
  console.log(`veiculação: ${veiculacao.size} dias com anúncio no ar`);
}
const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const diaNY = (iso) => nyFmt.format(new Date(iso));
const diaAntes = (d) => new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);

// candidatos → filtra por veiculação no dia (ou véspera) → único NOME vence
function decidir(candidatos, diaConversa) {
  for (const dia of [diaConversa, diaAntes(diaConversa)]) {
    const noAr = veiculacao.get(dia);
    if (!noAr) continue;
    const ativos = candidatos.filter((c) => noAr.has(c.ad_id));
    if (ativos.length === 0) continue;
    const nomes = [...new Set(ativos.map((c) => nomeBase(c.nome)))];
    if (nomes.length === 1) {
      // desempate entre variantes do mesmo nome: quem gastou mais no dia
      ativos.sort((x, y) => (noAr.get(y.ad_id) ?? 0) - (noAr.get(x.ad_id) ?? 0));
      return { ...ativos[0], dia };
    }
    return { ambiguo: nomes.join(" | ") };
  }
  return null; // ninguém veiculando → sem prova de qual era
}

// ── 3) alvos: leads sem identidade de anúncio, com evidência ──
const { data: todosLeads } = await pl
  .from("leads")
  .select("id, nome, canal, ig_id, telefone, ad_id, ad_name, ad_title, ad_evidencia, criado_em")
  .order("criado_em", { ascending: true })
  .limit(20000);
const dez = (t) => (t ?? "").replace(/\D/g, "").slice(-10);
// pessoa já tem criativo por outro lead? então não mexe (fusão já resolve)
const comAdPorTel = new Set(), comAdPorIg = new Set();
for (const l of todosLeads ?? []) {
  if (l.ad_id || l.ad_name || l.ad_title) {
    const t = dez(l.telefone);
    if (t.length === 10) comAdPorTel.add(t);
    if (l.ig_id) comAdPorIg.add(l.ig_id);
  }
}
const alvos = (todosLeads ?? []).filter((l) =>
  !l.ad_id && !l.ad_name && !l.ad_title &&
  l.ad_evidencia && l.ig_id &&
  (l.canal === "facebook" || l.canal === "instagram") &&
  !(dez(l.telefone).length === 10 && comAdPorTel.has(dez(l.telefone))) &&
  !comAdPorIg.has(l.ig_id)
);
console.log(`alvos com evidência e sem peça: ${alvos.length}`);

// token da página (threads do Messenger)
const { data: tokRows } = await app.from("platform_settings").select("platform").like("platform", "fbtok|%");
const pageToken = (tokRows ?? [])
  .map((r) => { const [, at, t] = String(r.platform).split("|"); return at && t ? { at, t } : null; })
  .filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0]?.t ?? envApp.FACEBOOK_PAGE_TOKEN;

async function saudacaoDaThread(psid) {
  try {
    const conv = await fetch(`https://graph.facebook.com/v24.0/me/conversations?user_id=${psid}&fields=id&access_token=${pageToken}`);
    if (!conv.ok) return null;
    const convId = (await conv.json()).data?.[0]?.id;
    if (!convId) return null;
    // mensagens mais ANTIGAS: paginar até a última página e olhar o fim
    let url = `https://graph.facebook.com/v24.0/${convId}/messages?fields=message,from&limit=100&access_token=${pageToken}`;
    let ultimas = [];
    for (let p = 0; p < 4 && url; p++) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      ultimas = j.data ?? ultimas;
      url = j.paging?.next ?? null;
    }
    // as mais antigas ficam no FIM da última página
    for (const m of [...ultimas].reverse().slice(0, 12)) {
      const t = cauda(m.message ?? "");
      if (t && porSaudacao.has(t)) return t;
    }
    return null;
  } catch { return null; }
}

// 1ª mensagem do cliente (para o caminho do botão de FAQ)
async function primeiraMensagem(igsid) {
  const { data: conv } = await app.from("instagram_conversations").select("id").eq("igsid", igsid).maybeSingle();
  if (!conv) return null;
  const { data: msgs } = await app.from("instagram_messages").select("role, content")
    .eq("conversation_id", conv.id).order("created_at", { ascending: true }).limit(6);
  const primeira = (msgs ?? []).find((m) => m.role === "user");
  return primeira ? String(primeira.content).split(/\n\n?\[SYSTEM:/)[0] : null;
}

let porSaud = 0, porFaq = 0, ambiguos = 0, semProva = 0, erros = 0;
for (const l of alvos) {
  const dia = diaNY(l.criado_em);

  // os DOIS textos da mesma conversa vêm do MESMO anúncio: a interseção
  // saudação ∩ pergunta desempata templates compartilhados (Ad16–20 ∩
  // pergunta exclusiva do Ad18 = Ad18). Sem interseção, cada um sozinho.
  let candSaud = null;
  if (l.canal === "facebook") {
    const t = await saudacaoDaThread(l.ig_id);
    await new Promise((ok) => setTimeout(ok, 200));
    if (t) candSaud = porSaudacao.get(t) ?? null;
  }
  const msg = await primeiraMensagem(l.canal === "facebook" ? `fb_${l.ig_id}` : l.ig_id);
  const q = norm((msg ?? "").replace(/\?+\s*$/, "?"));
  const candFaq = porPergunta.get(q) ?? null;

  let candidatos = null, fonte = null;
  if (candSaud && candFaq) {
    const ids = new Set(candFaq.map((c) => c.ad_id));
    const inter = candSaud.filter((c) => ids.has(c.ad_id));
    if (inter.length > 0) { candidatos = inter; fonte = "msg_greeting"; }
    else { candidatos = candSaud; fonte = "msg_greeting"; }
  } else if (candSaud) { candidatos = candSaud; fonte = "msg_greeting"; }
  else if (candFaq) { candidatos = candFaq; fonte = "faq_icebreaker"; }

  if (!candidatos) { semProva++; continue; }
  const d = decidir(candidatos, dia);
  let achado = d?.ad_id ? d : null;
  if (!achado) {
    if (d?.ambiguo) { ambiguos++; console.log(`  ~ ambíguo ${l.nome ?? "?"} ${dia}: ${d.ambiguo.slice(0, 90)}`); }
    else semProva++;
    continue;
  }

  if (fonte === "msg_greeting") porSaud++; else porFaq++;
  console.log(`  ✅ ${fonte.padEnd(14)} ${String(l.nome ?? "?").slice(0, 22).padEnd(22)} [${l.canal}] ${dia} → ${achado.nome} (${achado.ad_id})`);
  if (APLICAR) {
    await pl.from("ads").upsert({ ad_id: achado.ad_id, ad_name: achado.nome }, { onConflict: "ad_id", ignoreDuplicates: true });
    const { error: e } = await pl.from("leads")
      .update({ ad_id: achado.ad_id, ad_name: achado.nome, ad_source_type: fonte })
      .eq("id", l.id).is("ad_id", null).is("ad_name", null);
    if (e) { erros++; console.log(`     !! gravar: ${e.message}`); }
  }
}
console.log(`\nRESULTADO: saudação=${porSaud} faq=${porFaq} ambíguos=${ambiguos} sem prova=${semProva} erros=${erros}`);
