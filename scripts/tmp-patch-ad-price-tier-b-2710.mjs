// 27/10/2026 — AD PRICE CONTEXT (caso Jason): detector, marcador, intercepto, FAQ, regra 32 (ai.ts)
import { applyPatches } from "./tmp-patch-lib.mjs";

const F = "src/lib/ai.ts";

applyPatches([
  // B1. import das constantes novas
  {
    file: F,
    find: String.raw`WHAT_IS_INCLUDED_ASK_TYPE, OPENER_EN,`,
    replace: String.raw`WHAT_IS_INCLUDED_ASK_TYPE, WHAT_IS_INCLUDED_TWO_TIER_ASK, WHAT_IS_INCLUDED_TWO_TIER_VINYL_RESPONSE, INCLUSIONS_TWO_TIER_SENTENCE, AD_PRICE_TIER_NOTE, OPENER_EN,`,
  },
  // B2. detector + marcador + nota
  {
    file: F,
    find: String.raw`function adFlooringTypeFromMarker(text: string): AdFlooringType | null {
  const m = text.match(/\[AD_FLOORING_TYPE:\s*(tile|vinyl|hardwood)\]/i);
  return m ? (m[1].toLowerCase() as AdFlooringType) : null;
}`,
    replace: String.raw`function adFlooringTypeFromMarker(text: string): AdFlooringType | null {
  const m = text.match(/\[AD_FLOORING_TYPE:\s*(tile|vinyl|hardwood)\]/i);
  return m ? (m[1].toLowerCase() as AdFlooringType) : null;
}

// ─── AD PRICE TIER (owner rule 2026-10-27, caso Jason) ──────────────────────
// Our engagement ads show two prices, "$2,350 ❌ materials" and "$5,100 ✅ with
// materials" for 1000 sq ft, and the greeting usually quotes the $2,350. A lead
// who read that and asks "what's included" must hear the contrast (the $2,350
// is the installation only, the $5 per sq ft promo includes the luxury vinyl
// floor, the installation and the quarter round), never the bare "our vinyl
// promo includes the floor" line. The tier is read from the ad's own text (body
// or greeting, via fetchAdCreative) or from the client quoting those numbers.
// Deliberately narrow: only the two figures and the ❌/✅ materials marks.
export type AdPriceTier = "two_tier";
const AD_PRICE_TWO_TIER = /\$\s?2[,.]?350(?!\d)|\$\s?5[,.]?100(?!\d)|❌\s*materia|✅\s*(?:with|con|com)\s*materia|(?<!\d)2[,.]?350\s*(?:for|por|para)\s*(?:the\s+)?1[,.]?000\b/i;
// The herringbone ads carry their own prices ("$4000 ❌ materials / $7600 ✅"):
// their rules live in HERRINGBONE PATTERN, never the two-tier vinyl note.
const AD_HERRINGBONE_AD = /herr?ing\s*bone|harringbone|\$\s?4[,.]?000(?!\d)|\$\s?7[,.]?600(?!\d)/i;

export function detectAdPriceTier(...signals: Array<string | null | undefined>): AdPriceTier | null {
  const blob = signals.filter(Boolean).join(" ");
  if (!blob.trim()) return null;
  if (AD_HERRINGBONE_AD.test(blob)) return null;
  return AD_PRICE_TWO_TIER.test(blob) ? "two_tier" : null;
}

export function adPriceTierFromMarker(text: string): AdPriceTier | null {
  return /\[AD_PRICE_TIER:\s*two_tier\]/i.test(text || "") ? "two_tier" : null;
}

// The tier known for this conversation: the marker the webhooks inject (read
// from the ad's own text), or the client quoting the ad's numbers themselves.
export function conversationAdPriceTier(messages: ChatMessage[]): AdPriceTier | null {
  const last = messages[messages.length - 1];
  if (last && adPriceTierFromMarker(last.content)) return "two_tier";
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.split(/\n\n?\[SYSTEM:/)[0])
    .join(" ");
  return detectAdPriceTier(userText);
}

// The system note the webhooks inject when the tier is known (AD_PRICE_TIER_NOTE
// in system-prompt.ts is the single source of truth; the eval reads it too).
export function adPriceTierNote(): string {
  return AD_PRICE_TIER_NOTE;
}`,
  },
  // B3. intercepto "what's included" tier-aware
  {
    file: F,
    find: String.raw`      if (rule.id === "what_included") {
        // Known type → its exact inclusions.
        if (adType) return whatIsIncludedResponseFor(adType);`,
    replace: String.raw`      if (rule.id === "what_included") {
        // The ad this client saw shows "$2,350 ❌ materials / $5,100 ✅ with
        // materials" (owner rule 2026-10-27, caso Jason): the answer must state
        // the contrast, never the bare "our vinyl promo includes the floor" line
        // that let a client believe the $2,350 covered the vinyl and the quarter
        // round. Vinyl already known + size already stated → the model (same
        // contrast from the AD PRICE CONTEXT note, then the visit or the Ozzi
        // line per the size rules).
        const priceTier = conversationAdPriceTier(messages);
        if (priceTier && adType === "vinyl") return scopeAlreadyStated(messages) ? null : WHAT_IS_INCLUDED_TWO_TIER_VINYL_RESPONSE;
        // Known type → its exact inclusions.
        if (adType) return whatIsIncludedResponseFor(adType);
        if (priceTier && !carpetLead) return WHAT_IS_INCLUDED_TWO_TIER_ASK;`,
  },
  // B4a. cannedFaqReanswer: as 3 leituras do texto passam por "answer"
  {
    file: F,
    find: String.raw`FAQ_REANSWERS[lang][fam]`,
    replace: String.raw`answer`,
    count: 3,
  },
  // B4b. definição de "answer" (tier-aware para inclusions)
  {
    file: F,
    find: String.raw`  const lang = detectLang(t) === "es" ? "es" : "en";
  if (opts?.quick) {`,
    replace: String.raw`  const lang = detectLang(t) === "es" ? "es" : "en";
  // Two-price ad lead (AD PRICE CONTEXT, owner 2026-10-27): the inclusions
  // re-answer states the $2,350 install-only / $5 per sq ft full-promo contrast.
  const answer = fam === "inclusions" && conversationAdPriceTier(messages) ? INCLUSIONS_TWO_TIER_SENTENCE[lang] : FAQ_REANSWERS[lang][fam];
  if (opts?.quick) {`,
  },
  // B5a. primeiro contato: botão de inclusões → linha do anúncio de dois preços
  {
    file: F,
    find: String.raw`      if (!faqPlusTyped && AD_FAQ_INCLUSIONS.test(burst)) {
        console.log("[AI] First contact, ad-FAQ (inclusions) — inclusions ask-type line");
        return { text: WHAT_IS_INCLUDED_ASK_TYPE, inputTokens: 0, outputTokens: 0 };
      }`,
    replace: String.raw`      if (!faqPlusTyped && AD_FAQ_INCLUSIONS.test(burst)) {
        // Two-price ad (AD PRICE CONTEXT, owner 2026-10-27, caso Jason): the
        // client just read "$2,350", so the line states the contrast, never the
        // bare "our vinyl promo includes the floor" answer.
        if (conversationAdPriceTier(messages)) {
          console.log("[AI] First contact, ad-FAQ (inclusions) — two-price ad line ($2,350 install only / $5 per sq ft full promo)");
          return { text: WHAT_IS_INCLUDED_TWO_TIER_ASK, inputTokens: 0, outputTokens: 0 };
        }
        console.log("[AI] First contact, ad-FAQ (inclusions) — inclusions ask-type line");
        return { text: WHAT_IS_INCLUDED_ASK_TYPE, inputTokens: 0, outputTokens: 0 };
      }`,
  },
  // B5b. rajada de vários botões: fragmento de inclusões tier-aware
  {
    file: F,
    find: String.raw`        const combined = composeAdFaqOpener(topics, lang);`,
    replace: String.raw`        const combined = composeAdFaqOpener(topics, lang, { twoTier: !!conversationAdPriceTier(messages) });`,
  },
  // B6. regra 32: os dois números do nosso anúncio não são "mismatch"
  {
    file: F,
    find: String.raw`32. AD PRICE MISMATCH RULE: If the client quotes a price they saw in one of our ads ("the ad says $2,350 for 1000 sqft", "the promotion mentioned $2,300") that does NOT match the promotions in these rules,`,
    replace: String.raw`32. AD PRICE MISMATCH RULE: Our own ads show exactly two figures, "$2,350 for 1000 sq ft without materials" and "$5,100 for 1000 sq ft with materials". When the client quotes one of THOSE, it is ours: confirm it plainly, the $2,350 is the installation only (they supply the floor) and the $5,100 line is our $5 per square foot promo with the luxury vinyl floor, the installation and the quarter round included, then continue the normal flow with the size rules unchanged. If the client quotes any OTHER price they saw in an ad ("the promotion mentioned $2,300", "$4,500 for 1000 sqft") that does NOT match the promotions in these rules,`,
  },
  // B7. nota de primeira mensagem: exceção quando o contexto de preço está presente
  {
    file: F,
    find: String.raw`For what is included, say it depends on the floor: the vinyl promo includes the material, the labor and the quarter round, tile and hardwood are labor only.",`,
    replace: String.raw`For what is included, say it depends on the floor: the vinyl promo includes the material, the labor and the quarter round, tile and hardwood are labor only. EXCEPTION, AD PRICE CONTEXT: when the system note carries [AD PRICE CONTEXT ...], the client's ad showed $2,350 for 1000 sq ft without materials and $5,100 with materials, so for what is included say that the $2,350 is the installation only, they supply the floor, and that the $5 per sq ft promo is the one that includes the luxury vinyl floor, the installation and the quarter round.",`,
  },
]);
