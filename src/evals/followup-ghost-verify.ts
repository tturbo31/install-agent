// Follow-up de 17/09/2026 (pedido do dono): fantasma do botão de FAQ, sumiu
// depois do preço (com financiamento) e janela de 45 min. Só funções puras:
// zero API, zero envio. Prova que os alvos novos entram e que as travas
// antigas (1 por conversa, recusa, deferral, janela da Meta) continuam de pé.
// Run: npx tsx src/evals/followup-ghost-verify.ts
import {
  decideFollowup,
  ghostTemplate,
  financingTemplate,
  followupTemplate,
  FOLLOWUP_MARKER,
  isFaqGhost,
  priceWasStated,
  type FollowupMsg,
  type Lang,
} from "@/lib/followup";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = Date.parse("2026-09-17T18:00:00Z"); // 14h ET
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const m = (role: "user" | "assistant", content: string, hoursAgo: number): FollowupMsg => ({ role, content, created_at: at(hoursAgo) });

const FAQ_TAP = "What is the installation process?";
const FAQ_ANSWER = "We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?";
const PRICE_ANSWER = "Our vinyl promo is $5 per sqft and that already includes the flooring, the installation labor, and the quarter round. Are you planning to do just one area, or will it be the entire house?";
const VISIT_OFFER = "For a whole house I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Tuesday at 9am or 1pm, what works better for you?";

console.log("\n── 1. Fantasma do botão: toque + resposta automática + 45 min de silêncio ──");
const ghost = [m("user", FAQ_TAP, 1), m("assistant", FAQ_ANSWER, 0.98)];
check("isFaqGhost reconhece", isFaqGhost(ghost));
let d = decideFollowup("1234567890", ghost, NOW);
check("elegível como faq_ghost", d.eligible && d.kind === "faq_ghost", JSON.stringify(d));
check("sem financiamento (preço nunca foi dito)", d.financing === false);
d = decideFollowup("1234567890", [m("user", FAQ_TAP, 0.5), m("assistant", FAQ_ANSWER, 0.48)], NOW);
check("30 min ainda é cedo (mínimo 45 min)", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup("1234567890", [m("user", FAQ_TAP, 23), m("assistant", FAQ_ANSWER, 22.9)], NOW);
check("23h: janela da Meta fechada", !d.eligible && /window-closed/.test(d.reason), d.reason);
d = decideFollowup("wa_15551234567", [m("user", FAQ_TAP, 23), m("assistant", FAQ_ANSWER, 22.9)], NOW);
check("WhatsApp aos 23h ainda dentro (46h)", d.eligible && d.kind === "faq_ghost", d.reason);
d = decideFollowup("1234567890", [...ghost, m("assistant", ghostTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 0.5)], NOW);
check("nunca duas vezes", !d.eligible && d.reason === "already-followed-up", d.reason);
d = decideFollowup("1234567890", [m("user", FAQ_TAP, 2), m("assistant", FAQ_ANSWER, 1.9), m("user", "No thanks", 1)], NOW);
check("cliente com a última palavra não recebe nudge", !d.eligible && d.reason === "client-has-last-word", d.reason);
check("dois toques de botão continuam fantasma", isFaqGhost([m("user", FAQ_TAP, 3), m("assistant", FAQ_ANSWER, 2.9), m("user", "Is installation cost included in the price?", 2), m("assistant", FAQ_ANSWER, 1.9)]));
check("texto digitado NÃO é fantasma", !isFaqGhost([m("user", FAQ_TAP, 3), m("assistant", FAQ_ANSWER, 2.9), m("user", "vinyl for the living room", 2), m("assistant", PRICE_ANSWER, 1.9)]));

console.log("\n── 2. Sumiu depois do preço → after_price com financiamento ──");
const afterPrice = [m("user", "How much for vinyl?", 2), m("assistant", "Which one are you interested in, tile, vinyl, or hardwood?", 1.9), m("user", "Vinyl", 1.5), m("assistant", PRICE_ANSWER, 1.4)];
check("priceWasStated vê o $5", priceWasStated(afterPrice));
d = decideFollowup("1234567890", afterPrice, NOW);
check("elegível como after_price", d.eligible && d.kind === "after_price", JSON.stringify(d));
check("com financiamento", d.financing === true);
d = decideFollowup("1234567890", [...afterPrice, m("user", "I'll think about it and let you know", 1), m("assistant", "No problem, reach out whenever you are ready.", 0.9)], NOW);
check("cliente que adiou continua protegido", !d.eligible, d.reason);
d = decideFollowup("1234567890", [m("user", "Hi", 2), m("assistant", "Which one are you interested in, tile, vinyl, or hardwood?", 1.9), m("user", "get away from me", 1.5), m("assistant", PRICE_ANSWER, 1.4)], NOW);
check("rejeição hostil continua bloqueando", !d.eligible && d.reason === "client-rejected", d.reason);

console.log("\n── 3. Alvo original (oferta de visita) com preço já dito → engaged + financiamento ──");
d = decideFollowup("1234567890", [...afterPrice, m("user", "whole house", 1.2), m("assistant", VISIT_OFFER, 1.1)], NOW);
check("engaged", d.eligible && d.kind === "engaged", JSON.stringify(d));
check("leva financiamento porque o preço foi dito", d.financing === true);
d = decideFollowup("1234567890", [m("user", "Hi", 2), m("assistant", "Which one?", 1.9), m("user", "Vinyl whole house", 1.5), m("assistant", VISIT_OFFER, 1.4)], NOW);
check("engaged SEM preço dito → sem financiamento", d.eligible && d.kind === "engaged" && d.financing === false, JSON.stringify(d));
d = decideFollowup("1234567890", [m("user", "Hi", 2), m("assistant", "Which one?", 1.9), m("user", "Vinyl whole house", 1.5), m("assistant", "Great choice, vinyl is very popular in South Florida.", 1.4)], NOW);
check("última fala sem oferta e sem preço: fora", !d.eligible && d.reason === "last-bot-msg-not-a-scheduling-ask", d.reason);

console.log("\n── 4. Textos: regras do dono (sem traço, sem emoji), marcador de dedup ──");
for (const lang of ["en", "es", "pt"] as Lang[]) {
  for (const [nome, t] of [["ghost", ghostTemplate(lang)], ["financing", financingTemplate(lang)], ["classic", followupTemplate(lang)]] as const) {
    check(`${nome}/${lang} sem traço e sem emoji`, !/[-–—]/.test(t) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t));
    check(`${nome}/${lang} é reconhecido pelo FOLLOWUP_MARKER`, FOLLOWUP_MARKER.test(t));
    check(`${nome}/${lang} tem no máximo 2 frases`, (t.match(/[.!?](\s|$)/g) ?? []).length <= 2, t);
  }
  check(`financing/${lang} fala de financiamento`, /financ/i.test(financingTemplate(lang)));
  check(`financing/${lang} não promete taxa, parcela ou aprovação`, !/%|aprov|approv|\d/.test(financingTemplate(lang)));
}

console.log(`\n${failed === 0 ? `✅ ${passed} checks passed` : `❌ ${failed} failed, ${passed} passed`}`);
process.exit(failed === 0 ? 0 : 1);
