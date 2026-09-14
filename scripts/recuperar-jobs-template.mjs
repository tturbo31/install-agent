// CRIATIVO DOS JOBS ANTERIORES AO RASTREIO — pela conversa do agente (14/09/2026)
//
// O dono viu 94% dos jobs sem criativo. 107 deles são de clientes que
// conversaram (ou compraram) antes de 28/07, quando o contrato de anúncio da
// Meta ainda não era gravado. Mas a CONVERSA do agente ainda existe, e ela
// carrega duas provas que identificam o anúncio sem chute:
//   • a 1ª mensagem do cliente ser um BOTÃO de pergunta ("What is included in
//     the materials package?") — o botão só existe dentro do anúncio; o texto
//     é definido no criativo (ice_breakers do page_welcome_message);
//   • no Messenger, a SAUDAÇÃO automática da thread (via API da página),
//     também definida no criativo.
// Candidatos × quem veiculava no dia da conversa (ad_spend desde 11/04) → só
// atribui com UM nome de anúncio; ambíguo vira "veio de ANÚNCIO — sem a peça"
// quando há botão (prova de origem), e nada quando não há prova nenhuma.
//
// O elo job → conversa é o TELEFONE do orçamento aparecendo no texto da
// conversa (o cliente digitou) ou o e-mail sintético ia-<igsid>@ do orçamento.
// Coincidência de NOME não vale: fica listada para conferência humana.
//
// Grava na plataforma (fill-if-empty): lead existente pelo telefone → só os
// campos de anúncio vazios; sem lead → lead novo com criado_em = data da
// conversa (é ele que diz "nasceu antes do rastreio"). Re-rodável.
//
//   node --env-file=.env.local scripts/recuperar-jobs-template.mjs [--aplicar]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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
const app = createClient(envApp.NEXT_PUBLIC_SUPABASE_URL, envApp.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pl = createClient(envPl.NEXT_PUBLIC_SUPABASE_URL, envPl.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const cauda = (s) => {
  const n = norm(s);
  const i = n.indexOf("!");
  return i >= 0 && /^(hi|hello|olá|ola|oi)\b/.test(n) ? n.slice(i + 1).trim() : n;
};
const nomeBase = (n) => String(n ?? "").replace(/_Group_\d+$/i, "").trim();
const dez = (t) => String(t ?? "").replace(/\D/g, "").slice(-10);
const stripSys = (c) => String(c ?? "").split(/\n\n?\[SYSTEM:/)[0];

// ── 1) templates dos anúncios (saudação / botões) ──
const acct = envPl.META_AD_ACCOUNT_ID.startsWith("act_") ? envPl.META_AD_ACCOUNT_ID : "act_" + envPl.META_AD_ACCOUNT_ID;
const adsMeta = [];
{
  let url = `https://graph.facebook.com/v24.0/${acct}/ads?fields=id,name,effective_status,creative{object_story_spec}&limit=100&access_token=${envPl.META_ACCESS_TOKEN}`;
  while (url) {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) { console.log("!! ads:", JSON.stringify(j.error).slice(0, 160)); break; }
    adsMeta.push(...(j.data ?? []));
    url = j.paging?.next ?? null;
  }
}
const porSaudacao = new Map();
const porPergunta = new Map();
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

// ── 2) veiculação por dia ──
const veiculacao = new Map();
for (let de = 0; ; de += 1000) {
  const { data, error } = await pl.from("ad_spend").select("data, ad_id, valor, impressoes").range(de, de + 999);
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    if (!(Number(r.valor) > 0 || Number(r.impressoes) > 0)) continue;
    const d = String(r.data).slice(0, 10);
    const m = veiculacao.get(d) ?? new Map();
    m.set(String(r.ad_id), Number(r.valor) || 0);
    veiculacao.set(d, m);
  }
  if (!data || data.length < 1000) break;
}
const nyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const diaNY = (iso) => nyFmt.format(new Date(iso));
const diaAntes = (d) => new Date(Date.parse(d + "T12:00:00Z") - 864e5).toISOString().slice(0, 10);
function decidir(candidatos, diaConversa) {
  for (const dia of [diaConversa, diaAntes(diaConversa)]) {
    const noAr = veiculacao.get(dia);
    if (!noAr) continue;
    const ativos = candidatos.filter((c) => noAr.has(c.ad_id));
    if (ativos.length === 0) continue;
    const nomes = [...new Set(ativos.map((c) => nomeBase(c.nome)))];
    if (nomes.length === 1) {
      ativos.sort((x, y) => (noAr.get(y.ad_id) ?? 0) - (noAr.get(x.ad_id) ?? 0));
      return { ...ativos[0], dia };
    }
    return { ambiguo: nomes.join(" | ") };
  }
  return null;
}

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
    let url = `https://graph.facebook.com/v24.0/${convId}/messages?fields=message,from&limit=100&access_token=${pageToken}`;
    let ultimas = [];
    for (let p = 0; p < 4 && url; p++) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      ultimas = j.data ?? ultimas;
      url = j.paging?.next ?? null;
    }
    for (const m of [...ultimas].reverse().slice(0, 12)) {
      const t = cauda(m.message ?? "");
      if (t && porSaudacao.has(t)) return t;
    }
    return null;
  } catch { return null; }
}

// ── 3) jobs sem criativo → conversa do agente (elo forte) ──
const { data: jobs } = await pl
  .from("jobs")
  .select("id, data_conclusao, quotes(id, lead_id, nome_cliente, telefone, email, data_assinatura)")
  .order("data_conclusao", { ascending: false })
  .limit(1000);
const { data: leadsTudo } = await pl.from("leads").select("id, telefone, telefone_conversa, ig_id, ad_id, ad_name, ad_title, ad_evidencia, canal, criado_em").limit(20000);
const leadPorTel = new Map();
const leadPorIg = new Map();
for (const l of leadsTudo ?? []) {
  const t = dez(l.telefone);
  if (t.length === 10 && !leadPorTel.has(t)) leadPorTel.set(t, l);
  if (l.ig_id && !leadPorIg.has(l.ig_id)) leadPorIg.set(l.ig_id, l);
}
const temCriativo = (l) => !!(l && (l.ad_id || l.ad_name || l.ad_title));
const pessoaTemCriativo = (tel, igsid) => temCriativo(leadPorTel.get(tel)) || temCriativo(leadPorIg.get(igsid));

let atribuidos = 0, provas = 0, ambiguos = 0, semProva = 0, soNome = 0, jaTem = 0, erros = 0;
const vistos = new Set();
for (const j of jobs ?? []) {
  const q = Array.isArray(j.quotes) ? j.quotes[0] : j.quotes;
  if (!q) continue;
  const tel = dez(q.telefone);
  if (vistos.has(tel || q.id)) continue;
  vistos.add(tel || q.id);
  const nome = String(q.nome_cliente ?? "?").slice(0, 22).padEnd(22);
  const dataJob = String(j.data_conclusao).slice(0, 10);

  // elo forte: telefone do orçamento digitado na conversa, ou e-mail ia-<igsid>
  let conv = null;
  const tel7 = tel.slice(-7);
  if (tel7.length === 7) {
    const { data: msgs } = await app.from("instagram_messages").select("conversation_id").ilike("content", `%${tel7}%`).limit(3);
    const cid = msgs?.[0]?.conversation_id;
    if (cid) {
      const { data: c } = await app.from("instagram_conversations").select("id, igsid, created_at, name, username").eq("id", cid).maybeSingle();
      if (c) conv = c;
    }
  }
  if (!conv && q.email && /^ia-/.test(q.email)) {
    const igsid = q.email.replace(/^ia-/, "").replace(/@.*$/, "");
    const { data: c } = await app.from("instagram_conversations").select("id, igsid, created_at, name, username").eq("igsid", igsid).maybeSingle();
    if (c) conv = c;
  }
  if (!conv) {
    // só o nome: não vale como elo — listar para conferência humana
    if (q.nome_cliente && q.nome_cliente.length > 3) {
      const partes = q.nome_cliente.split(" ");
      const { data: cs } = await app.from("instagram_conversations").select("igsid, created_at, name").ilike("name", `%${partes[0]}%${partes[1] ?? ""}%`).limit(2);
      if (cs && cs.length === 1) { soNome++; console.log(`  ? só nome      ${nome} job ${dataJob} ~ conversa ${cs[0].created_at.slice(0, 10)} "${cs[0].name}" (não atribuído: nome não é prova)`); }
    }
    continue;
  }
  const igsidPuro = conv.igsid.replace(/^(fb_|wa_)/, "");
  const canal = conv.igsid.startsWith("fb_") ? "facebook" : conv.igsid.startsWith("wa_") ? "whatsapp" : "instagram";
  if (pessoaTemCriativo(tel, igsidPuro)) { jaTem++; continue; }
  if (canal === "whatsapp") { semProva++; continue; } // WhatsApp não tem template a ler

  const dia = diaNY(conv.created_at);
  const { data: msgs } = await app.from("instagram_messages").select("role, content").eq("conversation_id", conv.id).order("created_at", { ascending: true }).limit(6);
  const primeira = (msgs ?? []).find((m) => m.role === "user");
  const texto1 = norm(stripSys(primeira?.content ?? "").replace(/\?+\s*$/, "?"));
  const candFaq = porPergunta.get(texto1) ?? null;
  let candSaud = null;
  if (canal === "facebook") {
    const t = await saudacaoDaThread(igsidPuro);
    await new Promise((ok) => setTimeout(ok, 200));
    if (t) candSaud = porSaudacao.get(t) ?? null;
  }
  let candidatos = null, fonte = null;
  if (candSaud && candFaq) {
    const ids = new Set(candFaq.map((c) => c.ad_id));
    const inter = candSaud.filter((c) => ids.has(c.ad_id));
    candidatos = inter.length > 0 ? inter : candSaud;
    fonte = "msg_greeting";
  } else if (candSaud) { candidatos = candSaud; fonte = "msg_greeting"; }
  else if (candFaq) { candidatos = candFaq; fonte = "faq_icebreaker"; }

  const evidencia = candFaq ? "faq_button" : null;
  let achado = null, motivo = "";
  if (candidatos) {
    const d = decidir(candidatos, dia);
    if (d?.ad_id) achado = d;
    else motivo = d?.ambiguo ? `ambíguo: ${d.ambiguo.slice(0, 80)}` : "ninguém veiculando no dia";
  } else motivo = "sem botão nem saudação de anúncio";

  if (!achado && !evidencia) { semProva++; console.log(`  – sem prova     ${nome} job ${dataJob} · ${canal} ${dia} · ${motivo}`); continue; }
  if (achado) { atribuidos++; console.log(`  ✅ ${fonte.padEnd(14)} ${nome} job ${dataJob} · ${canal} ${dia} → ${achado.nome} (${achado.ad_id})`); }
  else { ambiguos++; provas++; console.log(`  ▲ prova s/ peça ${nome} job ${dataJob} · ${canal} ${dia} · ${motivo}`); }

  if (!APLICAR) continue;
  const campos = {
    ...(achado ? { ad_id: achado.ad_id, ad_name: achado.nome, ad_source_type: fonte } : {}),
    ...(evidencia ? { ad_evidencia: evidencia } : {}),
  };
  try {
    if (achado) await pl.from("ads").upsert({ ad_id: achado.ad_id, ad_name: achado.nome }, { onConflict: "ad_id", ignoreDuplicates: true });
    const existente = leadPorTel.get(tel) ?? leadPorIg.get(igsidPuro);
    if (existente) {
      const preencher = {};
      for (const [k, v] of Object.entries(campos)) if (!existente[k]) preencher[k] = v;
      if (!existente.ig_id && canal !== "whatsapp" && !leadPorIg.has(igsidPuro)) preencher.ig_id = igsidPuro;
      if (Object.keys(preencher).length > 0) {
        const { error } = await pl.from("leads").update(preencher).eq("id", existente.id);
        if (error) throw new Error(error.message);
        Object.assign(existente, preencher);
      }
    } else {
      const novo = {
        telefone: tel.length === 10 ? `1${tel}` : null,
        nome: q.nome_cliente ?? conv.name ?? null,
        canal,
        ig_id: leadPorIg.has(igsidPuro) ? null : igsidPuro,
        ig_username: conv.username ?? null,
        estagio: "vendido",
        criado_em: conv.created_at,
        ...campos,
      };
      const { data: ins, error } = await pl.from("leads").insert(novo).select("id, telefone, ig_id, ad_id, ad_name, ad_evidencia").single();
      if (error) throw new Error(error.message);
      if (tel.length === 10) leadPorTel.set(tel, ins);
      if (ins.ig_id) leadPorIg.set(ins.ig_id, ins);
      await pl.from("lead_eventos").insert({
        lead_id: ins.id,
        evento: "lead_criado",
        detalhe: JSON.stringify({ origem: "recuperacao_jobs_template", conversa: conv.igsid, conversa_em: conv.created_at, quote_id: q.id, fonte: achado ? fonte : null, evidencia }),
      });
      // orçamento órfão ganha o vínculo direto (mesma regra do conserto da auditoria: telefone idêntico, único)
      if (!q.lead_id) await pl.from("quotes").update({ lead_id: ins.id }).eq("id", q.id).is("lead_id", null);
    }
  } catch (e) {
    erros++;
    console.log(`     !! gravar ${nome}: ${e.message}`);
  }
}
console.log(`\nRESULTADO: atribuídos=${atribuidos} · prova sem peça=${provas} (ambíguos=${ambiguos}) · sem prova=${semProva} · só nome=${soNome} · já tinham=${jaTem} · erros=${erros}`);
