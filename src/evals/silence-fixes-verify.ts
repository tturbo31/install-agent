// Verificação dos fixes de silêncio (revisão 21/07/2026):
//  A. Re-tap de anúncio: cliente que só re-tocou o anúncio (nunca digitou nada)
//     recebia silêncio porque o modelo regenerava o opener idêntico e a guarda
//     anti-repetição o suprimia (3 leads IG mortos, 18–21/07). Agora sai um
//     nudge com fraseado diferente, no máximo uma vez por conversa.
//  B. Quote-reply "reenvia o orçamento": cliente pedindo o orçamento de novo
//     recebia só promessa ("Ozzi will resend") em loop (caso Salatheia, 3 dias
//     no vácuo). Agora o total sai na hora quando está no contexto.
// Rodar: npx tsx src/evals/silence-fixes-verify.ts   (parte B usa a API)
import { readFileSync } from "fs";
import { join } from "path";
function loadEnv() {
  const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const l of c.split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

import { adRetapNudge, isConsecutiveDuplicate, type ChatMessage } from "../lib/ai";
import { composeQuoteReply } from "../lib/quote-reply";
import { followupPolicyViolation } from "../lib/quote-followup";

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` | ${detail}` : ""}`); }
}

const PH = "[Client replied to our ad]";
const OPENER_EN = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const OPENER_ES = "Hola, trabajamos con vinyl de lujo, tile y hardwood, y tenemos promoción en cada uno. Cuál te interesa?";

async function main() {
  // ── A. adRetapNudge (offline) ──────────────────────────────────────────────
  console.log("[A] adRetapNudge — nudge no re-tap, nunca loop, nunca em conversa com texto real");
  const retap: ChatMessage[] = [
    { role: "user", content: PH },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: PH },
  ];
  const nudge = adRetapNudge(retap);
  ck("2º re-tap sem texto → nudge", nudge !== null);
  ck("nudge NÃO é duplicata do opener (a guarda não pode engoli-lo)", !!nudge && !isConsecutiveDuplicate(retap, nudge));
  ck("nudge pergunta o tipo (tile/vinyl/hardwood)", !!nudge && /tile/i.test(nudge) && /vinyl/i.test(nudge) && /hardwood/i.test(nudge));
  ck("nudge sem traços e sem emoji", !!nudge && !/[—–-]/.test(nudge.replace(/\b(re|de)-/g, "")) && !/\p{Emoji_Presentation}/u.test(nudge));

  const retapEs: ChatMessage[] = [
    { role: "user", content: PH },
    { role: "assistant", content: OPENER_ES },
    { role: "user", content: PH },
  ];
  const nudgeEs = adRetapNudge(retapEs);
  ck("opener em espanhol → nudge em espanhol", !!nudgeEs && /hola de nuevo/i.test(nudgeEs));

  ck("primeiro contato (1 msg) → null (opener normal cuida)", adRetapNudge([{ role: "user", content: PH }]) === null);
  ck("cliente já digitou texto real → null (deixa o modelo decidir)", adRetapNudge([
    { role: "user", content: PH },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: "how much for vinyl?" },
    { role: "assistant", content: "Vinyl runs $5/sqft..." },
    { role: "user", content: PH },
  ]) === null);
  const jaNudgado: ChatMessage[] = [
    { role: "user", content: PH },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: PH },
    { role: "assistant", content: adRetapNudge(retap)! },
    { role: "user", content: PH },
  ];
  ck("nudge já enviado → null (uma vez por conversa, nunca loop)", adRetapNudge(jaNudgado) === null);
  ck("variante 'shared a post/reel' também conta como placeholder", adRetapNudge([
    { role: "user", content: '[Client shared a post/reel from our ad: "Promo"]' },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: PH },
  ]) !== null);

  // Fiação: os dois webhooks Meta usam o nudge DENTRO do branch da guarda.
  console.log("\n[A2] Fiação nos webhooks");
  for (const [tag, rel] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"]] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    const guardIdx = src.indexOf("isConsecutiveDuplicate(messagesForAI, finalResponse)");
    ck(`${tag}: guarda de duplicata existe`, guardIdx > 0);
    const trecho = src.slice(guardIdx, guardIdx + 900);
    ck(`${tag}: nudge dentro do branch da guarda (antes do return silencioso)`, /adRetapNudge\(messagesForAI\)/.test(trecho));
    ck(`${tag}: nudge é enviado E gravado no histórico`, /content: nudge/.test(trecho));
  }

  // ── B. quote-reply: pedido de reenvio devolve o total na hora ──────────────
  console.log("\n[B] quote-reply — reenvio de orçamento (API ao vivo)");
  const ctx = { valor: 9870, parcela: 274, idioma: "en" as const, url: "https://app.gethearth.com/partners/ozzifloors", marcado_em: "2026-07-18T13:51:01Z" };
  const histSalatheia = [
    { role: "assistant", content: "Hi Salatheia, you do not have to pay the full $9,870 at once since we offer financing starting at $274 a month..." },
    { role: "user", content: "Good morning. Would you be so kind to resend the quote?" },
    { role: "assistant", content: "Of course! I'll have Ozzi resend the quote to you right away." },
  ];
  const r1 = await composeQuoteReply({ ctx, history: histSalatheia, clientText: "Hello. I haven't received the quote. Would you please resend it? Thanks." });
  console.log(`   → ${r1.text}`);
  ck("reenvio: reafirma o total $9,870 na hora (não só promete)", /\$9,870/.test(r1.text), r1.text);
  ck("reenvio: aciona o dono ([NOTIFY_OWNER])", r1.notifyOwner);
  ck("reenvio: passa no portão de política", followupPolicyViolation(r1.text) === null, followupPolicyViolation(r1.text) ?? "");

  const ctxSemValor = { ...ctx, valor: null };
  const r2 = await composeQuoteReply({ ctx: ctxSemValor, history: histSalatheia, clientText: "Can you resend my quote?" });
  console.log(`   → ${r2.text}`);
  ck("sem total no contexto: NUNCA inventa número", !/\$\s?\d/.test(r2.text), r2.text);
  ck("sem total: ainda aciona o dono", r2.notifyOwner);

  console.log(`\n${pass} ✅ / ${fail} ❌`);
  if (fail > 0) process.exit(1);
}
main();
