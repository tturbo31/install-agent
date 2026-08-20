// BACKFILL DA PROVA DE ANÚNCIO (20/08/2026) — para cada lead IG/FB da
// plataforma sem identidade de anúncio e sem evidência, procura:
//   • faq_button      — 1ª mensagem do cliente é botão de FAQ do anúncio
//   • card_messenger  — thread do Messenger tem "replied to an ad."
// e grava leads.ad_evidencia (fill-if-empty). Rodar com --aplicar para gravar.
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

// mesma lista de botões de FAQ do funil (src/lib/funil.ts)
const FAQ_BUTTON = /^\s*(?:what type of materials are included|what is the installation process|do you offer any discounts for larger spaces|is labor cost also \$?4,?500|can i customize the design|what is included in the materials package|is installation cost included in the price|is installation labor cost extra|schedule a quote)\s*\??\s*$/i;
const stripSys = (c) => (c || "").split(/\n\n?\[SYSTEM:/)[0];

// token da página do Facebook (linha fbtok| no banco do agente)
const { data: tokRows } = await app.from("platform_settings").select("platform").like("platform", "fbtok|%");
const pageToken = (tokRows ?? [])
  .map((r) => { const [, at, t] = String(r.platform).split("|"); return at && t ? { at, t } : null; })
  .filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0]?.t ?? envApp.FACEBOOK_PAGE_TOKEN;

async function cardMessenger(psid) {
  try {
    const conv = await fetch(`https://graph.facebook.com/v24.0/me/conversations?user_id=${psid}&fields=id&access_token=${pageToken}`);
    if (!conv.ok) return { evid: false, erro: `conv ${conv.status}` };
    const convId = (await conv.json()).data?.[0]?.id;
    if (!convId) return { evid: false, erro: "sem thread" };
    let url = `https://graph.facebook.com/v24.0/${convId}/messages?fields=message&limit=100&access_token=${pageToken}`;
    for (let p = 0; p < 3 && url; p++) {
      const res = await fetch(url);
      if (!res.ok) return { evid: false, erro: `msgs ${res.status}` };
      const j = await res.json();
      if ((j.data ?? []).some((m) => /replied to an ad/i.test(m.message ?? ""))) return { evid: true };
      url = j.paging?.next ?? null;
    }
    return { evid: false };
  } catch (e) {
    return { evid: false, erro: String(e).slice(0, 60) };
  }
}

// leads-alvo: IG/FB, sem identidade de anúncio, sem evidência
const { data: leads, error } = await pl
  .from("leads")
  .select("id, nome, canal, ig_id, telefone, ad_id, ad_name, ad_title, ad_evidencia, contato_origem, criado_em")
  .in("canal", ["instagram", "facebook"])
  .is("ad_id", null)
  .is("ad_name", null)
  .is("ad_title", null)
  .is("ad_evidencia", null)
  .order("criado_em", { ascending: true })
  .limit(5000);
if (error) { console.log("!! leads:", error.message); process.exit(1); }
console.log(`alvos: ${leads.length} leads IG/FB sem anúncio e sem evidência (aplicar=${APLICAR})`);

let faq = 0, card = 0, nada = 0, semConv = 0, erros = 0;
for (const l of leads) {
  if (!l.ig_id) { semConv++; continue; }
  const igsid = l.canal === "facebook" ? `fb_${l.ig_id}` : l.ig_id;
  let evidencia = null;
  let detalhe = "";

  // 1) FAQ: 1ª mensagem do cliente na conversa do agente
  const { data: conv } = await app.from("instagram_conversations").select("id").eq("igsid", igsid).maybeSingle();
  if (conv) {
    const { data: msgs } = await app
      .from("instagram_messages").select("role, content")
      .eq("conversation_id", conv.id).order("created_at", { ascending: true }).limit(10);
    const primeira = (msgs ?? []).find((m) => m.role === "user");
    if (primeira && FAQ_BUTTON.test(stripSys(primeira.content))) {
      evidencia = "faq_button";
      detalhe = `1ª msg: "${stripSys(primeira.content).trim().slice(0, 50)}"`;
    }
  } else {
    semConv++;
  }

  // 2) cartão do Messenger
  if (!evidencia && l.canal === "facebook") {
    const r = await cardMessenger(l.ig_id);
    if (r.evid) { evidencia = "card_messenger"; detalhe = "cartão 'replied to an ad.' na thread"; }
    else if (r.erro) { erros++; detalhe = r.erro; }
    await new Promise((ok) => setTimeout(ok, 250)); // ritmo educado com a Graph
  }

  if (evidencia) {
    if (evidencia === "faq_button") faq++; else card++;
    console.log(`  ✅ ${evidencia.padEnd(14)} ${String(l.nome ?? "?").slice(0, 24).padEnd(24)} [${l.canal}] ${String(l.criado_em).slice(0, 10)} — ${detalhe}`);
    if (APLICAR) {
      const { error: e } = await pl.from("leads").update({ ad_evidencia: evidencia }).eq("id", l.id).is("ad_evidencia", null);
      if (e) { console.log(`     !! gravar: ${e.message}`); erros++; }
    }
  } else {
    nada++;
  }
}
console.log(`\nRESULTADO: faq_button=${faq} card_messenger=${card} sem evidência=${nada} sem conversa/ig=${semConv} erros=${erros}`);
