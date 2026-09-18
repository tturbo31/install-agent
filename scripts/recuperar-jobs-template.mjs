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

// ── 3) jobs e vendas sem criativo → conversas do agente (elo forte) ──
// 18/09/2026: o elo por telefone buscava os 7 dígitos COLADOS ("7559043") e o
// cliente digita "201-755-9043", "(954) 668-0744", "305 2829441" — 12 pessoas
// com a prova na conversa ficaram de fora. Agora o padrão aceita qualquer
// separador e a conferência é pelos 10 dígitos, só em mensagem do CLIENTE.
// Também: TODAS as conversas da pessoa são avaliadas (não só a primeira
// achada), as vendas assinadas ainda sem job entram na varredura, e a thread
// do Messenger é lida uma vez para saudação E cartão "replied to an ad.".
const { data: jobs } = await pl
  .from("jobs")
  .select("id, quote_id, data_conclusao, quotes(id, lead_id, nome_cliente, telefone, email, data_assinatura)")
  .order("data_conclusao", { ascending: false })
  .limit(2000);
const { data: assinados } = await pl
  .from("quotes")
  .select("id, lead_id, nome_cliente, telefone, email, data_assinatura")
  .eq("status", "assinado")
  .order("data_assinatura", { ascending: false })
  .limit(2000);
const leadsTudo = [];
for (let de = 0; ; de += 1000) {
  const { data, error } = await pl.from("leads").select("id, telefone, telefone_conversa, ig_id, ad_id, ad_name, ad_title, ad_evidencia, canal, criado_em").range(de, de + 999);
  if (error) throw new Error("leads: " + error.message);
  leadsTudo.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const leadPorId = new Map();
const leadPorTel = new Map();
const leadPorIg = new Map();
for (const l of leadsTudo) {
  leadPorId.set(l.id, l);
  for (const t of [dez(l.telefone), dez(l.telefone_conversa)]) if (t.length === 10 && !leadPorTel.has(t)) leadPorTel.set(t, l);
  if (l.ig_id && !leadPorIg.has(l.ig_id)) leadPorIg.set(l.ig_id, l);
}
const temCriativo = (l) => !!(l && (l.ad_id || l.ad_name || l.ad_title));

const alvos = [];
const comJob = new Set();
for (const j of jobs ?? []) {
  const q = Array.isArray(j.quotes) ? j.quotes[0] : j.quotes;
  if (!q) continue;
  comJob.add(q.id);
  alvos.push({ tipo: "job", q, quando: String(j.data_conclusao ?? "").slice(0, 10) });
}
for (const q of assinados ?? []) if (!comJob.has(q.id)) alvos.push({ tipo: "venda", q, quando: String(q.data_assinatura ?? "").slice(0, 10) });

const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");
const COLS_CONV = "id, igsid, created_at, name, username";
async function conversasDaPessoa(q, tel) {
  const ids = new Map(); // conv id → conv
  if (tel.length === 10) {
    const { data: msgs, error } = await app
      .from("instagram_messages")
      .select("conversation_id, role, content")
      .ilike("content", `%${tel.slice(0, 3)}%${tel.slice(3, 6)}%${tel.slice(6)}%`)
      .limit(60);
    if (error) console.log("     !! busca telefone:", error.message);
    const cids = [...new Set((msgs ?? []).filter((m) => m.role === "user" && soDigitos(m.content).includes(tel)).map((m) => m.conversation_id))];
    if (cids.length > 0) {
      const { data: cs } = await app.from("instagram_conversations").select(COLS_CONV).in("id", cids);
      for (const c of cs ?? []) ids.set(c.id, c);
    }
    // o próprio chat de WhatsApp do número
    const { data: wa } = await app.from("instagram_conversations").select(COLS_CONV).in("igsid", [`wa_1${tel}`, `wa_${tel}`]);
    for (const c of wa ?? []) ids.set(c.id, c);
  }
  if (q.email && /^ia-/.test(q.email)) {
    const igsid = q.email.replace(/^ia-/, "").replace(/@.*$/, "");
    const { data: c } = await app.from("instagram_conversations").select(COLS_CONV).eq("igsid", igsid).maybeSingle();
    if (c) ids.set(c.id, c);
  }
  return [...ids.values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// thread do Messenger: saudação do anúncio E cartão "replied to an ad." numa leitura só
const cacheThread = new Map();
async function lerThread(psid) {
  if (cacheThread.has(psid)) return cacheThread.get(psid);
  const out = { saudacao: null, cartao: false };
  try {
    const conv = await fetch(`https://graph.facebook.com/v24.0/me/conversations?user_id=${psid}&fields=id&access_token=${pageToken}`);
    const convId = conv.ok ? (await conv.json()).data?.[0]?.id : null;
    if (convId) {
      let url = `https://graph.facebook.com/v24.0/${convId}/messages?fields=message,from&limit=100&access_token=${pageToken}`;
      let ultimas = [];
      for (let p = 0; p < 4 && url; p++) {
        const res = await fetch(url);
        if (!res.ok) break;
        const j = await res.json();
        if ((j.data ?? []).some((m) => /replied to an ad/i.test(m.message ?? ""))) out.cartao = true;
        ultimas = j.data ?? ultimas;
        url = j.paging?.next ?? null;
      }
      for (const m of [...ultimas].reverse().slice(0, 12)) {
        const t = cauda(m.message ?? "");
        if (t && porSaudacao.has(t)) {
          out.saudacao = t;
          break;
        }
      }
    }
  } catch {
    /* melhor esforço */
  }
  cacheThread.set(psid, out);
  await new Promise((ok) => setTimeout(ok, 200));
  return out;
}

async function avaliar(conv) {
  const canal = conv.igsid.startsWith("fb_") ? "facebook" : conv.igsid.startsWith("wa_") ? "whatsapp" : "instagram";
  const dia = diaNY(conv.created_at);
  const { data: msgs } = await app.from("instagram_messages").select("role, content").eq("conversation_id", conv.id).order("created_at", { ascending: true }).limit(6);
  const primeira = (msgs ?? []).find((m) => m.role === "user");
  const texto1 = norm(stripSys(primeira?.content ?? "").replace(/\?+\s*$/, "?"));
  const candFaq = porPergunta.get(texto1) ?? null;
  let candSaud = null;
  let cartao = false;
  if (canal === "facebook") {
    const th = await lerThread(conv.igsid.slice(3));
    cartao = th.cartao;
    if (th.saudacao) candSaud = porSaudacao.get(th.saudacao) ?? null;
  }
  let candidatos = null;
  let fonte = null;
  if (candSaud && candFaq) {
    const idsFaq = new Set(candFaq.map((c) => c.ad_id));
    const inter = candSaud.filter((c) => idsFaq.has(c.ad_id));
    candidatos = inter.length > 0 ? inter : candSaud;
    fonte = "msg_greeting";
  } else if (candSaud) {
    candidatos = candSaud;
    fonte = "msg_greeting";
  } else if (candFaq) {
    candidatos = candFaq;
    fonte = "faq_icebreaker";
  }
  // mesmas DUAS provas que a varredura automática aceita (funil.ts): botão de
  // FAQ na 1ª mensagem ou o cartão "replied to an ad." na thread do Messenger
  const evidencia = candFaq ? "faq_button" : cartao ? "card_messenger" : null;
  let achado = null;
  let motivo = "sem botão, saudação nem cartão de anúncio";
  // no WhatsApp a peça exata vem do referral (externalAdReply); o botão só PROVA a origem
  if (candidatos && canal !== "whatsapp") {
    const d = decidir(candidatos, dia);
    if (d?.ad_id) achado = d;
    else motivo = d?.ambiguo ? `ambíguo: ${d.ambiguo.slice(0, 80)}` : "ninguém veiculando no dia";
  } else if (candidatos) motivo = "WhatsApp: botão prova a origem, não a peça";
  return { conv, canal, dia, fonte, evidencia, achado, motivo };
}

let atribuidos = 0, provas = 0, semProva = 0, semConversa = 0, jaTem = 0, jaTemProva = 0, erros = 0;
const vistos = new Set();
for (const { tipo, q, quando } of alvos) {
  const tel = dez(q.telefone);
  if (vistos.has(tel || q.id)) continue;
  vistos.add(tel || q.id);
  const nome = String(q.nome_cliente ?? "?").slice(0, 22).padEnd(22);
  const rot = `${tipo} ${quando}`;
  const leadsDaPessoa = [leadPorId.get(q.lead_id), leadPorTel.get(tel)].filter(Boolean);
  if (leadsDaPessoa.some(temCriativo)) { jaTem++; continue; }

  const convs = await conversasDaPessoa(q, tel);
  if (convs.length === 0) { semConversa++; continue; }
  for (const c of convs) {
    const l = leadPorIg.get(c.igsid.replace(/^(fb_|wa_)/, ""));
    if (l) leadsDaPessoa.push(l);
  }
  if (leadsDaPessoa.some(temCriativo)) { jaTem++; continue; }

  // a conversa MAIS ANTIGA com peça vence (regra "primeiro anúncio vence"); sem peça, a 1ª com prova
  const avals = [];
  for (const c of convs) avals.push(await avaliar(c));
  const melhor = avals.find((a) => a.achado) ?? avals.find((a) => a.evidencia) ?? null;
  if (!melhor) { semProva++; console.log(`  – sem prova     ${nome} ${rot} · ${avals.map((a) => `${a.canal} ${a.dia}`).join(", ")} · ${avals[0].motivo}`); continue; }
  const { conv, canal, dia, fonte, evidencia, achado, motivo } = melhor;
  const igsidPuro = conv.igsid.replace(/^(fb_|wa_)/, "");
  if (!achado && leadsDaPessoa.some((l) => l.ad_evidencia)) { jaTemProva++; continue; }
  if (achado) { atribuidos++; console.log(`  ✅ ${fonte.padEnd(14)} ${nome} ${rot} · ${canal} ${dia} → ${achado.nome} (${achado.ad_id})`); }
  else { provas++; console.log(`  ▲ prova s/ peça ${nome} ${rot} · ${canal} ${dia} · ${evidencia} · ${motivo}`); }

  if (!APLICAR) continue;
  const campos = {
    ...(achado ? { ad_id: achado.ad_id, ad_name: achado.nome, ad_source_type: fonte } : {}),
    ...(evidencia ? { ad_evidencia: evidencia } : {}),
  };
  try {
    if (achado) await pl.from("ads").upsert({ ad_id: achado.ad_id, ad_name: achado.nome }, { onConflict: "ad_id", ignoreDuplicates: true });
    // o lead do ORÇAMENTO é quem a tela de Jobs lê primeiro; depois telefone, depois a conversa
    const existente = leadPorId.get(q.lead_id) ?? leadPorTel.get(tel) ?? leadPorIg.get(igsidPuro);
    if (existente) {
      const preencher = {};
      for (const [k, v] of Object.entries(campos)) if (!existente[k]) preencher[k] = v;
      if (!existente.ig_id && canal !== "whatsapp" && !leadPorIg.has(igsidPuro)) preencher.ig_id = igsidPuro;
      if (Object.keys(preencher).length > 0) {
        const { error } = await pl.from("leads").update(preencher).eq("id", existente.id);
        if (error) throw new Error(error.message);
        Object.assign(existente, preencher);
        if (preencher.ig_id) leadPorIg.set(preencher.ig_id, existente);
        await pl.from("lead_eventos").insert({
          lead_id: existente.id,
          evento: "criativo_recuperado",
          detalhe: JSON.stringify({ origem: "recuperacao_jobs_template", conversa: conv.igsid, conversa_em: conv.created_at, quote_id: q.id, fonte: achado ? fonte : null, evidencia, campos: Object.keys(preencher) }),
        });
      }
      if (!q.lead_id) await pl.from("quotes").update({ lead_id: existente.id }).eq("id", q.id).is("lead_id", null);
    } else {
      const novo = {
        telefone: tel.length === 10 ? `1${tel}` : null,
        nome: q.nome_cliente ?? conv.name ?? null,
        canal,
        ig_id: canal === "whatsapp" || leadPorIg.has(igsidPuro) ? null : igsidPuro,
        ig_username: conv.username ?? null,
        estagio: "vendido",
        criado_em: conv.created_at,
        ...campos,
      };
      const { data: ins, error } = await pl.from("leads").insert(novo).select("id, telefone, ig_id, ad_id, ad_name, ad_evidencia").single();
      if (error) throw new Error(error.message);
      leadPorId.set(ins.id, ins);
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
console.log(`\nRESULTADO (${alvos.length} alvos: jobs + vendas assinadas): peça exata=${atribuidos} · prova sem peça=${provas} · sem prova=${semProva} · sem conversa=${semConversa} · já tinham criativo=${jaTem} · já tinham a prova=${jaTemProva} · erros=${erros}`);
