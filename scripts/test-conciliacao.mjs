// TESTE REAL DA CONCILIAÇÃO COM REPARO (31/07/2026)
//
// A conciliação só vale se ela CONSERTAR — e um resultado "0 furos" num dia
// limpo não prova nada. Este teste fabrica o furo de propósito, contra os dois
// bancos de PRODUÇÃO, e depois apaga tudo o que criou:
//
//   1. cria uma conversa descartável no agente (igsid de teste) com 1 mensagem
//      do "cliente" e um contrato funil_adx_ apontando para um anúncio real;
//   2. confere que a plataforma NÃO tem lead para essa identidade;
//   3. roda a conciliação de verdade → ela tem que achar 1 furo e repará-lo;
//   4. confere que o lead nasceu na plataforma COM ad_id;
//   5. roda de novo → tem que reparar ZERO (idempotência);
//   6. apaga o lead + eventos na plataforma e a conversa + contrato no agente,
//      e confirma que sobrou 0 dos dois lados.
//
// Uso: node --env-file=.env.local scripts/test-conciliacao.mjs
//      (precisa de PLATAFORMA_URL, PLATAFORMA_WEBHOOK_TOKEN, ADMIN_SECRET e o
//       SUPABASE_SERVICE_ROLE_KEY da PLATAFORMA em PLATAFORMA_SERVICE_KEY ou no
//       .env.local dela — o script acha sozinho pelo caminho padrão)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const PADRAO_PLATAFORMA = "C:/Users/vicam/Downloads/Funil Ozzi/ozzi-plataforma/.env.local";

function lerEnv(caminho) {
  try {
    const out = {};
    for (const linha of readFileSync(caminho, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(linha.trim());
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return null;
  }
}

const EP = lerEnv(process.env.PLATAFORMA_ENV ?? PADRAO_PLATAFORMA);
if (!EP?.SUPABASE_SERVICE_ROLE_KEY) {
  console.error(`Não achei o .env.local da PLATAFORMA (${process.env.PLATAFORMA_ENV ?? PADRAO_PLATAFORMA}).`);
  process.exit(1);
}

const ag = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const pl = createClient(EP.NEXT_PUBLIC_SUPABASE_URL, EP.SUPABASE_SERVICE_ROLE_KEY);
const BASE = (process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app").replace(/\/$/, "");
const AGENTE = process.env.AGENTE_URL || "https://instagram-dm-agent-chi.vercel.app";
const SEGREDO = process.env.ADMIN_SECRET;

const marca = Date.now().toString().slice(-8);
const IGSID = `wa_1555${marca}`; // canal WhatsApp: a identidade é o próprio número
const TELEFONE10 = `555${marca}`;
const CONTRATO = {
  ad_id: "120248894662390443", // anúncio real da conta (New Engagement Ad3)
  ad_title: `[TESTE CONCILIACAO ${marca}]`,
  ad_source_type: "ad",
  ad_clicked_at: new Date().toISOString(),
};

let convId = null;
let falhou = false;
const passo = (ok, texto) => {
  console.log(`  ${ok ? "✅" : "❌"} ${texto}`);
  if (!ok) falhou = true;
};

async function limpar() {
  console.log("\n── limpeza ──");
  // plataforma: eventos e lead
  const { data: leads } = await pl.from("leads").select("id").like("telefone", `%${TELEFONE10}`);
  for (const l of leads ?? []) {
    await pl.from("lead_eventos").delete().eq("lead_id", l.id);
    await pl.from("leads").delete().eq("id", l.id);
  }
  // agente: contrato, mensagens (cascade) e conversa
  if (convId) {
    const { data: chaves } = await ag.from("platform_settings").select("platform").like("platform", `funil_adx_${convId}%`);
    for (const k of chaves ?? []) await ag.from("platform_settings").delete().eq("platform", k.platform);
    const { data: legado } = await ag.from("platform_settings").select("platform").like("platform", `funil_ad_${convId}%`);
    for (const k of legado ?? []) await ag.from("platform_settings").delete().eq("platform", k.platform);
    await ag.from("instagram_conversations").delete().eq("id", convId);
  }
  const { data: sobrouLead } = await pl.from("leads").select("id").like("telefone", `%${TELEFONE10}`);
  const { data: sobrouConv } = await ag.from("instagram_conversations").select("id").eq("igsid", IGSID);
  passo((sobrouLead ?? []).length === 0, `plataforma limpa (${(sobrouLead ?? []).length} lead(s) de teste sobrando)`);
  passo((sobrouConv ?? []).length === 0, `agente limpo (${(sobrouConv ?? []).length} conversa(s) de teste sobrando)`);
}

async function conciliar() {
  const res = await fetch(`${AGENTE}/api/funil-conciliar`, {
    method: "POST",
    headers: { "x-admin-secret": SEGREDO },
  });
  if (!res.ok) throw new Error(`conciliação HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

try {
  console.log(`\n═══ TESTE DA CONCILIAÇÃO COM REPARO — igsid ${IGSID} ═══\n`);

  // 1) furo fabricado
  console.log("── 1. fabricando o furo ──");
  const { data: conv, error: e1 } = await ag
    .from("instagram_conversations")
    .insert({ igsid: IGSID, name: `Teste Conciliacao ${marca}`, mode: "human" })
    .select("id")
    .single();
  if (e1) throw new Error(`criar conversa: ${e1.message}`);
  convId = conv.id;
  const { error: e2 } = await ag
    .from("instagram_messages")
    .insert({ conversation_id: convId, role: "user", content: "Hi, I want a quote for vinyl floors" });
  if (e2) throw new Error(`criar mensagem: ${e2.message}`);
  const chave = `funil_adx_${convId}::${encodeURIComponent(JSON.stringify(CONTRATO))}`;
  const { error: e3 } = await ag.from("platform_settings").insert({ platform: chave, paused: false });
  if (e3) throw new Error(`criar contrato: ${e3.message}`);
  passo(true, `conversa ${convId.slice(0, 8)} + 1 mensagem do cliente + contrato funil_adx_ criados`);

  // 2) a plataforma ainda não conhece ninguém com esse telefone
  const { data: antes } = await pl.from("leads").select("id").like("telefone", `%${TELEFONE10}`);
  passo((antes ?? []).length === 0, `plataforma ainda não tem lead para ${TELEFONE10} (${(antes ?? []).length})`);

  // 3) conciliação de verdade
  console.log("\n── 2. conciliação (reparo real) ──");
  const r1 = await conciliar();
  const meu = (r1.detalhes ?? []).find((d) => d.conversa === convId);
  passo(r1.ok === true, `rodou: ${r1.contratos} contratos, ${r1.furos} furo(s), ${r1.reparados} reparado(s)`);
  passo(!!meu, "o furo fabricado foi DETECTADO pela conciliação");
  passo(!!meu?.reparado, `reparo: ${meu?.motivo ?? "não tentou"}`);

  // 4) o lead nasceu com o anúncio
  console.log("\n── 3. resultado na plataforma ──");
  await new Promise((r) => setTimeout(r, 1500)); // o webhook enriquece via after()
  const { data: depois } = await pl.from("leads").select("id, telefone, canal, ad_id, ad_name, ad_title, ad_clicked_at").like("telefone", `%${TELEFONE10}`);
  const lead = (depois ?? [])[0];
  passo(!!lead, `lead criado: ${lead?.id?.slice(0, 8) ?? "NENHUM"}`);
  passo(lead?.ad_id === CONTRATO.ad_id, `ad_id gravado: ${lead?.ad_id ?? "-"} (esperado ${CONTRATO.ad_id})`);
  passo(lead?.canal === "whatsapp", `canal: ${lead?.canal ?? "-"}`);
  passo(!!lead?.ad_clicked_at, `ad_clicked_at: ${lead?.ad_clicked_at ?? "-"}`);

  // 5) idempotência
  console.log("\n── 4. idempotência (rodar de novo não repara nada) ──");
  const r2 = await conciliar();
  const meu2 = (r2.detalhes ?? []).find((d) => d.conversa === convId);
  passo(!meu2, `o contrato de teste saiu da lista de furos (${r2.furos} furo(s) no total)`);
} catch (e) {
  console.error(`\n💥 ${e.message}`);
  falhou = true;
} finally {
  await limpar();
  console.log(falhou ? "\n🔴 TESTE FALHOU\n" : "\n✅ TESTE PASSOU — a conciliação detecta e repara sozinha\n");
  process.exit(falhou ? 1 : 0);
}
