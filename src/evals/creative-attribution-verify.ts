/**
 * GUARDA da atribuição de CRIATIVO nos webhooks IG e FB (2026-07-27).
 *
 * Caso real: 94 mensagens/semana chegavam marcadas "replied to our ad" e ZERO
 * leads ganhavam anúncio — o referral dos anúncios de engajamento vem sem
 * ad_id/ads_context_data, e a informação do criativo mora no SHARE (título)
 * que o clique entrega junto da 1ª mensagem. Estes checks impedem regressão:
 * o share-fallback e o log do referral cru precisam existir nos DOIS webhooks,
 * e o referral com ad_id continua sendo a fonte primária.
 *
 * ZERO chamadas de API: só inspeção de fonte. Rodar:
 *   npx tsx src/evals/creative-attribution-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 140)}»`); }
}

const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf8");
const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf8");

for (const [nome, src] of [["IG", ig], ["FB", fb]] as const) {
  console.log(`\n[${nome}]`);
  ck(`${nome}: loga o referral cru para diagnóstico`, /referral cru/.test(src), "log 'referral cru' ausente");
  ck(`${nome}: referral com ad_id/título é fonte primária`, /refBruto\?\.ad_id \|\| refBruto\?\.ads_context_data\?\.ad_title/.test(src), "condição de prioridade ausente");
  ck(`${nome}: share vira atribuição (ads_context_data com ad_title)`, /ads_context_data: \{ ad_title: shareTitleAd/.test(src), "fallback do share ausente");
  ck(`${nome}: planta baixa nunca vira 'criativo'`, /ehPlantaBaixa/.test(src), "guarda de planta baixa ausente");
  ck(`${nome}: funil recebe referralFunil (não o referral cru)`, /insertedMsg\.created_at \?\? new Date\(\)\.toISOString\(\),\s*\n\s*referralFunil/.test(src), "funilOnInboundMessage não usa referralFunil");
}

// O guard anti-drop do texto vazio continua intacto (ad-message-verify também cobre)
ck("IG: guard '[Client replied to our ad]' intacto", ig.includes('if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]"'), "");
ck("FB: guard '[Client replied to our ad]' intacto", fb.includes('if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]"'), "");

console.log(`\n===== CREATIVE-ATTRIBUTION: ${pass} passed, ${fail} failed =====`);
if (fail > 0) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
