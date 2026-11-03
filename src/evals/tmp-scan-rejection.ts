// Varredura: clientes que REJEITARAM no 1º contato (ou hostilidade mid-convo)
// e ainda assim receberam resposta do bot (opener enlatado ou modelo) nos
// últimos 7 dias. Usa os detectores REAIS de produção (isFirstContactRejection
// / isHostileRejection) para medir exatamente o que a guarda nova teria pego.
// Run (da raiz do projeto): npx tsx <este arquivo>
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { isFirstContactRejection, isHostileRejection } from "@/lib/ai";

const envRaw = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
const env: Record<string, string> = {};
for (const line of envRaw.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const desde = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

async function main() {
  let msgs: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("instagram_messages")
      .select("*")
      .gte("created_at", desde)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) { console.error("ERR msgs:", error.message); process.exit(1); }
    msgs = msgs.concat(data ?? []);
    if (!data || data.length < 1000) break;
  }

  const byConv = new Map<string, any[]>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }

  const convIds = [...byConv.keys()];
  const convMeta = new Map<string, any>();
  for (let i = 0; i < convIds.length; i += 100) {
    const { data } = await admin
      .from("instagram_conversations")
      .select("*")
      .in("id", convIds.slice(i, i + 100));
    for (const c of data ?? []) convMeta.set(c.id, c);
  }

  const strip = (s: string) => (s || "").split(/\n\n?\[SYSTEM:/)[0];
  const roleOf = (m: any) => m.role ?? (m.is_from_me || m.sender === "assistant" ? "assistant" : "user");

  let firstContactVictims = 0, midConvoVictims = 0;
  console.log(`\n${byConv.size} conversas com tráfego nos últimos 7 dias\n`);

  for (const [convId, list] of byConv) {
    const conv = convMeta.get(convId);
    const label = conv?.igsid ?? convId;
    // burst inicial: mensagens do cliente antes da 1ª resposta do bot NESTA janela
    const firstBotIdx = list.findIndex((m) => roleOf(m) === "assistant");
    if (firstBotIdx > 0) {
      const burst = list.slice(0, firstBotIdx).filter((m) => roleOf(m) === "user").map((m) => strip(m.content)).join("\n");
      if (burst.trim() && isFirstContactRejection(burst)) {
        firstContactVictims++;
        console.log(`── 1º-CONTATO VÍTIMA: ${label} (${list[0].created_at})`);
        console.log(`   cliente: ${JSON.stringify(burst.slice(0, 160))}`);
        console.log(`   bot respondeu: ${JSON.stringify(strip(list[firstBotIdx].content).slice(0, 120))}\n`);
      }
    }
    // hostilidade em qualquer ponto seguida de resposta do bot
    for (let i = 0; i < list.length - 1; i++) {
      const m = list[i];
      if (roleOf(m) !== "user" || !isHostileRejection(strip(m.content))) continue;
      const nextBot = list.slice(i + 1).find((x) => roleOf(x) === "assistant");
      if (nextBot) {
        midConvoVictims++;
        console.log(`── MID-CONVO HOSTIL respondido: ${label} (${m.created_at})`);
        console.log(`   cliente: ${JSON.stringify(strip(m.content).slice(0, 160))}`);
        console.log(`   bot respondeu: ${JSON.stringify(strip(nextBot.content).slice(0, 120))}\n`);
        break;
      }
    }
  }

  console.log(`\nTOTAL: ${firstContactVictims} vítimas de 1º contato · ${midConvoVictims} conversas com hostilidade respondida`);

  // Estado da conversa do caso relatado (screenshot)
  const target = [...convMeta.values()].find((c) => c.igsid === "fb_27777958491826513");
  if (target) {
    console.log(`\nCaso do screenshot fb_27777958491826513: mode=${target.mode} booking_confirmed=${target.booking_confirmed}`);
    const hist = byConv.get(target.id) ?? [];
    for (const m of hist) console.log(`  [${m.created_at}] ${roleOf(m)}: ${JSON.stringify(strip(m.content).slice(0, 100))}`);
  } else {
    console.log("\nCaso do screenshot fb_27777958491826513: sem tráfego na janela de 7 dias (ou igsid diferente)");
  }
}
main();
