// ─── Jornada completa contra a Ozzi Plataforma (contrato do webhook) ────────
// Simula um contato FICTÍCIO (ig_id iniciando com TESTE, telefone iniciando
// com 1555) percorrendo o funil: lead_criado (ad "AD-TESTE-LOCAL") →
// conversando → agendamento_marcado → visita_realizada. Mostra a resposta da
// plataforma em cada passo e exige HTTP 200 {"ok":true} em todos.
// Run: npx tsx src/evals/funil-jornada.ts
import { readFileSync } from "fs";
import { join } from "path";
try {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
} catch { /* sem .env.local */ }

async function main() {
  const { enviarEventoFunil } = await import("@/lib/plataforma");
  const { funilVisitaResultado, dataVisitaIso } = await import("@/lib/funil");

  const igId = `TESTE_${Date.now()}`;
  const telefone = "+1 (555) 010-4477"; // fake: inicia com 1555, faixa 555-01xx
  const amanha = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  let falhas = 0;

  const passo = (n: number, nome: string, r: { ok: boolean; status: number; body?: string }) => {
    const veredito = r.ok && /"ok"\s*:\s*true/.test(r.body ?? "") ? "✅" : "❌";
    if (veredito === "❌") falhas++;
    console.log(`${veredito} ${n}) ${nome} -> HTTP ${r.status} | resposta: ${r.body}`);
  };

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  JORNADA COMPLETA → Ozzi Plataforma (contato fictício)");
  console.log(`  ig_id: ${igId} | telefone: ${telefone}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  passo(1, "lead_criado (com anúncio AD-TESTE-LOCAL)", await enviarEventoFunil("lead_criado", {
    ig_id: igId,
    ig_username: "teste.jornada",
    telefone,
    nome: "Contato Teste Jornada",
    canal: "instagram",
    ad_id: "AD-TESTE-LOCAL",
    ad_name: "Anúncio Teste Local",
    campanha: "Campanha Teste Local",
  }));

  passo(2, "conversando", await enviarEventoFunil("conversando", { ig_id: igId, telefone }));

  passo(3, "agendamento_marcado", await enviarEventoFunil("agendamento_marcado", {
    ig_id: igId,
    telefone,
    data_visita: dataVisitaIso(amanha, "14:00"),
  }));

  passo(4, "visita_realizada", await funilVisitaResultado("realizada", { telefone }));

  console.log(`\n${falhas === 0 ? "✅ JORNADA COMPLETA: 4/4 eventos com HTTP 200 {\"ok\":true}" : `❌ ${falhas} passo(s) falharam`}`);
  console.log(`⚠️  Apague na plataforma o lead de teste com telefone ${telefone} (e o +13055550142 dos testes E2E, se ainda existir).`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error("Jornada falhou:", e); process.exit(1); });
