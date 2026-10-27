// 27/10/2026 — AD PRICE CONTEXT: backstop determinístico "$5 per sq ft" (1 em 3 rodadas ao vivo dizia só "$5,100") + nota mais firme
import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  // G1. nota: as palavras literais "$5 per sq ft"; "$5,100" sozinho não basta
  {
    file: "src/lib/system-prompt.ts",
    find: String.raw`then name the full promo as \"$5 per sq ft\" (in Spanish \"$5 por sq ft\", in Portuguese \"$5 por sq ft\"), optionally adding that it is the $5,100 line of the ad.`,
    replace: String.raw`then name the full promo with the literal words \"$5 per sq ft\" (in Spanish and Portuguese \"$5 por sq ft\"); \"$5,100\" alone is NOT enough, it may only be added after the $5 per sq ft.`,
  },
  // G2. função de backstop ao lado da nota
  {
    file: "src/lib/ai.ts",
    find: String.raw`export function adPriceTierNote(): string {
  return AD_PRICE_TIER_NOTE;
}`,
    replace: String.raw`export function adPriceTierNote(): string {
  return AD_PRICE_TIER_NOTE;
}

// Deterministic guarantee of the owner's phrase (2026-10-27): when the client
// saw the two-price ad and the reply names the full promo only as "$5,100", the
// "$5 per sq ft" wording goes in and the $5,100 stays as the ad's line. With the
// note injected, 1 of 3 live runs still said "The $5,100 includes the vinyl...".
const FIVE_PER_SQFT_RE = /\$\s?5(?:\.00)?\s*(?:per|por|a|al|\/)\s*(?:sq|square|pie|p[eé]|sqft)/i;
export function fixTwoTierPromoWording(text: string, lang: "en" | "es" | "pt" = "en"): string {
  if (!/\$\s?5,?100(?!\d)/.test(text) || FIVE_PER_SQFT_RE.test(text)) return text;
  const per = lang === "en" ? "$5 per sq ft ($5,100 for 1000 sq ft)" : "$5 por sq ft ($5,100 por 1000 sq ft)";
  return text.replace(/\$\s?5,?100(?!\d)(?:\s+(?:for|por|para)\s+(?:the\s+|los\s+|unos\s+)?1,?000\s*(?:sq\.?\s?(?:ft|feet)\.?|square\s+feet|pies(?:\s+cuadrados)?|p[eé]s(?:\s+quadrados)?))?/i, per);
}`,
  },
  // G3. gancho no pipeline, depois do backstop de herringbone
  {
    file: "src/lib/ai.ts",
    find: String.raw`    // Website link (owner, 2026-09-22): any spelling of the old
    // www.ozzifloors.com the model copied from older turns becomes the
    // canonical https://ozzifloors.company before anything else looks at it.
    cleaned = canonicalizeSiteLink(cleaned);`,
    replace: String.raw`    // Anúncio de dois preços (dono, 27/10/2026): a promo completa sai como
    // "$5 per sq ft", nunca só como "$5,100" (1 em 3 rodadas ao vivo).
    if (process.env.TWO_TIER_BACKSTOP !== "off" && conversationAdPriceTier(messages)) {
      const fixed = fixTwoTierPromoWording(cleaned, usersLang());
      if (fixed !== cleaned) {
        cleaned = fixed;
        console.log("[AI] two-price ad backstop: the reply named the full promo only as $5,100, now $5 per sq ft");
      }
    }

    // Website link (owner, 2026-09-22): any spelling of the old
    // www.ozzifloors.com the model copied from older turns becomes the
    // canonical https://ozzifloors.company before anything else looks at it.
    cleaned = canonicalizeSiteLink(cleaned);`,
  },
]);
