// ─── Teste E2E dos GATILHOS do funil (v2 — spec 2026-07-11) ─────────────────
// Simula conversas completas passando pelas MESMAS funções que os webhooks
// chamam, e dispara eventos reais contra a Ozzi Plataforma com contato fake.
// Prova os gatilhos: lead_criado na 1ª mensagem (com anúncio via referral),
// conversando na 1ª resposta REAL, telefone incluído nos eventos seguintes,
// parou_de_responder após 24h, retomou_conversa na volta, agendamento_marcado
// na confirmação — e que NADA duplica do nosso lado.
// Run: npx tsx src/evals/funil-e2e.ts
// ⚠️ Envia eventos DE VERDADE (telefone fake +13055550142) — apagar o lead
// de teste na plataforma depois.
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

// Marco zero retroativo SÓ para este teste (o histórico simulado é backdatado).
process.env.FUNIL_DESDE = "2020-01-01T00:00:00Z";

const FONE_FAKE = "(305) 555-0142";

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase");
  const { funilOnInboundMessage, funilOnBookingConfirmed, runFunilSilenceCheck } = await import("@/lib/funil");

  const agora = Date.now();
  const em = (hAtras: number) => new Date(agora - hAtras * 3600_000).toISOString();

  const criarConv = async (igsid: string) => {
    const { data, error } = await supabaseAdmin
      .from("instagram_conversations")
      .insert({ igsid, mode: "agent", name: "Cliente Teste Funil", username: "teste.funil", created_at: em(51) })
      .select("id, igsid, name, username, created_at")
      .single();
    if (error || !data) throw new Error(`criar conversa: ${error?.message}`);
    return data as { id: string; igsid: string; name: string; username: string; created_at: string };
  };

  const conv = await criarConv(`funiltest_${agora}`);
  const addMsg = async (convId: string, role: "user" | "assistant", content: string, hAtras: number) => {
    const { data } = await supabaseAdmin
      .from("instagram_messages")
      .insert({ conversation_id: convId, role, content, created_at: em(hAtras) })
      .select("created_at")
      .single();
    return data?.created_at as string;
  };

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  E2E DOS GATILHOS DO FUNIL (v2) — telefone FAKE");
  console.log(`  igsid: ${conv.igsid} | telefone: ${FONE_FAKE}`);
  console.log("═══════════════════════════════════════════════════════════");

  try {
    console.log("\n[t-50h] 1ª MENSAGEM do contato novo + referral do anúncio → ➊ lead_criado (com ad, SEM telefone ainda)");
    const t1 = await addMsg(conv.id, "user", "Hi, I want new floors for my house", 50);
    await funilOnInboundMessage(conv, "Hi, I want new floors for my house", t1, {
      ad_id: "120210000000000001",
      ads_context_data: { ad_title: "Vinyl Promo — Anuncio de Teste" },
    });
    await addMsg(conv.id, "assistant", "Hi! Which floor are you interested in, tile, vinyl, or hardwood?", 49.95);

    console.log("\n[t-49.9h] 1ª resposta REAL do cliente → ➋ conversando");
    const t2 = await addMsg(conv.id, "user", "Vinyl, the whole house", 49.9);
    await funilOnInboundMessage(conv, "Vinyl, the whole house", t2);
    await addMsg(conv.id, "assistant", "For a whole house I come measure in person for free. What day works?", 49.8);

    console.log("\n[t-25h] cliente manda o TELEFONE → SILÊNCIO esperado (conversando já saiu; o fone entra no PRÓXIMO evento)");
    const t3 = await addMsg(conv.id, "user", `My number is ${FONE_FAKE}`, 25);
    await funilOnInboundMessage(conv, `My number is ${FONE_FAKE}`, t3);
    await addMsg(conv.id, "assistant", "Perfect! I have tomorrow 1pm or 3pm, what works better?", 24.9);

    console.log("\n[agora] sweep de silêncio (última msg é nossa, cliente calado 25h) → ➌ parou_de_responder (JÁ COM o telefone)");
    await runFunilSilenceCheck(agora, conv.id);

    console.log("\n[agora] cliente VOLTA → ➍ retomou_conversa");
    const t4 = await addMsg(conv.id, "user", "I'm back! Can we schedule the visit?", 0);
    await funilOnInboundMessage(conv, "I'm back! Can we schedule the visit?", t4);

    console.log("\n[agora] agente confirma a visita → ➎ agendamento_marcado");
    const amanha = new Date(agora + 24 * 3600_000).toISOString().slice(0, 10);
    await funilOnBookingConfirmed(conv.id, conv.igsid, { date: amanha, time: "15:00", phone: FONE_FAKE, name: "Cliente Teste Funil" });

    console.log("\n── Prova de dedup (nada abaixo pode gerar evento novo do NOSSO lado) ──");
    console.log("[dedup] nova mensagem comum ~1min depois (conversando é 1x por conversa → silêncio esperado):");
    const t5 = await addMsg(conv.id, "user", "ok thanks", -0.02);
    await funilOnInboundMessage(conv, "ok thanks", t5);
    console.log("[dedup] segundo sweep de silêncio (flag limpa pela retomada + cliente tem a última palavra → 0 disparos):");
    await runFunilSilenceCheck(agora, conv.id);

    console.log("\n── WhatsApp: 1ª mensagem → lead_criado com canal whatsapp e telefone do próprio número ──");
    const convWa = await criarConv(`wa_15550104488`);
    try {
      const tw = await addMsg(convWa.id, "user", "Hi, how much for 300 sqft of vinyl?", 0);
      await funilOnInboundMessage(convWa, "Hi, how much for 300 sqft of vinyl?", tw);
    } finally {
      await supabaseAdmin.from("platform_settings").delete().like("platform", `funil_%${convWa.id}%`);
      await supabaseAdmin.from("instagram_conversations").delete().eq("id", convWa.id);
    }
  } finally {
    await supabaseAdmin.from("platform_settings").delete().eq("platform", `funil_sumido_${conv.id}`);
    await supabaseAdmin.from("platform_settings").delete().like("platform", `funil_ad_${conv.id}::%`);
    await supabaseAdmin.from("instagram_conversations").delete().eq("id", conv.id);
    console.log("\n── Limpeza concluída (conversas de teste, mensagens e flags removidas do banco do agente) ──");
    console.log("⚠️  Na PLATAFORMA, apague os leads de teste: telefone +13055550142 e +15550104488.");
  }
  process.exit(0);
}

main().catch((e) => { console.error("Teste falhou:", e); process.exit(1); });
