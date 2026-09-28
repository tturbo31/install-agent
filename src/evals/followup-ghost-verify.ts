// Follow-up de 17/09/2026 (fantasma do botão, sumiu depois do preço com
// financiamento), com a cadência do dono de 27/09/2026: só depois de 2 dias de
// silêncio, só WhatsApp (a janela da Meta fecha antes), 2ª e última nudge 2 dias
// depois. Só funções puras: zero API, zero envio.
// Run: npx tsx src/evals/followup-ghost-verify.ts
import {
  decideFollowup,
  ghostTemplate,
  financingTemplate,
  followupTemplate,
  lastTouchTemplate,
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

const NOW = Date.parse("2026-09-27T18:00:00Z"); // 14h ET
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const m = (role: "user" | "assistant", content: string, hoursAgo: number): FollowupMsg => ({ role, content, created_at: at(hoursAgo) });
const WA = "wa_15551234567";

const FAQ_TAP = "What is the installation process?";
const FAQ_ANSWER = "We move all the furniture, install the floors, add the quarter round, and clean everything up when we finish. Which flooring are you thinking about, tile, vinyl, or hardwood?";
const PRICE_ANSWER = "Our vinyl promo is $5 per sqft and that already includes the flooring, the installation labor, and the quarter round. Are you planning to do just one area, or will it be the entire house?";
const VISIT_OFFER = "For a whole house I need to come measure in person to give you the best price, and I bring all the floor samples so you can pick right there. I have Tuesday at 9am or 1pm, what works better for you?";

console.log("\n── 1. Fantasma do botão: toque + resposta automática + 2 dias de silêncio (WhatsApp) ──");
const ghost = (h: number) => [m("user", FAQ_TAP, h), m("assistant", FAQ_ANSWER, h - 0.02)];
check("isFaqGhost reconhece", isFaqGhost(ghost(50)));
let d = decideFollowup(WA, ghost(50), NOW);
check("elegível como faq_ghost aos 50h", d.eligible && d.kind === "faq_ghost", JSON.stringify(d));
check("sem financiamento (preço nunca foi dito)", d.financing === false);
d = decideFollowup(WA, ghost(1), NOW);
check("1h ainda é cedo (mínimo 48h desde 27/09)", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup(WA, ghost(23), NOW);
check("23h ainda é cedo", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup("1234567890", ghost(50), NOW);
check("Instagram: nunca (a janela de 24h da Meta fecha antes dos 2 dias)", !d.eligible && d.reason === "channel-window-closes-before-2-days", d.reason);
d = decideFollowup("fb_1234567890", ghost(50), NOW);
check("Messenger: nunca", !d.eligible && d.reason === "channel-window-closes-before-2-days", d.reason);
d = decideFollowup(WA, [...ghost(100), m("assistant", ghostTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 49)], NOW);
check("2 dias depois da 1ª nudge sem resposta → 2ª e última (last_touch)", d.eligible && d.kind === "last_touch", d.reason);
d = decideFollowup(WA, [...ghost(100), m("assistant", ghostTemplate("en") + "\n\n[SYSTEM: FOLLOWUP_NUDGE]", 60), m("assistant", lastTouchTemplate("en"), 10)], NOW);
check("nunca uma 3ª", !d.eligible && d.reason === "max-nudges-reached", d.reason);
d = decideFollowup(WA, [m("user", FAQ_TAP, 60), m("assistant", FAQ_ANSWER, 59.9), m("user", "No thanks", 50)], NOW);
check("cliente com a última palavra não recebe nudge", !d.eligible && d.reason === "client-has-last-word", d.reason);
check("dois toques de botão continuam fantasma", isFaqGhost([m("user", FAQ_TAP, 3), m("assistant", FAQ_ANSWER, 2.9), m("user", "Is installation cost included in the price?", 2), m("assistant", FAQ_ANSWER, 1.9)]));
check("texto digitado NÃO é fantasma", !isFaqGhost([m("user", FAQ_TAP, 3), m("assistant", FAQ_ANSWER, 2.9), m("user", "vinyl for the living room", 2), m("assistant", PRICE_ANSWER, 1.9)]));

console.log("\n── 2. Sumiu depois do preço → after_price com financiamento (2 dias) ──");
const afterPrice = (h: number) => [m("user", "How much for vinyl?", h + 0.5), m("assistant", "Which one are you interested in, tile, vinyl, or hardwood?", h + 0.4), m("user", "Vinyl", h), m("assistant", PRICE_ANSWER, h - 0.05)];
check("priceWasStated vê o $5", priceWasStated(afterPrice(50)));
d = decideFollowup(WA, afterPrice(50), NOW);
check("elegível como after_price", d.eligible && d.kind === "after_price", JSON.stringify(d));
check("com financiamento", d.financing === true);
d = decideFollowup(WA, afterPrice(2), NOW);
check("2h depois do preço: cedo demais", !d.eligible && /too-fresh/.test(d.reason), d.reason);
d = decideFollowup(WA, [...afterPrice(60), m("user", "I'll think about it and let you know", 55), m("assistant", "No problem, reach out whenever you are ready.", 54.9)], NOW);
check("cliente que adiou continua protegido", !d.eligible, d.reason);
d = decideFollowup(WA, [m("user", "Hi", 60), m("assistant", "Which one are you interested in, tile, vinyl, or hardwood?", 59.9), m("user", "get away from me", 55), m("assistant", PRICE_ANSWER, 54.9)], NOW);
check("rejeição hostil continua bloqueando", !d.eligible && d.reason === "client-rejected", d.reason);

console.log("\n── 3. Alvo original (oferta de visita) com preço já dito → engaged + financiamento ──");
d = decideFollowup(WA, [...afterPrice(60), m("user", "whole house", 55), m("assistant", VISIT_OFFER, 54.9)], NOW);
check("engaged", d.eligible && d.kind === "engaged", JSON.stringify(d));
check("leva financiamento porque o preço foi dito", d.financing === true);
d = decideFollowup(WA, [m("user", "Hi", 60), m("assistant", "Which one?", 59.9), m("user", "Vinyl whole house", 55), m("assistant", VISIT_OFFER, 54.9)], NOW);
check("engaged SEM preço dito → sem financiamento", d.eligible && d.kind === "engaged" && d.financing === false, JSON.stringify(d));
d = decideFollowup(WA, [m("user", "Hi", 60), m("assistant", "Which one?", 59.9), m("user", "Vinyl whole house", 55), m("assistant", "Great choice, vinyl is very popular in South Florida.", 54.9)], NOW);
check("última fala sem oferta e sem preço: fora", !d.eligible && d.reason === "last-bot-msg-not-a-scheduling-ask", d.reason);

console.log("\n── 4. Textos: regras do dono (sem traço, sem emoji, curtos), marcador de dedup ──");
for (const lang of ["en", "es", "pt"] as Lang[]) {
  for (const [nome, t] of [["ghost", ghostTemplate(lang)], ["financing", financingTemplate(lang)], ["classic", followupTemplate(lang)], ["last", lastTouchTemplate(lang)]] as const) {
    check(`${nome}/${lang} sem traço e sem emoji`, !/[-–—]/.test(t) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t));
    check(`${nome}/${lang} é reconhecido pelo FOLLOWUP_MARKER`, FOLLOWUP_MARKER.test(t));
    check(`${nome}/${lang} tem no máximo 2 frases e até 170 caracteres`, (t.match(/[.!?](\s|$)/g) ?? []).length <= 2 && t.length <= 170, `${t.length}c: ${t}`);
    check(`${nome}/${lang} não promete "esta semana" nem nomeia dia/hora`, !/this week|esta semana|\b\d{1,2}\s*(?:am|pm)\b/i.test(t));
  }
  check(`financing/${lang} fala de financiamento`, /financ/i.test(financingTemplate(lang)));
  check(`financing/${lang} não promete taxa, parcela ou aprovação`, !/%|aprov|approv|\d/.test(financingTemplate(lang)));
}
check("marcadores antigos (nudges já gravadas) continuam reconhecidos", FOLLOWUP_MARKER.test("Hi, want me to check a time this week for your free estimate visit? I bring all the samples and you get the exact price on the spot.") && FOLLOWUP_MARKER.test("Hi, just checking in, want me to get your free estimate visit scheduled?"));

console.log(`\n${failed === 0 ? `✅ ${passed} checks passed` : `❌ ${failed} failed, ${passed} passed`}`);
process.exit(failed === 0 ? 0 : 1);
