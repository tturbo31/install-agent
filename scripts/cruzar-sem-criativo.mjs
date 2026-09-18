// CRUZAMENTO CASO A CASO — quem está sem criativo na plataforma × conversas do agente.
// Lê o JSON do diag-sem-criativo.mts (plataforma) e procura CADA pessoa aqui por
// cinco chaves: ig_id, telefone digitado no chat, e-mail, endereço e nome completo.
// Para cada conversa achada diz se há contrato de anúncio (funil_adx_) e qual a
// força do elo. SÓ LEITURA — nada é gravado.
//   node scripts/cruzar-sem-criativo.mjs <entrada.json> <saida.json>
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";

const [entrada, saida] = process.argv.slice(2);
const lerEnv = (caminho) => {
  const env = {};
  for (const line of readFileSync(caminho, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
};
const envApp = lerEnv("C:/Users/vicam/Downloads/Ozzi floors/instagram-dm-agent/.env.local");
const app = createClient(envApp.NEXT_PUBLIC_SUPABASE_URL, envApp.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const dez = (t) => String(t ?? "").replace(/\D/g, "").slice(-10);
const soDigitos = (s) => String(s ?? "").replace(/\D/g, "");
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

// ── contratos de anúncio por conversa ──
const contratoPorConv = new Map();
for (let de = 0; ; de += 1000) {
  const { data, error } = await app.from("platform_settings").select("platform").like("platform", "funil\\_adx\\_%").range(de, de + 999);
  if (error) throw new Error("contratos: " + error.message);
  for (const r of data ?? []) {
    const m = String(r.platform).match(/^funil_adx_([0-9a-f-]{36})::([\s\S]*)$/);
    if (!m) continue;
    try {
      contratoPorConv.set(m[1], JSON.parse(decodeURIComponent(m[2])));
    } catch {
      contratoPorConv.set(m[1], { ilegivel: true });
    }
  }
  if (!data || data.length < 1000) break;
}
console.log("contratos de anúncio no agente:", contratoPorConv.size);

// ── todas as conversas (para busca por nome e por ig_id em memória) ──
const convs = [];
for (let de = 0; ; de += 1000) {
  const { data, error } = await app.from("instagram_conversations").select("id, igsid, name, username, created_at").range(de, de + 999);
  if (error) throw new Error("conversas: " + error.message);
  convs.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
console.log("conversas no agente:", convs.length);
const convPorId = new Map(convs.map((c) => [c.id, c]));
const convPorIgsid = new Map();
for (const c of convs) convPorIgsid.set(String(c.igsid).replace(/^(fb_|wa_)/, ""), c);

async function buscarMsgs(padrao) {
  const { data, error } = await app.from("instagram_messages").select("conversation_id, role, content, created_at").ilike("content", padrao).limit(40);
  if (error) {
    console.log("!! busca", padrao, error.message);
    return [];
  }
  return data ?? [];
}

const dados = JSON.parse(readFileSync(entrada, "utf-8"));
const grupos = [
  ["visita", dados.visitasSem],
  ["job", dados.jobsSem],
  ["venda", dados.vendasSem],
];
const resultado = [];
for (const [tipo, lista] of grupos) {
  for (const p of lista) {
    const achados = new Map(); // convId → Set(elos)
    const marcar = (cid, elo) => {
      if (!cid || !convPorId.has(cid)) return;
      if (!achados.has(cid)) achados.set(cid, new Set());
      achados.get(cid).add(elo);
    };

    // 1) ig_id direto
    if (p.ig_id) {
      const c = convPorIgsid.get(String(p.ig_id));
      if (c) marcar(c.id, "ig_id");
    }
    // 1b) e-mail sintético ia-<igsid>@
    if (p.email && /^ia-/.test(p.email)) {
      const c = convPorIgsid.get(p.email.replace(/^ia-/, "").replace(/@.*$/, ""));
      if (c) marcar(c.id, "email_ia");
    }
    // 2) telefone: chat de WhatsApp com o próprio número + número DIGITADO em qualquer chat
    for (const tel of [dez(p.telefone), dez(p.telefone_conversa)]) {
      if (tel.length !== 10) continue;
      for (const c of convs) if (String(c.igsid).startsWith("wa_") && dez(c.igsid) === tel) marcar(c.id, "wa_chat");
      const msgs = await buscarMsgs(`%${tel.slice(0, 3)}%${tel.slice(3, 6)}%${tel.slice(6)}%`);
      for (const m of msgs) {
        if (m.role !== "user") continue; // o número tem que ter sido dito pelo CLIENTE
        if (soDigitos(m.content).includes(tel)) marcar(m.conversation_id, "telefone_digitado");
      }
    }
    // 3) e-mail real dito na conversa
    if (p.email && !/^ia-/.test(p.email) && /@/.test(p.email)) {
      const msgs = await buscarMsgs(`%${p.email.replace(/[%_]/g, "")}%`);
      for (const m of msgs) if (m.role === "user") marcar(m.conversation_id, "email_digitado");
    }
    // 4) endereço: número + 1ª palavra da rua
    const end = String(p.endereco ?? "");
    const mEnd = end.match(/^\s*(\d{2,6})\s+(?:[NSEW]{1,2}\.?\s+)?([A-Za-z0-9]{3,})/);
    if (mEnd) {
      const msgs = await buscarMsgs(`%${mEnd[1]} %${mEnd[2]}%`);
      // número INTEIRO ("785" não casa com "4785") seguido da rua em até 3 palavras
      const reEnd = new RegExp("(^|[^0-9])" + mEnd[1] + "\\s+(?:[a-z0-9.]+\\s+){0,3}" + mEnd[2], "i");
      for (const m of msgs) if (m.role === "user" && reEnd.test(m.content)) marcar(m.conversation_id, "endereco_digitado");
    }
    // 5) nome completo (primeiro + último) — elo FRACO, só para conferência
    const partes = norm(p.nome).split(" ").filter((x) => x.length > 1);
    if (partes.length >= 2) {
      const [pri, ult] = [partes[0], partes[partes.length - 1]];
      for (const c of convs) {
        const n = norm(c.name);
        if (n && n.includes(pri) && n.includes(ult)) marcar(c.id, "nome_completo");
      }
    }

    const conversas = [...achados.entries()].map(([cid, elos]) => {
      const c = convPorId.get(cid);
      const ct = contratoPorConv.get(cid) ?? null;
      return {
        conv_id: cid,
        igsid: c.igsid,
        nome_conversa: c.name,
        username: c.username,
        conversa_criada: c.created_at,
        elos: [...elos],
        elo_forte: [...elos].some((e) => e !== "nome_completo"),
        contrato: ct ? { ad_id: ct.ad_id ?? null, ad_name: ct.ad_name ?? ct.ad_title ?? null, source: ct.ad_source_type ?? ct.source ?? null } : null,
      };
    });
    resultado.push({ tipo, ...p, conversas });
  }
}

// ── resumo ──
const chave = (r) => r.lead_id ?? r.telefone ?? r.quote_id ?? r.ag_id;
for (const tipo of ["visita", "job", "venda"]) {
  const rs = resultado.filter((r) => r.tipo === tipo);
  const semConversa = rs.filter((r) => r.conversas.length === 0).length;
  const comForte = rs.filter((r) => r.conversas.some((c) => c.elo_forte));
  const forteComAnuncio = comForte.filter((r) => r.conversas.some((c) => c.elo_forte && c.contrato?.ad_id));
  const soNome = rs.filter((r) => r.conversas.length > 0 && !r.conversas.some((c) => c.elo_forte));
  const soNomeComAnuncio = soNome.filter((r) => r.conversas.some((c) => c.contrato?.ad_id));
  console.log(`\n=== ${tipo.toUpperCase()} (${rs.length}) ===`);
  console.log(`sem NENHUMA conversa no agente: ${semConversa}`);
  console.log(`conversa com elo forte: ${comForte.length} · delas com CONTRATO DE ANÚNCIO: ${forteComAnuncio.length}`);
  console.log(`só nome igual: ${soNome.length} · delas com anúncio: ${soNomeComAnuncio.length}`);
  for (const r of forteComAnuncio) {
    for (const c of r.conversas.filter((x) => x.elo_forte && x.contrato?.ad_id))
      console.log(`  🔴 FURO ${String(r.nome ?? "?").padEnd(24)} ${chave(r)} [${r.categoria}] ← ${c.igsid} (${c.elos.join("+")}) ${c.contrato.ad_name ?? c.contrato.ad_id}`);
  }
  for (const r of soNomeComAnuncio) {
    for (const c of r.conversas.filter((x) => x.contrato?.ad_id))
      console.log(`  ? nome   ${String(r.nome ?? "?").padEnd(24)} tel=${r.telefone ?? "-"} ← ${c.igsid} "${c.nome_conversa}" ${String(c.conversa_criada).slice(0, 10)} ${c.contrato.ad_name ?? c.contrato.ad_id}`);
  }
}
writeFileSync(saida, JSON.stringify(resultado, null, 1));
console.log("\ngravado:", saida);
