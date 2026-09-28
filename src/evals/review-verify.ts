/**
 * GUARDA do pedido de REVIEW + INDICAÇÃO (28/09/2026): POST /api/enviar tipo
 * "review", marcador [SYSTEM: REVIEW_REQUEST], cérebro estreito de resposta e
 * o desvio do wa-webhook (foto = print do review, texto = review-reply).
 *
 * ZERO chamadas de API e ZERO envios: só helpers puros + inspeção de fonte.
 * Rodar: npx tsx src/evals/review-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildReviewCtxMarker,
  parseReviewCtxMarker,
  REVIEW_CTX_PREFIX,
  REVIEW_HANDOFF_MARK,
  REVIEW_HANDOFF_SUFFIX,
  isReviewDoneClaim,
  isReviewRefusal,
  reviewHandoffActive,
  reviewPhotoReply,
  reviewAskScreenshotReply,
  looksLikeNewProjectRequest,
  imageAnalysisIsRealFloor,
} from "../lib/review-reply";
import { stripInternalMarkers } from "../lib/outbound-text";
import { containsSchedulingOffer } from "../lib/ai";
import { followupPolicyViolation } from "../lib/quote-followup";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 160)}»`); }
}

const GOOGLE = "https://www.google.com/maps/place//data=!4m3!3m2!1s0x87abfe6d4f665579:0xff474714eb50f3e8!12e1?source=g.page.m._&laa=merchant-review-solicitation";
const YELP = "https://www.yelp.com/writeareview/biz/0YfSJgqNuZ-zNu11AqZhxA?review_origin=review-feed-war-widget";

function main() {
  console.log("\n============== REVIEW-VERIFY (pedido de review + indicação) ==============");

  // ── 1. Marcador: ida e volta com os links REAIS do dono ─────────────────────
  console.log("\n[1] Marcador [SYSTEM: REVIEW_REQUEST] guarda e devolve o contexto");
  const marker = buildReviewCtxMarker({ idioma: "es", etapa: "pedido", google_url: GOOGLE, yelp_url: YELP, valor_google: 25, valor_yelp: 25, comissao_pct: 10, chave: "abc-123:pedido" });
  ck("marcador começa com o prefixo", marker.includes(REVIEW_CTX_PREFIX));
  const ctx = parseReviewCtxMarker("Hi Maria, thank you!" + marker, "2026-09-28T12:00:00Z");
  ck("parse devolve o contexto", !!ctx);
  ck("link do Google volta idêntico (tem ! : ? & no meio)", ctx?.google_url === GOOGLE, ctx?.google_url);
  ck("link do Yelp volta idêntico (tem hífen)", ctx?.yelp_url === YELP, ctx?.yelp_url);
  ck("idioma/etapa/valores/comissão/chave", ctx?.idioma === "es" && ctx?.etapa === "pedido" && ctx?.valor_google === 25 && ctx?.valor_yelp === 25 && ctx?.comissao_pct === 10 && ctx?.chave === "abc-123:pedido");
  ck("marcado_em = created_at da mensagem", ctx?.marcado_em === "2026-09-28T12:00:00Z");
  ck("sem marcador → null", parseReviewCtxMarker("Hi Maria", "2026-09-28T12:00:00Z") === null);
  ck("marcador corrompido → null, nunca lança", parseReviewCtxMarker(REVIEW_CTX_PREFIX + "{nope]", "x") === null);
  ck("url http (não https) é descartada", parseReviewCtxMarker(buildReviewCtxMarker({ idioma: "en", etapa: "lembrete", google_url: "http://x", yelp_url: YELP, valor_google: 25, valor_yelp: 25, comissao_pct: 10 }), "x")?.google_url === "");

  // ── 2. O marcador NUNCA sai para o cliente ──────────────────────────────────
  console.log("\n[2] stripInternalMarkers apaga os marcadores de review");
  ck("REVIEW_REQUEST removido", stripInternalMarkers("Thanks!" + marker) === "Thanks!", stripInternalMarkers("Thanks!" + marker));
  ck("REVIEW_HANDOFF removido", stripInternalMarkers("Call Ozzi." + REVIEW_HANDOFF_SUFFIX) === "Call Ozzi.");
  ck("QUOTE_HANDOFF também removido (era um furo)", stripInternalMarkers("Ok.\n\n[SYSTEM: QUOTE_HANDOFF]") === "Ok.");
  ck("texto sem marcador intacto", stripInternalMarkers("Google: " + GOOGLE) === "Google: " + GOOGLE);

  // ── 3. "Já fiz o review" ────────────────────────────────────────────────────
  console.log("\n[3] isReviewDoneClaim");
  for (const t of ["I left a review", "Just posted it!", "Done", "done.", "I already wrote the review on Google", "Review posted", "Ya la hice", "Listo", "Ya dejé la reseña", "Publiqué la reseña en Yelp", "Já deixei o review"]) {
    ck(`✔ "${t}"`, isReviewDoneClaim(t));
  }
  for (const t of ["How do I leave it?", "I will do it later", "Where is the link?", "My neighbor wants floors too", "ok", "What do I get for the review?"]) {
    ck(`✘ "${t}"`, !isReviewDoneClaim(t));
  }

  // ── 4. Recusa: mesma régua estreita do follow-up ────────────────────────────
  console.log("\n[4] isReviewRefusal");
  ck("'stop texting me' é recusa", isReviewRefusal("Please stop texting me"));
  ck("'not interested' é recusa", isReviewRefusal("Not interested, thanks"));
  ck("'wrong number' é recusa", isReviewRefusal("wrong number"));
  ck("'later this week' NÃO é recusa", !isReviewRefusal("I'll do it later this week"));
  ck("'no me interesa' é recusa", isReviewRefusal("No me interesa"));

  // ── 5. Repasse ao Ozzi marca silêncio até o próximo pedido ──────────────────
  console.log("\n[5] reviewHandoffActive");
  const hist = (rows: Array<[string, string]>) => rows.map(([role, content]) => ({ role, content }));
  ck("repasse na última rodada nossa → ativo", reviewHandoffActive(hist([["assistant", "Hi" + marker], ["user", "I have a complaint"], ["assistant", "Reach Ozzi at (561) 674-8334." + REVIEW_HANDOFF_SUFFIX], ["user", "ok but..."]])));
  ck("sem repasse → inativo", !reviewHandoffActive(hist([["assistant", "Hi" + marker], ["user", "done"], ["assistant", "Thanks, send the screenshot"], ["user", "here"]])));
  ck("novo pedido/lembrete depois do repasse zera", !reviewHandoffActive(hist([["assistant", "x" + REVIEW_HANDOFF_SUFFIX], ["assistant", "Reminder" + marker], ["user", "ok"]])));
  ck("marca de repasse é literal", REVIEW_HANDOFF_MARK === "[SYSTEM: REVIEW_HANDOFF]");

  // ── 6. Textos fixos: nunca disparam o detector de agendamento nem a regra 31 ─
  console.log("\n[6] Textos fixos passam nas réguas dos outros canais");
  for (const lang of ["en", "es"] as const) {
    const foto = reviewPhotoReply(lang);
    const print = reviewAskScreenshotReply(lang);
    ck(`${lang}: agradecimento da foto não é oferta de horário`, !containsSchedulingOffer(foto), foto);
    ck(`${lang}: agradecimento da foto sem violação (desconto/agenda)`, !followupPolicyViolation(foto), followupPolicyViolation(foto) ?? "");
    ck(`${lang}: pedido do print não é oferta de horário`, !containsSchedulingOffer(print), print);
    ck(`${lang}: sem travessão nem emoji`, !/[—–]|[\u{1F300}-\u{1FAFF}]/u.test(foto + print));
    ck(`${lang}: sem ¿¡`, !/[¿¡]/.test(foto + print));
  }

  // ── 7. Fiação do wa-webhook e do /api/enviar (inspeção de fonte) ────────────
  console.log("\n[7] Fiação");
  const semCR = (s: string) => s.split("\r\n").join("\n");
  const wa = semCR(readFileSync(join(__dirname, "../app/api/wa-webhook/route.ts"), "utf8"));
  const enviar = semCR(readFileSync(join(__dirname, "../app/api/enviar/route.ts"), "utf8"));
  const iRev = wa.indexOf("const reviewCtx = await findReviewContext(conv.id)");
  const iInst = wa.indexOf("ETAPA DE INSTALAÇÃO: cliente respondeu ao aviso de véspera");
  const iQuote = wa.indexOf("const quoteCtx = await findQuoteFollowupContext(conv.id);\n        if (quoteCtx) {");
  ck("webhook: bloco de review existe", iRev > 0);
  ck("webhook: review vem ANTES da etapa de instalação", iRev > 0 && iInst > 0 && iRev < iInst);
  ck("webhook: review vem ANTES do follow-up de orçamento", iRev > 0 && iQuote > 0 && iRev < iQuote);
  const iPhotoCtx = wa.indexOf("let reviewPhotoCtx = imageUrl ? await findReviewContext(conv.id)");
  const iAnalyse = wa.indexOf("preFetchedImageBase64 = await downloadZApiImage(imageUrl)");
  ck("webhook: contexto de review é lido ANTES de baixar/analisar a imagem", iPhotoCtx > 0 && iAnalyse > 0 && iPhotoCtx < iAnalyse);
  ck("webhook: foto de PISO de cliente de review volta ao fluxo normal (não é print)", wa.includes("if (reviewPhotoCtx && preAnalysis && imageAnalysisIsRealFloor(preAnalysis)) {") && wa.includes("reviewPhotoCtx = null;"));
  ck("webhook: orçamento novo de cliente de review cai no fluxo de vendas", wa.includes("if (reviewCtx && looksLikeNewProjectRequest(rawText)) {"));
  // O cérebro de VENDAS (ai.ts / system-prompt.ts / scheduler.ts) não importa
  // nada do review: o que a IA responde a lead continua exatamente igual.
  for (const f of ["../lib/ai.ts", "../lib/system-prompt.ts", "../lib/scheduler.ts", "../lib/quote-followup.ts", "../lib/quote-reply.ts"]) {
    ck(`cérebro de vendas intacto: ${f} não importa review-reply`, !readFileSync(join(__dirname, f), "utf8").includes("review-reply"));
  }
  // O bloco de review só roda quando a conversa tem o marcador (findReviewContext
  // devolve null para todo mundo mais) e sempre dentro de try/catch que segue o
  // fluxo normal em erro.
  ck("webhook: erro no bloco de review segue o fluxo normal", wa.includes('console.error("WA review-reply error (seguindo o fluxo normal):", err);'));

  // ── 8. Cliente de review que vira lead de novo ─────────────────────────────
  console.log("\n[8] looksLikeNewProjectRequest / imageAnalysisIsRealFloor");
  for (const t of ["Can I get a quote for my mom's house?", "How much for 800 sqft of vinyl?", "I want to install floors in another room", "Quiero una cotización para otra casa", "Cuánto cuesta instalar 100 m2", "Quanto custa o orçamento pra outra casa"]) {
    ck(`✔ orçamento novo: "${t}"`, looksLikeNewProjectRequest(t));
  }
  for (const t of ["My friend wants a quote, can I refer her?", "How much do I get for the review?", "Where do I leave the Google review?", "Done, here is the screenshot", "ok thanks", "Mi vecino quiere una cotización, lo recomiendo"]) {
    ck(`✘ assunto de review/indicação: "${t}"`, !looksLikeNewProjectRequest(t));
  }
  ck("análise 'Floor type: not a floor' = print (fica no review)", !imageAnalysisIsRealFloor("A screenshot of a Google review page.\nFloor type: not a floor"));
  ck("análise 'Floor type: tile' = piso de verdade (fluxo normal)", imageAnalysisIsRealFloor("Photo of a bathroom.\nFloor type: tile"));
  ck("análise 'Floor type: floor plan' = não é piso", !imageAnalysisIsRealFloor("Floor type: floor plan"));
  ck("análise sem linha final = não decide (fica no review)", !imageAnalysisIsRealFloor("could not analyze"));
  const iPhotoHandler = wa.indexOf('await enviarEventoFunil("review_foto_recebida"');
  const iHumanGate = wa.indexOf('if (conv.mode === "human") {\n      // Cliente de REVIEW respondeu com a conversa em modo humano');
  ck("webhook: print do review é tratado ANTES do gate de modo humano (dono sempre avisado)", iPhotoHandler > 0 && iHumanGate > 0 && iPhotoHandler < iHumanGate);
  ck("webhook: foto vai ao dono com a imagem", wa.includes("notifyOwnersReviewPhoto({ phone, clientName: nomeCliente, imageUrl, alert: REVIEW_PHOTO_ALERT })"));
  ck("webhook: resposta em modo humano ainda avisa a plataforma (review_respondeu)", wa.includes('"review_respondeu"') && (wa.match(/"review_respondeu"/g) ?? []).length >= 2);
  ck("enviar: tipo review aceito", enviar.includes('["mensagem_direta", "followup", "review"]'));
  ck("enviar: review respeita a recusa (conversa viva/humana)", enviar.includes('(tipo === "followup" || tipo === "review") && !dry'));
  ck("enviar: recusa de review NÃO dispara followup_respondeu", enviar.includes('if (tipo === "followup") await enviarEventoFunil("followup_respondeu"'));
  ck("enviar: idempotência pela chave (nunca 2 pedidos)", enviar.includes("await reviewAlreadySent(telefone, chave)"));
  ck("enviar: cada mensagem gravada com o marcador", enviar.includes("recordInHistory(telefone, texto + marcador)"));
  ck("enviar: texto do review NÃO passa por sanitizeOutbound (links com hífen/!)", !/tipo === "review"[\s\S]{0,400}sanitizeOutbound\(/.test(enviar));

  console.log(`\n============== ${pass} ✅  ${fail} ❌ ==============`);
  if (fail) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}

main();
