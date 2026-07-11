// ─── Teste E2E do funil → plataforma de análise ─────────────────────────────
// Simula uma conversa completa de Instagram com TELEFONE FAKE e dispara os 5
// eventos reais contra a plataforma (ozzi-plataforma), mostrando cada resposta
// HTTP. Usa uma conversa de teste isolada (igsid "funiltest_...") e apaga tudo
// no final — as mensagens, a conversa (cascade) e as flags técnicas.
// ATENÇÃO: envia eventos DE VERDADE para a plataforma com o telefone fake
// +13055550142 — apague esse lead na plataforma depois do teste.
// Run: npx tsx src/evals/funil-e2e.ts
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

const FONE_FAKE = "(305) 555-0142"; // número fake padrão NANP 555-01xx

async function main() {
  const { supabaseAdmin } = await import("@/lib/supabase");
  const { funilOnInboundMessage, funilOnBookingConfirmed, runFunilSilenceCheck } = await import("@/lib/funil");

  const agora = Date.now();
  const em = (hAtras: number) => new Date(agora - hAtras * 3600_000).toISOString();
  const igsid = `funiltest_${agora}`;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TESTE E2E DO FUNIL — conversa simulada, telefone FAKE");
  console.log(`  igsid: ${igsid} | telefone: ${FONE_FAKE}`);
  console.log(`  plataforma: ${process.env.PLATAFORMA_URL || "https://ozzi-plataforma.vercel.app"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // ── Conversa de teste (o anúncio entra via referral na 1ª mensagem, como
  // num lead real de click-to-message) ──
  const { data: conv, error } = await supabaseAdmin
    .from("instagram_conversations")
    .insert({ igsid, mode: "agent", name: "Cliente Teste Funil", username: "teste.funil" })
    .select()
    .single();
  if (error || !conv) { console.error("Falha ao criar conversa de teste:", error?.message); process.exit(1); }
  const convLite = { id: conv.id as string, igsid, name: "Cliente Teste Funil", username: "teste.funil" };

  const addMsg = async (role: "user" | "assistant", content: string, hAtras: number) => {
    const { data } = await supabaseAdmin
      .from("instagram_messages")
      .insert({ conversation_id: conv.id, role, content, created_at: em(hAtras) })
      .select("created_at")
      .single();
    return data?.created_at as string;
  };

  try {
    // ── Timeline da conversa ──────────────────────────────────────────────
    console.log("\n[t-50h] cliente: 'Hi, I want new floors for my house' + referral do anúncio (sem telefone → nenhum evento; anúncio fica persistido)");
    const t1 = await addMsg("user", "Hi, I want new floors for my house", 50);
    await funilOnInboundMessage(convLite, "Hi, I want new floors for my house", t1, {
      ad_id: "120210000000000001",
      ads_context_data: { ad_title: "Vinyl Promo — Anuncio de Teste" },
    });
    await addMsg("assistant", "For a whole house I need to come measure in person. What day works for you?", 49.95);

    console.log("\n[t-49.9h] cliente manda o TELEFONE → deve disparar ➊ lead_criado");
    const t2 = await addMsg("user", `Sure! My number is ${FONE_FAKE}`, 49.9);
    await funilOnInboundMessage(convLite, `Sure! My number is ${FONE_FAKE}`, t2);
    await addMsg("assistant", "Perfect! What day works better for you?", 49.8);

    console.log("\n[t-25h] cliente responde no dia seguinte → deve disparar ➋ conversando (1x/dia)");
    const t3 = await addMsg("user", "Does the promo include installation?", 25);
    await funilOnInboundMessage(convLite, "Does the promo include installation?", t3);
    await addMsg("assistant", "Yes, everything included. Want me to book your free visit?", 24.9);

    console.log("\n[agora] sweep de silêncio (última msg é nossa, cliente calado há 25h) → deve disparar ➌ parou_de_responder");
    await runFunilSilenceCheck(agora, conv.id as string);

    console.log("\n[agora] cliente VOLTA a responder → deve disparar ➍ retomou_conversa");
    const t4 = await addMsg("user", "I'm back! Can we schedule the visit?", 0);
    await funilOnInboundMessage(convLite, "I'm back! Can we schedule the visit?", t4);

    console.log("\n[agora] agente confirma a visita → deve disparar ➎ agendamento_marcado");
    const amanha = new Date(agora + 24 * 3600_000).toISOString().slice(0, 10);
    await funilOnBookingConfirmed(conv.id as string, igsid, {
      date: amanha, time: "15:00", phone: FONE_FAKE, name: "Cliente Teste Funil",
    });

    // ── Prova de dedup: repetir tudo NÃO pode duplicar nenhum evento ──────
    console.log("\n── Prova de dedup (nada abaixo pode gerar evento novo do NOSSO lado) ──");
    console.log("[dedup] replay do webhook da msg do telefone (produção bloqueia antes pelo instagram_msg_id; se chegasse aqui, a plataforma deduplica por telefone — esperado 'criado:false'):");
    await funilOnInboundMessage(convLite, `Sure! My number is ${FONE_FAKE}`, t2);
    console.log("[dedup] nova mensagem ~1min depois (conversando 1x/24h → NÃO pode enviar de novo, silêncio esperado):");
    const t5 = await addMsg("user", "ok thanks", -0.02);
    await funilOnInboundMessage(convLite, "ok thanks", t5);
    console.log("[dedup] segundo sweep de silêncio (flag já limpa pela retomada, cliente tem a última palavra → 0 disparos esperado):");
    await runFunilSilenceCheck(agora, conv.id as string);
  } finally {
    // ── Limpeza: conversa (cascade apaga mensagens) + flags técnicas ──────
    await supabaseAdmin.from("platform_settings").delete().eq("platform", `funil_sumido_${conv.id}`);
    await supabaseAdmin.from("platform_settings").delete().like("platform", `funil_ad_${conv.id}::%`);
    await supabaseAdmin.from("instagram_conversations").delete().eq("id", conv.id);
    console.log("\n── Limpeza concluída: conversa de teste, mensagens e flags apagadas do banco do agente ──");
    console.log(`⚠️  Na PLATAFORMA, apague o lead de teste com telefone +13055550142 (não há endpoint de exclusão exposto).`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("Teste falhou:", e); process.exit(1); });
