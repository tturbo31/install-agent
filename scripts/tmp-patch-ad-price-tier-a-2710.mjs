// 27/10/2026 — AD PRICE CONTEXT (caso Jason): constantes + opener combinado + regra do prompt (system-prompt.ts)
import { applyPatches } from "./tmp-patch-lib.mjs";

const F = "src/lib/system-prompt.ts";

applyPatches([
  // A1. constantes novas logo após a enlatada ASK_TYPE
  {
    file: F,
    find: String.raw`export const WHAT_IS_INCLUDED_ASK_TYPE = "Hi, our vinyl promo includes the floor, the installation and the quarter round, tile and hardwood are labor only, you supply the material. Which one are you interested in?";`,
    replace: String.raw`export const WHAT_IS_INCLUDED_ASK_TYPE = "Hi, our vinyl promo includes the floor, the installation and the quarter round, tile and hardwood are labor only, you supply the material. Which one are you interested in?";

// AD PRICE CONTEXT (owner rule 2026-10-27, caso Jason, Messenger): every active
// engagement ad shows TWO prices in its body, "1000 sq.ft. FOR JUST $2,350 ❌
// materials" and "1000 sq.ft. ONLY $5,100 ✅ with materials", and most of the
// greetings the client reads first quote the $2,350 ("starting at $2,350",
// "$2,350 for 1000 sq.ft. labor only"). The seller arrived at a house where the
// client believed the $2,350 already covered the vinyl, the quarter round and
// the labor: the bot had answered "our vinyl promo includes the floor, the
// installation and the quarter round" to someone who had just read "$2,350".
// Owner: the bot must read what the ad (the first message of the conversation)
// promised, say that the $2,350 is the installation only and that the $5 per
// sq ft promo is the one that includes the labor, the luxury vinyl floor and
// the quarter round.
export const AD_PRICE_TIER_MARKER = "[AD_PRICE_TIER: two_tier]";
export const AD_PRICE_TIER_NOTE =
  AD_PRICE_TIER_MARKER +
  "\n[AD PRICE CONTEXT, READ BEFORE ANSWERING WHAT IS INCLUDED: the ad this client came from shows TWO prices, \"1000 sq.ft. FOR JUST $2,350 ❌ materials\" and \"1000 sq.ft. ONLY $5,100 ✅ with materials\", and its greeting may say \"starting at $2,350\" or \"$2,350 for 1000 sq.ft. labor only\". The client has that $2,350 in mind. FACTS: the $2,350 for 1000 sq ft is the INSTALLATION ONLY, the client supplies the floor, it includes NO flooring material and NO quarter round. The promo that includes everything is $5 per square foot: the luxury vinyl floor, the installation labor and the quarter round (that is the $5,100 line). Whenever the client asks what is included, what materials are included, whether labor or installation is extra, whether the price includes the floor, or treats the $2,350 as the full package, answer with that contrast in one or two short sentences, in their language: the $2,350 is the installation only, you supply the floor, and the full promo at $5 per sq ft includes the luxury vinyl floor, the installation and the quarter round. NEVER let them believe the $2,350 covers the vinyl or the quarter round, and never send the bare \"our vinyl promo includes the floor, the installation and the quarter round\" line to this client without the $2,350 clarification. Both numbers are OUR ad: never call them wrong, a mismatch or a different promotion, never recompute them into a per sq ft rate, and never contrast the $2,350 with another installation-only rate. Tile and hardwood are not this promo: if the client wants tile or hardwood, their labor-only rules apply as usual. Every size rule stays: 500 sq ft or more gets no total and the free in-person visit, under 400 sq ft gets Ozzi directly at (561) 674-8334.]";

// The canned "what's included" lines for a lead whose ad showed the two prices:
// type still unknown (the first-contact FAQ button and the intercept) and vinyl
// already known. Both state the contrast the owner asked for, in two short
// sentences plus the forward question.
export const WHAT_IS_INCLUDED_TWO_TIER_ASK = "Hi, the $2,350 for 1000 sq ft is the installation only, you supply the floor. Our full promo is $5 per sq ft and that one includes the luxury vinyl floor, the installation and the quarter round. Which option are you leaning toward?";
export const WHAT_IS_INCLUDED_TWO_TIER_VINYL_RESPONSE = "Hello, the $2,350 for 1000 sq ft is the installation only, you supply the floor. Our full promo is $5 per sq ft and that one includes the luxury vinyl floor, the installation and the quarter round. I offer a free quote, are you planning to do just one area, or the entire house?";
// Same contrast as a FAQ re-answer sentence (EN and ES, like the other FAQ
// texts; Meta's buttons are EN/ES).
export const INCLUSIONS_TWO_TIER_SENTENCE = {
  en: "The $2,350 for 1000 sq ft is the installation only, you supply the floor. Our full promo at $5 per sq ft includes the luxury vinyl floor, the installation and the quarter round.",
  es: "Los $2,350 por 1000 sq ft son solo la instalacion, tu pones el piso. Nuestra promo completa a $5 por sq ft incluye el piso vinilico de lujo, la instalacion y el quarter round.",
} as const;`,
  },
  // A2a. fragmento de inclusões para o anúncio de dois preços
  {
    file: F,
    find: String.raw`const AD_FAQ_TYPE_ASK = {
  en: "Which one is it, tile, vinyl, or hardwood?",
  es: "Cuál te interesa, tile, vinyl o hardwood?",
};`,
    replace: String.raw`const AD_FAQ_TYPE_ASK = {
  en: "Which one is it, tile, vinyl, or hardwood?",
  es: "Cuál te interesa, tile, vinyl o hardwood?",
};
// Inclusions clause for the two-price ad (see AD_PRICE_TIER_NOTE above): the
// $2,350 install-only / $5 per sq ft full-promo contrast (owner, 2026-10-27).
const AD_FAQ_TWO_TIER_INCLUSIONS: Record<"en" | "es", string> = {
  en: "the $2,350 for 1000 sq ft is the installation only, you supply the floor, and our full promo at $5 per sq ft includes the luxury vinyl floor, the installation and the quarter round",
  es: "los $2,350 por 1000 sq ft son solo la instalación, tú pones el piso, y nuestra promo completa a $5 por sq ft incluye el piso vinílico de lujo, la instalación y el quarter round",
};`,
  },
  // A2b. composeAdFaqOpener aceita o contexto de preço
  {
    file: F,
    find: String.raw`export function composeAdFaqOpener(topics: AdFaqTopic[], lang: "en" | "es"): string | null {
  const wanted = AD_FAQ_TOPIC_ORDER.filter((t) => topics.includes(t));
  if (wanted.length < 2) return null;
  const frag = AD_FAQ_FRAGMENTS[lang];`,
    replace: String.raw`export function composeAdFaqOpener(topics: AdFaqTopic[], lang: "en" | "es", opts?: { twoTier?: boolean }): string | null {
  const wanted = AD_FAQ_TOPIC_ORDER.filter((t) => topics.includes(t));
  if (wanted.length < 2) return null;
  // Two-price ad (AD PRICE CONTEXT): the inclusions clause states the $2,350
  // install-only / $5 per sq ft full-promo contrast instead of the generic one.
  const frag: Record<AdFaqTopic, string> = opts?.twoTier
    ? { ...AD_FAQ_FRAGMENTS[lang], inclusions: AD_FAQ_TWO_TIER_INCLUSIONS[lang] }
    : AD_FAQ_FRAGMENTS[lang];`,
  },
  // A3. seção WHAT IS INCLUDED do prompt: exceção quando a nota de preço está presente
  {
    file: F,
    find: String.raw`CRITICAL: this answer is the VINYL offer (material included). If the flooring type is still UNKNOWN, do NOT give it (tile and hardwood include NO material, only labor). Instead ask which type they want: tile, vinyl, or hardwood. If you already know they want TILE or HARDWOOD, say that the promotion covers the installation labor only and they provide the material.`,
    replace: String.raw`CRITICAL: this answer is the VINYL offer (material included). If the flooring type is still UNKNOWN, do NOT give it (tile and hardwood include NO material, only labor). Instead ask which type they want: tile, vinyl, or hardwood. If you already know they want TILE or HARDWOOD, say that the promotion covers the installation labor only and they provide the material.
AD PRICE CONTEXT EXCEPTION: when the system note carries [AD PRICE CONTEXT ...], the client's ad showed "$2,350 for 1000 sq ft without materials" and "$5,100 with materials", so do NOT use the response above: answer that the $2,350 is the installation only (they supply the floor) and that the $5 per sq ft promo is the one that includes the luxury vinyl floor, the installation and the quarter round, exactly as that note says, and never let them believe the $2,350 covers the vinyl or the quarter round.`,
  },
]);
