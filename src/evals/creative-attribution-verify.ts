/**
 * GUARDA da atribuição de CRIATIVO nos webhooks IG e FB (2026-07-27, rev. 29/07).
 *
 * Regra vigente (29/07): a fonte ÚNICA de atribuição é o referral REAL da
 * Meta (ad_id/ads_context_data) — provado chegando nos 3 canais em 29/07
 * (14/14 cliques atribuídos). O fallback por título de SHARE foi REMOVIDO:
 * post orgânico compartilhado pelo cliente virava criativo falso (casos
 * "Amen🙏" 28/07 e "Have a blessed Wednesday" 29/07). Estes checks impedem
 * o fallback de voltar e garantem que o referral segue indo ao funil.
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
  ck(`${nome}: share NÃO vira atribuição (fallback removido 29/07)`, !/ads_context_data: \{ ad_title: shareTitleAd/.test(src), "fallback do share VOLTOU — post orgânico compartilhado vira criativo falso");
  ck(`${nome}: atribuição = só referral real (referralFunil = refComClique)`, /const referralFunil = refComClique;/.test(src), "referralFunil não é o referral real puro");
  ck(`${nome}: funil recebe referralFunil (não o referral cru)`, /insertedMsg\.created_at \?\? new Date\(\)\.toISOString\(\),\s*\n\s*referralFunil/.test(src), "funilOnInboundMessage não usa referralFunil");
}

// O guard anti-drop do texto vazio continua intacto (ad-message-verify também cobre)
ck("IG: guard '[Client replied to our ad]' intacto", ig.includes('if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]"'), "");
ck("FB: guard '[Client replied to our ad]' intacto", fb.includes('if (!rawText && (isAdReferral || hasAnyAttachment)) rawText = "[Client replied to our ad]"'), "");

// ── Auditoria 28/07 (P0/P1/P2): captura raw + WA→funil + standalone/postback ──
const wa = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf8");
console.log("\n[P0 captura raw]");
ck("IG: capturarRawFunil presente", /capturarRawFunil\("ig"/.test(ig), "");
ck("FB: capturarRawFunil presente", /capturarRawFunil\("fb"/.test(fb), "");
ck("WA: capturarRawFunil presente", /capturarRawFunil\("wa"/.test(wa), "");

console.log("\n[P1 WhatsApp]");
ck("WA: extrai ctwa_clid (e variantes)", /"ctwa_clid", "ctwaClid"/.test(wa), "chaves ctwa_clid ausentes da extração");
ck("WA: referral VAI ao funilOnInboundMessage", /referralFunilWa\s*\)\s*\)/.test(wa) && /funilOnInboundMessage\(/.test(wa), "4º argumento referralFunilWa ausente");
ck("WA: persiste atribuição via funil_ad_ (persistirAnuncioDaConversa)", /persistirAnuncioDaConversa\(conv\.id/.test(wa), "");
ck("WA: NÃO grava mais nas colunas fantasma de instagram_conversations", !/update\(upd\)\.eq\("id", conv\.id\)/.test(wa) && !/update\(\{ ad_title: persisted \}\)/.test(wa), "update em coluna inexistente ainda presente");

console.log("\n[P2 standalone/postback]");
ck("FB: evento sem mid trata referral standalone + postback.referral", /postbackFb\?\.referral/.test(fb) && /refSolo/.test(fb), "bloco standalone ausente");
ck("FB: standalone persiste via persistirAnuncioDaConversa", /persistirAnuncioDaConversa\(convRef\.id/.test(fb), "");
ck("IG: lê postback.title e postback.referral", /postbackIG\?\.title/.test(ig) && /postbackIG\?\.referral/.test(ig), "");
ck("IG: refBruto considera o referral do postback", /messaging\.referral \?\? postbackIG\?\.referral \?\? null/.test(ig), "");

console.log(`\n===== CREATIVE-ATTRIBUTION: ${pass} passed, ${fail} failed =====`);
if (fail > 0) { console.log("FALHAS:", fails.join(" | ")); process.exit(1); }
