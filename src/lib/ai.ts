import { zipsInText, cityAliasZip } from "./geo/zip-geo";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { SYSTEM_PROMPT, WHAT_IS_INCLUDED_RESPONSE, WHAT_IS_INCLUDED_TILE_RESPONSE, WHAT_IS_INCLUDED_HARDWOOD_RESPONSE, WHAT_IS_INCLUDED_ASK_TYPE, OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LANG_EN, OPENER_LANG_ES, OPENER_LANG_PT, OPENER_PROCESS_EN, OPENER_PROCESS_ES, OPENER_DISCOUNT_EN, OPENER_DISCOUNT_ES, OPENER_LOCATION_EN, OPENER_LOCATION_ES, OPENER_LOCATION_PT, composeAdFaqOpener, type AdFaqTopic } from "@/lib/system-prompt";
import { clientConfirmedSlot, detectLang, repairDeclineMessage } from "@/lib/scheduler";
import { stripInvertedPunctuation } from "@/lib/outbound-text";

// ─── Anthropic client (Claude) ─────────────────────────────────────────────
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      // Self-heal transient failures (overloaded 529, rate-limit 429, 5xx,
      // network drops) automatically before the webhook falls back to the
      // "team will reach out" handoff. The SDK retries with exponential backoff.
      // Non-retryable errors (e.g. 400 "credit balance too low") fail fast.
      maxRetries: 4,
      timeout: 30_000,
    });
  }
  return _anthropic;
}

// True when the API rejected us because the Anthropic account is out of credits.
// This is NOT a code bug and NOT transient — the owner must top up billing.
// Surfaced loudly so it is unmistakable in the logs and owner alerts.
export function isLowCreditError(err: unknown): boolean {
  const e = err as { status?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.status === 400 && (msg.includes("credit balance") || msg.includes("plans & billing"));
}

// Owner-facing WhatsApp alert when the bot is down because the Anthropic account
// ran out of credits. Plain ASCII (Z-API friendly), no emoji/accents required.
export const CREDIT_ALERT =
  "A IA esta SEM CREDITOS na Anthropic e NAO responde nenhum cliente. Adicione creditos AGORA em console.anthropic.com (Plans & Billing). Depois clique em Reativar todas no painel.";

// ─── OpenAI client (Whisper + TTS only) ───────────────────────────────────
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }
  return _openai;
}

// `at` (ISO timestamp) is optional context the webhooks attach from the DB —
// used ONLY by the repeated-message intercept to tell a button double-tap
// (seconds apart) from a genuine re-ask hours later. Never sent to the API.
export type ChatMessage = { role: "user" | "assistant"; content: string; at?: string };

// ─── Hard-coded intercepts — bypass AI for specific question patterns ─────────
// These override the AI completely because the model cannot be reliably
// instructed to omit pricing from "what's included" type questions.

const HARDCODED_RESPONSES: Array<{ id?: string; patterns: RegExp[]; response: string; skipIfSubstantive?: boolean }> = [
  {
    // PRICE NEGOTIATION / COMPETITOR QUOTE — owner rule (2026-07-08): the bot
    // must NEVER commit to beating or matching a price (it once wrote "I can
    // beat that $3.99 quote" for a rate the business cannot do). Instead: tell
    // the client the team will check the space and see about a better number,
    // and notify BOTH owners so a human runs the negotiation. Response is
    // language-matched in checkHardcodedResponse (id-based special case).
    id: "price_negotiation",
    patterns: [
      // "another company / other contractor ... $X / cheaper / lower price"
      /\b(?:another|other|different)\s+(?:company|contractor|installer|guy|guys|place|crew)\b[^.!?]{0,80}?(?:\$\s?\d|price|quote|cheaper|less|lower)/i,
      // "they quoted (me) 3.99 per square foot" / "someone offered me $4"
      /\b(?:they|he|she|someone|company|competitor)\s+(?:quoted|offered|gave)\s+(?:me\s+|us\s+)?\$?\s?\d/i,
      /\bquoted\s+(?:me\s+|us\s+)?\$?\s?\d+(?:\.\d{1,2})?\s*(?:per|a|\/)\s*(?:sq|square)/i,
      // direct asks to go lower / match / beat
      /\bcan\s+(?:you|u)\s+(?:go|do|get|make\s+it)\s+(?:any\s+)?(?:lower|cheaper|better|less)\b/i,
      /\b(?:match|beat)\s+(?:that|their|the)\s+(?:price|quote|offer|number)\b/i,
      /\b(?:lower|drop|reduce|bring\s+down)\s+(?:the\s+|your\s+)?price\b/i,
      /\bbest\s+price\s+you\s+can\s+(?:do|give|offer)\b/i,
      // Spanish
      /\b(?:otra|otro)\s+(?:compa[ñn][ií]a|empresa|contratista)\b[^.!?]{0,80}?(?:\$|precio|cotiz|m[aá]s\s+barat)/i,
      /\bme\s+(?:cotizaron|ofrecieron|dieron)\s+(?:a\s+)?\$?\s?\d/i,
      /\b(?:bajar|rebajar|mejorar)\s+(?:el\s+)?precio\b/i,
      /\bpuede[ns]?\s+(?:hacer(?:lo)?\s+)?m[aá]s\s+barato\b/i,
      // Portuguese
      /\boutra\s+empresa\b[^.!?]{0,80}?(?:\$|pre[çc]o|or[çc]amento|mais\s+barat)/i,
      /\b(?:baixar|abaixar|melhorar)\s+o\s+(?:pre[çc]o|valor)\b/i,
      /\bme\s+(?:passaram|deram|cotaram)\s+\$?\s?\d/i,
    ],
    response: "", // resolved per-language in checkHardcodedResponse
  },
  {
    id: "what_included",
    patterns: [
      /what\s+is\s+included/i,
      /what('s|\s+is)\s+in(cluded)?\s*(in)?\s*the\s+(materials?\s+)?package/i,
      /what\s+does\s+the\s+package\s+(include|cover|come\s+with)/i,
      /what\s+comes?\s+with\s+(it|the\s+package)/i,
      /is\s+(labor|installation)\s+included/i,
      /does\s+(it|the\s+package)\s+include\s+(labor|installation)/i,
      /what\s+does?\s+(it|that)\s+include/i,
      // Meta ad FAQ variants (2026-07-15/17 reviews): inclusions questions, same
      // flow. "installation cost included in the price" and "what type of
      // materials are included" escaped the router for 8 leads in 3 days.
      /\b(?:labor|installation)\s+(?:cost\s+)?(?:extra|included|also)\b/i,
      /\bis\s+(?:the\s+)?(?:labor|installation)\s+cost\b/i,
      /\bwhat\s+(?:kind|type)s?\s+of\s+materials?\s+(?:are\s+|is\s+)?included\b/i,
    ],
    response: WHAT_IS_INCLUDED_RESPONSE,
  },
  {
    // Portuguese: client asking to see photos / samples / catalog
    patterns: [
      /[nm]e\s+(envi[ae]|mand[ae]|mostr[ae])\s+.{0,25}(foto|imagem|amostra|cat[aá]logo|op[cç][aã]o)/i,
      /conseg[ue]{1,2}\s+.{0,10}(enviar?|mandar?|mostrar?)\s+.{0,20}(foto|imagem|amostra)/i,
      /enviar?\s+.{0,10}(fotos?|imagens?|amostra)/i,
      /tem\s+(alguma\s+)?(foto|imagem|amostra|cat[aá]logo)/i,
      /(foto|imagem|amostra)s?\s+(dos?\s+|de\s+)?(piso|ch[aã]o|vinyl|lvp|op[cç][aã]o)/i,
      /quer\s+ver\s+.{0,25}(foto|imagem|amostra|op[cç][aã]o)/i,
      /ver\s+.{0,15}(foto|imagem|amostra|op[cç][aã]o)s?/i,
      /qual\s+(é\s+o\s+)?visual\s+(dos?\s+)?(piso|ch[aã]o|vinyl)/i,
      /(foto|imagem|amostra|cat[aá]logo)\s+dos?\s+(pisos?|chão|ch[aã]o|op[cç])/i,
    ],
    id: "see_options_pt",
    // Regra do dono (2026-07-27): pedido de amostras/fotos → manda o LINK DO
    // SITE direto (antes era redirect pro WhatsApp da equipe).
    response: "Claro! Você pode ver nossos pisos em https://www.ozzifloors.com, e eu também levo todas as amostras na visita grátis para você comparar direto no seu piso. É só uma área ou a casa toda?",
    skipIfSubstantive: true,
  },
  {
    // English: client asking to see photos / samples / catalog / material options
    patterns: [
      // Only intercept when client asks AGENT to send photos — NOT "send me a quote" or "I'll send you a photo"
      /send\s+me\s+(?!.{0,30}(?:quote|estimate|price|cost|approx|message|info))(photos?|images?|pics?|samples?|catalogs?)/i,
      /(?:can|could|would|please)\s+(?:you\s+)?send\s+(?!.{0,30}(?:quote|estimate|price|cost)).{0,60}(photos?|images?|pics?|samples?|catalogs?)/i,
      /would\s+like\s+(?:you\s+to\s+)?send\s+me\s+(?!.{0,20}(?:quote|estimate|price|cost|approx))(photos?|images?|samples?)/i,
      /like\s+to\s+(?:see|view|receive|get)\s+.{0,40}(photos?|images?|samples?)/i,
      /can\s+you\s+(?:send|show|share)\s+.{0,40}(photos?|images?|pics?|samples?|catalogs?)/i,
      /do\s+you\s+have\s+(?:any\s+)?(photos?|images?|pics?|samples?|catalogs?)/i,
      /show\s+me\s+(?:your\s+)?(floor|option|color|sample|catalog)/i,
      /photos?\s+of\s+(?:the\s+)?(floor|tile|vinyl|option|samples?)\s+(?:you\s+have\s+)?available/i,
      /samples?\s+(?:you\s+have\s+)?available/i,
      /what\s+do\s+(?:the\s+)?floors?\s+look\s+like/i,
      /colors?\s+(?:do\s+you\s+have|options?|available)/i,
      // Material / flooring options questions
      /material\s+options?/i,
      /(?:floor|flooring)\s+options?/i,
      /what\s+(?:are\s+(?:the|your)|options?\s+do\s+you\s+have).{0,30}(?:material|floor|option|color|style|product)/i,
      /what\s+(?:kind|type)s?\s+of\s+(?:floor|flooring|material|vinyl|product)/i,
      /what\s+options?\s+(?:do\s+you\s+have|are\s+(?:available|there))/i,
      /(?:available|offer(?:ed)?)\s+(?:floor|flooring|material|color|style)\s+options?/i,
      // "Do you have / carry / sell a specific floor / color / style?"
      /do\s+you\s+(?:have|carry|sell|offer|got|stock)\s+(?!.{0,20}(?:warranty|guarantee|financ|appointment|time|slot))(?:any\s+|some\s+|a\s+|the\s+)?(?:\w+\s+){0,3}(floor|flooring|vinyl|lvp|colou?r|style|option|wood|marble|grey|gray|plank|laminate|hardwood|design|pattern|finish)/i,
      /what\s+(?:do\s+you\s+(?:have|carry|sell|offer|got)|(?:kinds?|types?|colou?rs?|styles?|options?|designs?|finishes?)\s+(?:do\s+you|are\s+(?:available|there)))/i,
    ],
    id: "see_options_en",
    // Owner rule (2026-07-27): samples/photos requests get the WEBSITE link
    // directly (was: redirect to the team's WhatsApp).
    response: "Of course! You can see our floors at https://www.ozzifloors.com, and I also bring all the samples to your free visit so you can compare them right on your floor. Is it just one area or the whole house?",
    skipIfSubstantive: true,
  },
  {
    // Client who already had an in-person visit wants to negotiate the quoted price
    patterns: [
      // Portuguese patterns
      /negoci[ao]/i,
      /quero\s+(discutir|falar|conversar)\s+(sobre\s+)?(os?\s+)?(valor|pre[cç]o|or[cç]amento)/i,
      /or[cç]amento\s+(que|da\s+visit|j[aá]\s+foi|feito|que\s+voc)/i,
      /valor(es)?\s+(do|da|que|j[aá])/i,
      /j[aá]\s+(fiz|fizemos|fizeram|foi\s+feito)\s+(o\s+)?or[cç]amento/i,
      /j[aá]\s+tiv(e|emos)\s+(a\s+)?visit/i,
      /depois\s+da\s+visit/i,
      /sobre\s+o\s+or[cç]amento/i,
      /o\s+pre[cç]o\s+(que|do)/i,
      // English patterns
      /negotiate\s+(the\s+)?(price|quote|cost|value|estimate)/i,
      /(discuss|talk\s+about|go\s+over)\s+(the\s+)?(price|quote|estimate|value|cost)/i,
      /the\s+(quote|estimate|price)\s+(from|you\s+gave|we\s+discussed|after)/i,
      /after\s+the\s+(visit|in.?person)/i,
      /from\s+the\s+(visit|in.?person|quote)/i,
      /you\s+(visited|came\s+to)\s+my/i,
      /already\s+(got|have|received)\s+a\s+(quote|estimate|price)/i,
      /want\s+to\s+negotiate/i,
    ],
    response: "I'll make sure our team reaches out to you directly to go over all the details from your visit. You'll hear from us very shortly![NOTIFY_OWNER]",
  },
];

// A genuine product question (suitability, durability, climate, recommendation,
// etc.) must be ANSWERED, never deflected to a canned "browse the website" reply.
const SUBSTANTIVE_PRODUCT_Q = /\b(suitable|suit\b|water\s?proof|durab|humid|climate|moisture|weather|tropical|recommend|advise|hold(s)?\s+up|warranty|wear\s*layer|\bmil\b|\bpet|scratch|works?\s+(in|for|with|outside|outdoor)|used?\s+(in|for|outside|outdoor)|install\s+over|over\s+(tile|wood|concrete)|subfloor|good\s+(for|in)|ok\s+(for|in)|fine\s+(for|in)|right\s+for|can\s+(this|it|i)\s+(be\s+)?(use|install|put)|is\s+(this|it)\s+(good|ok|fine|safe|suitable)|how\s+(thick|durable|long)|bathroom|kitchen|basement|outdoor)\b/i;

// "What IS the product / material?" questions. These must be ANSWERED with the
// luxury-vinyl description (handled by the AI per the MATERIAL vs SEE rule), NOT
// deflected to the "see our options" WhatsApp redirect. This is the screenshot
// bug: "what kind of materials, what is the material allowance?" was redirected
// to a link instead of getting the product description. Deliberately does NOT
// match "colors", "photos", "samples", "show me" — those still redirect.
const PRODUCT_TYPE_Q = new RegExp(
  [
    /what\s+(?:kind|type|sort)s?\s+of\s+(?:material|floor|flooring|product|vinyl|wood)/.source,
    /what(?:'?s| is| are)?\s+(?:the\s+)?materials?\b/.source,
    /material\s+allowance/.source,
    /\b(?:material|floor|flooring)\s+options?\b/.source,
    /what\s+options?\s+do\s+you\s+(?:have|offer|carry)/.source,
    /\bis\s+(?:it|this|that)\s+(?:really\s+)?(?:a\s+)?(?:luxury\s+)?vinyl/.source,
    /\bare\s+(?:these|they|the\s+floors?)\s+(?:really\s+)?(?:luxury\s+)?vinyl/.source,
    /what\s+(?:flooring|floor|material)\s+do\s+you\s+(?:use|install|offer|have|carry|sell)/.source,
    /luxury\s+vinyl/.source,
    /marble\s+(?:finish|look|effect)/.source,
  ].join("|"),
  "i"
);

// True when we have ALREADY asked the client which flooring type they want in a
// recent assistant turn (any bot message that lists the type options — the canned
// opener and the model's own asks both name tile + hardwood). Used so the
// deterministic type-ask NEVER fires twice: resending the identical canned
// "which one, tile, vinyl, or hardwood?" line mid-conversation is the reported
// robotic-loop bug (a client asked "what's included / how much" three times and
// got the same canned opener three times, and one called it a "scam bot"). Once
// asked, the full-context model handles the follow-up naturally.
function assistantAlreadyAskedType(messages: ChatMessage[]): boolean {
  return messages
    .filter((m) => m.role === "assistant")
    .slice(-4)
    .some((m) => /\btile\b/i.test(m.content) && /\bhardwood\b/i.test(m.content));
}

// CARPET (owner rule 2026-07-30): we DO install carpet, $2.20/sqft LABOR ONLY
// (the client buys the carpet). Carpet is NOT one of the three ADVERTISED types,
// so detectAdFlooringType() returns null for it — and without this guard a lead
// who opens with "how much do you charge to install carpet?" trips the
// vinyl-prone branch below and gets the canned "tile, vinyl, or hardwood?"
// opener, which ignores their question AND implicitly denies carpet (the bot
// literally told a client we don't install carpet). When carpet is the only type
// on the table we skip every canned type-ask line and let the full-context model
// answer with the CARPET INSTALLATION rules. A mixed message that also names a
// real ad type ("remove my carpet and install vinyl") is unaffected: adType is
// then vinyl/tile/hardwood and these branches never run.
// NOT "carpeta"/"carpetas": that is Spanish for a folder, never a floor.
const CARPET_MENTION = /\b(carpets?|carpetes?|carpeting|alfombras?|moquetas?|alcatifas?)\b/i;

export function mentionsCarpet(text: string): boolean {
  return CARPET_MENTION.test((text || "").split(/\n\n?\[SYSTEM:/)[0]);
}

function conversationMentionsCarpet(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user" && mentionsCarpet(m.content));
}

function checkHardcodedResponse(messages: ChatMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  // Pattern-match the CLIENT's text only, never the injected [SYSTEM: ...] note,
  // so an availability/ad note can never accidentally trip an intercept. The ad
  // flooring type is still read from the FULL content (the marker lives in the
  // system note) so the "what's included" answer matches the ad the client came
  // from: a tile ad is labor only, NOT the vinyl flooring+labor+quarter round.
  const text = last.content.split(/\n\n?\[SYSTEM:/)[0];
  // The flooring type known for this whole conversation (ad marker, or any type
  // the client named). Used so "what's included" answers per type and never
  // assumes the vinyl package when the type is still unknown.
  const adType = conversationFlooringType(messages);
  // Carpet is a type we install but do NOT advertise, so it never sets adType.
  // Treat it as a KNOWN type for every canned type-ask below.
  const carpetLead = !adType && conversationMentionsCarpet(messages);
  // TYPE FIRST (any turn, the audit's core fix): while the type is still unknown,
  // a material/product-type question ("what material/options do you use?", "is it
  // vinyl?"), a "how does it work? / how much?", or a generic pricing/promo
  // inquiry must ASK which type first — never describe the product as vinyl or
  // quote $5. A capability question (waterproof) and a specific-type message are
  // NOT vinyl-prone (they keep their own handling below). This also covers turn 2+,
  // where the first-contact opener no longer fires.
  // A capability/suitability question (waterproof, humid climate, can-it-be-used,
  // over tile) is ANSWERED, never converted to a type-ask — even if it also says
  // "flooring options" or "material".
  if (!adType && !carpetLead && !SUBSTANTIVE_PRODUCT_Q.test(text)) {
    const vinylProne =
      PRODUCT_TYPE_Q.test(text) ||
      /\bhow\s+(?:much|does\s+(?:it|this|that|your|the)|do\s+you\s+(?:charge|price|work))\b/i.test(text) ||
      isFlooringInquiry(text);
    // FIRST-CONTACT ONLY: the canned type-ask opener is a safety net for a
    // brand-new lead whose type we do not know. Mid-conversation we must NOT
    // re-fire it — the full-context model answers what the client asked and folds
    // in the type question naturally, instead of blurting the identical canned
    // "which one, tile, vinyl, or hardwood?" line again (the robotic-loop bug).
    // A first message that already declares 500+ sqft skips the canned opener
    // entirely (OPENER EXCEPTION): the model must acknowledge the size and
    // propose the free visit.
    // ...and a first message whose question the opener does NOT answer goes to
    // the model too (2026-08-21 sweep) — see questionBeyondOpener.
    if (vinylProne && !messages.some((m) => m.role === "assistant") && !mentionsLargeSqft(text) && !questionBeyondOpener(text) && !mentionsRejection(text) && !firstMessageNeedsReading(text)) return openerMessage(last.content);
  }
  // Capability questions (waterproof, durable, climate...) get a real answer;
  // "what is the material / is it vinyl" product-type questions get the luxury
  // vinyl description; tile questions get the Floor & Decor answer. All three
  // must bypass the "redirect to WhatsApp" options deflection.
  const skipDeflection = SUBSTANTIVE_PRODUCT_Q.test(text) || PRODUCT_TYPE_Q.test(text) || /\b(tile|porcelain|ceramic)\b/i.test(text);
  // (2026-07-27) The see_options responses now send the WEBSITE link, which
  // reads fine on every channel — the old [WHATSAPP CHANNEL] special wording
  // ("team follows up right here") is no longer needed.
  for (const rule of HARDCODED_RESPONSES) {
    if (rule.patterns.some((p) => p.test(text))) {
      if (rule.skipIfSubstantive && skipDeflection) continue;
      // "What are the payment options?" matched the samples/colors FAQ and got
      // the website + "one area or the whole house?" line (Albania, WA
      // 2026-08-23). Payment/financing questions belong to the model.
      if (rule.id?.startsWith("see_options") && /\b(?:payment|pay|paying|financ\w*|deposit|installments?)\b/i.test(text)) continue;
      if (rule.id === "price_negotiation") return priceNegotiationHandoff(text);
      if (rule.id === "what_included") {
        // Known type → its exact inclusions.
        if (adType) return whatIsIncludedResponseFor(adType);
        // Type still unknown → ask which type first (tile is labor only, vinyl
        // includes the material). But ask AT MOST ONCE: if we already asked the
        // type, hand the repeat to the full-context model so it never resends the
        // identical canned ask-type line ("what's included?" x3 → same line x3
        // was the loop). First time through, the deterministic ask is safe.
        // Carpet lead: the canned ask-type line names only tile/vinyl/hardwood,
        // which reads as "we don't do carpet". Let the model answer instead.
        if (carpetLead || assistantAlreadyAskedType(messages)) return null;
        return WHAT_IS_INCLUDED_ASK_TYPE;
      }
      return rule.response;
    }
  }
  return null;
}

// ─── Ad flooring type: tile vs vinyl vs hardwood ───────────────────────────
// Instagram/Facebook tell us which ad a lead came from via the ad title, the
// creative image, and the ad id. We advertise THREE products at different terms
// (vinyl = $5/sqft material INCLUDED; tile = $4.50/sqft LABOR ONLY, client buys
// the tile; hardwood = $3.20/sqft LABOR ONLY). Knowing the type up front lets us
// answer "what's included" correctly and skip asking a type we already know.
export type AdFlooringType = "tile" | "vinyl" | "hardwood";

// EXPLICIT type tokens only. We deliberately do NOT infer a type from "X-look"
// marketing copy (e.g. "stone-look", "wood look", "marble-look"): that copy
// appears on BOTH our luxury-vinyl creatives AND real porcelain/tile creatives,
// and a client who clicked a wood-look-TILE ad naturally types "wood look" — so
// committing to vinyl there is exactly the reported bug. Genuine tile excludes
// "tile-look". Hardwood is real wood only (never bare "wood"/"wood look").
// Every stem accepts the inflected forms real clients actually type — otherwise
// the client names their type and the bot STILL re-asks it (the reported bug):
//  - "laminate[ds]?" = laminate/laminated/laminates; "laminad[oa]s?" = PT/ES
//    laminado/a/os/as. The bare "laminate" stem MISSED "laminated floor".
//  - "v[iy]n[iy]ls?" = vinyl/vinil/vynil/vynyl + plurals (vynil is a VERY common
//    misspelling). "lvt" (Luxury Vinyl Tile) is a mainstream vinyl product name.
//  - AD_TILE pluralizes each stem (porcelains, ceramics, azulejos, porcelanatos)
//    while still EXCLUDING "tile-look" copy (that appears on vinyl creatives too).
//  - AD_HARDWOOD adds "solid wood" (= solid hardwood) and "engineered floor(ing)"
//    (engineered flooring is an engineered-WOOD product in the trade). It still
//    NEVER matches bare "wood"/"wood look" — that is genuinely ambiguous (wood-look
//    vinyl exists), so it stays null and the bot asks, which is correct.
const AD_VINYL = /\b(v[iy]n[iy]ls?|lvp|lvt|spc|laminate[ds]?|laminad[oa]s?)\b/i;
const AD_TILE = /\b(?:tiles?|porcelains?|porcelanatos?|ceramics?|cer[aâ]mic[ao]s?|azulejos?)\b(?![\s-]?look)/i;
// "oak (wood) floor" is a real-wood species name — a client naming oak means
// hardwood ("Do you install oak wood floor?" used to get the type-ask opener,
// 2026-07-15 review). "oak look"/"oak-look" stays excluded (that copy appears on
// vinyl creatives too).
const AD_HARDWOOD = /\b(hardwoods?|solid\s*(?:hard)?wood|engineered\s*(?:wood|hardwood|floors?|flooring)|oak(?![\s-]?look)(?:\s+(?:wood|floors?|flooring))?)\b/i;

// Detect the flooring type from ad signals (ad_title/creative_url/ad_id) OR from
// a type the CLIENT explicitly named. Returns null when NO explicit type is named
// (incl. bare "X-look" copy) OR when MORE THAN ONE type is named (e.g. a combined
// "Vinyl & Tile" ad) — in both cases the caller must ASK the type, never assume.
export function detectAdFlooringType(...signals: Array<string | null | undefined>): AdFlooringType | null {
  const blob = signals.filter(Boolean).join(" ");
  if (!blob.trim()) return null;
  const hasVinyl = AD_VINYL.test(blob);
  const hasTile = AD_TILE.test(blob);
  const hasHard = AD_HARDWOOD.test(blob);
  if ([hasVinyl, hasTile, hasHard].filter(Boolean).length > 1) return null; // ambiguous → ask
  if (hasVinyl) return "vinyl";
  if (hasTile) return "tile";
  if (hasHard) return "hardwood";
  return null;
}

function adFlooringTypeFromMarker(text: string): AdFlooringType | null {
  const m = text.match(/\[AD_FLOORING_TYPE:\s*(tile|vinyl|hardwood)\]/i);
  return m ? (m[1].toLowerCase() as AdFlooringType) : null;
}

function whatIsIncludedResponseFor(type: AdFlooringType | null): string {
  if (type === "tile") return WHAT_IS_INCLUDED_TILE_RESPONSE;
  if (type === "hardwood") return WHAT_IS_INCLUDED_HARDWOOD_RESPONSE;
  return WHAT_IS_INCLUDED_RESPONSE;
}

// The system note the webhooks inject once the ad's flooring type is known. The
// [AD_FLOORING_TYPE: x] marker is read by the hardcoded "what's included"
// intercept; the prose locks the AI to that product's terms and stops it asking
// a type we already know. When the type is unknown the webhooks fall back to the
// existing AD_REPLY_NOTE ("ask tile, vinyl, or hardwood first").
export function adFlooringTypeNote(type: AdFlooringType): string {
  if (type === "tile") {
    return `[AD_FLOORING_TYPE: tile]\n[AD TYPE KNOWN — TILE: This client replied to one of our TILE ads, so you ALREADY know they want tile. Do NOT ask whether they want tile, vinyl, or hardwood. Our tile promotion is $4.50 per square foot for INSTALLATION LABOR ONLY; the client buys their own tile material and the promotion includes NOTHING else, no flooring material and no quarter round. NEVER tell them the package includes the flooring or the quarter round, that is the vinyl offer, not tile. Apply all TILE rules: tile labor is exactly the square footage times $4.50 with no add-on, and for 500 sqft or more give NO price by DM and propose the free in-person visit.]`;
  }
  if (type === "hardwood") {
    return `[AD_FLOORING_TYPE: hardwood]\n[AD TYPE KNOWN — HARDWOOD: This client replied to one of our HARDWOOD ads, so you ALREADY know they want hardwood. Do NOT ask whether they want tile, vinyl, or hardwood. Our hardwood promotion is $3.20 per square foot for INSTALLATION LABOR ONLY; the client buys their own wood material and the promotion includes NOTHING else, no flooring material and no quarter round. NEVER tell them the package includes the flooring or the quarter round, that is the vinyl offer. For 500 sqft or more give NO price by DM and propose the free in-person visit.]`;
  }
  return `[AD_FLOORING_TYPE: vinyl]\n[AD TYPE KNOWN — VINYL: This client replied to one of our VINYL ads, so you ALREADY know they want vinyl. Do NOT ask whether they want tile, vinyl, or hardwood. Our vinyl promotion is $5 per square foot and that already includes the flooring, the installation labor, and the quarter round. Offer the free quote and ask one area or the whole house, UNLESS the client has ALREADY stated a size of 500 sqft or more anywhere in the conversation (like "Vinyl, 1400 square feet"): in that case NEVER ask one area or whole house and NEVER quote a number, acknowledge the size and go straight to proposing the free in-person visit.]`;
}

// Best-effort vision fallback (the "check the ad creative" path): when no ad text
// signal names a product, classify the ad's creative image as tile / hardwood /
// vinyl. Conservative on purpose — returns null on any doubt or error, so the
// caller falls back to simply asking the client the type (never a wrong guess
// that breaks the working vinyl flow). Tile shows grout lines and square/rect
// tiles; vinyl/laminate are planks (often wood or stone look); hardwood is real
// wood planks.
export async function classifyAdCreativeType(imageUrl: string): Promise<AdFlooringType | null> {
  try {
    if (!imageUrl || !/^https?:\/\//i.test(imageUrl) || !process.env.ANTHROPIC_API_KEY) return null;
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const mediaType = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : ct.includes("gif") ? "image/gif" : "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength < 500 || buf.byteLength > 5_000_000) return null;
    const base64 = buf.toString("base64");
    const anthropic = getAnthropic();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 } },
            { type: "text", text: "This is a flooring advertisement for a company whose MAIN product is luxury vinyl plank that imitates wood, stone, and marble. Classify the floor shown. Answer EXACTLY one lowercase word:\n- 'vinyl' if it shows long rectangular PLANKS laid in rows (wood look, stone look, or marble look strips). This is the default look-alike product.\n- 'tile' ONLY if it clearly shows separate square or rectangular CERAMIC or PORCELAIN tiles in a grid with grout lines on all four sides, NOT long planks.\n- 'hardwood' only if it is unmistakably real wood planks.\n- 'unknown' if you cannot be confident.\nWhen in any doubt between vinyl planks and tile, answer 'vinyl'. One word only." },
          ],
        },
      ],
    });
    const block = response.content[0];
    const ans = (block.type === "text" ? block.text : "").toLowerCase();
    if (/tile|porcelain|ceramic/.test(ans)) return "tile";
    if (/hardwood/.test(ans)) return "hardwood";
    if (/vinyl|laminate|lvp/.test(ans)) return "vinyl";
    return null;
  } catch (err) {
    console.warn("classifyAdCreativeType failed:", err);
    return null;
  }
}

// Final safety net: strip [SEND_IMAGES] tags even if the AI generates them
// Called both inside getAIResponse AND at webhook level as a double guard
export function stripForbiddenTags(text: string): string {
  if (!/\[SEND_IMAGES/i.test(text)) return text;
  let cleaned = text.replace(/\[SEND_IMAGES[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned.includes("ozzifloors.com")) {
    cleaned += "\n\nYou can browse all our options at ozzifloors.com and on our Instagram @ozzi.floors.";
  }
  console.log("[AI] [SEND_IMAGES] tag stripped at safety layer");
  return cleaned;
}

export function removeEmojis(text: string): string {
  // Strip emoji unicode ranges as a safety net
  const cleaned = text.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F900}-\u{1F9FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}\u{1F004}\u{1F0CF}]/gu,
    ""
  ).replace(/\s{2,}/g, " ").trim();
  if (cleaned !== text) console.log("[AI] emoji stripped from response");
  return cleaned;
}

// Strip quotation marks that wrap the WHOLE message. The model sometimes copies
// the surrounding quotes from the prompt examples and sends `"Hello, ..."` to the
// client, which looks wrong. Removes matching wrapping pairs (straight, curly,
// single, guillemets) and a stray single wrapping double-quote at an edge. Never
// touches quotes that are genuinely inside the sentence.
export function stripWrappingQuotes(text: string): string {
  let t = text.trim();
  while (t.length >= 2) {
    const f = t[0];
    const l = t[t.length - 1];
    if (
      (f === '"' && l === '"') ||
      (f === "“" && l === "”") ||
      (f === "‘" && l === "’") ||
      (f === "'" && l === "'") ||
      (f === "«" && l === "»")
    ) {
      t = t.slice(1, -1).trim();
    } else break;
  }
  // A single, unbalanced wrapping double-quote left at the start or end.
  if ((t.match(/"/g) || []).length === 1) t = t.replace(/^"|"$/g, "").trim();
  return t;
}

// The prompt rule is: never a standalone "Hi!"/"Hello!"/"Hey!" — "if you greet,
// combine it with the first sentence". The model occasionally ships a standalone
// greeting anyway, which both breaks the rule and inflates the message to 3
// sentences. MERGE it into the next sentence with a comma ("Hi! Yes, ..." ->
// "Hi, yes, ...") so we keep the warmth but obey the rule. Never touches an
// already-merged "Hi, yes..." (comma) form.
function mergeLeadingGreeting(text: string): string {
  // Covers English, Portuguese, and Spanish greetings (hi/hello/hey, oi/olá,
  // hola) so a standalone "Oi!" or "Hola!" gets merged too.
  const cleaned = text.replace(
    /^\s*(hi|hey|hello|oi|ol[áa]|hola)(?:\s+there)?\s*[!.]+\s+([A-Za-zÀ-ÿ])/i,
    (_m, g: string, c: string) => `${g.charAt(0).toUpperCase()}${g.slice(1).toLowerCase()}, ${c.toLowerCase()}`
  );
  if (cleaned !== text) console.log("[AI] standalone greeting merged into first sentence");
  return cleaned;
}

export function removeDashes(text: string): string {
  const emDash = String.fromCharCode(0x2014);
  const enDash = String.fromCharCode(0x2013);
  const figDash = String.fromCharCode(0x2012);
  const horizBar = String.fromCharCode(0x2015);
  return text
    .split(emDash).join(",")
    .split(enDash).join(",")
    .split(figDash).join(",")
    .split(horizBar).join(",")
    .replace(/ - /g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".");
}

export type AIResponse = { text: string; inputTokens: number; outputTokens: number };

// Salvage a reply that the API cut off at the token limit. Sending the raw text
// ships a half sentence to the client ("respondendo pela metade"), so we drop any
// unterminated [BOOK:...] fragment (its JSON is incomplete and would never parse)
// and trim back to the last complete sentence. If nothing complete remains, the
// caller's empty-response guard keeps us from sending a broken fragment.
function trimTruncatedResponse(text: string): string {
  let t = text;
  // An unclosed [BOOK:... was cut mid-JSON — remove it entirely.
  const bookIdx = t.indexOf("[BOOK:");
  if (bookIdx !== -1 && !/\[BOOK:[\s\S]*?\}\]/.test(t)) {
    t = t.slice(0, bookIdx).trim();
  }
  // Keep everything up to the last sentence terminator so no half sentence ships.
  const m = t.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().length > 0) return m[0].trim();
  return t.trim();
}

// ─── Anti-pressure backstop ────────────────────────────────────────────────
// A scheduling push is one of: the scheduling QUESTION ("what time works",
// "which works for you"), a clock TIME ("1pm"), or a slot MENU re-offer
// ("I have Sunday or Monday", "we've got Thursday open"). A bare weekday on its
// own (e.g. "right after you close Thursday") is NOT a push, so it is allowed.
const SCHEDULING_QUESTION = /(?:what|which)\s+(?:time|day)\b|works?\s+(?:best\s+)?for\s+you|get\s+started\s+right\s+away|which\s+works\b|what\s+works\b/i;
const CLOCK_TIME = /\b\d{1,2}\s*(?:am|pm)\b/i;
const SLOT_OFFER = /\b(?:i\s+have|i'?ve\s+got|i\s+can\s+(?:do|come|stop|swing)|we\s+have|we'?ve\s+got|open(?:ings)?|i'?m\s+available|availab|free\s+on)\b[^.!?]*\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm)|morning|afternoon|evening)\b/i;
function isSchedulingPush(s: string): boolean {
  return SCHEDULING_QUESTION.test(s) || CLOCK_TIME.test(s) || SLOT_OFFER.test(s);
}

// True when an assistant message is offering/asking about a time slot. Used by
// the webhooks to tell that a reschedule exchange is already in progress (the
// bot already offered new slots), so the client's follow-up that just names a
// day/time is still routed through the reschedule flow instead of going silent.
export function containsSchedulingOffer(text: string): boolean {
  return isSchedulingPush(text || "");
}

// Our OWN lines that RESTATE the booked day and time are not offers. Since
// 2026-08-25 the booking confirmation carries the slot ("Appointment confirmed
// for Thursday, August 27 at 2pm"), so containsSchedulingOffer read it as an
// open slot offer and EVERY post-booking message ("Perfect", "Text me or call
// me please 40 mins before") flipped the booked client into RESCHEDULE MODE:
// the model re-emitted [BOOK] for the very same slot, rescheduleClientBooking
// failed against the client's own visit and the client got "Sorry, I couldn't
// lock in that exact time" one minute after "Appointment confirmed" (Prince
// Cambow, fb_27572562225755806, 2026-08-26). Covers the confirmation, the
// reschedule success line and the visit-details restatement, in en/es/pt, in
// any position (the confirmation may be prefixed by the answer to a question
// sent in the same burst).
const BOOKING_RESTATEMENT = /\b(?:appointment confirmed|cita confirmada|visita confirmada|your visit is confirmed|tu visita est[aá] confirmada|sua visita est[aá] confirmada|your visit has been rescheduled|tu visita qued[oó] reagendada|sua visita foi remarcada)\b/i;
export function isBookingRestatement(text: string): boolean {
  return BOOKING_RESTATEMENT.test((text || "").split(/\n\n?\[SYSTEM:/)[0]);
}

// An assistant message that offers/asks about a slot the client still has to
// pick. This is what the webhooks must use to decide "a reschedule exchange is
// in progress" — a restatement of the booked slot never is.
export function isOpenSlotOffer(text: string): boolean {
  return containsSchedulingOffer(text) && !isBookingRestatement(text);
}

// A lone surviving clause that opens with one of these connectors is a dangling
// lead-in to the scheduling clause we just removed ("Since you get off at 5:30",
// "So that we can get started", "And I have Monday open"), NOT a standalone
// thought. Emitting it produces the broken fragment "...all in one price. Since
// you get off at 5:30." Drop it instead.
const LEADING_CONNECTOR = /^(?:since|because|so|as|when|if|while|after|before|once|and|but|or|plus|also|that\s+way|so\s+that|which\s+is\s+why|therefore|then)\b/i;
const QUESTION_LEAD_IN = /^(?:does|do|would|could|can|will|is|are|what|which|when|how)\b[^?]*$/i;

// A sentence that asks for the client's contact/booking data (name, phone,
// address) is DATA COLLECTION, not scheduling pressure — it must survive the
// anti-pressure strip even when it also carries a clock time ("…to confirm
// Friday at 5pm?"). Without this, the bot's ask for the missing phone+name
// after the client sent only the address was deleted and the funnel stalled
// until the owner stepped in (Emanuel, Boynton Beach, 2026-07-28).
const CONTACT_ASK = /\b(?:your|full|first|last)\s+name\b|\bname\s+(?:for|to|under|should)\b|\bphone\b|\b(?:best|contact)\s+number\b|\bnumber\s+to\s+(?:reach|confirm|call|text)\b|\b(?:property\s+)?address\b|\bzip(?:\s*code)?\b|\bpostal\s+code\b|\bc[oó]digo\s+postal\b|\btel[eé]fono\b|\bn[uú]mero\b|\bnombre\b|\bdirecci[oó]n\b/i;

// Remove every scheduling push (in any position) so the bot never pushes the
// appointment two messages in a row (the "stop pressuring the client" rule).
// Sentences carrying a tag ([NOTIFY_OWNER], [BOOK:...], etc.) or a contact-data
// ask are always kept. Exported for the conversion-fixes eval guard.
export function stripSchedulingPush(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    if (s.includes("[") || CONTACT_ASK.test(s) || !isSchedulingPush(s)) {
      kept.push(s);
      continue;
    }
    // Sentence contains a push: salvage the non-push comma clauses (the info).
    // Split on comma+SPACE only — the thousands separator inside "1,500 sqft"
    // has no space after it and must never be treated as a clause boundary
    // (a "1, 500 sqft" mangle shipped to a real client, 2026-07-28).
    const clauses = s
      .split(/,\s+/)
      .filter((cl) => cl.includes("[") || CONTACT_ASK.test(cl) || !isSchedulingPush(cl))
      // A short question lead-in whose times were just removed ("Does tomorrow
      // work" from "Does tomorrow work, 9am or 1pm?") is a headless fragment,
      // not information: it shipped as "Does tomorrow work." (27/08/2026).
      .filter((cl) => !(cl.trim().length < 45 && QUESTION_LEAD_IN.test(cl.trim())));
    // If the only thing left is a single leading-connector clause, it is
    // usually a dangling lead-in to the removed scheduling clause. Drop it when
    // SHORT ("Since you get off at 5:30.") — but a substantive clause is the
    // actual info answer and must be healed instead: strip the connector and
    // re-capitalize ("and for the living room at 1,500 sqft I can measure…"
    // was the whole answer, Emanuel 2026-07-28).
    if (clauses.length === 1 && LEADING_CONNECTOR.test(clauses[0].trim())) {
      const healed = clauses[0].trim().replace(LEADING_CONNECTOR, "").replace(/^[\s,]+/, "");
      if (healed.length < 40) continue;
      clauses[0] = healed.charAt(0).toUpperCase() + healed.slice(1);
    }
    const rebuilt = clauses.join(", ").trim().replace(/[,\s]+$/, "");
    if (rebuilt) kept.push(/[.!?]$/.test(rebuilt) ? rebuilt : rebuilt + ".");
  }
  return kept.join(" ").trim();
}

// True when the client's own latest message engages scheduling (asks about a
// time/day/availability, names a clock time, or accepts a slot). The injected
// [SYSTEM: ...] note (which contains availability slots) is excluded so its
// am/pm tokens never count as the client engaging scheduling.
// Exported for the conversion-fixes eval guard.
export function clientEngagedScheduling(userText: string): boolean {
  const clientText = userText.split(/\n\n?\[SYSTEM:/)[0];
  // Includes timing-adjustment phrases ("can you come earlier", "anything before
  // 3", "what about after 5", "sooner") so a client negotiating the time is never
  // mistaken for ignoring scheduling — which used to nuke the bot's reply into a
  // generic non-answer. Also catches a bare clock time ("5:30", no am/pm) and
  // availability phrases ("I get off at 5:30", "after work", "off work") — these
  // ARE the client engaging scheduling, so the anti-pressure guard must not fire
  // and mangle the bot's slot reply into a dangling fragment.
  // "Soonest" phrases (28/08/2026, caught by route-offer-verify T9): "any day
  // works, whatever is soonest", "asap", "the earliest you have", "today if
  // possible", "lo antes posible", "cuanto antes", "qualquer dia" were NOT
  // counted as engaging scheduling, so the anti-pressure strip deleted the very
  // slot sentence the client asked for and shipped "Does that work, or would
  // you prefer something Tuesday?" with no time in it.
  return /\b(?:asap|as\s+soon\s+as\s+(?:possible|you\s+can)|soonest|earliest|anytime|any\s+(?:time|day|days|hour)|whenever|today|tonight|this\s+week|all\s+week|free\s+(?:all|any|every|this)\b|available\s+(?:all|any|every|this)\b|hoy|hoje|amanh[ãa]|lo\s+antes\s+posible|cuanto\s+antes|cualquier\s+(?:d[ií]a|hora|momento)|qualquer\s+(?:dia|hora|momento)|o\s+quanto\s+antes|esta\s+semana|toda\s+la\s+semana|a\s+semana\s+toda)\b|(?:\bwhat|which)\s+(?:time|day)|\bgood\s+time\b|\bwhen\s+can\s+(?:you|u|someone)\b|\bcome\s+(?:out|by|over|see|take\s+a\s+look)\b|\b(?:next|this)\s+week\b|schedul|appointment|availab|\bbook\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:get|gets|getting)\s+off\b|\boff\s+(?:at|about|around|by|work)\b|\bafter\s+work\b|\bget\s+home\b|\bfinish(?:ed)?\s+(?:work|at|by)\b|\bdone\s+(?:at|by|with\s+work)\b|\bfree\s+(?:after|at|around|by)\b|\bleave\s+work\b|works\s+for\s+me|let'?s\s+do|that\s+works|sounds\s+good|morning|afternoon|evening|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b(?:earlier|sooner|later)\b|\b(?:before|after)\b|can\s+you\s+(?:come|do|make|swing|stop)|any(?:thing)?\s+(?:earlier|sooner|else|other\s+time)|\b(?:hoy|mañana|ma[ñn]ana|tarde|noche|hora|cita|disponible|temprano|m[aá]s\s+tarde|puede\s+ser|no\s+puedo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\bduring\s+the\s+week\b|\bweek\s*days?\b|\bweekends?\b|\bi\s+work\b|\bwork(?:ing)?\s+(?:all\s+)?(?:day|days|week)\b|\bonly\s+(?:on\s+)?(?:weekends?|saturdays?|sundays?|evenings?|nights?|mornings?)\b|\bdays?\s+off\b|\bfin(?:es)?\s+de\s+semana\b|\bentre\s+semana\b|\bd[ií]as?\s+de\s+semana\b/i.test(clientText);
}

// Decides whether the anti-pressure strip may run at all. It fires only when
// (a) a recent assistant turn already pushed scheduling, (b) the client's last
// message did NOT engage scheduling, and (c) the client has NOT yet picked a
// slot. (c) is the Emanuel/Boynton case (2026-07-28): after "Friday at 5" the
// conversation is in the booking DATA-COLLECTION phase — the bot re-asking for
// the missing name/phone (often citing "Friday at 5pm") is not pressure, and
// stripping it left the client unanswered until the owner stepped in manually.
// Exported for the conversion-fixes eval guard.
// Rota (27/08/2026): com a nota ZIP CODE FIRST, a proposta da visita pede o ZIP
// em vez de listar horários ("...I bring the samples. What's the zip code of the
// property?"). Não tem clock time nem "what time works", mas É a proposta da
// visita — conta como push para o anti-pressão não deixar o próximo turno
// informativo ganhar uma lista de horários.
export function isVisitProposalWithZipAsk(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  return /\b(?:visit|measure|samples?|estimate|visita|medir|muestras|amostras|or[cç]amento)\b/i.test(t) && /\bzip\b|c[oó]digo\s+postal/i.test(t) && /\?/.test(t);
}

// ZIP já digitado pelo cliente (caso Adelyn, IG 27/08/2026): o bot pediu o
// ZIP para posicionar a visita, a cliente mandou "33176", escolheu "1pm" e o
// pedido de dados ainda dizia "the full property address with the zip code".
// O prompt e a nota de rota agora instruem o modelo; este backstop apaga o
// trecho "with/including the zip code" (EN/ES/PT) do pedido quando algum ZIP
// já está numa bolha do cliente. Só mexe no pedido de dados, nunca numa pergunta
// isolada de ZIP ("What's the zip code for that address?") nem nas tags.
const CLIENT_SYSTEM_BRACKETS = /\[(?:Client (?:shared|replied)|Floor plan analysis|Image|Photo|Attachment|Sticker|Video)[^\]]*\]/gi;
export function clientAlreadyGaveZip(messages: Array<{ role: string; content: string }>): boolean {
  return (messages ?? []).some(
    (m) => m.role === "user" && zipsInText((m.content || "").split(/\n\n?\[SYSTEM:/)[0].replace(CLIENT_SYSTEM_BRACKETS, " ")).length > 0
  );
}
// SHOWROOM (caso WA 27/08/2026): o cliente perguntou "Do you have a showroom"
// e o modelo respondeu "We don't have a showroom". Regra do dono: a resposta é
// SIM, temos o MOBILE showroom (sem loja física, levamos as amostras até a casa).
// isShowroomQuestion detecta a pergunta (EN/ES/PT); fixShowroomDenial troca a
// frase de negação por essa resposta quando a reply nega e não cita "mobile".
const SHOWROOM_WORD = /\b(?:show\s*rooms?|store|shop|warehouse|storefront|physical\s+location|tiendas?|local|almac[eé]n|bodega|lojas?|loja\s+f[ií]sica)\b/i;
export function isShowroomQuestion(text: string): boolean {
  const t = normalizeSmartPunct(text || "").split(/\n\n?\[SYSTEM:/)[0];
  if (!SHOWROOM_WORD.test(t)) return false;
  return /\b(?:do|does|did|have|has|got|is|are|where|any|there)\b[^.!?\n]{0,60}\b(?:show\s*rooms?|store|shop|warehouse|storefront|physical\s+location)\b|\b(?:show\s*rooms?|store|shop|warehouse)\b[^.!?\n]{0,30}\?|\b(?:tienen?|hay|d[oó]nde|cu[aá]l\s+es)\b[^.!?\n]{0,40}\b(?:show\s*rooms?|tiendas?|local|almac[eé]n|bodega)\b|\b(?:t[eê]m|tem|voc[eê]s?|onde|qual)\b[^.!?\n]{0,40}\b(?:show\s*rooms?|lojas?)\b|\b(?:come|go|visit|stop)\s+(?:by|to|in)?\s*(?:your|the|a)\s+(?:show\s*rooms?|store|shop|warehouse)\b/i.test(t);
}
const SHOWROOM_DENIAL = /[^.!?\n]*\b(?:(?:don'?t|do\s+not|doesn'?t|does\s+not|no)\s+(?:currently\s+|actually\s+)?(?:have|got)\s+(?:a|an|any)?\s*(?:physical\s+|traditional\s+)?(?:show\s*rooms?|store|shop|warehouse|storefront)|(?:we|there)(?:'re|'s|\s+are|\s+is)\s+(?:not|no)\s+(?:a\s+)?(?:physical\s+|traditional\s+)?(?:show\s*rooms?|store|shop|warehouse|storefront)|no\s+(?:tenemos|contamos\s+con|hay)\s+(?:un\s+|una\s+)?(?:show\s*rooms?|tiendas?|local|almac[eé]n)|n[aã]o\s+(?:temos|tem)\s+(?:um\s+|uma\s+)?(?:show\s*rooms?|lojas?))\b[^.!?\n]*[.!?]?/i;
const SHOWROOM_ANSWER: Record<string, string> = {
  en: "Yes, we have a mobile showroom: we don't have a physical store, I bring all the samples right to your home so you can compare them on your own floor, free of charge.",
  es: "Sí, tenemos un showroom móvil: no tenemos tienda física, te llevo todas las muestras a tu casa para que las compares en tu propio piso, sin costo.",
  pt: "Sim, temos um showroom móvel: não temos loja física, eu levo todas as amostras até a sua casa para você comparar no seu próprio piso, sem custo.",
};
export function fixShowroomDenial(text: string, lang: "en" | "es" | "pt" = "en"): string {
  return withTagsProtected(text, (prose) => {
    if (/\bmobile\s+show\s*room|show\s*room\s+m[oó]vi[l]?/i.test(prose)) return prose;
    if (!SHOWROOM_DENIAL.test(prose)) return prose;
    const answer = SHOWROOM_ANSWER[lang] ?? SHOWROOM_ANSWER.en;
    let out = prose.replace(SHOWROOM_DENIAL, answer);
    // Sobrou uma explicação redundante da mesma coisa ("but that's actually the
    // better setup: I come directly to your property, bring all the samples…")?
    // Apaga a frase seguinte que só repete amostras/visita, mantendo a pergunta.
    const idx = out.indexOf(answer);
    if (idx >= 0) {
      const after = out.slice(idx + answer.length);
      const redundant = after.match(/^\s*(?:but\s+)?[^.!?\n]*\b(?:samples|muestras|amostras|come\s+(?:directly\s+)?to\s+your|property)\b[^.!?\n]*[.!?]/i);
      if (redundant) out = out.slice(0, idx + answer.length) + " " + after.slice(redundant[0].length).trimStart();
    }
    return out.replace(/[ \t]{2,}/g, " ").trim();
  });
}

const ZIP_REASK_FRAGMENT = /,?\s*(?:(?:along\s+)?with|including|plus|and)\s+(?:the|its|your)?\s*(?:zip\s*code|zip|postal\s+code)\b|,?\s*(?:con|incluyendo)\s+(?:el|su)?\s*c[oó]digo\s+postal\b|,?\s*(?:com|incluindo)\s+(?:o|seu)?\s*(?:zip\s*code|cep|c[oó]digo\s+postal)\b/gi;
export function stripZipReask(text: string): string {
  return withTagsProtected(text, (prose) =>
    prose
      .replace(ZIP_REASK_FRAGMENT, "")
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.!?])/g, "$1")
  );
}

export function antiPressureShouldFire(messages: ChatMessage[]): boolean {
  // Look back over the last few assistant turns: once the visit/scheduling
  // was already pushed, the client may ask several info questions in a row,
  // and we must not re-push on any of them. The push is often not the most
  // recent assistant message (that may be an info answer), so scan a window.
  const recentAssistantPushed = [...messages]
    .filter((m) => m.role === "assistant")
    .slice(-3)
    .some((m) => isSchedulingPush(m.content) || isVisitProposalWithZipAsk(m.content));
  const lastMsg = messages[messages.length - 1];
  // Resposta ao pedido de ZIP (rota, 27/08/2026): nossa última mensagem pediu o
  // ZIP na proposta da visita e o cliente respondeu com o ZIP, a cidade ou uma
  // resposta curta sem pergunta → o próximo turno DEVE oferecer os horários;
  // isso é o fluxo, não pressão. Uma pergunta informativa ("is it waterproof?")
  // continua protegida: a lista de horários colada nela é cortada.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastMsg?.role === "user" && lastAssistant && isVisitProposalWithZipAsk(lastAssistant.content) && isLocationAnswer(lastMsg.content)) {
    return false;
  }
  return (
    recentAssistantPushed &&
    lastMsg?.role === "user" &&
    !clientEngagedScheduling(lastMsg.content) &&
    !clientConfirmedSlot(messages)
  );
}

export function isLocationAnswer(userText: string): boolean {
  const t = (userText || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  if (zipsInText(t).length > 0 || cityAliasZip(t) !== null) return true;
  return t.split(/\s+/).length <= 4 && !/\?/.test(t);
}

// Detects if client's message mentions >= 500 sqft (or equivalent sqm).
// Returns the sqft value, or null if not a large lead.
export function detectLargeLeadSqft(text: string): number | null {
  const sqftMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqft|sq\.?\s*ft\.?|square\s+feet?)/i);
  if (sqftMatch) {
    const n = parseInt(sqftMatch[1].replace(/,/g, ""), 10);
    if (n >= 500) return n;
  }
  const sqmMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqm|sq\.?\s*m\.?|square\s+met(?:er|re)s?|m[²2])/i);
  if (sqmMatch) {
    const sqm = parseInt(sqmMatch[1].replace(/,/g, ""), 10);
    const sqft = Math.round(sqm * 10.76);
    if (sqft >= 500) return sqft;
  }
  return null;
}

// ─── Large-lead price backstop ─────────────────────────────────────────────
// The LARGE LEAD RULE forbids ANY dollar total by DM for 500+ sqft projects.
// The model occasionally slipped ("the price starts at $9,170") — and worse,
// the nightly Dreaming analysis once codified that slip as a "learning" after
// one lucky conversion, which spread the violation to every conversation
// (found in the 2026-07-07 review: 6 large leads got totals; at least 2 went
// cold right after receiving the number). This deterministic guard strips any
// $1,000+ figure from the reply whenever the client has signaled a large
// project, so no big total can ship even if the model or a future learning
// regresses again. Per-sqft rates ($5, $4.50) are unaffected.
// ─── Tag protection for sentence-level scrubbers ───────────────────────────
// [BOOK:{...}] carries free text ("notes"), so a scrubber that judges sentences
// sees the JSON as one more sentence. On 2026-08-26 (Shaeleen Herrera-Garcia,
// IG) the notes tripped REASONING_LEAK_SENTENCE and stripReasoningLeak deleted
// the WHOLE tag: "Perfect, see you then!" went out with no visit behind it, the
// client waited at home for a 7pm visit nobody had in the system, and the bot
// then told her the slot had "filled up". Every scrubber that drops sentences
// or clauses runs on the prose only: tags are swapped for opaque placeholders
// (bracketed, so existing "[" checks keep treating them as tags) and restored.
const PROTECTED_TAG = /\[BOOK:\{[\s\S]*?\}\]|\[(?:CANCEL_BOOKING|NOTIFY_OWNER|REACT_ONLY)\]/g;
const TAG_PLACEHOLDER = /\[#TAG(\d+)#\]/g;
export function withTagsProtected(text: string, fn: (prose: string) => string): string {
  const tags: string[] = [];
  const masked = text.replace(PROTECTED_TAG, (t) => {
    tags.push(t);
    return "[#TAG" + (tags.length - 1) + "#]";
  });
  if (tags.length === 0) return fn(text);
  return fn(masked).replace(TAG_PLACEHOLDER, (_m, i: string) => tags[Number(i)] ?? "");
}

// True when the reply is nothing but the short line the model writes in front
// of [BOOK:...] ("Perfect, see you then!", "All set!"). Without a booking behind
// it that line is a promise the client acts on. Whitelist-style: the whole text
// must be made of these tokens AND carry a "visit is set" one, so "Perfect,
// what's the address?" or "Sounds good, Ozzi will be in touch" never match.
// Tags are ignored (a [NOTIFY_OWNER] may ride along).
const BARE_CONFIRM_TOKEN =
  "(?:perfect|perfecto|perfeito|great|awesome|wonderful|excellent|done|listo|genial|feito|combinado|sounds good|you'?re all set|you are all set|all set|tudo certo|see you (?:then|soon|there)|nos vemos(?: entonces| pronto| ah[ií])?|hasta (?:entonces|pronto)|at[eé] (?:l[aá]|logo|breve)|you'?re welcome|thank you|thanks|gracias|obrigad[oa])";
const BARE_CONFIRM_RE = new RegExp("^(?:" + BARE_CONFIRM_TOKEN + "[\\s,.!]*){1,4}$", "i");
// No \b: JS word boundaries are ASCII-only, so "até lá!" never closed one after
// the "á". The whole-text whitelist above already guarantees only tokens remain.
const VISIT_SET_TOKEN = /(?:see you|all set|nos vemos|hasta (?:entonces|pronto)|at[eé] (?:l[aá]|logo|breve)|tudo certo|listo|combinado)/i;
export function isBarePreBookingText(text: string): boolean {
  const t = (text ?? "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[¡¿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length > 60) return false;
  if (!VISIT_SET_TOKEN.test(t)) return false;
  return BARE_CONFIRM_RE.test(t);
}

const BIG_DOLLAR = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d{4,}/;

export function conversationHasLargeLead(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (detectLargeLeadSqft(m.content.split(/\n\n?\[SYSTEM:/)[0]) !== null) return true;
    // The floor-plan image analysis marks big projects explicitly.
    if (/LARGE PROJECT/.test(m.content)) return true;
  }
  return false;
}

export function stripLargeLeadPrices(text: string): string {
  // Tags are masked first: a "$" total inside [BOOK] notes must never break
  // the JSON (a half tag = parse error = no visit).
  return withTagsProtected(text, (prose) => stripLargeLeadPricesProse(prose));
}
function stripLargeLeadPricesProse(text: string): string {
  if (!BIG_DOLLAR.test(text)) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    // Sentences carrying a tag ([BOOK:...], [NOTIFY_OWNER]) are always kept.
    if (s.includes("[") || !BIG_DOLLAR.test(s)) {
      kept.push(s);
      continue;
    }
    // CLAUSE-LEVEL strip: the model often packs the allowed per-sqft rate and
    // the forbidden total into ONE sentence ("Our promo is $5 per sqft, so
    // 1,577 sqft comes to about $7,885, and..."). Dropping the whole sentence
    // also killed the legitimate "$5 per sqft" answer — so drop only the
    // comma-clauses that carry the big total and keep the rest. Split on
    // comma+SPACE only: the thousands separator inside "$9,170" has no space
    // after it and must never be treated as a clause boundary.
    const rawClauses = s.split(/,\s+/);
    const clauses: string[] = [];
    let droppedLeadClause = false;
    for (const cl of rawClauses) {
      if (cl.includes("[") || !BIG_DOLLAR.test(cl)) clauses.push(cl);
      else if (clauses.length === 0) droppedLeadClause = true;
    }
    // A lone leading-connector leftover ("so", "and") is a dangling lead-in
    // to the removed total, not a real clause — drop it.
    const cleaned = clauses.filter((cl, i) => !(clauses.length === 1 && i === 0 && LEADING_CONNECTOR.test(cl.trim())));
    // The LEADING clause carried the price and was removed: the survivor now
    // starts mid-sentence ("and the exact price always depends…" shipped to a
    // real client, 2026-07-21, Otto). Strip the orphaned connector and
    // re-capitalize so the seam reads like a normal sentence.
    if (droppedLeadClause && cleaned.length > 0) {
      const healed = cleaned[0].trim().replace(LEADING_CONNECTOR, "").replace(/^[\s,]+/, "");
      if (healed) cleaned[0] = healed.charAt(0).toUpperCase() + healed.slice(1);
    }
    const rebuiltSentence = cleaned.join(", ").trim().replace(/[,\s]+$/, "");
    if (rebuiltSentence) kept.push(/[.!?]$/.test(rebuiltSentence) ? rebuiltSentence : rebuiltSentence + ".");
  }
  const rebuilt = kept.join(" ").trim();
  if (rebuilt) return rebuilt;
  // The whole reply was the forbidden total — replace with the visit pivot.
  return "For a project that size I do a free in-person visit, I measure everything, bring all the samples, and lock in your best price on the spot. What day works best for you?";
}

// ─── Consecutive-duplicate send guard ──────────────────────────────────────
// True when the reply about to be sent is identical (after normalizing
// whitespace/case) to the LAST assistant message already in the conversation.
// Sending the same line twice in a row is the "robotic bot" signature (rule
// 29) — it happened when a client re-tapped an ad FAQ button, re-sent an
// attachment ("Got your message! Could you type your question?" x2), and worst
// of all during an AI outage, where one client received the canned handoff
// line TWELVE times in 90 minutes. Callers skip the send entirely when this
// returns true — the client already has the identical answer directly above.
export function isConsecutiveDuplicate(history: ChatMessage[], candidate: string): boolean {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const c = norm(candidate);
  return c.length >= 15 && norm(lastAssistant.content) === c;
}

// ─── Ad re-tap nudge ────────────────────────────────────────────────────────
// A client who taps our ad AGAIN sends another contentless "[Client replied to
// our ad]" event. The model then either regenerates the type-ask opener almost
// verbatim (suppressed by the duplicate guard) or answers [REACT_ONLY] — both
// dead air for a returning lead (three real IG leads went silent this way,
// 2026-07-18/21). When the whole client side of the history is ad placeholders
// — the client has NEVER typed real text — the webhooks skip the model and send
// a differently-worded nudge deterministically. "At most once per conversation"
// still left dead air: a client tapped the ad a 4th time and the model's answer
// was swallowed by the duplicate guard again (Cleverson, 2026-07-27). Every tap
// is an explicit client action, so every tap gets a reply — the variants rotate
// so the consecutive-duplicate guard can never eat one, with a hard cap as a
// webhook-storm backstop. The webhook appends "\n\n[SYSTEM: ...]" context to
// the latest user message BEFORE this check runs, so the suffix is stripped
// per message.
const AD_PLACEHOLDER_RE = /^\[Client (?:replied to|shared a post\/reel from) our ad[^\]]*\]$/i;
const AD_RETAP_NUDGES_EN = [
  "Hi again! Just reply with the word tile, vinyl, or hardwood and I'll send you the current promotion for it. I'm here whenever you're ready.",
  "No rush at all! Whenever you get a chance, just type tile, vinyl, or hardwood and I'll send over that promotion.",
  "I'm still here! One word is all I need, tile, vinyl, or hardwood, and you'll get the current promo right away.",
];
const AD_RETAP_NUDGES_ES = [
  "Hola de nuevo! Solo respondeme con la palabra tile, vinyl o hardwood y te mando la promocion actual de ese piso. Aqui estoy cuando gustes.",
  "Sin apuro! Cuando puedas, escribeme tile, vinyl o hardwood y te mando la promocion de ese piso.",
  "Sigo por aqui! Con una sola palabra, tile, vinyl o hardwood, te mando la promo actual al momento.",
];
const AD_RETAP_NUDGE_CAP = 6;
export function adRetapNudge(history: ChatMessage[]): string | null {
  const users = history.filter((m) => m.role === "user");
  if (users.length < 2) return null;
  // Only when the client never typed anything themselves — with real text in
  // play the model's answer matters and silence-vs-nudge is not our call here.
  const clientPart = (s: string) => s.split("\n\n[SYSTEM:")[0].trim();
  if (!users.every((m) => AD_PLACEHOLDER_RE.test(clientPart(m.content)))) return null;
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return null;
  // Language from the WHOLE assistant side, not just the last message — a
  // rotated ES variant without the keyword set must not flip the next one to EN.
  const assistantText = history.filter((m) => m.role === "assistant").map((m) => m.content).join(" ");
  const isEs = /\b(hola|cu[aá]l|te interesa|promoci[oó]n|apuro|escribeme|gustes)\b/i.test(assistantText);
  const variants = isEs ? AD_RETAP_NUDGES_ES : AD_RETAP_NUDGES_EN;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const isVariant = (s: string) => variants.some((v) => norm(v) === norm(s));
  const sent = history.filter((m) => m.role === "assistant" && isVariant(m.content)).length;
  if (sent >= AD_RETAP_NUDGE_CAP) return null; // storm backstop; model decides from here
  // Prefer a wording the client has never seen; once all are used, any variant
  // that isn't the message directly above (so the duplicate guard stays happy).
  const unsent = variants.find((v) => !history.some((m) => m.role === "assistant" && norm(m.content) === norm(v)));
  return unsent ?? variants.find((v) => norm(v) !== norm(lastAssistant.content)) ?? null;
}

// ─── Recap instead of dead air on a repeated question ──────────────────────
// A client who re-sends the SAME question after our answer (FAQ button re-tap,
// or a genuine re-ask because the first answer didn't land) makes the model
// regenerate a near-identical reply, which the consecutive-duplicate guard then
// silences — dead air for an explicit client action (3 real cases in the 5-day
// review, 2026-08-10: Cathy 0d12b131, fb 010e3e84, fb d3b9394d). Instead of
// silence, prefix the answer with a short rotating "as I mentioned" so the
// duplicate guard is satisfied AND the client gets their answer again. Capped
// at 2 recaps per conversation — after that, silence again (storm backstop).
const RECAP_PREFIXES: Record<"en" | "es" | "pt", string[]> = {
  en: ["As I mentioned above: ", "Just to recap: ", "In case my last message didn't come through: "],
  es: ["Como te mencioné arriba: ", "Para recapitular: ", "Por si no te llegó mi último mensaje: "],
  pt: ["Como mencionei acima: ", "Recapitulando: ", "Caso minha última mensagem não tenha chegado: "],
};
const RECAP_CAP = 2;
export function recapForDuplicateReply(history: ChatMessage[], reply: string): string | null {
  if (!reply.trim()) return null;
  const allPrefixes = [...RECAP_PREFIXES.en, ...RECAP_PREFIXES.es, ...RECAP_PREFIXES.pt];
  const recapsSent = history.filter(
    (m) => m.role === "assistant" && allPrefixes.some((p) => m.content.startsWith(p))
  ).length;
  if (recapsSent >= RECAP_CAP) return null;
  const lang: "en" | "es" | "pt" = /[¿¡]|\b(hola|precio|instalaci[oó]n|cu[aá]l|gracias)\b/i.test(reply)
    ? "es"
    : /\b(voc[eê]|or[cç]amento|obrigad|instala[cç][aã]o)\b/i.test(reply)
      ? "pt"
      : "en";
  const prefix = RECAP_PREFIXES[lang][recapsSent] ?? RECAP_PREFIXES[lang][RECAP_PREFIXES[lang].length - 1];
  return prefix + reply;
}

// ─── Empty-promise backstop ────────────────────────────────────────────────
// The model routinely tells clients "Ozzi will reach out to you shortly" — but
// the owner is only ACTUALLY pinged when the reply carries [NOTIFY_OWNER]. When
// the model says the words without the tag, the promise is empty: one client
// (Jorge, wa_13059155997) waited WEEKS through five "I'm flagging this right
// now" replies, nobody was ever notified, and a $16,625 job walked. Detect the
// promise in the FINAL outbound text so the webhook can force the owner
// notification whenever the tag is missing.
const OWNER_PROMISE_PATTERNS: RegExp[] = [
  /\b(ozzi|the owner|our team|someone)\b[^.!?\n]{0,60}\b(will|is going to|going to)\b[^.!?\n]{0,40}\b(reach(?:ing)? out|call(?:ing)?|contact(?:ing)?|be in touch|get(?:ting)? in touch|text(?:ing)? you|follow(?:ing)? up|get(?:ting)? back)/i,
  /\bI'?ll (have|make sure|get|ask)\b[^.!?\n]{0,40}\b(ozzi|the owner|our team)\b/i,
  /\bflagging (this|it)\b[^.!?\n]{0,40}\b(for|to|as urgent)/i,
  /\b(ozzi|el due[nñ]o|nuestro equipo|alguien)\b[^.!?\n]{0,60}(te (va a )?(llama|contacta|responde)|se pondr[aá] en contacto|se comunicar[aá]|se comunique|se va a comunicar|estar[aá] esperando|devolver[aá] la llamada|te contacta)/i,
  /\b(ozzi|o dono|nossa equipe|algu[eé]m)\b[^.!?\n]{0,60}(vai (te )?(ligar|contatar|responder)|entra(r[aá])? em contato)/i,
];
export function promisesOwnerContact(text: string): boolean {
  const t = normalizeSmartPunct(text || "");
  return OWNER_PROMISE_PATTERNS.some((p) => p.test(t));
}

// Phone keyboards send smart punctuation: U+2019 for the apostrophe ("Let’s")
// instead of the ASCII "'" every guard regex here is written with. "Let’s do
// 9:00–thank you" failed `let'?s\s+do` ONLY because of the curly quote, carried
// no other recognized substance, matched "thank you" — and the client's slot
// pick was silenced as a pure closing (Brian Guilford, 2026-07-25). Every guard
// that can SILENCE a client or gate a booking must normalize before matching.
const SMART_APOSTROPHE_RE = /[‘’ʼ´]/g;
export function normalizeSmartPunct(s: string): string {
  return (s || "").replace(SMART_APOSTROPHE_RE, "'");
}

// Backstop for the [REACT_ONLY] behavior: detect when the client's latest
// message is purely a thank-you / farewell / "I'll reach out later" with NO new
// question or request. Conservative on purpose — bare "ok"/"sure" are left to
// the model so it never silences a client who is still deciding on a slot.
const CLOSING_PATTERNS: RegExp[] = [
  /\b(thank you|thanks|thank u|thx|tysm|appreciate (it|that)|gracias|obrigad[oa])\b/i,
  /\b(bye|goodbye|see (you|ya)|take care|have a (good|great|nice|wonderful)|adi[oó]s|hasta luego|tchau)\b/i,
  /\b(i'?ll?\s+(call|reach|contact|text|message|hit you|get back|let you know|let u know)|i will\s+(call|reach|contact|let|get back)|call (you|u)\s+(tomorrow|later|back|soon)|talk (to you )?(later|soon)|te llamo|te aviso|luego (te )?(llamo|aviso|hablo))\b/i,
];
const QUESTION_SIGNALS = /\?|\b(how|what|when|where|why|which|who|do you|do u|does|did|can you|can u|could|would|will you|are you|is it|is there|are there|price|cost|how much|quote|estimate|available|availability|schedule|book|sqft|square feet|cu[aá]nto|c[oó]mo|qu[eé]|cu[aá]ndo|d[oó]nde|puede|podr[ií]a|quanto|quando)\b/i;

// A message carrying booking payload (a phone number or a street address) is
// NEVER a pure closing, even when it opens with "ok thank you". Without this
// guard a reply like "Ok thank you. Randy Santos 11417 SW 251st St, Homestead
// FL 33032 786-368-1800" (77 chars, no question word, contains "thank you")
// was classified as a farewell, so the bot stayed silent AND never booked the
// visit. Detect a phone number, a ZIP, or a "<number> <street>" address token.
const BOOKING_INFO_SIGNALS = /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\b\d{5}(?:-\d{4})?\b|\b\d{1,6}\s+\w+(?:\s+\w+){0,4}\s+(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terrace|pl|place|hwy|highway|cir|circle|calle|avenida)\b/i;

export function containsBookingInfo(text: string): boolean {
  return BOOKING_INFO_SIGNALS.test(text || "");
}

// True when OUR reply is still asking the client for the property address or a
// phone number (i.e. the booking is not yet complete). Used by the webhooks to
// give a short grace window before sending a redundant "what's the address?":
// clients routinely confirm the slot and then send the address as a SECOND
// message a few seconds later, just past the 10s debounce. Without this, the bot
// fires the re-ask right as the address lands (the screenshot bug) and looks like
// it ignored what the client just sent. Requires a question so a booking
// confirmation ("see you then!") never matches.
const ASKING_BOOKING_INFO = /\b(?:address|property\s+address|phone|phone\s+number|callback\s+number|best\s+(?:number|phone)|name|zip(?:\s*code)?|postal\s+code|c[oó]digo\s+postal|cep|direcci[oó]n|tel[eé]fono|n[uú]mero(?:\s+de\s+(?:tel[eé]fono|contacto))?|nombre|endere[çc]o|telefone|nome)\b/i;
export function isAskingForBookingInfo(text: string): boolean {
  const t = text || "";
  if (!t.includes("?")) return false;
  if (/\[BOOK:/i.test(t)) return false;
  return ASKING_BOOKING_INFO.test(t);
}

// A message that is ONLY a greeting (a bare "hi" / "hola" / "olá", optionally
// "good morning" etc.) with no other substance. Such a first message used to get
// a silent reaction or empty reply and leave the lead unanswered. We open with
// the promotion instead. The injected [SYSTEM: ...] note is stripped first so it
// never counts as substance. EN / ES / PT.
const GREETING_ONLY = /^[\s!.,?¡¿]*(?:hi+|hey+|hello|hiya|yo|howdy|sup|hi\s+there|hello\s+there|good\s+(?:morning|afternoon|evening|day)|ol[aá]|oi+|al[oô]|bom\s+dia|boa\s+(?:tarde|noite)|hola+|buenas(?:\s+(?:tardes|noches))?|buenos\s+d[ií]as|saludos|qu[eé]\s+tal)[\s!.,?]*$/i;
export function isBareGreeting(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t || t.length > 40) return false;
  return GREETING_ONLY.test(t);
}

// ─── Explicit language request ─────────────────────────────────────────────
// "En español" / "Hablas español" / "No inglés" / "Em português" / "Do you speak
// Spanish" — the client is telling us which language to use. Until 2026-08-25
// NOTHING in the pipeline read that: openerLang() knew greetings and a handful
// of inquiry words, so a first message that was ONLY a language request came
// back "en" and the ad-context leg fired the ENGLISH opener over it (Pedro
// Sanchez 25/08, "Hablas español" 21/08, "No inglés" 14/08, "No sé inglés, si
// puede tráeselo en español" 13/08 — all four leads went silent afterwards).
// Returns the requested language, or null when the message carries no explicit
// request. Precision notes:
//  • "I don't speak Spanish/Portuguese" / "no hablo español" → EN (negated
//    target), checked before the positive matches.
//  • "Spanish tile / Spanish style" is a product, not a language.
//  • "no inglés" / "no hablo inglés" / "no english" → ES: someone who tells us
//    they do not speak English is, in this market, asking for Spanish; the PT
//    form ("não falo inglês") and "espanhol" (PT word for Spanish) → PT.
export function requestedLang(text: string): "en" | "es" | "pt" | null {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].toLowerCase();
  if (!t.trim()) return null;
  // Negated target language → the client wants English.
  if (/\b(?:don'?t|do\s+not|can'?t|cannot|doesn'?t|does\s+not)\s+(?:speak|understand|know|read|write)\s+(?:any\s+|much\s+)?(?:spanish|portuguese)\b/.test(t)) return "en";
  if (/\bno\s+hablo\s+(?:nada\s+de\s+)?(?:espa[ñn]ol|portugu[eê]s)\b/.test(t)) return "en";
  // Portuguese (PT-exclusive wording first: "português", "espanhol", "não falo inglês").
  if (/(?:^|[^a-zà-ÿ])(?:portugu[eê]s|espanhol)(?![a-zà-ÿ])/.test(t)) return "pt";
  if (/\bportuguese\b(?!\s+(?:tile|style|floor|flooring|pattern))/.test(t)) return "pt";
  if (/(?:^|[^a-zà-ÿ])n[aã]o\s+(?:falo|entendo|sei|falamos|entendemos)\s+(?:bem\s+|nada\s+de\s+|muito\s+)?(?:o\s+|em\s+)?ingl[eê]s(?![a-zà-ÿ])/.test(t)) return "pt";
  // Spanish.
  if (/(?:^|[^a-zà-ÿ])(?:espa[ñn]ol|castellano)(?![a-zà-ÿ])/.test(t)) return "es";
  if (/\bspanish\b(?!\s+(?:tile|tiles|style|floor|flooring|pattern|colonial|revival|villa|home|house|mission|clay|terracotta|terra))/.test(t)) return "es";
  if (/(?:^|[^a-zà-ÿ])no\s+(?:me\s+|nos\s+)?(?:hablo|hablamos|hable[ns]?|habla|s[eé]|sabemos|sabe|entiendo|entendemos|entiende[ns]?|escriba[ns]?|escribe[ns]?|manden?|domino|manejo)\s+(?:bien\s+|nada\s+de\s+|mucho\s+|muy\s+bien\s+)?(?:el\s+|en\s+)?ingl[eé]s(?![a-zà-ÿ])/.test(t)) return "es";
  if (/(?:^|[\s.,!¡¿])no\s+ingl[eé]s(?![a-zà-ÿ])/.test(t)) return "es";
  if (/\bno\s+(?:speak|speaking)\s+english\b|\bno\s+english\b|\bdon'?t\s+speak\s+(?:any\s+|much\s+)?english\b/.test(t)) return "es";
  // English, explicitly requested.
  if (/\bin\s+english\b|\benglish\s+(?:please|pls|plz|only)\b|\bspeak\s+english\b|(?:^|[\s.,!¡¿])en\s+ingl[eé]s(?![a-zà-ÿ])|(?:^|[\s.,!¡¿])em\s+ingl[eê]s(?![a-zà-ÿ])/.test(t)) return "en";
  return null;
}

// Pick the first-contact opener in the language of the greeting itself (the
// greeting word is the most reliable language signal), so a "Hola" gets Spanish
// and an "Olá" gets Portuguese. An EXPLICIT language request always wins.
export function openerLang(text: string): "en" | "es" | "pt" {
  const requested = requestedLang(text);
  if (requested) return requested;
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].toLowerCase();
  // Accent-safe boundaries: JS \b does not work around accented letters, so a
  // trailing \b after "olá" never matches. Anchor on start/space/punctuation and
  // a "not-a-letter-next" lookahead instead.
  // Accented "olá" / "oi" / "bom dia" are clearly Portuguese; bare "ola" (no H,
  // no accent) is far more often a Spanish speaker dropping the H of "hola". A few
  // non-greeting words also pin the language for a no-greeting inquiry.
  // "onde" is uniquely Portuguese (Spanish is "donde"/"dónde", and \b protects
  // against the substring inside them — "d" is a word char, so no boundary).
  if (/(?:^|[\s!.,?¡¿])(?:olá|oi|bom\s+dia|boa\s+(?:tarde|noite)|al[oô])(?![a-zà-ÿ])/.test(t) || /\b(você|voce|obrigad|reforma|quanto custa|orçamento|gostaria|onde)\b/.test(t)) return "pt";
  // "pisos?/cerámica/instalación/cotización" pin Spanish for no-greeting
  // inquiries like "Q piso es el de la promo?" — that message used to fail both
  // language checks and get the ENGLISH opener (2026-07-07 review). "piso" is
  // also Portuguese, but the PT check above runs first and catches PT context.
  // "loza/losa" ("Quw material de loza es ese") and "nesesitan/instalar" cover
  // common misspelled Spanish first messages that used to get the English opener.
  // "dónde/donde", "ubicación/ubicados" and the "encuentr-" verb stem (PT stem
  // is "encontr-") pin Spanish for location questions — "Dónde te encuentras"
  // used to fail both checks and get the ENGLISH opener (2026-08-21).
  if (/(?:^|[\s!.,?¡¿])(?:hola|ola|buenas|buenos|saludos|qu[eé]\s+tal)(?![a-zà-ÿ])/.test(t) || /\b(cu[aá]nto|precio|cuesta|necesito|nesesito|quiero|busco|interesad|promoci[oó]n|presupuesto|pisos?|cer[aá]mica|instalaci[oó]n|cotizaci[oó]n|lo[sz]as?|madera|cocina|ba[ñn]o|d[oó]nde|ubicaci[oó]n|ubicad[oa]s?|encuentr\w*|zonas?|trabaja[ns]?|est[aá]n)\b/.test(t)) return "es";
  // 3-day review 2026-08-25: "No se inglés, español", "Me gustaría tener un
  // estimado", "Esto es epoxy", "786… llamame", "7865396038 me interesa" all
  // got the ENGLISH opener. Accent-safe anchors (no trailing \b after "é").
  if (/(?:^|[\s!.,?¡¿])(?:ingl[eé]s|espa[ñn]ol|no\s+s[eé]|no\s+hablo|gustar[ií]a|estimado|esto\s+es|ll[aá]m[ae]\w*|me\s+interesa|quisiera|puedo|mism[oa]|pagar[eé]?|cheque)(?![a-zà-ÿ])/.test(t)) return "es";
  return "en";
}

export function openerMessage(text: string): string {
  // An explicit language request gets the variant that CONFIRMS the language
  // before asking the type ("Claro, con gusto te atiendo en español. …").
  const requested = requestedLang(text);
  if (requested) return requested === "pt" ? OPENER_LANG_PT : requested === "es" ? OPENER_LANG_ES : OPENER_LANG_EN;
  const lang = openerLang(text);
  return lang === "pt" ? OPENER_PT : lang === "es" ? OPENER_ES : OPENER_EN;
}

// The Meta ad quick-reply FAQ buttons arrive as known first messages. Answer the
// tapped question in the SAME deterministic message that asks the type — never
// blurt the generic opener over a direct question (2026-07-15 review: ~17 leads
// went silent right after the generic opener ignored their tapped FAQ).
const AD_FAQ_PROCESS = /\bwhat(?:'?s| is)?\s+the\s+installation\s+process\b|\bhow\s+does\s+the\s+installation\s+work\b|\bc[oó]mo\s+es\s+el\s+proceso\b|proceso\s+de\s+instalaci[oó]n/i;
const AD_FAQ_DISCOUNT = /\bdiscounts?\b[^.!?\n]{0,40}\b(?:large|larger|big|bigger)\s+(?:spaces?|areas?|projects?|jobs?)\b|\b(?:large|larger|big|bigger)\s+(?:spaces?|areas?|projects?)\b[^.!?\n]{0,20}\bdiscounts?\b|\bdescuentos?\b[^.!?\n]{0,40}\b(?:espacios?|[aá]reas?|proyectos?)\s+(?:m[aá]s\s+)?grandes?\b/i;
// OPEN-QUESTION BACKSTOP (2026-08-21 sweep: 25 first messages in 7 days carried
// a real question and got the canned opener over it — "Are you guys licensed?",
// "Do you do smaller projects?", "Do you give free estimates?", "Que material
// están colocando??"). Price / how-it-works / what-material questions are the
// opener's home turf ("which type?" IS the first step of that answer) and keep
// the deterministic opener; ANY other question in the first message must reach
// the model, which answers it in the client's own language and folds in the
// type question naturally. The FAQ-aware location/process/discount/inclusions
// branches run BEFORE this is consulted, so they stay deterministic.
export function questionBeyondOpener(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  // A bare "Hola?"/"Hello??" is a greeting, not a question.
  if (isBareGreeting(t)) return false;
  const interrogative =
    /\?|(?:^|[\s¡¿])(?:where|when|why|who|do\s+(?:you|yo?u|ya|u)|are\s+you|can\s+you|does\b|is\s+(?:this|it|that|there|the)\b|hacen\b|tienen\b|a\s?d[oó]nde|d[oó]nde|donde|cu[aá]ndo|c[oó]mo|por\s*qu[eé]|onde|quando|como|porqu[eê]|voc[eê]s|ustedes)(?![a-zà-ÿ])/i.test(t);
  if (!interrogative) return false;
  return !(PROMO_PRICE.test(t) || HOW_WORK.test(t) || PRODUCT_TYPE_Q.test(t));
}

// "Where are you located?" typed as the first message — a direct question the
// generic opener used to steamroll (Tom Kiper, 2026-07-29: asked twice, got the
// type-ask opener once and then dead air). Answer + type-ask, zero-token.
// Spanish must cover the SINGULAR/tú and usted forms too — "Dónde te
// encuentras" (Ken, 2026-08-21) matched nothing and got the generic ENGLISH
// opener: question ignored AND wrong language. Bare "ubicación"/"ubicados" and
// "en qué zona/ciudad/área" are also common first-message location asks.
const AD_FAQ_LOCATION = /\bwhere\b[^.!?\n]{0,40}\b(?:located|based|location)\b|\bwhat(?:'?s| is)\s+your\s+location\b|\bwhat\s+areas?\s+do\s+you\s+(?:serve|cover|service)\b|\bd[oó]nde\s+(?:est[aá]|te\s+encuentras?|se\s+encuentran?|te\s+ubicas?|se\s+ubican?|quedan?|los\s+encuentro)|\bubicaci[oó]n\b|\bubicad[oa]s?\b|\ben\s+qu[eé]\s+(?:zona|ciudad|[aá]rea)\b|\bqu[eé]\s+zonas?\s+(?:cubren|atienden|sirven|trabajan)\b|\bonde\s+(?:voc[eê]s?\s+)?(?:ficam?|est[aã]o|atendem|se\s+localizam?)\b|\blocaliza[çc][aã]o\b/i;
// Inclusions-family Meta FAQ buttons (shared by the first-contact opener router
// AND the repeated-message intercept, so both agree on what the ask-type
// inclusions line actually answered).
const AD_FAQ_INCLUSIONS = /\b(?:labor|installation)\s+(?:cost\s+)?(?:extra|included|also)\b|\bis\s+(?:the\s+)?(?:labor|installation)\s+cost\b|\bwhat\s+(?:kind|type)s?\s+of\s+materials?\s+(?:are\s+|is\s+)?included\b/i;

// OPENER EXCEPTION backstop (2026-07-15 review): a FIRST message that already
// declares 500+ sqft ("I have about 2500sf how much can you do it for…") must
// NEVER get the canned type-ask opener — the prompt's OPENER EXCEPTION requires
// acknowledging the size and proposing the free visit, which only the model can
// do. Six large leads got the canned opener in 4 days; two never replied again.
// Metric side: 47+ m2 ≈ 500+ sqft.
export function mentionsLargeSqft(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet|foot)?\.?|sf\b|sqft|square\s*(?:feet|foot|ft)|ft2|ft²|pies(?:\s+cuadrados)?|m2|m²|mts?2|metros?(?:\s+cuadrados)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    const isMetric = /^m(?:etro|ts?|²|2)/i.test(m[2]) || /^m2$/i.test(m[2]);
    if (isMetric ? n >= 47 : n >= 500) return true;
  }
  return false;
}

// Language-matched handoff for price-negotiation asks (owner rule 2026-07-08):
// never commit to a better number — the team checks the space and decides, and
// BOTH owners are notified via the [NOTIFY_OWNER] tag.
export function priceNegotiationHandoff(text: string): string {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].toLowerCase();
  // PT check first with PT-exclusive words only ("empresa"/"me" exist in
  // Spanish too — "Otra empresa me cotizó" once landed on the PT reply).
  if (/(?:^|[\s!.,?¡¿])(?:olá|oi|bom\s+dia|boa\s+(?:tarde|noite))(?![a-zà-ÿ])/.test(t) || /\b(?:você|voce|obrigad\w*|or[çc]amento|pre[çc]o|abaixar|baixar|conseguem?)\b/.test(t))
    return "Vou passar isso para a nossa equipe. Vamos verificar o espaço pessoalmente e ver se conseguimos chegar num valor melhor para você, alguém já entra em contato![NOTIFY_OWNER]";
  if (/(?:^|[\s!.,?¡¿])(?:hola|buenas|buenos)(?![a-zà-ÿ])/.test(t) || /\b(?:cotiz\w*|ofrecieron|precio|barat[oa]s?|compa[ñn][ií]as?|pueden?|empresa|rebajar)\b/.test(t))
    return "Déjame pasar esto a nuestro equipo. Vamos a verificar el espacio en persona y ver si podemos llegar a un mejor número para ti, alguien te contacta en seguida![NOTIFY_OWNER]";
  return "Let me get our team on this one. We'll check the space in person and see if we can get to a better number for you, someone will reach out shortly![NOTIFY_OWNER]";
}

// The flooring type already established for this conversation — from the ad-type
// marker the webhook injects, OR from any type the CLIENT has named anywhere in
// the chat. Used so we ask the type ONLY when it is genuinely unknown (never
// re-asking once the client has told us tile / vinyl / hardwood).
function conversationFlooringType(messages: ChatMessage[]): AdFlooringType | null {
  const last = messages[messages.length - 1];
  const marked = last ? adFlooringTypeFromMarker(last.content) : null;
  if (marked) return marked;
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.split(/\n\n?\[SYSTEM:/)[0])
    .join(" ");
  return detectAdFlooringType(userText);
}

// A generic flooring/pricing/promotion inquiry that does NOT name a type — the
// cases where we must ask "tile, vinyl, or hardwood?" instead of pitching the
// vinyl promo. Deliberately EXCLUDES: a message that already names a type, a
// product CAPABILITY question (waterproof/durable — answer it), a photos/colors
// request (redirect), and other topics (bathroom remodel, permits, repairs,
// jobs) that have their own handling.
const FLOORING_CTX = /\b(floors?|flooring|pisos?)\b/i;
const INQUIRY_INTENT = /\b(interested|interesad[oa]|interessad[oa]|need|want|looking|quiero|necesito|busco|preciso|quero|gostaria|option|options|opci[oó]n|op[çc][õo]es|install|redo|new|do you (?:do|have|offer|install))\b/i;
const PROMO_PRICE = /\b(promotion|promo|promo[çc][aã]o|promoci[oó]n|deal|special|oferta|price|pricing|cost|quote|estimate|cu[aá]nto|precio|cuesta|or[çc]amento|presupuesto)\b/i;
const HOW_WORK = /how\s+(?:much|does\s+(?:it|this|that|your|the)\s+\w*\s*work|do\s+you\s+(?:charge|price|work))/i;
// Mirrors the AD_* stems (same inflected forms) so "the client already named a
// type, skip the opener" agrees with detectAdFlooringType and the bot never
// re-asks a plural/misspelled/shorthand type the client already gave.
const SPECIFIC_TYPE = /\b(tiles?|v[iy]n[iy]ls?|laminate[ds]?|laminad[oa]s?|hardwoods?|solid\s*(?:hard)?wood|engineered\s*(?:wood|hardwood|floors?|flooring)|oak(?![\s-]?look)|porcelains?|porcelanatos?|ceramics?|cer[aâ]mic[ao]s?|carpets?|carpetes?|carpeting|alfombras?|moquetas?|alcatifas?|marble|m[aá]rmol|m[aá]rmore|azulejos?|lvp|lvt|spc)\b/i;
const SEE_OR_COLOR = /\b(photo|picture|image|catalog|colou?r|grey|gray|style|sample|show me|wood.?look|stone.?look|tile.?look|marble.?look|website|instagram)\b/i;
const OTHER_TOPIC = /\b(bathroom|ba[ñn]o|banheiro|remodel|reforma|renovat|permit|licen[çcs]|repair|fix\b|hiring|\bjob\b|trabajo|emprego|baseboards?|quarter\s*round|rodap[ée]s?|z[oó]calos?)\b/i;

export function isFlooringInquiry(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t || t.length > 200) return false;
  if (SPECIFIC_TYPE.test(t)) return false;
  if (SUBSTANTIVE_PRODUCT_Q.test(t)) return false;
  if (SEE_OR_COLOR.test(t)) return false;
  if (OTHER_TOPIC.test(t)) return false;
  if (isRepairRequest(t)) return false;
  if (PROMO_PRICE.test(t) || HOW_WORK.test(t)) return true;
  return FLOORING_CTX.test(t) && INQUIRY_INTENT.test(t);
}

// ─── Repair request: we do NOT do repairs of ANY kind → never a visit ────────
// THE BUG (Priti Budhrani, IG 2026-08-24): "These tiles are damaged so we would
// like to replace them would you be able to give me a quote please" was read as
// a tile INSTALLATION lead. The bot offered two slots, collected name, address
// and phone and wrote a real [BOOK] — the seller was sent to look at a repair
// the company does not do. The prompt's REPAIRS section only covered "small"
// repairs ("a few cracked tiles"), so "replace the damaged tiles" slipped past.
// Owner rule (2026-08-25): we do NOT do repairs of any kind; a repair request
// gets the polite decline and NEVER a visit. Three layers: (1) the prompt now
// says so explicitly (REPAIRS section + rule 39), (2) getAIResponse injects a
// CRITICAL block whenever the client's standing request is a repair, (3) the
// three webhooks block any [BOOK] (and any visit offer / booking-details ask)
// while the repair request stands.
const REPAIR_NOUN = /\b(repairs?|reparos?|consertos?|arreglos?|reparaci[oó]n(?:es)?|re-?grout(?:ing)?|rejunte|patch(?:ing)?|remendos?)\b/i;
// "fix" (and "arreglar"/"arrumar") only count next to damage or a floor piece:
// "fix a time for the visit" / "fixed price" are scheduling and pricing.
const REPAIR_VERB = /\b(repair(?:s|ed|ing)?|fix(?:es|ed|ing)?|patch(?:es|ed|ing)?|mend(?:ed|ing)?|re-?grout(?:ed|ing)?|re-?set(?:ting)?|re-?glue[ds]?|reparar|reparen?|arreglar|arreglen?|arregla|consertar|consert[ae]m?|arrumar|arrum[ae]m?)\b/i;
const REPLACE_VERB = /\b(replac(?:e|ed|es|ing|ement)|swap(?:ped|ping)?|reemplaz\w*|cambiar|cambien?|substitui\w*|troc(?:ar|a|am|o)|repor)\b/i;
const DAMAGE = /\b(damaged?|broken|crack(?:s|ed)?|chip(?:s|ped)?|loose|lifting|hollow|popping|missing|scratch(?:ed|es)?|water\s*damaged?|da[ñn]ad[oa]s?|rot[oa]s?|quebrad[oa]s?|rachad[oa]s?|trincad[oa]s?|agrietad[oa]s?|partid[oa]s?|suelt[oa]s?|solt[oa]s?|faltando|faltan|lascad[oa]s?|estragad[oa]s?|despegad[oa]s?|descolad[oa]s?|levantad[oa]s?)\b/i;
const FLOOR_PIECE = /\b(tiles?|planks?|boards?|pieces?|grout|azulejos?|baldosas?|losas?|losetas?|porcelanatos?|cer[aâ]mic[ao]s?|tablas?|tablones?|l[aá]minas?|r[eé]guas?|pe[çc]as?|piezas?|floors?|flooring|pisos?|suelos?|ch[aã]o)\b/i;
// "a few / some / 3 (broken) tiles": a partial replacement is a repair even
// with no repair verb ("some tiles are cracked, can you give me a quote?").
const FEW_PIECES = /\b(a\s+few|few|some|a\s+couple(?:\s+of)?|couple(?:\s+of)?|several|one|two|three|four|five|six|\d{1,2}|algun[oa]s|unos|unas|un\s+par\s+de|varios|varias|alguns|algumas|umas?|poucos|poucas|dos|tres|dois|tr[eê]s)\s+(?:of\s+(?:the|my|our)\s+)?(?:broken|cracked|damaged|loose|chipped|missing|rot[oa]s|quebrad[oa]s|da[ñn]ad[oa]s)?\s*(tiles?|planks?|boards?|pieces?|azulejos?|baldosas?|losas?|losetas?|porcelanatos?|pe[çc]as?|piezas?|tablas?)\b/i;
// Scheduling / pricing uses of "fix" and "arreglar" are NOT repairs.
const FIX_NOT_REPAIR = /\b(?:fix(?:ed|ing)?|arregl\w+|arrum\w+)\s+(?:up\s+)?(?:a|an|the|una?|el|la|um|uma|o)?\s*(?:time|date|day|appointment|visit|slot|schedule|meeting|price|rate|cost|fee|quote|cita|visita|hora|horario|hor[aá]rio|d[ií]a|fecha|reuni[oó]n|precio|pre[çc]o)\b|\bfixed[\s-]+(?:price|rate|cost|fee|quote)\b/gi;
// The client wants a NEW floor (or the vinyl-over-tile install from the "liquid"
// ad, or a bathroom remodel): NOT a repair, even with damage words around.
// Deliberately generous: a false "not a repair" only falls back to the model
// and the prompt, a false "repair" would block a real installation lead.
const NEW_FLOOR_SIGNAL = /\b(whole|entire|everything|all\s+(?:of\s+)?(?:the|my|our|it|them)\b|toda\s+(?:a|la|mi|minha|nuestra|nossa)\b|todo\s+(?:o|el|mi|meu|nuestro|nosso)\b|inteir[ao]|complet[ao]|new\s+(?:floors?|flooring|tiles?|vinyl|hardwood|laminate)|piso\s+nov[oa]|pisos\s+novos|piso\s+nuev[oa]|pisos\s+nuevos|vinyl|laminate|hardwood|lvp|spc|carpet|installation|instala[çc][aã]o|instalaci[oó]n|remodel\w*|reforma\w*|renovat\w*|renova[çc][aã]o|renovaci[oó]n|redo|refazer|rehacer|(?:go(?:es)?|put|lay|install(?:ed)?|poured?|pour)\s+(?:right\s+)?(?:over|on\s+top\s+of)|over\s+(?:the\s+)?(?:existing|old|current)\s+(?:tiles?|floor)|on\s+top\s+of|liquid|l[ií]quido|encima\s+de|por\s+cima\s+d[oa]s?)\b/i;
const ANY_SQFT = /\d[\d,.]*\s*(?:sq\.?\s*(?:ft|feet|foot)|sf\b|sqft|square\s*(?:feet|foot|ft)|ft2|ft²|pies(?:\s+cuadrados)?|m2|m²|mts?2|metros?(?:\s+quadrados|\s+cuadrados)?)\b/i;
// System-ish bubbles that ride along as "user" content (floor-plan / image
// analysis, ad tags) must never feed the detector.
const NON_CLIENT_BUBBLE = /^\s*\[(?:Floor plan analysis|Image analysis|Image|Audio|Sticker|Attachment)\b/i;
const NON_CLIENT_TAGS = /\[(?:Client replied to our ad|AD REPLY|Client shared a post)[^\]]*\]/gi;

function clientTextForRepair(text: string): string {
  const t = normalizeSmartPunct((text || "").split(/\n\n?\[SYSTEM:/)[0]);
  if (NON_CLIENT_BUBBLE.test(t)) return "";
  return t.replace(NON_CLIENT_TAGS, " ").trim();
}

// The client is asking us to FIX or REPLACE damaged pieces of an EXISTING floor.
export function isRepairRequest(text: string): boolean {
  const t = clientTextForRepair(text);
  if (!t) return false;
  if (NEW_FLOOR_SIGNAL.test(t) || ANY_SQFT.test(t)) return false;
  if (REPAIR_NOUN.test(t)) return true;
  const stripped = t.replace(FIX_NOT_REPAIR, " ");
  if (REPAIR_VERB.test(stripped) && (DAMAGE.test(stripped) || FLOOR_PIECE.test(stripped))) return true;
  if (REPLACE_VERB.test(t) && DAMAGE.test(t)) return true;
  if (FEW_PIECES.test(t) && DAMAGE.test(t)) return true;
  return false;
}

// Conversation-level: the repair request STANDS until the client pivots to a
// new floor (whole-floor / sqft / new-floor / remodel wording). This is what
// the [BOOK] block reads: the booking turn itself ("Priti Budhrani, 801 S Miami
// Ave...") carries no repair words, the request lives three bubbles earlier.
export function repairRequestActive(history: Array<{ role: string; content: string }>): boolean {
  let active = false;
  for (const m of history ?? []) {
    if (m.role !== "user") continue;
    const t = clientTextForRepair(m.content);
    if (!t) continue;
    if (isRepairRequest(t)) active = true;
    else if (NEW_FLOOR_SIGNAL.test(t) || ANY_SQFT.test(t)) active = false;
  }
  return active;
}

// Post-model backstop while a repair request stands: the model offered a visit,
// asked for the booking details, or wrote a [BOOK] anyway. The webhook swaps the
// reply for the deterministic decline (scheduler.repairDeclineMessage).
const VISIT_OFFER = /\b(free\s+(?:visit|estimate|quote)|in.?person|come\s+(?:by|out|over|measure|take\s+a\s+look|and\s+(?:measure|take))|stop\s+by|set\s+up\s+(?:a|your|the)\s+(?:free\s+)?(?:visit|estimate)|schedule\s+(?:a|the|your)\s+(?:free\s+)?(?:visit|estimate)|(?:which|what)\s+(?:day|time|one)\s+works|visita|presencial|pessoalmente|qu[eé]\s+d[ií]a\s+(?:te|le)\s+(?:queda|viene|funciona)|que\s+dia\s+(?:fica|funciona))\b/i;
export function repairVisitOfferLeak(history: Array<{ role: string; content: string }>, aiText: string): boolean {
  if (!repairRequestActive(history)) return false;
  const t = aiText || "";
  return /\[BOOK:/i.test(t) || containsSchedulingOffer(t) || VISIT_OFFER.test(t) || isAskingForBookingInfo(t);
}

export const REPAIR_REQUEST_NOTE = `CRITICAL, REPAIR REQUEST (WE DO NOT DO REPAIRS OF ANY KIND):
The client is asking to FIX or REPLACE damaged, broken, cracked, chipped or loose pieces of an EXISTING floor. That is a REPAIR. We do NOT do repairs of any kind, on any floor, of any size, no exceptions, and the owner does not drive out to look at repairs.
1. Tell them politely, in one or two sentences and in the client's language, that we only do full new installations (projects over 500 square feet) and do not do repairs, then close warmly. Example: "At the moment we only do full installations, we don't do repairs of any kind. We work with projects over 500 square feet. If you ever need a new floor, I'm happy to help!"
2. NEVER offer, propose or set up a visit or estimate for a repair. NEVER ask for their name, address or phone. NEVER quote a price for it. NEVER say you need to see it in person. NEVER generate [BOOK:...].
3. If the same message also asks something unrelated, answer that part normally.
4. Only if the client clearly says they want a whole NEW floor installed (not the damaged pieces fixed) return to the normal flow.
5. If earlier in this conversation a visit was already offered, a slot was "held" or the name, address or phone were collected for this repair, that was a MISTAKE: do NOT confirm it, do NOT write [BOOK:...], apologize briefly and give the decline above instead.
6. Keep the figure as 500 square feet (pies cuadrados / pés quadrados), never convert it to square meters.`;

// A courtesy "thanks" that ALSO carries a real answer — a flooring type, a
// room/scope, or a "yes please" to proceed — is the client ANSWERING our
// qualifying question, never a pure closing. Silencing it was the screenshot
// bug: we asked "tile, vinyl, or hardwood?", the client replied "Thank you!
// Either vinyl or laminate", and because the message opened with "Thank you!"
// the pure-closing backstop discarded the reply and the bot went silent on a
// hot lead. When any of this substance is present, it is NOT a closing.
// Question words ("how much", "sqft", "quote"...) are already handled by
// QUESTION_SIGNALS; this catches DECLARATIVE answers that carry no question.
// Day/weekday/time words are ALWAYS substance: "El martes está bien gracias" is
// the client PICKING the Tuesday slot, and it was silenced as a pure closing
// because "gracias" matched and no substance token did (2026-07-17 review,
// fb_26322579897413190 — the Saturday visit was booked but the client was never
// told, and the Tuesday pick got no reply). A closing that names a day or a
// clock time is an ANSWER, never a goodbye. A bare "9:00" (colon, NO am/pm) is
// also a clock time — "Let’s do 9:00–thank you" was silenced because the am/pm
// token missed it (Brian Guilford, 2026-07-25).
const SUBSTANTIVE_CONTENT = /\b(v[iy]n[iy]ls?|laminate[ds]?|laminad[oa]s?|hardwoods?|wood|madeira|tile|tiles|porcelains?|porcelanatos?|ceramics?|cer[aâ]mic[ao]s?|azulejos?|lvp|lvt|spc|carpet|carpete|marble|m[aá]rmore|floor|flooring|piso|kitchen|bedroom|bathroom|living\s*room|cozinha|quarto|banheiro|sala|house|casa|home|apartment|apartamento|condo|garage|garagem|office|escrit[oó]rio|whole\s+(?:house|home|place|thing)|one\s+(?:area|room)|both|either\b|yes\s+please|s[ií]\s+por\s+favor|sim\s+por\s+favor|go\s+ahead|let'?s\s+do|monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|segunda|ter[çc]a|quarta|quinta|sexta|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2}|a\s+las?\s+\d{1,2}|pay(?:ing|ment)?|paid|pagar[eé]?|pagamos|pago|pagamento|cheque|(?:by|with\s+a?)\s+check|zelle|venmo|cash|efectivo|dep[oó]sito?|financ\w*|financiamiento|financiamento|upfront|in\s+full|credit\s+card|tarjeta|cart[aã]o|cancel\w*|reschedul\w*|reagendar|remarcar|postpone)\b/i;

export function hasSubstantiveContent(text: string): boolean {
  return SUBSTANTIVE_CONTENT.test(normalizeSmartPunct(text));
}

// Detects when an ALREADY-BOOKED client wants to move their appointment to a
// different day/time. Only consulted when booking_confirmed is true, so mild
// over-matching is low risk (worst case: the bot offers to reschedule). Covers
// English, Spanish, and Portuguese. A bare day/time with no "change" intent is
// NOT a reschedule (that is handled as booking info / normal flow).
const RESCHEDULE_PATTERNS: RegExp[] = [
  /\b(reschedul|re-?schedul|remarc|reagend|reprogram)/i,
  /\b(move|change|switch|push|shift|bump|cambiar|mover|cambia|trocar|mudar|adiar)\b[^.!?\n]{0,32}\b(appointment|visit|time|day|date|booking|schedule|slot|cita|hora|d[ií]a|fecha|visita|agendamento|hor[áa]rio)\b/i,
  /\b(appointment|visit|booking|cita|visita|agendamento|hor[áa]rio)\b[^.!?\n]{0,32}\b(another|different|a new|other|earlier|later|otro|otra|nuevo|outro|outra)\b[^.!?\n]{0,12}\b(day|time|date|d[ií]a|hora)\b/i,
  /\b(another|different|a new|other|earlier|later|otro|otra|nuevo|outro|outra)\b[^.!?\n]{0,12}\b(day|time|date|d[ií]a|hora)\b[^.!?\n]{0,32}\b(work|instead|better|para|mejor|melhor)/i,
  /\binstead of\b[^.!?\n]{0,20}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|\d{1,2}\s*(?:am|pm))\b/i,
  /\bcan('?t| ?not| we)\b[^.!?\n]{0,40}\b(make|do|come)\b[^.!?\n]{0,20}\b(it|the visit|the appointment|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|that day|that time)\b[^.!?\n]{0,30}\b(another|different|instead|reschedul|move|change)\b/i,
  // CANCEL intent (2026-07-15 review): two booked clients said "Sorry I need to
  // cancel or we could do this friday 2pm" (IG) and "please cancel the appointment
  // for tomorrow, will text you with new time" (WA) and got TOTAL SILENCE — no
  // pattern here covered "cancel", so the silent post-booking path swallowed a
  // cancellation. The visit stayed booked (wasted trip) and the replacement time
  // was never picked up. A cancellation IS the reschedule family: engage and let
  // the model run [CANCEL_BOOKING] / [RESCHEDULE] per its existing rules.
  // "Cansela" (2026-07-27, FB): booked client typed the Spanish "cancela" with
  // an s ("Candela tube q salir de viaje" / "Cansela") and the cancel intent
  // slipped through — tolerate the common s/z misspelling family too.
  /\b(cancel(l?(ed|ing|ation))?|cancelar?|cancelo|cancelen?|can[sz]el\w*|desmarcar?|anular?)\b/i,
  // "I can't make it (tomorrow / Monday / at 3pm)" with no explicit "move/change"
  // verb is still a booked client telling us the visit will not happen — engage.
  /\bcan'?t\s+(?:make|do)\s+(?:it|the\s+(?:visit|appointment))\b/i,
  /\bno\s+(?:voy\s+a\s+)?pod(?:er|r[ée])\b|\bno\s+puedo\s+(?:ir|estar|ese|el|la|ma[ñn]ana|hoy)\b|\bn[ãa]o\s+(?:vou\s+)?poder\b|\bn[ãa]o\s+posso\b/i,
  // Slot-availability probe from a booked client ("Hi Ozzi, do you still have the
  // 1pm time slot available on Wednesday?" got silence, 2026-07-15 review): asking
  // whether a DIFFERENT time is open is a reschedule probe, never a closing.
  /\b(?:do\s+)?(?:you|u)\s+(?:still\s+)?have\b[^.!?\n]{0,50}\b(?:slot|opening|spot|time)\b/i,
  /\b(?:slot|spot|opening|time\s*slot|hora|horario|hor[áa]rio|cita|turno)\b[^.!?\n]{0,30}\b(?:available|open|free|libre|disponible|dispon[ií]vel)\b/i,
  /\b(?:available|disponible|dispon[ií]vel|libre)\b[^.!?\n]{0,30}\b(?:slot|spot|opening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|amanh[ãa]|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
  // "I can't tomorrow" / "can't Tuesday" with no verb at all is still a booked
  // client saying the visit day no longer works (2026-07-20, YunioC: the burst
  // "I can't tomorrow / Can you make possible for tomorrow in the morning / 11 is
  // perfect / Done" got TOTAL SILENCE — no pattern matched any single bubble).
  /\b(?:can'?t|cannot|can\s+not)\b[^.!?\n]{0,25}\b(?:tomorrow|today|tonight|that\s+day|this\s+time|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  // "Can you make (it) possible for tomorrow in the morning" — a reschedule ask
  // phrased without move/change verbs (same 2026-07-20 silence).
  /\bmake\s+(?:it\s+)?possible\b[^.!?\n]{0,40}\b(?:tomorrow|today|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  // ASK FOR A NEW APPOINTMENT, no move/change/reschedule verb anywhere: "Could
  // you please send another appointment so we can meet?" (Msleo, 2026-08-01, IG)
  // — a booked client stranded abroad asked to be re-booked, then wrote "I will
  // take the 9am" and "that will be August 5th at 9am", and got TOTAL SILENCE on
  // all three. "send/set up/book another appointment" carried no matched verb,
  // so the booked gate never opened and the visit was simply lost.
  /\b(?:send|set\s*up|setup|book|schedule|give|arrange|make|get|need|want|pick|dar|dame|darme|d[eé]jame|poner|mandar|manda|m[aá]ndame|enviar|env[ií]a|agendar|marcar|remarcar)\b[^.!?\n]{0,24}\b(?:another|a\s+new|a\s+different|different|other|otra|otro|nueva|nuevo|outra|outro)\b[^.!?\n]{0,24}\b(?:appointment|appt|visit|time|date|day|slot|booking|cita|visita|hora|horario|fecha|d[ií]a|agendamento|hor[áa]rio)\b/i,
  // "I won't be able to make it / to be there / to travel until Monday" — the
  // same Msleo message. A booked client saying they will not be there is a
  // reschedule signal even when they never name a replacement day.
  /\b(?:wo\s?n'?t|will\s+not|would\s+not|wouldn'?t|can'?t|cannot|am\s+not\s+going\s+to|not\s+going\s+to)\b[^.!?\n]{0,28}\b(?:be\s+able\s+to|make\s+it|be\s+(?:there|home|around|available)|travel|attend|come\s+back|get\s+back)\b/i,
  // "no voy a estar / no estaré / não vou estar (en casa / aquí)" — same idea ES/PT.
  /\bno\s+(?:voy\s+a\s+)?estar[eé]?\b|\bno\s+estar[eé]\b|\bn[ãa]o\s+(?:vou\s+)?estar\b/i,
];

export function isRescheduleRequest(text: string): boolean {
  const t = normalizeSmartPunct(text).trim();
  if (!t) return false;
  return RESCHEDULE_PATTERNS.some((p) => p.test(t));
}

// ─── Cliente AFIRMA uma visita que o scheduler não enxerga ───────────────────
// CASO MSLEO (2026-08-05, IG): o dono remarcou a visita manualmente pelo app do
// Instagram ("confirmed for Wednesday, August 5th") e o scheduler ficou com a
// data VELHA. Quando a visita velha passou, a flag booked caiu como "stale", o
// cliente virou "lead normal" e o bot respondeu ao gate code dela oferecendo
// OUTROS dias ("August 5th is fully booked") — contradizendo o acordo do dono e
// perdendo a cliente. A regra: quando a rajada não-respondida AFIRMA que uma
// visita já existe/foi combinada (gate code, "we had a confirmed appointment",
// aceite de horário sem oferta nossa em aberto), o bot NUNCA re-engaja o fluxo
// de vendas — ack neutro + dono. Ele não tem como saber o que foi combinado por
// fora, então nunca deve afirmar o contrário.
//
// Precisão sobre cobertura: um pedido de REMARCAÇÃO ("can we do another day?")
// ou um orçamento novo semanas depois da visita NÃO casam — esses continuam no
// re-engajamento normal (a trava de 2026-07-21 contra silêncio eterno).
const APPOINTMENT_BELIEF_PATTERNS: RegExp[] = [
  // Código de portão/porta/acesso: só quem espera uma visita manda isso.
  /\b(?:gate|door|access|entry|garage|building|lock\s*box|lockbox)\s*code\b/i,
  /\bcode\s+(?:for|to)\s+the\s+(?:gate|door|building|garage|entrance)\b/i,
  /\bc[oó]digo\s+(?:d[eo]l?\s+|de\s+la\s+|do\s+|da\s+)?(?:port[ãa]o|port[oó]n|puerta|porta|acesso|acceso|entrada|garagem|garaje|pr[eé]dio|edificio)\b/i,
  // "we had a confirmed appointment (already)" / "I had an appointment"
  /\b(?:we|i)\s+(?:already\s+)?had\b[^.!?\n]{0,24}\b(?:appointment|appt|cita|agendamento)\b/i,
  // presente só com "already" (sem ele, "can I have an appointment?" é PEDIDO)
  /\b(?:we|i)\s+already\s+have\b[^.!?\n]{0,24}\b(?:appointment|appt|cita|agendamento)\b/i,
  /\b(?:we|i)\s+have\b[^.!?\n]{0,24}\b(?:appointment|appt|cita|agendamento)\b[^.!?\n]{0,16}\balready\b/i,
  /\b(?:my|our)\s+(?:appointment|appt)\b|\bmi\s+cita\b|\bnuestra\s+cita\b|\bminha\s+visita\b|\bmeu\s+agendamento\b/i,
  // "the appointment/visit was confirmed", "can you confirm my appointment"
  /\b(?:appointment|appt|visit|cita|visita|agendamento)\b[^.!?\n]{0,32}\bconfirm/i,
  /\bconfirm(?:ed|ada|ado)?\b[^.!?\n]{0,32}\b(?:appointment|appt|visit|cita|visita|agendamento)\b/i,
  /\b(?:i|we)\s+confirmed\s+with\s+you\b|\byou\s+(?:already\s+)?confirmed\b|\bit\s+was\s+confirmed\b/i,
  /\balready\s+(?:scheduled|booked|confirmed|set|arranged)\b|\bya\s+(?:agendad|confirmad|programad)/i,
  /\b(?:ya|j[áa])\s+(?:tengo|tenemos|ten[ií]amos|tenho|temos|t[ií]nhamos)\b[^.!?\n]{0,24}\b(?:cita|visita|agendamento|hor[aá]rio)\b/i,
  // referência a algo que O DONO mandou e o bot não vê ("that is what you sent me")
  /\byou\s+sent\s+me\b/i,
  // despedida que pressupõe visita marcada
  /\bsee\s+you\s+(?:then|today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|on\s+\w|at\s+\d)/i,
];
// Aceite de horário ("I will take the 9am", "that will be August 5th at 9 am"):
// só conta como afirmação de acordo EXTERNO se a última mensagem do bot NÃO era
// uma oferta de horários em aberto — senão é o fluxo normal de agendamento.
const SLOT_ACCEPTANCE_PATTERNS: RegExp[] = [
  /\b(?:i|we)(?:'ll|\s+will)?\s+(?:take|do|go\s+with)\s+(?:the\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  /\bthat\s+(?:will\s+be|would\s+be|is)\b[^.!?\n]{0,40}\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
];

export function assertsExistingAppointment(burstText: string, lastAssistantText?: string | null): boolean {
  const t = normalizeSmartPunct(burstText || "");
  if (!t.trim()) return false;
  if (APPOINTMENT_BELIEF_PATTERNS.some((p) => p.test(t))) return true;
  const liveOffer = !!(lastAssistantText && isOpenSlotOffer(lastAssistantText));
  return !liveOffer && SLOT_ACCEPTANCE_PATTERNS.some((p) => p.test(t));
}

// Joined client text of the trailing user bubbles since the last assistant
// reply. The 10s debounce means only the LAST bubble's handler acts, so any
// intent spread across a rapid burst is invisible to single-bubble checks
// (2026-07-20, YunioC: "I can't tomorrow" + "Can you make possible for tomorrow
// in the morning" + "11 is perfect" + "Done" — only "Done" was judged, and a
// booked client's reschedule request was silenced). Gate decisions on booked
// conversations must judge THIS text, not just the final bubble.
export function unansweredUserBurst(history: Array<{ role: string; content: string }>): string {
  const parts: string[] = [];
  for (let i = (history ?? []).length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") break;
    if (history[i].role !== "user") continue;
    const t = (history[i].content || "").split(/\n\n?\[SYSTEM:/)[0].trim();
    if (t) parts.unshift(t);
  }
  return parts.join("\n");
}

// ─── The question the booking confirmation would swallow ────────────────────
// THE BUG (5-day review, 2026-08-01): a successful [BOOK] throws the model's
// whole reply away and sends only the canned "Appointment confirmed..." line.
// When the client slipped a real question into the SAME burst as their booking
// details, that question died there — and because booking_confirmed then makes
// the bot go silent by design, they never got an answer at all. Kenny Abbasi
// sent his name, address, phone AND "Do you guys do bathrooms too?" (07-31) and
// Meylan asked "¿Ustedes ponen los rodapiés??" (07-31); both got the confirmation
// and then dead air, and Meylan wrote back a lone "?".
//
// The confirmation itself is the owner's exact wording and must not change, so
// we send the model's OWN answer first and the confirmation right after. This is
// deliberately conservative: it fires only when the client actually asked
// something beyond their booking payload, and it keeps only prose that carries
// no scheduling, confirmation or data-collection language, so nothing can
// compete with or contradict the canned confirmation.
const BOOKING_PAYLOAD_ONLY = /^[\s\d\p{L},.'#/()+-]*$/u;
// Only the phrases that would DUPLICATE or contradict the canned confirmation.
// Deliberately narrow: words like "visit" or "appointment" show up in perfectly
// good answers ("Ozzi can price the bathroom out at the same visit") and an
// over-broad filter silently threw the whole answer away.
const CONFIRMATION_LIKE = /\b(confirmed|confirmada|confirmado|locked\s+in|all\s+set|you'?re\s+set|see\s+you|notify\s+you|40\s+minut(?:es|os)|te\s+aviso|my\s+name\s+is\s+ozzi|mi\s+nombre\s+es\s+ozzi|cita\s+confirmada)\b/i;
// A sentence that is us ASKING for the booking data — already satisfied, so it
// must never be re-sent alongside the confirmation.
const DATA_REQUEST_LIKE = /\?/;
const HAS_CLOCK_OR_DAY = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|today|tomorrow|hoy|ma[ñn]ana)\b/i;

export function questionSwallowedByBooking(
  aiResponse: string,
  history: Array<{ role: string; content: string }>
): string | null {
  const burst = unansweredUserBurst(history);
  if (!burst) return null;
  // A real question, not just the client's name/address/phone (which are all
  // digits, letters and punctuation) and not a bare "ok/thanks".
  const asked = burst
    .split(/\n+/)
    .map((l) => normalizeSmartPunct(l).trim())
    .filter((l) => l.length > 8 && /\?/.test(l) && !BOOKING_PAYLOAD_ONLY.test(l) && QUESTION_SIGNALS.test(l));
  if (!asked.length) return null;
  // A URL's query string is not a question (a client pasted a Zillow link with
  // "?utm_campaign=..." and it read as one).
  if (asked.every((l) => /https?:\/\/\S*\?/.test(l) && !/\?(?!\S)/.test(l.replace(/https?:\/\/\S+/g, "")))) return null;

  const prose = aiResponse.replace(/\[BOOK:[\s\S]*?\]/g, "").replace(/\[[A-Z_]+\]/g, "").trim();
  if (!prose) return null;
  const kept = prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length >= 12 &&
        !CONFIRMATION_LIKE.test(s) &&
        !HAS_CLOCK_OR_DAY.test(s) &&
        // Drop any trailing question: the confirmation ends the turn, so a
        // "which works better for you?" or a re-ask for the address would leave
        // the client answering something we already have.
        !DATA_REQUEST_LIKE.test(s)
    );
  const answer = kept.join(" ").trim();
  if (answer.length < 20) return null;
  return answer;
}

// A BOOKED client asking about their own scheduled visit ("Are you coming at
// 3?", "Which day, Tuesday?", "What time will you arrive?"). These used to fall
// into the silent post-booking path (2026-07-20, YunioC waited at home on the
// wrong day; 2026-07-10, a client asked "Which day, Tuesday" right after the
// confirmation and never got an answer). Only consulted when booking_confirmed
// is true AND an upcoming visit exists, so mild over-matching is low risk: the
// worst case is a correct restatement of the client's own appointment.
const VISIT_DETAIL_PATTERNS: RegExp[] = [
  /\b(?:are\s+)?(?:you|u)\s+(?:still\s+)?coming\b/i,
  /\b(?:are\s+)?we\s+still\s+on\b/i,
  /\bstill\s+(?:on|good|coming)\s+for\b/i,
  /\b(?:what|which)\s+day\b/i,
  /\bwhat\s+time\b/i,
  /\bwhen\s+(?:is|are|will|do)\b[^.!?\n]{0,30}\b(?:visit|appointment|arrive|arriving|come|coming|you)\b/i,
  /\bconfirm\b[^.!?\n]{0,30}\b(?:visit|appointment|time|day|date)\b/i,
  // "Thank you Ozzi and see you on Tuesday at 4:00 pm. Right?" — a booked
  // client double-checking the slot got the booked-silence (fbcbac15,
  // 2026-08-23). Restating the real date/time is exactly the answer.
  /\bsee\s+(?:you|u|ya)\b[^!?\n]{0,60}\?/i,
  /\b(?:tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b[^!?\n]{0,30}\b(?:right|correct|yes|still\s+(?:on|good|ok))\s*\?/i,
  /\b(?:nos\s+vemos|te\s+veo|los\s+veo)\b[^!?\n]{0,60}\?/i,
  // Spanish. Only the tú forms were listed until 2026-08-24: Maria Hernandez's
  // "Todavía están viniendo hoy?" (ustedes progressive) matched nothing and she
  // waited at home in the booked-silence. Cover viene/vienen/viniendo and the
  // llegar/venir plural+future forms too — over-matching here only restates the
  // client's own appointment, which is the safe direction.
  /\ba\s+qu[eé]\s+hora\b/i,
  /\b(?:vienes?|vienen|viniendo|vendr[aá]s?|vendr[aá]n|llegas?|llegan|llegar[aá]s?|llegar[aá]n)\b/i,
  /\bsigue\s+en\s+pie\b/i,
  /\bcu[aá]ndo\s+(?:es|vienen?|llegan?|ser[ií]a)\b/i,
  /\bqu[eé]\s+d[ií]a\b/i,
  // Portuguese
  /\bque\s+horas\b/i,
  /\bqual\s+dia\b/i,
  /\bquando\s+(?:[eé]|vem|chega)\b/i,
  /\b(?:est[aã]o?\s+vindo|v[eê]m\s+hoje)\b/i,
];

export function isVisitDetailQuestion(text: string): boolean {
  const t = normalizeSmartPunct(text).split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  return VISIT_DETAIL_PATTERNS.some((p) => p.test(t));
}

// ─── Booked client asking to be warned before the visit ─────────────────────
// Owner rule (2026-08-26, Prince Cambow, FB): after the visit is booked, a
// request like "Text me or call me please 40 mins before" gets ONE fixed line
// promising the 40-minute text (scheduler.reminderAckMessage) — never the
// model, never silence, never the failure handoff. A thank-you / "ok" after the
// booking still closes the conversation (the silent post-booking path).
// The request needs an ASK verb (text/call/let me know/avísame/me avisa…) AND
// a "before the visit" anchor (before you come, ahead of time, cuando estés en
// camino, antes de chegar, "40 mins before"…), so "call me" alone, questions
// about the visit (isVisitDetailQuestion runs first) and reschedule intents
// (isRescheduleRequest runs first) never land here.
const REMINDER_PATTERNS: RegExp[] = [
  // EN: ask verb … "before you come / ahead of time / when you're on your way"
  /\b(?:text|txt|call|ring|phone|message|msg|dm|notify|alert|warn|ping|buzz|contact|holler|hit\s+me\s+up|reach\s+out|let\s+me\s+know|give\s+me\s+a\s+(?:call|ring|text|shout|heads?\s*up)|heads?\s*up|confirm|remind)\b[^.!?\n]{0,60}(?:before\s+(?:you|u|he|they|someone|anyone|the\s+(?:visit|appointment|tech|guy|seller|team))\b|before\s+(?:coming|arriving|heading|leaving|showing\s+up|stopping\s+by|the\s+visit|the\s+appointment)|ahead\s+of\s+time|in\s+advance|beforehand|prior\s+to|with\s+(?:some\s+|a\s+little\s+|a\s+)?(?:notice|heads?\s*up|warning)|when\s+(?:you|u|you'?re|you\s+are|they|they'?re|he'?s|he\s+is)\s+(?:on\s+(?:your|the|his|their)\s+way|close|closer|near|nearby|almost\s+(?:here|there)|about\s+to|coming|heading\s+(?:over|out|my\s+way)|leaving|en\s+route|(?:about\s+|around\s+|like\s+|roughly\s+)?(?:\d+|a\s+few|some|ten|fifteen|twenty|thirty)\s+(?:mins?|minutes?)\s+(?:away|out)))/i,
  // "40 mins before", "give me 30 minutes notice", "an hour ahead"
  /\b(?:\d{1,3}|a\s+few|some|half\s+an?|an?|one|two|couple\s+(?:of\s+)?)\s*(?:mins?|minutes?|hrs?|hours?)\s+(?:before|ahead|prior|early|in\s+advance|notice|heads?\s*up|warning)\b/i,
  // ES: "avísame / llámame / mándame un texto … antes de llegar / cuando estés en camino / con anticipación"
  /\b(?:av[ií]s[aeo]\w*|ll[aá]m[aeo]\w*|escr[ií]b[aeo]\w*|m[aá]nd[aeo]\w*|env[ií][aeo]\w*|notif[ií]c\w*|confirm[aeo]\w*|mensaje|texto|llamada|llamadita|whatsapp)\b[^.!?\n]{0,60}\b(?:antes\b|con\s+(?:anticipaci[oó]n|antelaci[oó]n|tiempo)|cuando\s+(?:est[eé]n?|est[eé]s|vengan?|vayan?|salgan?)\s+(?:en\s+camino|de\s+camino|cerca|cerquita|saliendo|llegando|por\s+llegar|para\s+ac[aá]|en\s+ruta))/i,
  /\b(?:\d{1,3}|unos|una|media)\s*(?:min|mins|minutos?|hora|horas)\s+antes\b/i,
  // PT: "me avisa / me liga / manda mensagem … antes de chegar / quando estiver a caminho / com antecedência"
  /\b(?:avis[aeo]\w*|lig[aeou]\w*|mand[aeo]\w*|envi[aeo]\w*|notific\w*|confirm[aeo]\w*|cham[aeo]\w*|mensagem|liga[cç][aã]o|texto|whatsapp|zap)\b[^.!?\n]{0,60}\b(?:antes\b|com\s+anteced[eê]ncia|quando\s+(?:estiver(?:em)?|tiver(?:em)?|for(?:em)?|vier(?:em)?)\s+(?:a\s+caminho|chegando|perto|pertinho|saindo|vindo|por\s+perto|de\s+sa[ií]da))/i,
  /\b(?:\d{1,3}|uns|uma|meia)\s*(?:min|mins|minutos?|hora|horas)\s+antes\b/i,
];
export function isReminderRequest(text: string): boolean {
  const t = normalizeSmartPunct(text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  // A client telling us THEY will call ("I'll call you before I leave") is not
  // asking for a reminder.
  if (/\b(?:i|we)(?:'ll|\s+will|\s+can|\s+am\s+going\s+to|\s+gonna)\s+(?:call|text|message|let\s+you\s+know)\b/i.test(t)) return false;
  return REMINDER_PATTERNS.some((p) => p.test(t));
}

// System note injected when a stale booked flag was just reset: the client HAD
// a visit, it is behind us, and they are talking to us again. The model must
// answer like a returning-client conversation, not a cold sales opener.
export function pastVisitSystemNote(lastPast: { date: string; time: string } | null): string {
  const when = lastPast?.date ? ` (their visit was on ${lastPast.date})` : "";
  return `[PAST VISIT: This client already had an in-person visit with us${when} and that date is behind us. Do NOT restart the cold sales pitch or re-introduce the company. Answer their message directly. If it concerns their existing quote, price, project status, or anything only Ozzi can resolve, say Ozzi will follow up personally and add [NOTIFY_OWNER]. If they want NEW work or a new visit, follow the normal flow.]`;
}

// Cancel INTENT specifically (a subset of the reschedule family). Used by the
// webhooks to swap the [RESCHEDULE MODE] note for a cancel-aware one: routing
// "I need to cancel" into a note that says the client "wants to MOVE the visit"
// made the model push invented slots ("Wednesday at 3pm works perfectly!") and
// never emit [CANCEL_BOOKING] (Priscilla, 2026-07-17 review).
const CANCEL_INTENT = /\b(cancel(l?(ed|ing|ation))?|cancelar?|cancelo|cancelen?|desmarcar?|anular?)\b/i;
export function isCancelRequest(text: string): boolean {
  return CANCEL_INTENT.test(normalizeSmartPunct(text).split(/\n\n?\[SYSTEM:/)[0]);
}

// Detects someone looking for a JOB or offering their labor (installer, painter,
// helper, etc.) — NOT a customer. These get no reply at all. Tuned for PRECISION:
// it must never silence a real customer (e.g. "do you have installers?", "I need
// my floor installed"), so it only fires on clear work-seeking / service-offering
// intent. Covers English, Spanish, Portuguese.
const JOB_SEEKER_PATTERNS: RegExp[] = [
  /\b(are|r)\s+(you|u|y'?all|you all|yall|guys)\b[^.!?\n]{0,20}\bhiring\b/i,
  /\b(you|u)\s+(guys\s+)?hiring\b/i,
  /\bare you hiring\b|\bhiring\?\s*$/i,
  /\b(looking|searching)\s+for\s+(a\s+)?(job|work|employment|position|jobs)\b/i,
  /\b(need|want)\s+(a\s+)?(job|work|employment)\b(?![^.!?\n]{0,15}\bdone\b)/i,
  /\bi('?m| am)\s+(an?\s+)?(installer|painter|laborer|labourer|handyman|carpenter|contractor|flooring\s+(installer|guy|pro)|tile\s+(setter|installer)|worker)\b/i,
  /\bi\s+(install|do|lay)\s+(floor|flooring|tile|vinyl|laminate|hardwood|painting|paint)\b[^.!?\n]{0,40}\b(looking|available|work|hire|need|jobs?|crew|for you)\b/i,
  /\b(can|could)\s+i\s+work\s+(for|with)\s+(you|your|ozzi|the team)\b/i,
  /\b(offer|offering)\s+(my|you|our)\s+(services|labor|labour|work|help)\s+(as|for|to)\b/i,
  /\bdo\s+you\s+need\s+(any\s+)?(workers?|installers?|painters?|laborers?|crew|help|hands?|people)\b/i,
  /\bdo\s+you\s+have\s+(any\s+)?(openings?|positions?|vacanc|job\s+openings?)\b/i,
  /\bjoin\s+(your|the)\s+(team|crew|company)\b/i,
  /\b(any\s+)?(job|work)\s+(openings?|opportunit|available|positions?)\b/i,
  // Spanish
  /\b(busco|buscando|necesito|quiero)\s+(trabajo|empleo|chamba|pega)\b/i,
  /\bsoy\s+(instalador|pintor|albañil|trabajador|obrero)\b/i,
  /\b(est[aá]n|estas?)\s+contratando\b|\bhay\s+(trabajo|vacante|empleo)\b/i,
  // "¿Necesitan instaladores?" (incl. common misspellings "nesesitan istalador",
  // 2026-07-15 review: an installer asking for work got the English sales opener).
  /\b(?:necesitan?|nesesitan?|ocupan)\s+(?:alg[uú]n\s+|un\s+|una\s+)?(?:in?stal+adore?s?|trabajadore?s?|ayudantes?|obreros?|emplead[oa]s?)\b/i,
  // Service OFFERS phrased as credentials ("Tengo experiencia en instalación de
  // cerámica y tengo herramientas") — an installer pitching, not a customer.
  // Used to slip through and get the promo opener (2026-07-07 review).
  /\btengo\s+(?:experiencia|herramientas?)\b[^.!?\n]{0,60}\b(?:instalaci[oó]n|instalar|cer[aá]mica|pisos?|construcci[oó]n|herramientas?)\b/i,
  /\bexperiencia\s+en\s+instalaci[oó]n\b/i,
  // "necesito trabajar yo sé entalar pisos y tengo una compañía de remodelación"
  // (2026-07-08 review) — an installer/contractor pitching their own company.
  // "entalar" is a common misspelling of "instalar".
  /\bnecesito\s+trabajar\b/i,
  /\b(?:yo\s+)?s[eé]\s+(?:c[oó]mo\s+)?[ei]n[st]?talar\b/i,
  /\btengo\s+una?\s+(?:compañ[ií]a|empresa)\s+de\s+(?:remodelaci[oó]n|construcci[oó]n|pisos|instalaci[oó]n)\b/i,
  // Portuguese
  /\b(procuro|preciso de|busco|quero|t[ôo] procurando)\s+(emprego|trabalho|vaga|servi[çc]o)\b/i,
  /\bsou\s+(instalador|pintor|pedreiro|trabalhador|ajudante)\b/i,
  /\b(est[aã]o|t[aã]o)\s+contratando\b|\btem\s+vaga\b|\bvaga\s+de\s+emprego\b/i,
];

export function isJobSeeker(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return JOB_SEEKER_PATTERNS.some((p) => p.test(t));
}

// ─── Rejection / hostility → total silence ─────────────────────────────────
// fb_27777958491826513 (2026-08-22): the client's FIRST message was "No. Get
// away from me" and the ad-context leg still fired the canned promo opener —
// nothing in the pipeline read the client's words, and their next messages
// were "Reporting you for spam" and an insult. 29 first-contact victims in
// the 7-day sweep ("Stop", "No", "not interested", "Seriously piss off"...).
// A client who tells us to go away gets NO reply at all: a promo is fuel for
// a real spam report (Meta counts those against the Page), and even an
// apology is one more unwanted message.
//
// PRECISION-FIRST, three families with surgical exceptions (the adversarial
// sweep of 2026-08-22 killed the naive one-list version: "get away with
// vinyl", "take me off the schedule", "no me hablen en ingles" and "my
// neighbor reported you did an amazing job" were all being silenced):
//  • HOSTILE_CORE — insults / f-off / go-away-AT-US. No exceptions.
//  • STOP_CONTACT — stop/don't-message-me. EXCEPT when a channel/time/language
//    preference or alternative is attached ("call me instead", "en español",
//    "before 9am", "my new number") — that is a preference, the model answers.
//  • SPAM_ACCUSATION — report/spam/scam/estafa/golpe threats. EXCEPT when the
//    message carries a "?": "esto es spam o es real?" / "no son una estafa
//    verdad?" is a suspicious-but-interested lead the model reassures.
// When in doubt the tie always breaks toward the MODEL (which reads the
// words) — never toward the canned opener, never toward silencing a real
// client.
const HOSTILE_CORE: RegExp[] = [
  // EN — aimed at us ("get away with vinyl" / "stay away from the pool area"
  // never match: the target must be me/us)
  /\b(?:get|stay|keep)\s+(?:the\s+)?(?:f\W{0,2}(?:u\W{0,2})?c?k(?:ing)?\s+|hell\s+|tf\s+)?away\s+from\s+(?:me|us)\b/i,
  // "we go away for the summer / in June" is travel, not hostility
  /\bgo\s+away\b(?!\s+(?:for|in|on|to|this|next|that|during|until|till))/i,
  /\bleave\s+(?:me|us)\s+(?:the\s+)?(?:f\W{0,2}(?:u\W{0,2})?c?k(?:ing)?\s+|tf\s+|hell\s+)?(?:alone|be)\b/i,
  /\bf\W{0,2}(?:u\W{0,2})?c?k\s*(?:off|you|u\b|this)/i,
  /\b(?:f|eff)\s+(?:off|you|u)\b/i,
  /\bscrew\s+(?:you|off)\b/i,
  /\bpiss\s+off\b|\bgtfo\b|\bstfu\b|\bgo\s+to\s+hell\b|\bget\s+off\s+my\s+phone\b/i,
  // "get lost" only as the ENTIRE message — "if you get lost just call me
  // when you get to the gate" is a booked client giving directions
  /^[\s.,!]*(?:get\s+lost|buzz\s+off|blocked(?:\s+and\s+reported)?|chega|vaza|basta|ya\s+basta)[\s.,!]*$/i,
  /\byou(?:'?re|\s+are|r)\s+(?:trash|garbage|pathetic|a\s+joke|the\s+worst|horrible|terrible)\b/i,
  // ES
  /\bd[eé]j[ea](?:me|nme|nos)\s+(?:en\s+paz|tranquil[oa]s?)\b/i,
  /\bl[aá]rg(?:ate|uense)\b/i,
  // "váyase derecho por la calle 8" is directions to the client's house
  /\bv[aá]ya(?:n)?se\b(?!\s+(?:derecho|recto|por|a\s|hasta|hacia))/i,
  /\bno\s+(?:me\s+)?jodas?\b|\bdeja\s+de\s+(?:chingar|fregar|joder)\b/i,
  // PT — "NÃO me esquece" is a client chasing the quote; "sai fora DO meu
  // orçamento" is a price objection
  /\b(?:me|nos)\s+deixe[m]?\s+em\s+paz\b|\bme\s+deixa\s+em\s+paz\b/i,
  /(?<!n[aã]o\s)\bme\s+esquece\b/i,
  /\bsai\s+fora\b(?!\s+d[oa])/i,
  /\bsome\s+daqui\b|\bn[aã]o\s+enche\b|\bpar[ae]\s+com\s+isso\b|\bpar[ae]\s+de\s+encher\b/i,
];
// Stop-contact requests. "stop by" / "stop the installation" never match (the
// verb list is contact-only); "stop sending the crew" doesn't either (send/
// write/hit require a me/us-style object).
const STOP_CONTACT: RegExp[] = [
  /\b(?:stop|quit)\s+(?:messag\w*|msg\w*|te?xt\w*|contact\w*|dm\w*|spamm?\w*|bother\w*|harass\w*|blowing\s+up)\b/i,
  /\b(?:stop|quit)\s+(?:send\w*|writ\w*|hit\w*)\s+(?:(?:to|up)\s+)?(?:me|us|my\s+line|stuff|messages?|texts?|msgs?|any\w*|more)\b/i,
  /\b(?:stop|quit)\s+reach\w*(?:\s+out)?\b/i,
  /\b(?:don'?t|do\s+not|never)\s+(?:message|msg|te?xt|contact|write\s+(?:to\s+)?|dm|hit)\s*(?:me|us|this\s+number|my\s+(?:number|phone|line))\b/i,
  /\bdon'?t\s+send\s+(?:me|us)\s+(?:any\w*|more|messages?|texts?|stuff)\b/i,
  // bare / polite "stop" as the whole message ("please stop", "stop already")
  /^[\s.,!]*(?:pl(?:ea)?[sz]e?\s+)?stop(?:\s+(?:it|already|please|pls|plz))*[\s.,!]*$/i,
  /^[\s.,!]*no\s+more\s+(?:messages?|texts?|msgs?|spam)[\s\w.,!]*$/i,
  /\bstop\s+with\s+the\s+(?:messages?|texts?|spam)\b/i,
  /\bunsubscribe\b/i,
  /\b(?:remove|take|delete)\s+(?:me|my\s+number)\s+(?:off|from|out\s+of)\b[^.!?\n]{0,30}\b(?:lists?|contacts?|database|system|file)\b/i,
  /\blose\s+my\s+number\b/i,
  // ES — imperative with OR without the object pronoun ("no molesten por
  // favor"); "no me mandaron el precio" (past-tense complaint) never matches
  /\b(?:ya\s+)?no\s+(?:me\s+|nos\s+)?(?:escriba[sn]?|moleste[sn]?|contacte[sn]?|hable[sn]?|mande[sn]?\s+(?:m[aá]s\s+)?(?:mensajes?|nada)|env[ií]e[sn]?\s+(?:m[aá]s\s+)?mensajes?)\b/i,
  /\bno\s+(?:escriban?|molesten?|manden?)\s+m[aá]s\b/i,
  /\bdeje[n]?\s+de\s+(?:escribir|molestar|mandar|contactar)(?:me|nos)?\b/i,
  // PT — coloquial "manda" and singular "mensagem" both covered
  /\bpar(?:e[m]?|a)\s+de\s+me\s+(?:mandar|escrever|incomodar|perturbar|procurar)\b/i,
  /\bn[aã]o\s+me\s+mand[ae][mns]?\s+(?:mais\s+)?mensage[mn]s?\b/i,
  /\bme\s+tira\s+dessa\s+lista\b|\btira\s+meu\s+n[uú]mero\b/i,
];
// A stop-contact phrase with one of these attached is a PREFERENCE (channel /
// schedule / language / another person or number), not a rejection — route to
// the model, which accommodates it: "don't text me, call me instead", "no me
// hablen en ingles", "stop texting me here, whatsapp me", "quit bothering my
// tenant, coordinate with me", "deje de mandar mensajes porque estaba de
// viaje, todavia me interesa".
const CONTACT_PREFERENCE = /\b(?:call|calling|ll[aá]m[aeo]\w*|ligue?m?|liga\w*|whatsapp|wpp|instead|rather|before|after|until|morning|night|tonight|\d{1,2}\s*(?:am|pm)|english|spanish|portuguese|ingl[eé]s|espa[ñn]ol|portugu[eê]s|tenant|inquilino|esposo|esposa|marido|mujer|wife|husband|old\s+number|new\s+(?:number|account|phone)|other\s+number|este\s+n[uú]mero|antes\s+de|despu[eé]s\s+de|depois\s+de|mejor|melhor|celular|keep\s+my|appointment|visita?|cita|reminders?|already\s+booked|porque|pero|but\b|todav[ií]a|a[uú]n|ainda|estaba|interesa|quiero|quero)\b/i;
// Spam/report/scam accusations and threats. A "?" anywhere turns these into a
// suspicious-but-interested question that deserves reassurance, not silence.
const SPAM_ACCUSATION: RegExp[] = [
  // "my neighbor reported you did an amazing job" (reported speech) must not
  // match: only present/future report-you forms, plus "reported as spam"
  /\breport(?:ing)?\s+(?:you\b|y'?all|u\b|your\s+(?:page|account|profile|number|business)|this\s+(?:page|account|profile|number|business)|this\s+to\s+(?:facebook|fb|meta|instagram))/i,
  /\breported?\s+as\s+spam\b/i,
  /\b(?:this|it)\s+is\s+spam\b|\bit'?s\s+(?:all\s+)?spam\b|\bspamming\s+(?:me|us|people|everyone)\b/i,
  /\byou(?:'?re|\s+are|r|\s+guys\s+are|\s+all\s+are)\s+(?:all\s+)?(?:a\s+)?(?:spam+er|scam+er)s?\b/i,
  /\b(?:this|it)\s*(?:is|'?s)\s+a\s+(?:scam|fraud)\b|\btotal\s+scam\b|\bscam\s+alert\b/i,
  /\bscamming\s+(?:me|us|people|everyone)\b/i,
  /^[\s.,!]*(?:spam+|scam+(?:mers?)?|spammers?)[\s.,!]*$/i,
  /\bthis\s+is\s+harassment\b/i,
  /\b(?:i'?m|i\s+am|about\s+to|gonna|going\s+to)\s+block(?:ing)?\s+(?:you\b|this\s+(?:page|number|account))/i,
  // ES — "vou denunciar meu vizinho" (third party) never matches: the target
  // must be us; enclitic "reportarlos" covered
  /\b(?:l[oa]s?|te)\s+voy\s+a\s+(?:reportar|denunciar|bloquear)\b|\bvoy\s+a\s+(?:reportar|denunciar|bloquear)l[oa]s\b/i,
  /\bes(?:to)?\s+es\s+spam\b|\bson\s+(?:unos?\s+)?estafadores\b|(?<!\bno\s)\bes\s+una\s+estafa\b/i,
  // PT
  /\bvou\s+(?:te|voc[eê]s?|os)\s+(?:denunciar|bloquear)\b|\bvou\s+(?:denunciar|bloquear)\s+(?:voc[eê]s?|essa?\s+p[aá]gina|isso)\b/i,
  // JS \b never matches before an accented letter, so "é golpe" needs an
  // explicit start/space anchor instead of \b.
  /\bisso\s+[eé]\s+spam\b|(?:^|[\s.,!¡¿])(?<!n[aã]o\s)(?<!\bou\s)[eé]\s+golpe\b|\bs[aã]o\s+golpistas\b/i,
];

// Explicit hostility / stop-contact / spam-accusation — silences at ANY point
// in the conversation (also consumed by the follow-up sweep: a client who sent
// any of this is never nudge-eligible).
export function isHostileRejection(text: string): boolean {
  const t = normalizeSmartPunct(text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  if (HOSTILE_CORE.some((p) => p.test(t))) return true;
  if (!/\?/.test(t) && SPAM_ACCUSATION.some((p) => p.test(t))) return true;
  return STOP_CONTACT.some((p) => p.test(t)) && !CONTACT_PREFERENCE.test(t);
}

// Polite declines — a softer family that only silences the very FIRST contact
// (an accidental ad tap being declined). Mid-conversation these go to the
// model, which closes politely.
const POLITE_DECLINE_PATTERNS: RegExp[] = [
  /\b(?:not|no\s+longer)\s+interested\b/i,
  /\bno\s+(?:estoy|estamos)\s+interesad[oa]s?\b|\bno\s+me\s+interesa\b/i,
  /\bn[aã]o\s+(?:tenho|temos|t[oô])\s+interesse\b|\bn[aã]o\s+me\s+interessa\b/i,
  // "não quero O vinil, quero tile" keeps its answer (the interest check also
  // rescues it); "no quiero nada" / "não quero" alone decline
  /\bno\s+(?:quiero|necesito)\s+nada\b|\bn[aã]o\s+quero(?:\s+nada)?\b(?!\s+(?:o\b|a\b|de|que))/i,
  /\bwrong\s+(?:number|person)\b|\bn[uú]mero\s+(?:equivocado|errado)\b/i,
  /^[\s.,!]*(?:not\s+needed|no\s+need|not\s+necessary|no\s+necesito|no\s+gracias|n[aã]o\s+preciso)[\s.,!]*$/i,
  /\bi\s+never\s+(?:contacted|messaged|texted)\s+(?:you|this)\b|\b(?:never|didn'?t)\s+sign(?:ed)?\s+up\b/i,
  // The ENTIRE message is just a "no" (optionally + thanks), or the classic
  // "I'm good / we're all set" brush-off.
  /^[\s.,!¡¿?]*(?:no+|nope|nah)[\s.,!]*(?:thanks?|thank\s+(?:you|u)|ty|gracias|obrigad[oa])?[\s.,!?]*$/i,
  /^[\s.,!]*(?:no+[\s.,!]*)?(?:i'?m|im|we'?re|were)\s+(?:good|all\s+set|fine|ok(?:ay)?)(?:\s+(?:thanks?|thank\s+(?:you|u)|ty))?[\s.,!]*$/i,
];

// ACCIDENTAL TAP — "Sorry, clicked by mistake" / "Hit by accident" / "Sorry MIs
// press" / "fue sin querer". 9 of these in the 3-day review of 2026-08-22..25
// got the PROMO OPENER (the rejection families above only knew "no thanks"
// and "not interested"), which is exactly the "bot doesn't read the message"
// complaint. First contact → total silence like the polite declines; the
// interest signals checked first in isFirstContactRejection still win ("clicked
// by mistake but how much is vinyl?", "wrong button, I meant hardwood", an
// address). Any DIGIT in the message disqualifies it — "I made a mistake on the
// measurements, it's 800 sqft" is a correction, never an accidental tap.
const ACCIDENTAL_TAP_PATTERNS: RegExp[] = [
  // tap-verb … by mistake/accident ("clicked on your post by mistake")
  /\b(?:hit|click(?:ed)?|press(?:ed)?|push(?:ed)?|tap(?:ped)?|sent|send|text(?:ed)?|messag(?:ed|e)|contact(?:ed)?|replied|touch(?:ed)?|open(?:ed)?)\b[^.!?\n]{0,25}\b(?:by\s+(?:mistake|accident|error)|accidental(?:ly)?|on\s+accident|mistakenly|wrong\s+(?:button|thing|ad|post|page|chat))\b/i,
  // by mistake/accident … tap-verb ("by mistake i text you", "accidentally hit button")
  /\b(?:by\s+(?:mistake|accident|error)|accidental(?:ly)?|mistakenly)\b[^.!?\n]{0,25}\b(?:hit|click(?:ed)?|press(?:ed)?|push(?:ed)?|tap(?:ped)?|sent|send|text(?:ed)?|messag(?:ed|e)|contact(?:ed)?|replied|touch(?:ed)?)\b/i,
  /\bmis-?\s?(?:press|click|tap|touch)(?:ed)?\b|\bfat[\s-]?finger/i,
  /\bwrong\s+(?:button|chat|ad|post|page)\b/i,
  // "didn't mean to contact/message you" — NOT "didn't mean to ignore you" (a
  // client coming back) nor "didn't mean to be rude"
  /\b(?:didn'?t|did\s+not|never)\s+mean\s+to\s+(?:contact|message|msg|text|click|hit|press|push|tap|reply|send|reach\s+out|bother|write|dm)\b/i,
  /\b(?:it|that|this)\s+was\s+(?:a\s+|an\s+|my\s+)?(?:mistake|accident|error)\b/i,
  // "Sorry, my mistake" / "my bad" as the END of the message only — "my
  // mistake on the sqft was…" keeps flowing
  /(?:^|[\s.,!])(?:sorry,?\s+)?my\s+(?:mistake|bad)[\s.,!]*$/i,
  /^[\s.,!]*(?:sorry[,.!]*\s*)?(?:oops|whoops|oopsie)[\s.,!]*$/i,
  // ES / PT
  /\b(?:fue|ha\s+sido)\s+(?:un\s+)?(?:error|accidente)\b|\bpor\s+error\b|\bsin\s+querer\b|\bme\s+equivoqu[eé](?![a-záéíóú])|\bequivocaci[oó]n\b|\bfue\s+por\s+equivocaci[oó]n\b/i,
  /\bsem\s+querer\b|\bfoi\s+(?:um\s+)?engano\b|\bpor\s+engano\b|\bme\s+enganei\b|\bcliquei\s+errado\b|\bmandei\s+errado\b|\bfoi\s+erro\b/i,
];
export function isAccidentalTap(text: string): boolean {
  const t = cleanRejectionText(text);
  if (!t || /\d/.test(t)) return false;
  return ACCIDENTAL_TAP_PATTERNS.some((p) => p.test(t));
}

// Interest expressed in the same breath — negation-aware ("no quiero nada"
// and "não quero" do NOT count; "quero piso vinílico" and "todavia me
// interesa" do). Also plugs the SPECIFIC_TYPE gap for ES/PT forms it lacks
// (madera, madeira, vinílico, porcelanato).
const INTEREST_AFFIRM = /(?<!\bno\s)(?<!\bn[aã]o\s)\b(?:quiero|quero|necesito|nesesito|preciso|busco|gostaria|i\s+want|i\s+need|i'?d\s+like|me\s+interes+a\w*|estou\s+interessad\w*|estoy\s+interesad\w*)\b(?!\s+nada\b)|\b(?:todav[ií]a|a[uú]n|ainda|still)\s+(?:me\s+interes+a\w*|interested|quero|quiero|t[oô]\s+esperando|estou|espero)\b|\b(?:maderas?|madeiras?|vin[ií]licos?|porcelanatos?)\b/i;

// Shared cleaner: strip the [SYSTEM: ...] note and ad placeholder lines
// ("[Client replied to our ad]") so whole-message patterns can see "No." as
// the entire real message.
function cleanRejectionText(burst: string): string {
  return normalizeSmartPunct(burst || "")
    .split(/\n\n?\[SYSTEM:/)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l))
    .join("\n")
    .trim();
}

// ANY rejection-family wording present at all, exceptions ignored. Used by
// the first-contact router to suppress every CANNED opener: when the burst is
// rejection-flavored the reply is either total silence (isFirstContactRejection)
// or the model reading the actual words — never the canned promo line.
export function mentionsRejection(text: string): boolean {
  const t = cleanRejectionText(text);
  if (!t) return false;
  return (
    HOSTILE_CORE.some((p) => p.test(t)) ||
    STOP_CONTACT.some((p) => p.test(t)) ||
    SPAM_ACCUSATION.some((p) => p.test(t)) ||
    POLITE_DECLINE_PATTERNS.some((p) => p.test(t)) ||
    isAccidentalTap(t)
  );
}

// First-contact rejection → total silence. ANY interest signal alongside (a
// question mark, a named type, a price ask, a phone/address, an affirmative
// want) routes to the model instead — including for the hostile family: "How
// do I know you're not scammers? Are you licensed?" is due diligence from a
// hot lead, and a re-engaging client whose old hostile bubble still sits in
// the un-answered burst ("Sorry about earlier. Do you install tile?") must
// get an answer, not eternal silence.
export function isFirstContactRejection(burst: string): boolean {
  const t = cleanRejectionText(burst);
  if (!t) return false;
  if (/\?/.test(t) || SPECIFIC_TYPE.test(t) || PROMO_PRICE.test(t) || containsBookingInfo(t) || INTEREST_AFFIRM.test(t)) return false;
  if (isHostileRejection(t)) return true;
  if (POLITE_DECLINE_PATTERNS.some((p) => p.test(t)) || isAccidentalTap(t)) return true;
  // Several bubbles that are EACH a rejection ("No ty" … 6h later … "No"):
  // the whole-message patterns above are single-line, so the joined burst
  // matched nothing and the second bubble got the promo opener (fb 4d907e41,
  // 2026-08-24). Judge line by line when there is more than one.
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => isHostileRejection(l) || POLITE_DECLINE_PATTERNS.some((p) => p.test(l)) || isAccidentalTap(l))) return true;
  return false;
}

// FIRST MESSAGE THAT NEEDS READING — the canned openers must never answer it;
// the model reads the words (and hands the owner in when asked). Every family
// here is a real 3-day-review victim (2026-08-22..25) of the generic opener:
//  • a phone number / "call me" / "phone number please" / "llámame" (10 cases)
//  • an existing client ("You did an estimate… I have a question on the quote")
//  • a conditional objection ("Not if you don't remove and replace moldings")
//  • a language statement ("I don't speak English", "No se inglés, español")
//  • DIY / not-a-customer ("Lo puedo hacer yo misma", "I sell it!", "I do not
//    own a house", "I own a flooring company")
// Cheap on purpose: routing to the model is always safe (never silence).
export function firstMessageNeedsReading(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  if (!t.trim()) return false;
  return (
    /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b|\b\d{3}\s\d{3}\s\d{2}\s\d{2}\b/.test(t) ||
    /\b(?:call|text|contact|phone|ring)\s+(?:me|us)\b|\bgive\s+me\s+a\s+call\b|\b(?:your|ur)\s+(?:phone|number|contact)\b|\bphone\s+number\b|\bcontact\s+me\b|\bsend\s+(?:me\s+)?(?:one\s+)?text\b|\bll[aá]m[ae](?:me|nos|n)?\b|\bme\s+(?:llaman?|pueden\s+llamar)\b|\bme\s+lig(?:a|ue|uem)\b/i.test(t) ||
    /\byou\s+(?:did|came|gave|sent|already)\b|\balready\s+(?:had|got|received|came|been)\b|\bmoving\s+forward\b|\b(?:my|the|your)\s+(?:quote|estimate)\b|\bcame\s+to\s+my\s+(?:house|home)\b|\bwere\s+(?:here|at\s+my)\b|\bi\s+have\s+a\s+question\b|\bya\s+(?:vinieron|me\s+dieron|tengo)\b/i.test(t) ||
    /\b(?:not\s+if|only\s+if|unless)\b|\bmou?ldings?\b|\bbaseboards?\b/i.test(t) ||
    /\b(?:don'?t|do\s+not|cannot|can'?t)\s+(?:speak|understand)\s+english\b|\bno\s+(?:s[eé]|hablo|entiendo)\s+(?:el\s+)?ingl[eé]s\b|\b(?:solo|s[oó]lo)\s+espa[ñn]ol\b|\bhabla[ns]?\s+espa[ñn]ol\b|\bspanish\s+speakers?\b/i.test(t) ||
    /\b(?:do\s+it|hacerlo)\s+(?:my|our)self|\byo\s+mism[oa]\b|\beu\s+mesm[oa]\b|\bi\s+sell\s+(?:it|flooring|floors)\b|\bown\s+a\s+flooring\b|\b(?:do\s+not|don'?t)\s+own\s+a\s+(?:house|home)\b|\bi\s+(?:am|'m)\s+an?\s+installer\b|\bnot\s+needed\b/i.test(t)
  );
}

export function isPureClosing(text: string): boolean {
  const t = normalizeSmartPunct(text).trim();
  if (!t || t.length > 80) return false;
  if (QUESTION_SIGNALS.test(t)) return false;
  if (BOOKING_INFO_SIGNALS.test(t)) return false;
  // "Thank you! Either vinyl or laminate" answers our question — never silence it.
  if (SUBSTANTIVE_CONTENT.test(t)) return false;
  return CLOSING_PATTERNS.some((p) => p.test(t));
}

// Burst-aware pure-closing check — judges the WHOLE un-answered burst, not just
// the last bubble. THE SILENCE BUG: the 10s debounce collapses a client's rapid
// bubbles so only the LAST one's handler replies. When a client asks a real
// question and then sends a polite "thanks!"/"ok" a few seconds later (before the
// bot has answered), the debounce keeps only the "thanks!"; judging that single
// bubble as a pure closing then DISCARDS the model's correct answer to the
// earlier question and the bot goes silent on a hot lead — on all three channels.
// Fix: it is a pure closing ONLY when the last bubble is a closing AND every other
// still-un-answered bubble in the same burst (the user messages after the last
// assistant turn) also carries no question, booking info, or substantive content.
export function isPureClosingBurst(history: Array<{ role: string; content: string }>): boolean {
  if (!history || history.length === 0) return false;
  const last = history[history.length - 1];
  if (!last || last.role !== "user") return false;
  const strip = (c: string) => normalizeSmartPunct(c).split(/\n\n?\[SYSTEM:/)[0];
  // The latest bubble must itself be a pure closing, or there is nothing to skip.
  if (!isPureClosing(strip(last.content))) return false;
  // If OUR last message asked for booking info (name / address / phone), the
  // client's reply is the ANSWER, never a goodbye. A bare name ("It's John,
  // thanks!") carries no substance token any regex can recognize, so without
  // this check the name reply would be silenced and the booking never completed
  // (name required since 2026-07-27).
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (lastAssistant && isAskingForBookingInfo(lastAssistant.content)) return false;
  // Walk back across the un-answered burst (the user bubbles since the last
  // assistant reply). If any earlier one is a real, still-unanswered message,
  // the model's answer to it must be sent — never silenced by the trailing thanks.
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].role === "assistant") break; // reached the last answered turn
    const t = strip(history[i].content);
    if (QUESTION_SIGNALS.test(t) || SUBSTANTIVE_CONTENT.test(t) || BOOKING_INFO_SIGNALS.test(t)) {
      return false;
    }
  }
  return true;
}

// ─── Bare acknowledgment ("ok") = the conversation is over ──────────────────
// OWNER RULE (2026-08-26): when the client answers "ok" / "okay" / "perfect" /
// "got it" / a thumbs up / a thank-you, the bot STOPS. What was happening,
// mostly on WhatsApp with quote-follow-up clients: we said "Ozzi will reach
// out", the client typed "Ok", the bot answered "Sounds good, Ozzi will be in
// touch!", the client typed "Okay" again and the bot spoke AGAIN (Dary, 26/08:
// "Ok cool" → "Sounds good, talk soon!" → "Okay" → "Sounds good, we'll be in
// touch!"; Edna, Burt, Jale: same shape — 7 such turns in 10 days).
// isPureClosing deliberately left a bare "ok" to the model ("never silence a
// client who is still deciding on a slot"); that safety is kept HERE by
// context instead of by ignoring the word: an ack is only a closing when OUR
// last message was not waiting for an answer (no question, no slot offer, no
// name/address/phone ask) — or when the client already acked once and we
// re-asked anyway (second "ok" in a row: stop, whatever we asked).
//
// Deliberately NOT acks: "yes", "sure", "claro", "dale", "sim" (affirmative
// answers), "that works" (a slot acceptance), anything with a question word,
// a day, a time, booking data, or product/scope substance.
const ACK_TOKEN =
  /^(?:ok(?:ay|ey|ie|i)?|oks|kk+|k|perfect[oa]?|perfeito|great|awesome|cool|nice|good|fine|alright|all\s+right|all\s+good|got\s+it|noted|understood|copy(?:\s+that)?|will\s+do|no\s+problem|np|no\s+worries|sounds?\s+(?:good|great|perfect|fine)|that'?s\s+(?:fine|great|perfect|good|ok(?:ay)?)|you\s+too|same\s+to\s+you|entendido|entiendo|vale|listo|de\s+acuerdo|est[aá]\s+bien|muy\s+bien|bien|genial|excelente|excellent|wonderful|igualmente|t[aá]\s+bom|beleza|blz|certo|combinado|tranquilo|fechado|ha+|haha+|lol|jaja+|rs+)(?=$|\s)/i;

export function isBareAck(text: string): boolean {
  const t = normalizeSmartPunct(text ?? "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  if (t.includes("?")) return false;
  // Only emoji / symbols: 👍 🙏 ❤️ is an ack; bare punctuation ("...") is not.
  if (!/[\p{L}\p{N}]/u.test(t)) return /\p{Extended_Pictographic}/u.test(t);
  if (t.length > 60) return false;
  if (QUESTION_SIGNALS.test(t) || BOOKING_INFO_SIGNALS.test(t) || SUBSTANTIVE_CONTENT.test(t)) return false;
  // Each punctuation-separated chunk must be a run of ack words, optionally
  // ending in a thank-you / farewell ("ok cool", "perfect, thank you!",
  // "ok I'll call you tomorrow", "gracias 🙏").
  const chunks = t
    .replace(/[\p{Extended_Pictographic}️]/gu, " ")
    .split(/[.!,;:…]+|\s{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (chunks.length === 0) return false;
  return chunks.every((chunk) => {
    let rest = chunk;
    for (;;) {
      const m = rest.match(ACK_TOKEN);
      if (!m) break;
      rest = rest.slice(m[0].length).trim();
    }
    return rest === "" || isPureClosing(rest);
  });
}

// Every un-answered client bubble in the current burst is a bare ack / closing.
export function isAckOnlyBurst(history: Array<{ role: string; content: string }>): boolean {
  if (!history || history.length === 0) return false;
  if (history[history.length - 1].role !== "user") return false;
  let saw = false;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") break;
    if (history[i].role !== "user") continue;
    const t = (history[i].content || "").split(/\n\n?\[SYSTEM:/)[0].trim();
    if (!t) continue;
    saw = true;
    if (!isBareAck(t)) return false;
  }
  return saw;
}

// A message of ours that names a day or a clock time is (or may be) a slot
// offer even without a question mark — "Perfect" to it is an acceptance.
const SLOT_MENTION = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|segunda|ter[çc]a|quarta|quinta|sexta)\b/i;

// Is OUR message still waiting for the client to answer something?
export function botAwaitsAnswer(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  // A booking confirmation / restatement closes the exchange even though it
  // names a day and a clock time — "Perfect" to it is the client signing off.
  if (isBookingRestatement(t)) return false;
  return t.includes("?") || containsSchedulingOffer(t) || isAskingForBookingInfo(t) || SLOT_MENTION.test(t);
}

// The webhook decision: the client's burst is only "ok"/thanks AND either our
// last message asked nothing, or the client had ALREADY answered our previous
// message with a bare ack (we re-asked once — never a third time). First
// contact (no assistant message yet) is never silenced: that is the opener's job.
export function isAckClosingBurst(history: Array<{ role: string; content: string }>): boolean {
  if (!isAckOnlyBurst(history)) return false;
  let lastAsst = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") { lastAsst = i; break; }
  }
  if (lastAsst === -1) return false;
  if (!botAwaitsAnswer(history[lastAsst].content)) return true;
  // The client turn our last message answered: also a bare ack → stop the loop.
  let prevAcks = 0;
  for (let i = lastAsst - 1; i >= 0; i--) {
    if (history[i].role === "assistant") break;
    if (history[i].role !== "user") continue;
    const t = (history[i].content || "").split(/\n\n?\[SYSTEM:/)[0].trim();
    if (!t) continue;
    if (!isBareAck(t)) return false;
    prevAcks++;
  }
  return prevAcks > 0;
}

// ─── Internal-monologue leak scrubber ───────────────────────────────────────
// Three REAL leaks shipped to clients in the 2026-07-11..15 window:
//   "…What's the full address so I can get you scheduled? Wait, let me handle
//    this properly. 16 steps at $140 per step is $2,240… Let me redo this: …"
//   "This is a small tile job quoted by DM, not a visit, so I just need to
//    notify Ozzi to follow up. Since the client accepted the quote, I'll
//    escalate. Great, I'll have Ozzi reach out to you directly…"
//   "I have Saturday August 16 at... wait, let me check what I have open…"
// The model narrates its own decision process INTO the reply. Drop every
// sentence that is clearly the model talking ABOUT the conversation (third-
// person "the client…", "I'll escalate", "notify Ozzi to follow up", "let me
// redo…") rather than TO the client. Patterns are deliberately narrow so real
// client-facing lines ("I need to come measure", "I'll have Ozzi reach out to
// you") NEVER match. Fail open: if nothing substantive survives, keep the
// original text — an awkward reply still beats silence or a broken fragment.
const REASONING_LEAK_SENTENCE = new RegExp(
  [
    /\bwait,?\s+let\s+me\b/.source,
    /\blet\s+me\s+(?:redo|recalculate|re-?check|recompute|handle\s+this\s+properly|start\s+over|try\s+(?:this|that)\s+again|give\s+the\s+right\s+answer|fix\s+that)\b/.source,
    /\bscratch\s+that\b/.source,
    // 3-day review 2026-08-25 (fb a9a3e8da, wa R0t4ld3, quote follow-up Angie):
    // "The type is still unknown here, but 1,900 sqft is already a large lead so
    // no DM price regardless. I need to propose the visit… I'll acknowledge the
    // size…", "let me give you the right ones: … Sunday the 31st does not
    // exist", "Wait, I need to copy the link exactly."
    /\bwait,?\s+i\s+(?:need|have|should)\s+to\b/.source,
    /\blet\s+me\s+give\s+(?:you\s+)?the\s+(?:right|correct)\s+ones?\b/.source,
    /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[^.!?\n]{0,25}\bdoes\s+not\s+exist\b/.source,
    /\bno\s+dm\s+price\b/.source,
    /\b(?:the\s+)?type\s+is\s+still\s+unknown\b/.source,
    /\blarge\s+lead\b/.source,
    /\bi\s+need\s+to\s+propose\b/.source,
    /\bi(?:'ll|\s+will)\s+(?:acknowledge|propose)\b/.source,
    // ENGLISH self-correction leak shipped 2026-08-03 (Stacey Russo, fb_384715…):
    // "Let me give you the correct number: … Hmm, I need to apply the rules
    // properly and not narrate my math. 400 sqft of LVT, small job tier (200 to
    // 400 sqft): 400 x $5 = $2,000, plus $500 small job add-on = $2,500. Demo:
    // 400 x $1.50 = $600. Total = $3,100. For 400 sqft…" — the model corrected
    // itself out loud AND revealed the internal small-job pricing (forbidden by
    // STEP 2A: "never mention any range, band, tier, or the arithmetic").
    /\bhmm+,?\s+i\s+(?:need|should|have)\s+to\b/.source,
    /\blet\s+me\s+give\s+(?:you\s+)?the\s+(?:right|correct)\s+(?:number|answer|price|total|quote)\b/.source,
    /\bapply\s+the\s+rules?\s+properly\b/.source,
    /\bnarrat(?:e|ing)\b/.source,
    // Internal small-job pricing must NEVER reach a client: no tier/add-on
    // labels, no "plus $500", and no narrated arithmetic ("400 x $5 = $2,000",
    // "Total = $3,100"). A real client-facing total says "comes out to about
    // $X" with no equation, so these sentence shapes are always internal.
    /\bsmall[\s-]?job\s+(?:tier|add[\s-]?on|surcharge|fee|pricing)\b/.source,
    /\bplus\s+(?:a\s+|the\s+)?\$\s?500\b/.source,
    /\b\d[\d,]*(?:\.\d+)?\s*(?:x|×|\*)\s*\$?\s?\d[\d.,]*\s*=\s*\$?\s?\d/.source,
    /\btotal\s*=\s*\$?\s?\d/.source,
    /\b(?:i|we)(?:'|’)?ll\s+escalate\b/.source,
    /\bi\s+(?:just\s+)?need\s+to\s+notify\b/.source,
    /\bnotify\s+(?:ozzi|the\s+owner|the\s+team)\s+to\b/.source,
    /\bthe\s+client\s+(?:accepted|wants|said|asked|is\s+asking|gave|confirmed|sent|replied|responded|chose|picked|selected|has\s+(?:accepted|confirmed|given|sent)|hasn'?t\s+(?:confirmed|chosen|picked|replied|sent|given|answered))\b/.source,
    // SECOND English leak, 2026-08-01 (conv 810d2f45): the ENTIRE planning
    // monologue shipped before the real reply — "The client sent their phone
    // number but hasn't confirmed a specific day and time yet, and I still need
    // their name and address. The 'following week' from the week of Aug 5 would
    // be the week of Aug 10. Now they sent their phone number. I should
    // acknowledge the number and ask which time works…". Third-person "their"
    // after "I still need", "I should <plan-verb>", and "now they sent" are
    // never client-facing English.
    /\bi\s+still\s+need\s+their\b/.source,
    /\bi\s+should\s+(?:acknowledge|ask|confirm|offer|collect|check|respond|clarify)\b/.source,
    /\bnow\s+they\s+(?:sent|said|asked|gave|confirmed|replied)\b/.source,
    /\bfrom\s+the\s+week\s+of\b[^.!?\n]*\bwould\s+be\s+the\s+week\s+of\b/.source,
    /\bthis\s+is\s+a\b[^.!?\n]{0,60}\b(?:job|lead|request)\b[^.!?\n]{0,50}\b(?:quoted|by\s+dm|not\s+a\s+visit)\b/.source,
    // SPANISH/PORTUGUESE leaks — the English-only list let "El cliente eligió el
    // lunes pero no especificó la hora, necesito confirmar cuál de las dos
    // prefiere antes de pedir los datos." ship to a client (caught LIVE by the
    // 2026-07-17 E2E replay). Third-person "el cliente / o cliente" narration
    // and planning phrases are never client-facing text.
    /\bel\s+cliente\s+(?:eligi[oó]|elige|dij[oó]|pidi[oó]|quiere|acept[oó]|confirm[oó]|mand[oó]|envi[oó]|no\s+(?:especific[oó]|eligi[oó]|confirm[oó]|dij[oó]))\b/.source,
    /\bo\s+cliente\s+(?:escolheu|disse|pediu|quer|aceitou|confirmou|mandou|enviou|n[ãa]o\s+(?:especificou|escolheu|confirmou|disse))\b/.source,
    /\bantes\s+de\s+pedir\s+(?:los\s+datos|os\s+dados)\b/.source,
    /\bnecesito\s+(?:confirmar|verificar|revisar)\s+cu[aá]l\b/.source,
    /\bdebo\s+(?:confirmar|preguntar|verificar|revisar)\b/.source,
    /\bespera,?\s+d[eé]jame\b|\bd[eé]jame\s+(?:recalcular|rehacer|corregir)\b/.source,
    // ROUTE-NOTE leak (route-offer-verify, 2026-08-27): with the internal
    // "ROUTE PRIORITY" schedule note in context the model narrated its slot
    // selection to the client — "The client can only do mornings before noon,
    // so from the schedule the matching slots are Monday at 9am or 11am … I
    // need to offer exactly two. Tuesday 9am and 11am fit the route priority
    // and the client's constraint best." None of these phrases is ever
    // client-facing; the note's own labels least of all.
    /\bthe\s+client(?:'s)?\s+(?:can|cannot|can'?t|only|needs?|prefers?|constraints?|is|was|has|hasn'?t|did|didn'?t)\b/.source,
    /\bi\s+need\s+to\s+(?:offer|pick|choose|select|name|list)\b/.source,
    /\bfits?\s+the\s+route\b|\broute\s+priorit(?:y|ies)\b|\boffer\s+first\b|\bthe\s+matching\s+slots?\b|\bfrom\s+the\s+schedule\s+(?:the|above|in\s+context)\b|\bexactly\s+two\s+(?:slots?|times?|options?)\b|\bzip\s+code\s+first\b/.source,
    /\bprioridad\s+de\s+ruta\b|\bprioridade\s+de\s+rota\b|\bel\s+cliente\s+(?:s[oó]lo|solo|puede|necesita|prefiere)\b|\bo\s+cliente\s+(?:s[oó](?![a-z])|pode|precisa|prefere)(?![a-z])/.source,
    // DATE-FIRST note labels (2026-08-27): "priority day", "70% booked", "fill
    // rate", "preferred seller" and their ES/PT forms are never client-facing.
    /\bpriority\s+day\b|\bd[ií]a\s+prioritari[oa]\b|\bdia\s+priorit[áa]ri[oa]\b|\bfill\s+rate\b|\bpreferred\s+seller\b|\bvendedor\s+prefer(?:ido|ente)\b|\b\d{1,3}\s?%\s+(?:booked|full|reserved|ocupad[oa]|reservad[oa]|llen[oa]|chei[oa])\b/.source,
  ].join("|"),
  "i"
);

export function stripReasoningLeak(text: string): string {
  // Tags ([BOOK:{...}] and friends) are masked first: the JSON "notes" once
  // matched a leak pattern and the WHOLE tag was deleted, shipping "Perfect,
  // see you then!" with no visit behind it (Shaeleen Herrera-Garcia, IG
  // 2026-08-26). Only the prose is ever judged sentence by sentence.
  return withTagsProtected(text, (prose) => {
    if (!REASONING_LEAK_SENTENCE.test(prose)) return prose;
    // Sentence split that never breaks inside a decimal price ("$4.50").
    const parts = prose.match(/(?:[^.!?\n]|\.(?=\d))+[.!?]*\s*/g) ?? [prose];
    const kept = parts.filter((s) => !REASONING_LEAK_SENTENCE.test(s));
    const result = kept.join("").replace(/[ \t]{2,}/g, " ").trim();
    const substance = result.replace(/\[[^\]]*\]/g, "").trim();
    if (substance.length < 20) return prose;
    console.log("[AI] reasoning-leak scrubber: removed internal monologue sentence(s) from the reply");
    return result;
  });
}

// ─── Foreign-phone scrubber ────────────────────────────────────────────────
// Owner rule: the ONLY phone number that may ever appear in a message to a
// client is (561) 674-8334. The model once ECHOED the client's own callback
// number back at them ("I'll have Ozzi reach out to you directly at 3057668885
// shortly!", 2026-07-18, Rezashahid) — the number came from the chat history,
// not thin air, but it reads confusing, adds zero information, and one day a
// digit gets garbled. Any other phone-looking token is removed from the OUTBOUND
// text (with its "at/on/al/en" connector), while content inside [ ... ] tags is
// left alone so [BOOK:{"phone":...}] keeps the client's real number.
// EXCEPTION (2026-08-10): the installation confirmation we send via
// /api/confirmar-instalacao legitimately hands the client the seller's direct
// number ("Diego ... reach them directly at (954) 325-6735"), and the prompt
// tells the model to point reschedules/changes at exactly that contact — so the
// caller may pass the numbers found in those confirmation messages as allowed.
// Only numbers OUR system already delivered to this client qualify; the
// client's own number keeps being scrubbed.
const OFFICIAL_PHONE_DIGITS = "5616748334";
const FOREIGN_PHONE = /(?:\b(?:at|on|to|al|en|no)\s+)?(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/gi;

// True when the recent history contains the installation confirmation our
// /api/confirmar-instalacao sent. A client replying after that message is a
// CLOSED SALE in the installation stage — the appointment they assert IS one we
// ourselves confirmed, so the stale-booked "visita afirmada" guard must NOT
// intercept: the model answers via the INSTALLATION CONFIRMED prompt section
// (caso Jean E Raymond, 2026-08-11: "See you tomorrow" após a confirmação levou
// o handoff enlatado de visita em vez da continuidade natural).
// Mesma regex de src/lib/instalacao.ts (INSTALL_CONFIRMATION_RE) — duplicada
// aqui para não criar import circular (instalacao.ts importa de ai.ts).
const INSTALL_CONFIRMATION_TEXT = /installation (?:is confirmed for|starts tomorrow)/i;

export function hasInstallationConfirmation(messages: { role: string; content: string }[]): boolean {
  return messages.some((m) => m.role === "assistant" && INSTALL_CONFIRMATION_TEXT.test(m.content));
}

// Extracts the allowed phone digits from installation-confirmation messages in
// the history. Normalized the same way scrubForeignPhones normalizes matches.
export function installConfirmationPhones(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === "assistant" && INSTALL_CONFIRMATION_TEXT.test(m.content))
    .flatMap((m) => m.content.match(/\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g) ?? [])
    .map((p) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""));
}

export function scrubForeignPhones(text: string, allowedDigits: string[] = []): string {
  let out = "";
  let seg = "";
  let depth = 0;
  let fired = false;
  const flush = () => {
    out += seg.replace(FOREIGN_PHONE, (m) => {
      const digits = m.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      if (digits === OFFICIAL_PHONE_DIGITS || allowedDigits.includes(digits)) return m;
      fired = true;
      return "";
    });
    seg = "";
  };
  for (const ch of text ?? "") {
    if (ch === "[") { flush(); depth++; out += ch; continue; }
    if (ch === "]") { depth = Math.max(0, depth - 1); out += ch; continue; }
    if (depth > 0) out += ch;
    else seg += ch;
  }
  flush();
  if (!fired) return text;
  console.log("[AI] foreign phone number scrubbed from outbound text");
  return out.replace(/ {2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();
}

// ─── Main AI response via Claude claude-sonnet-4-6 ───────────────────────────────
export async function getAIResponse(
  messages: ChatMessage[],
  memoryContext?: string | null,
  systemMemory?: string | null,
  ownerCorrections?: string | null,
  bookingConfirmed?: boolean
): Promise<AIResponse> {
  // After booking is confirmed, send NOTHING to the client — webhook already notified the owner
  if (bookingConfirmed) {
    console.log("[AI] Booking confirmed — sending nothing to client");
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }

  // REPEATED-MESSAGE INTERCEPT: the client re-sent the exact same message we
  // just answered (Messenger ad FAQ quick-reply buttons get re-tapped — one
  // client sent "What is the installation process?" five times and used to get
  // the identical paragraph five times). Re-answering identically is the
  // robotic-loop signature (rule 29) AND a wasted paid model call. React-only
  // instead: the answer is directly above. Booking payloads (address/phone) are
  // exempt — a re-sent address means the client is pushing to book, never
  // silence it. Only the MOST RECENT answered message is compared, so asking
  // the same thing much later in the conversation still gets a fresh answer.
  const repeatCandidate = messages[messages.length - 1];
  if (repeatCandidate?.role === "user" && messages.length >= 3) {
    const normRepeat = (s: string) => s.split(/\n\n?\[SYSTEM:/)[0].replace(/\s+/g, " ").trim().toLowerCase();
    const lastText = normRepeat(repeatCandidate.content);
    if (lastText.length >= 15 && !containsBookingInfo(lastText)) {
      for (let i = messages.length - 2; i >= 1; i--) {
        if (messages[i].role !== "assistant") continue;
        if (messages[i - 1]?.role === "user" && normRepeat(messages[i - 1].content) === lastText) {
          // ONLY suppress the quick double-tap (same FAQ button hit again
          // within 15 minutes). A repeat AFTER that window is a genuine
          // re-ask that deserves a real answer — a client re-sent "What is
          // the installation process?" 2 HOURS after getting only the
          // type-ask opener (which never answered the question) and was
          // wrongly silenced (2026-07-08, Nardine). Without timestamps we
          // never suppress — answering twice beats ignoring a client.
          // NOT a pure double-tap when the un-answered burst carries ANY
          // other real bubble: the 10s debounce folds rapid messages into
          // this turn, and "Can you schedule to see my house" + re-tapped
          // FAQ arrived together — the intercept silenced BOTH and a hot
          // scheduling request got dead air (2026-07-23, Romulla). The
          // model must answer the full burst.
          const burstHasNewContent = messages
            .slice(i + 1, messages.length - 1)
            .some((m) => m.role === "user" && normRepeat(m.content) && normRepeat(m.content) !== lastText);
          if (burstHasNewContent) {
            console.log("[AI] double-tap folded into a burst with new content — answering the full burst");
            break;
          }
          // NOT a double-tap when our reply to the FIRST send was only the
          // type-ask opener (it names tile + hardwood and asks which one) and
          // the repeated text is NOT one of the FAQs those openers already
          // answer: the client is repeating because their question was IGNORED
          // ("Where are you located" twice, 1 min apart — the opener steamrolled
          // the question and this intercept then silenced the re-ask; Tom
          // Kiper, 2026-07-29). Answering twice beats ignoring a client.
          const betweenReply = messages[i].content;
          const typeAskOpener = /\btile\b/i.test(betweenReply) && /\bhardwood\b/i.test(betweenReply);
          // "Answered" = the reply carries that FAQ's actual answer content
          // (the FAQ-aware openers do; the GENERIC opener never does).
          const openerAnsweredIt =
            (AD_FAQ_PROCESS.test(lastText) && /furniture|muebles/i.test(betweenReply)) ||
            (AD_FAQ_DISCOUNT.test(lastText) && /pricing|precio/i.test(betweenReply)) ||
            (AD_FAQ_LOCATION.test(lastText) && /miami|florida/i.test(betweenReply)) ||
            // "what is included is a little different for each" (the ask-type
            // inclusions line) contains "included" but answers NOTHING — the
            // re-tapped "What type of materials are included?" 99s later was
            // silenced as a double-tap (fb_27474567792195210, 2026-08-25).
            // Answered = the reply actually names what is included.
            (AD_FAQ_INCLUSIONS.test(lastText) &&
              /\b(?:includes?|incluye|inclui)\s+(?:the\s+|el\s+|la\s+|o\s+|a\s+)?(?:flooring|material|labor|installation|instalaci[oó]n|mano|piso)|\blabor\s+only\b|\bquarter\s+round\b|\bmano\s+de\s+obra\b|\bm[aã]o\s+de\s+obra\b/i.test(betweenReply));
          if (typeAskOpener && !openerAnsweredIt) {
            console.log("[AI] repeat right after a type-ask opener that ignored the question — answering it fresh");
            break;
          }
          const prevAt = messages[i - 1].at ? Date.parse(messages[i - 1].at as string) : NaN;
          const nowAt = repeatCandidate.at ? Date.parse(repeatCandidate.at as string) : NaN;
          const gapMin = (nowAt - prevAt) / 60000;
          if (Number.isFinite(gapMin) && gapMin >= 0 && gapMin <= 15) {
            console.log("[AI] client repeated the exact message within 15min — REACT_ONLY (double-tap, no repeat)");
            return { text: "[REACT_ONLY]", inputTokens: 0, outputTokens: 0 };
          }
          console.log("[AI] repeated question after a gap (or no timestamps) — answering it fresh");
        }
        break;
      }
    }
  }

  // JOB SEEKERS FIRST: someone looking for work or offering their own labor
  // (installer, painter, "are you hiring", "busco trabajo") is never a customer.
  // Guard this at the very top so a hardcoded intercept or the type-ask opener
  // can never turn it into a sales pitch (the reported "job seeker got the promo
  // opener" bug). Only on true first contact, and only the client's own text.
  const firstUser = messages[messages.length - 1];
  if (
    firstUser?.role === "user" &&
    !messages.some((m) => m.role === "assistant") &&
    isJobSeeker(firstUser.content.split(/\n\n?\[SYSTEM:/)[0])
  ) {
    console.log("[AI] Job seeker on first contact — REACT_ONLY (no pitch)");
    return { text: "[REACT_ONLY]", inputTokens: 0, outputTokens: 0 };
  }

  // REJECTION / HOSTILITY: read the client's words BEFORE any canned line
  // fires (fb_27777958491826513, 2026-08-22: first message "No. Get away from
  // me" still got the promo opener through the ad-context leg — the client
  // then wrote "Reporting you for spam"). First contact judges the whole
  // opening burst but ANY interest signal routes to the model instead of
  // silence. Mid-conversation only the NEWEST bubble is judged: [REACT_ONLY]
  // writes no assistant row, so the un-answered burst keeps old bubbles — a
  // client who came back days after a "stop messaging me" with "actually I'd
  // like the estimate" must reach the model, not be silenced by their own
  // stale hostility. A cancel request or booking info always keeps its flow.
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  const unansweredBurst = unansweredUserBurst(messages);
  if (unansweredBurst.trim()) {
    const newestBubble = (messages[messages.length - 1]?.role === "user" ? messages[messages.length - 1].content : "").split(/\n\n?\[SYSTEM:/)[0];
    const rejected =
      lastAssistantIdx === -1
        ? isFirstContactRejection(unansweredBurst)
        : isHostileRejection(newestBubble) && !isCancelRequest(newestBubble) && !containsBookingInfo(newestBubble);
    if (rejected) {
      console.log("[AI] client rejected the contact — REACT_ONLY (total silence, no promo, no apology)");
      return { text: "[REACT_ONLY]", inputTokens: 0, outputTokens: 0 };
    }
  }

  // TYPE FIRST: on first contact, when we do NOT yet know the flooring type
  // (no ad detection, client has not named one), open by asking which of the
  // three types they want — for a bare greeting AND for a generic pricing/promo/
  // "how does it work" inquiry — instead of pitching the vinyl promo. The client
  // answers and the normal per-type script continues. A plain "hi"/"hola"/"olá"
  // used to get a silent reaction; a "how much?" used to get the $5 vinyl answer.
  const lastMsg = messages[messages.length - 1];
  const hasPriorAssistant = messages.some((m) => m.role === "assistant");
  if (!hasPriorAssistant && lastMsg?.role === "user" && !conversationFlooringType(messages) && !isJobSeeker(lastMsg.content)) {
    const t = lastMsg.content.split(/\n\n?\[SYSTEM:/)[0];
    // The FIRST-CONTACT BURST: on Meta, the tapped quick-reply question and the
    // "[Client replied to our ad]" tag can arrive as SEPARATE messages in either
    // order. The debounce answers on the LAST one — when that is the bare ad
    // tag, matching only `t` missed the question sitting one bubble earlier and
    // the generic opener steamrolled it (Joan Caruso, 2026-07-17 review). Since
    // there is no assistant reply yet, EVERY user message is un-answered: match
    // the FAQ/large-sqft/language signals against the whole burst.
    const burst = messages
      .filter((m) => m.role === "user")
      .map((m) => m.content.split(/\n\n?\[SYSTEM:/)[0])
      .join("\n");
    // OPENER EXCEPTION backstop: 500+ sqft already declared in the very first
    // message → NEVER the canned type-ask; the model acknowledges the size and
    // proposes the free visit per the prompt's OPENER EXCEPTION.
    const largeFirstMessage = mentionsLargeSqft(burst);
    // CARPET backstop (owner rule 2026-07-30): every canned opener below names
    // only tile, vinyl, and hardwood, so firing one at a lead who asked about
    // carpet reads as "we don't install carpet" — which is false and is exactly
    // what a client was told. Carpet is not an advertised type, so it never sets
    // conversationFlooringType; skip the canned lines and let the model answer
    // with the CARPET INSTALLATION rules ($2.20/sqft labor only).
    const carpetFirstMessage = mentionsCarpet(burst);
    // REJECTION-FLAVORED wording anywhere in the burst → no canned line at
    // all (2026-08-22): either the guard above already silenced it, or an
    // interest signal routed it here — and then the MODEL must read the words
    // ("don't text me, call me instead" must never get the promo opener).
    const rejectionish = mentionsRejection(burst);
    // Phone number / call-me / existing client / objection / language / DIY
    // in the opening burst → the model reads it, never a canned line.
    // A language request ("Hablas español", "en português") keeps its own
    // deterministic language-confirming opener below; everything else that
    // needs reading goes to the model.
    const needsReading = firstMessageNeedsReading(burst) && !requestedLang(burst);
    // AD-FAQ AWARE OPENERS: the tapped quick-reply question gets its one-line
    // answer folded into the SAME deterministic type-ask (still zero-token).
    // Meta's FAQ buttons are EN/ES; PT falls through to the generic opener.
    if (!largeFirstMessage && !carpetFirstMessage && !rejectionish && !needsReading) {
      const lang = openerLang(burst);
      // MULTI-TAP FIRST: the ad quick-replies are buttons and leads tap several
      // at once, so the single-topic chain below (first match wins) answered one
      // question and silently dropped the rest — 17 of 24 multi-question bursts
      // in the 5-day review came back incomplete (2026-08-01). When the burst
      // carries 2+ distinct topics, answer ALL of them in one message.
      if (lang !== "pt") {
        const topics: AdFaqTopic[] = [];
        if (AD_FAQ_LOCATION.test(burst)) topics.push("location");
        if (AD_FAQ_PROCESS.test(burst)) topics.push("process");
        if (AD_FAQ_DISCOUNT.test(burst)) topics.push("discount");
        if (AD_FAQ_INCLUSIONS.test(burst)) topics.push("inclusions");
        const combined = composeAdFaqOpener(topics, lang);
        if (combined) {
          console.log(`[AI] First contact, ${topics.length} ad-FAQs tapped (${topics.join("+")}) — answering all of them + asking the type`);
          return { text: combined, inputTokens: 0, outputTokens: 0 };
        }
      }
      if (AD_FAQ_PROCESS.test(burst)) {
        const opener = lang === "es" ? OPENER_PROCESS_ES : OPENER_PROCESS_EN;
        console.log("[AI] First contact, ad-FAQ (installation process) — answering + asking the type");
        return { text: opener, inputTokens: 0, outputTokens: 0 };
      }
      if (AD_FAQ_DISCOUNT.test(burst)) {
        const opener = lang === "es" ? OPENER_DISCOUNT_ES : OPENER_DISCOUNT_EN;
        console.log("[AI] First contact, ad-FAQ (larger-space discounts) — answering + asking the type");
        return { text: opener, inputTokens: 0, outputTokens: 0 };
      }
      // "Where are you located?" — answer the service area AND ask the type in
      // the same deterministic message (the generic opener used to ignore the
      // question entirely; Tom Kiper, 2026-07-29).
      if (AD_FAQ_LOCATION.test(burst)) {
        const opener = lang === "pt" ? OPENER_LOCATION_PT : lang === "es" ? OPENER_LOCATION_ES : OPENER_LOCATION_EN;
        console.log("[AI] First contact, location question — answering the service area + asking the type");
        return { text: opener, inputTokens: 0, outputTokens: 0 };
      }
      // Inclusions-family quick-replies (all real Meta FAQ buttons seen in
      // production): "Is installation labor cost extra?", "Is labor cost also
      // $4,500?", "Is installation cost included in the price?", "What type of
      // materials are included?" — the ask-type inclusions line acknowledges
      // them properly instead of the generic opener steamrolling the question
      // (8 leads hit the two unmapped variants in the 3-day review).
      if (AD_FAQ_INCLUSIONS.test(burst)) {
        console.log("[AI] First contact, ad-FAQ (inclusions) — inclusions ask-type line");
        return { text: WHAT_IS_INCLUDED_ASK_TYPE, inputTokens: 0, outputTokens: 0 };
      }
    }
    // The lead came from an ad but we could NOT detect its type (no
    // [AD_FLOORING_TYPE] marker, just the ad-reply note / placeholder). This is
    // exactly the "clicked the tile ad → got the vinyl $5 pitch" case: ask the
    // type deterministically instead of letting the model pitch the vinyl package.
    // "what's included" is excluded so it routes to its own ask-type intercept.
    const adContext = /\[AD REPLY:|\[Client replied to our ad\]|Client shared a post\/reel from our ad/i.test(lastMsg.content);
    const excludedTopic =
      SPECIFIC_TYPE.test(t) || SUBSTANTIVE_PRODUCT_Q.test(t) || SEE_OR_COLOR.test(t) ||
      OTHER_TOPIC.test(t) || isRepairRequest(t) || /\bincluded?\b|what(?:'?s| is| does)\b.{0,25}\bpackage\b|come with|\blabor\s+cost\b/i.test(t);
    // questionBeyondOpener: a first-message question the opener does not answer
    // (licensed? smaller projects? free estimates?) reaches the model instead of
    // being steamrolled by the canned line (2026-08-21 sweep, 25 cases/7 days).
    if (!largeFirstMessage && !carpetFirstMessage && !rejectionish && !needsReading && !questionBeyondOpener(burst) && (isBareGreeting(lastMsg.content) || isFlooringInquiry(lastMsg.content) || (adContext && !excludedTopic))) {
      const opener = openerMessage(burst);
      console.log("[AI] First contact, type unknown — asking the flooring type:", opener.slice(0, 50));
      return { text: opener, inputTokens: 0, outputTokens: 0 };
    }
  }

  // Check hard-coded intercepts first — bypasses AI entirely for known patterns
  const hardcoded = checkHardcodedResponse(messages);
  if (hardcoded) {
    console.log("[AI] Hard-coded intercept triggered:", hardcoded.slice(0, 60));
    return { text: hardcoded, inputTokens: 0, outputTokens: 0 };
  }

  const anthropic = getAnthropic();

  // Build system prompt — layer: base prompt + system learnings + client memory.
  // COST: the prompt is split into a STABLE prefix (base prompt + global
  // learnings — byte-identical for every conversation) and a DYNAMIC remainder
  // (per-client memory, owner corrections, final reminders). The stable prefix
  // carries a prompt-cache breakpoint, so after the first call of any 5-minute
  // window the API re-reads it at ~10% of the input price instead of billing the
  // full ~10K-token prompt on every single client message. Content, order, and
  // model are unchanged — replies are unaffected; only the billing changes.
  let stableSystem = SYSTEM_PROMPT;

  if (systemMemory) {
    stableSystem += `\n\n---\n\n## AGENT LEARNINGS (from Dreaming analysis)\nUse these patterns to improve responses. Don't mention them explicitly.\n${systemMemory}`;
  }

  let dynamicSystem = "";

  if (memoryContext) {
    dynamicSystem += `\n\n---\n\n## RETURNING CLIENT — MEMORY\n${memoryContext}\n\nUse this memory to avoid repeating questions the client already answered. Do NOT ask for info you already have.`;
  }

  if (ownerCorrections) {
    dynamicSystem += `\n\n---\n\n## MANDATORY OWNER CORRECTIONS — THESE OVERRIDE EVERYTHING\nThe owner has already corrected these responses. When the client's question matches or is similar to a PERGUNTA below, you MUST use the exact RESPOSTA CORRETA. No exceptions.\n\n${ownerCorrections}`;
  }

  // FINAL REMINDERS — come last to reinforce the most critical rules
  dynamicSystem += `\n\n---\n\nFINAL REMINDERS:\n1. Zero dashes — no -, –, or — anywhere. Replace with commas or periods.\n1b. SPANISH PUNCTUATION: never use the inverted marks ¿ or ¡. In Spanish, punctuate exactly like Portuguese: only the closing ? or ! at the end of the sentence ("Cuál te interesa?", "Perfecto!"), never "¿Cuál te interesa?" or "¡Perfecto!".\n2. Zero emojis — no emoji, no decorative symbol, nothing. Plain text only.\n3. LENGTH RULE: Use 1 sentence when the message is complete with just the answer. Use 2 sentences ONLY when you genuinely need both an answer AND a forward question. Never 3 sentences. NEVER use a standalone opener like "Perfect!", "Great!", "Sounds good!", "Hello!", or "Hi!" as its own sentence — always merge it with a comma: "Perfect, your project comes to about $1,500." not "Perfect! Your project comes to about $1,500."\n4. SQFT RULE: If the client mentions a specific number of 500 sqft or more, NEVER give a price. Always propose the free in-person visit. This overrides everything else.\n5. SCOPE ALREADY ANSWERED RULE: If the client has already mentioned in this conversation which areas, rooms, or project scope (kitchen, bedroom, whole house, one room, etc.), NEVER ask "one area or whole house?" again. That question is asked ONCE at the very start. When the client asks about scheduling, availability, pricing, or anything else AFTER already stating scope, answer their question directly without re-attaching the classification question.\n6. BOOKING DONE RULE: If [BOOKING ALREADY CONFIRMED] appears in the system context, the conversation is over. Do NOT answer any question. For ANY client message, respond with ONE sentence redirecting to Ozzi and add [NOTIFY_OWNER] — example: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]" NEVER generate [BOOK:...]. NEVER answer questions directly. NEVER mention appointment details.\n7. SLOT CONFIRMATION RULE: Ask for the client's name, address, and phone ONLY after the client explicitly names a specific day and time (e.g., "Monday at 3pm works"). Vague replies like "Okay", "Sounds good", "Alright", "I'll let you know" mean they are still deciding — respond with ONE sentence only and wait. NEVER use "No problem!" as a standalone sentence — merge it: "No problem, just let me know which day works!" Never push for name/address/phone when the slot is not confirmed. An address or phone number by itself is NOT a slot selection: if the client sent contact info but never picked one of the offered days/times, do not generate [BOOK:...], ask which of the offered times works instead.\n8. PRE-BOOKING TEXT RULE: The text before [BOOK:...] must be 5 words or fewer. NEVER repeat the date, time, or address in that text. The system sends the confirmation automatically. Write ONLY something like "Perfect, see you then!" or "All set!" before the tag.\n8b. WHATSAPP NO-PHONE RULE: If a [WHATSAPP CHANNEL] note is in context, you ALREADY have the client's phone number. NEVER ask for a phone, a callback number, or the "best number" on WhatsApp. Ask for the client's NAME and the property address instead. The MOMENT you have a confirmed day/time, the client's name, AND the property address, generate [BOOK:...] immediately using the WhatsApp number, do not ask for anything else.\n9. WHAT IS INCLUDED — TYPE GATED: The "${WHAT_IS_INCLUDED_RESPONSE}" answer is the VINYL offer (material included). Give it EXACTLY only when you ALREADY KNOW the client wants vinyl and they ask "what is included" / "is labor included" / "does it include installation". If the flooring type is still UNKNOWN, do NOT give it (tile and hardwood include NO material, only labor) — ask which type they want: tile, vinyl, or hardwood. If you know they want TILE or HARDWOOD, say the promotion covers the installation labor only and they provide the material. For any other package question, answer naturally.\n10. Colors: plain text only, no tags or brackets of any kind.\n10b. MATERIAL vs SEE RULE: Two cases. CASE A, the client asks WHAT the product is ("what kind of materials", "what is the material", "what is the material allowance", "what flooring do you use", "what kind of floor", "what are the material/flooring options", "what do you offer", "is it vinyl") then, IF you already know the client wants vinyl, DESCRIBE it directly and send NO link: say it is our luxury vinyl, waterproof and highly resistant, with a 20-year warranty, then mention the free quote and ask one area or whole house. If the flooring type is still UNKNOWN, do NOT describe it as vinyl, instead ask which type they want first: tile, vinyl, or hardwood (or propose the visit if the size is already 500+ sqft). NEVER list color or product names. CASE B, the client asks you to SEND or show photos/pictures/images/catalog, asks which COLORS/styles you have, names a SPECIFIC color/style, or asks for your website or Instagram, then redirect with EXACTLY: "For that, the best is to message our team directly on WhatsApp at (561) 674-8334 and we'll help you find the right floor!" and add [NOTIFY_OWNER]; never send the website/Instagram link unless they specifically ask for it. WHATSAPP EXCEPTION: if a [WHATSAPP CHANNEL] note is in context the client is ALREADY messaging us on WhatsApp, so never tell them to message us on WhatsApp, instead say the team will send the photos of the options right here and add [NOTIFY_OWNER]. CASE B EXCEPTION (propose the visit, do NOT redirect): if the client just wants to SEE the product or floors in person or as soon as possible ("would love to see it", "see the product asap", "can I see it soon", "want to see what you have") WITHOUT asking you to SEND photos and WITHOUT naming a specific color, treat it as a buying signal: say you bring all the samples to the free in-person visit so they can see everything and pick right there, and move to scheduling (ask one area or whole house if size unknown, or propose the visit if already 500+ sqft). If the client asks whether it is really vinyl (some marble-finish floors we advertise are still luxury vinyl), confirm yes, it is luxury vinyl. EXCEPTION 1: real PRODUCT CAPABILITY questions (waterproof, durable, humid/tropical climate, over tile, warranty) are answered directly. EXCEPTION 2: tile questions ("do you have tile that looks like wood") get the Floor & Decor answer.\n11. If the client asks for a phone number or contact: use ONLY (561) 674-8334. The owner's name is Ozzi. NEVER invent a number. NEVER write any other phone number in a message, not even the CLIENT'S OWN number back to them — when saying the team will call, say "on the number you provided" with NO digits (wrong: "I'll have Ozzi reach out to you at 3057668885"; right: "I'll have Ozzi reach out to you on the number you provided shortly!"). The only place a client's number belongs is inside the [BOOK:...] tag. If the client asks for YOUR name, say you are Ozzi's assistant, NEVER invent a personal name (no "Alex", no made-up names, ever).\n12. LARGE LEAD RULE: For projects 500 sqft or more: NEVER give a total price or dollar estimate by DM. Always push for the free in-person visit. Asking "how much?" or "what's the price per sqft?" does NOT mean the client refuses a visit — it means they want information. Give the visit offer, not a price.\n13. TILE RULE: When the client mentions "tile", "tiles", "porcelain", or "ceramic" — this is a TILE installation job, NOT luxury vinyl. NEVER quote $5/sqft for a tile job. Tile labor only is $4.50/sqft. Tile pricing is ALWAYS exactly sqft x $4.50 with NOTHING added: the +$500 small-job surcharge is EXCLUSIVE to luxury vinyl (LVP) and must NEVER be applied to a tile job (250 sqft tile = $1,125 not $1,625; 300 sqft tile = $1,350 not $1,850). Tile demo/removal is $1.50/sqft extra, only if asked. For tile projects 500 sqft or more, NEVER give a total DM price — always propose the free visit.\n14. NO INVENTED SLOTS RULE: If you do NOT see [REAL-TIME SCHEDULE] with actual time slots in this conversation context, you have ZERO schedule information. NEVER say "I have Thursday at 2pm" or any specific day/time. The ONLY correct answer when asked about availability is: "Let me check what I have open. What day works best for you?" — then stop. Do not invent or guess any slot.
18. SMALL-JOB PRICING RULE: UNDER 200 sqft we DO NOT take the job, under any circumstance — never quote a price, never propose a visit, just politely decline in one short sentence and invite them back for a bigger area (example: "We focus on larger installations, so we don't take projects under 200 square feet, but reach out anytime you have a bigger area!"). For a LUXURY VINYL (LVP) project you quote by DM that is 200 to 400 sqft, the total MUST be (sqft x $5) + $500, presented as ONE final number with the $500 already baked in. This +$500 add-on is for luxury vinyl ONLY: NEVER apply it to a tile, porcelain, or ceramic job (tile is always sqft x $4.50 with no add-on). NEVER reveal, itemize, mention, or hint at the $500, and do NOT show any per-sqft breakdown for these small jobs (no "$5/sqft", no "$5 x N"). Example: 200 sqft -> say about $1,500 (not $1,000). Example: 300 sqft -> about $2,000. For 401 to 499 sqft use plain $5/sqft with no add-on. For 500 sqft or more NEVER give a DM price, propose the free visit. The pricing tiers are INTERNAL: never explain them, never mention any range/band/tier, never narrate your calculation or self-correct out loud (no "let me give the right answer", no "480 is between 401 and 499"). Reply with ONLY the final total in one clean sentence.
23. JOB SEEKER RULE: If the message is from someone seeking a job or offering their own labor/services (installer, painter, laborer, helper, carpenter, "are you hiring", "looking for work", "I'm an installer", "busco trabajo", "soy instalador", "procuro emprego", "sou pintor"), this is NOT a customer. Output EXACTLY [REACT_ONLY] and nothing else, no greeting, no pitch. A real customer asking about our service ("do you have installers?", "I need my floor installed") is NOT a job seeker, answer them normally.
19. HOW IT WORKS RULE: When the client asks how the promotion works or how you charge, state that it is $5 per square foot and that price already includes the floor and the installation, and that installation only (client supplies the material) is $2 per square foot. Keep it short. Do not reveal the small-job surcharge.
21. ANSWER PRODUCT QUESTIONS RULE: When the client asks a real question about the product, ALWAYS answer it directly and helpfully FIRST — never deflect a genuine product question to "browse our website". Key facts you can state: our luxury vinyl is 100% waterproof, has a stone composite (SPC) core, a 20-year warranty, is highly scratch and water resistant, performs great in humid and tropical climates, and can usually be installed right over existing tile. If they ask you to recommend something, give a brief direction based on their style and then invite them to browse for the exact look. If the client is OUTSIDE South Florida (another state, the Caribbean, the West Indies, another country) and is asking about the PRODUCT, still answer their product question helpfully; only mention that our installation service covers South Florida if they specifically ask US to install or visit. NEVER dismiss an out-of-area client with "we can't help you" — answer what they asked.
20. TILE MATERIAL RULE: We do NOT sell tile material. If the client asks whether you offer, sell, have, or carry tile, or tile/porcelain that looks like wood (wood-look tile), respond with EXACTLY this and nothing more: "We don't sell tile materials. We only do the installation. However, you can find wood-look tiles at stores like Floor & Decor." Do NOT append, add, or tack on a luxury vinyl / LVP suggestion or any upsell after it — give only those sentences and stop. NEVER respond to a TILE question by pitching luxury vinyl wood-look as if it were the same thing. (Wood-look luxury VINYL is only the right answer when the client asks about vinyl or wood-look floors generally, not tile.)
17. PURE CLOSING RULE: If the client's latest message is ONLY a thank-you, farewell, acknowledgment, or a statement that they will act later ("I'll call you tomorrow", "I'll let you know", "ok thanks", "got it", "sounds good", a heart or a thumbs up) and contains NO new question or request, output EXACTLY [REACT_ONLY] and nothing else. Do NOT repeat the phone number, do NOT add any sentence, do NOT keep selling. The system will simply react to their message. EXCEPTION: if the message mixes a thanks with a real new question (example: "thanks, do you do screens?"), OR with an ANSWER to something you just asked (you asked "tile, vinyl, or hardwood?" and they say "Thank you! Either vinyl or laminate"; you asked the scope and they say "thanks, the whole house"; you offered the quote and they say "yes please"), ignore the thanks and respond to the substance normally — NEVER [REACT_ONLY]. A message that names a DAY or a TIME (like "El martes está bien, gracias" or "Tuesday works, thanks") is ALWAYS the client picking a slot, never a closing: proceed with the booking flow, never [REACT_ONLY]. Also do NOT use [REACT_ONLY] for a vague reply while you are still waiting for the client to pick a time slot, treat that per the SLOT CONFIRMATION RULE. A bare "ok", "okay", "perfect", "great", "cool", "got it", "sounds good", "entendido", "listo", "beleza" sent after a message of yours that did NOT ask a question is a closing too: [REACT_ONLY]. And once you (or the system) told the client that Ozzi will reach out or be in touch, ANY acknowledgment or thanks that follows gets EXACTLY [REACT_ONLY]: never answer "Sounds good, Ozzi will be in touch soon" to an "ok". One handoff line is the END of the conversation, the client's "ok" does not reopen it.
16. DATE INTEGRITY RULE: When you name a weekday to the client (Friday, viernes, etc.), the date MUST be the exact [YYYY-MM-DD] shown next to that same weekday in the REAL-TIME SCHEDULE. NEVER compute or guess a date yourself, and NEVER pair a weekday with a date from a different schedule line. Before writing [BOOK:...], re-read the schedule line for the weekday you promised and copy its [YYYY-MM-DD] and only a time listed on that line. Example: if the schedule shows "Friday ... [2026-06-05]: 9am, 1pm", then "Friday at 1pm" books date 2026-06-05 and time 13:00, NEVER 2026-06-06. Saturday is a different line with different times. If the time the client wants is not listed under the exact date you promised, tell them it is not open and offer a time that IS listed for that date.
15. CLIENT AVAILABILITY RULE: If the client states when they are available (examples: "only after 6pm", "I'm only home after 6", "only on weekends", "evenings only", "I work until 5", "only Saturday", "only Sunday", "no mornings"), you MUST filter all slot options to ONLY those that match their constraint. NEVER propose a time that contradicts what the client said. Examples: if the client says "after 6pm", offer ONLY 6pm or later slots on weekdays. If they say "only weekends", offer ONLY Saturday or Sunday slots. If they say "after 6pm or weekends", that means weekdays ONLY after 6pm AND weekends at any time — do NOT offer a weekday slot before 6pm, but a Saturday or Sunday at any hour is fine. If no slots in the schedule match their constraint, acknowledge it directly and ask what flexibility they have. This rule overrides the general "offer 2 available slots" instruction — always honor the client's stated availability first.
22. NO PRESSURE RULE: Propose the visit and offer time slots ONCE. After you have already proposed the visit, do NOT tack a scheduling push onto the end of every message ("what time works for you", "what day works", "so we can get started right away", or a list of slots). When the client asks an informational question (materials, specs, thickness, wear layer, lighting, timeline, etc.), ANSWER that question and stop, with no scheduling pressure appended. Re-offer specific slots or re-ask "what time works" ONLY when the client signals readiness to book or themselves asks about scheduling or availability. NEVER end two messages in a row with the same scheduling question, that is pressuring the client and is forbidden. When the client raises an obstacle ("I don't have access", "it's owner occupied", "I can't be there", "I'm just researching", "not this week"), acknowledge it and adapt, NEVER ignore it and keep offering the same slots; if a visit is genuinely blocked, hand to Ozzi with [NOTIFY_OWNER] instead of pushing.
24. NEVER SAY A SLOT WAS TAKEN: You must NEVER tell a client that a time or slot "just got taken", "is no longer available", "is unavailable", or ask them to "pick another time". This is forbidden in EVERY situation, including follow-up or clarification messages after a booking. If a time the client wants is not in the schedule, just offer a different time that IS listed, in a normal friendly way. If you ever cannot complete a booking, hand it to Ozzi with [NOTIFY_OWNER], never blame the slot.
25. CAN BOOK ANY LISTED DAY, INCLUDING FUTURE WEEKS: The REAL-TIME SCHEDULE covers about three weeks ahead. You CAN and SHOULD book next week or the week after when the client wants it. NEVER say you cannot see, access, or open the calendar for a future week, and never say you can only book this week. Any date shown in the schedule is bookable. If the same weekday appears more than once, use the soonest one unless the client says "next week" or names a specific date.
26. SERVICE AREA HARD GATE (overrides scheduling): We serve ONLY the Miami / South Florida EAST coast, from Homestead up to Jupiter (Miami-Dade, Broward, Palm Beach). We do NOT serve the Gulf / WEST coast at all (Tampa, St. Petersburg, Clearwater, Sarasota, Bradenton, Fort Myers, Cape Coral, Lehigh Acres, Estero, Bonita Springs, Naples, Marco Island, Port Charlotte, Punta Gorda), nor north of Jupiter (Treasure Coast), nor the Florida Keys south of Homestead. BEFORE proposing a visit, offering any time slot, confirming an appointment, or generating [BOOK:...], you MUST check the client's stated city/address. If it is on the west/Gulf coast or otherwise outside Homestead-to-Jupiter, you MUST NOT book — politely say we only serve the Miami area (the South Florida east coast from Homestead to Jupiter) and we do not cover their area. NEVER generate [BOOK:...] for an out-of-area address under any circumstance. This rule overrides every scheduling instruction.
27. NO SQFT ARITHMETIC / NO INVENTED TOTALS: NEVER add, subtract, or recompute the client's stated square footage into a different number, and NEVER narrate a calculation out loud (forbidden examples: "that puts you at about 1,600 sqft to cover", "1900 minus 300", "so that's X sqft total"). Do NOT assume some rooms (bathrooms, laundry, kitchen) get a different material and subtract them, the whole job is the same flooring unless the client says otherwise. If you need to reference the size, repeat the client's own number back unchanged. For ANY job of 500 sqft or more, do NOT compute, quote, or restate any sqft total at all, just acknowledge warmly and move to the free in-person visit. Math errors and invented totals destroy trust, so when unsure, say nothing about the number and propose the visit.
28. BATHROOM REMODELING RULE: We DO bathroom remodels (reforma de banheiro), not only flooring. When the client asks if we do, offer, or want a bathroom remodel or renovation (remodel, renovate, redo, or gut the bathroom), confirm YES we do it, explain that for a remodel we first need to check the space in person to give an accurate quote, and propose the FREE in-person visit exactly like a large lead: never quote a remodel price by DM, and never decline it for being small (it always goes to the visit, any size). This does NOT apply to a request for FLOORING in a bathroom (that is a normal flooring job under the usual sqft rules, including the under-200-sqft decline) or to a repair of any kind (fixing or replacing damaged tiles, patching), which we do NOT do and never visit for, see rule 39.
29. ASK THE FLOORING TYPE AT MOST ONCE, NEVER LOOP IT: When you ask which flooring type the client wants, name all three (tile, vinyl, or hardwood) and quote NO price until you know it. Ask this AT MOST ONCE in the whole conversation. If you have already asked it, do NOT ask again and NEVER resend the same "which one, tile, vinyl, or hardwood?" line, that robotic repeat is the single worst thing you can do here. When the type is still unknown and the client asks something specific, first ACKNOWLEDGE or briefly answer what you can, then fold the type question into that SAME short message, so the client never feels ignored, and quote NO dollar figure until you know the type. For a "what is included / what materials / is labor extra" question, give the real reason it depends on the type instead of a bare re-ask, for example: "Good question, it depends on the floor, our vinyl promo already includes the material while tile and hardwood cover the installation labor only, which one are you interested in?" (no prices). For a "how much / how does the pricing work" question with the type still unknown, briefly say the rate depends on the floor type and ask which they want, with NO dollar figure yet. For a process/timeline/warranty/over-tile/service-area question, just ANSWER it and add the type question only if it still fits naturally. If the client keeps replying without naming a type ("ok", "yes", "sure"), STOP asking the type entirely: pivot warmly in one sentence to offering a FREE in-person estimate so we confirm everything and give the exact price on site. NEVER send the client two identical messages.
30. ANSWER, DON'T DEFLECT-LOOP: When the client asks a real question you can answer (installation process, timeline, warranty, over-tile, service area, website), ANSWER it directly and move forward. Do NOT reply to a specific question with only a generic promotional line or a repeated question, and never hand an easily answerable question to "our specialist / our team". Escalate to Ozzi only for things you genuinely cannot answer, never as a way to avoid a normal question.
31. PRICE NEGOTIATION RULE: When the client mentions a LOWER price from another company, asks you to lower/match/beat a price, or asks for a discount on a price you already gave: you must NEVER commit to beating or matching any number, NEVER say the final price "may end up lower than" the competitor's, NEVER invent a discount, and NEVER change the promo rates. The ONLY correct reply is ONE sentence saying the team will check the space in person and see if we can get to a better number, plus [NOTIFY_OWNER] so the owners take over the negotiation. Price decisions belong to Ozzi, not to you.
32. AD PRICE MISMATCH RULE: If the client quotes a price they saw in one of our ads ("the ad says $2,350 for 1000 sqft", "the promotion mentioned $2,300") that does NOT match the promotions in these rules, NEVER confirm, endorse, repeat, or validate that number as ours, and NEVER do math that legitimizes it (never "that $2,300 promo is our vinyl package"). Say the promotions vary by flooring type and the exact price is confirmed at the free in-person measure, then continue the normal flow. Never call the ad wrong or fake either, just move to what you can offer.
33. EXACTLY TWO SLOTS RULE: When offering visit times, offer exactly TWO concrete options ("Thursday at 9am or 11am"), never three or more in one message. A long slot menu reads desperate and overwhelms the client. Both options come from the SOONEST day in the schedule that has open times (today first, then tomorrow; see SOONEST DAY FIRST in the schedule) and are that day's EARLIEST open times (its first two listed, 9am before 11am before 1pm), and if that day has only one open time, that one plus the first open time of the next day. The CLIENT AVAILABILITY RULE still applies first.
34. NO INVENTED COMPANY FACTS: NEVER state years in business, number of installers or crews, business hours, company history, or any company fact that is not written in these rules. If asked, keep it warm and general (the team has deep local experience across South Florida) and steer back to the free visit. Also never assert which city a zip code belongs to.
35. REPEATED IDENTICAL QUESTION RULE: If the client re-sends the EXACT same question you already answered (typical of a re-tapped ad FAQ button, e.g. "What type of materials are included?" arriving again right after your answer), NEVER output [REACT_ONLY], NEVER stay silent, and NEVER resend your previous answer word-for-word. Send ONE short, DIFFERENTLY-WORDED reply that briefly re-answers and pivots to the free in-person visit (example: "It really depends on the floor you pick, vinyl includes the material while tile and hardwood are labor only, want me to set up your free visit so you can see samples and exact prices?"). If they send the identical question yet again after that, output [REACT_ONLY].
36. CRACKED, UNEVEN OR LOOSE TILES UNDER THE "LIQUID" AD: when a client mentions cracked, broken, uneven or loose tiles while asking about the floor from the ad (the one "poured" over old tile), that is NOT a repair request, it is a full vinyl-over-tile installation lead. Answer that our luxury vinyl goes right over the existing tile and covers cracked or uneven tiles cleanly (we assess the surface at the free visit), and move to the estimate. A request to fix or replace the damaged tiles themselves (any number) with no new floor going over them is a REPAIR we decline and never visit for (rule 39).
37. NEVER INVENT PRODUCT SPECS: no plank width, thickness, wear layer, brand, collection, or color name unless it is written in this prompt. If asked for a spec you do not have ("what is the widest plank you have", "how thick is it"), say the estimator brings the samples with the exact specs to the free visit, or hand it to Ozzi with [NOTIFY_OWNER]. Never guess a number.
38. AFTER "APPOINTMENT CONFIRMED", IF THE CLIENT SAYS THE TIME PASSED OR NOBODY CAME ("it's 5:10 now", "you guys never came", "no one showed up"): NEVER say the slot filled up, was taken, or got moved, and never invent an explanation. Apologize once, say Ozzi will personally contact them right away about the visit, and end with [NOTIFY_OWNER]. Do not offer new slots in that same message.
39. REPAIRS OF ANY KIND ARE DECLINED, NEVER BOOKED: fixing, replacing, re-setting or re-grouting damaged, broken, cracked, chipped or loose tiles, planks or boards, patching or leveling a damaged spot, or replacing a damaged section, is a REPAIR no matter how many pieces or how big the spot. We do NOT do repairs of any kind and the owner never drives out to look at one. Say so politely, mention we only do full installations (projects over 500 sqft), and NEVER propose a visit, ask for the address or phone, quote a price, or generate [BOOK:...] for it. A whole NEW floor, a bathroom remodel, or our vinyl going OVER existing cracked tile (rule 36) is NOT a repair.`;

  // Inject booking-confirmed block directly into system prompt (highest priority — model reads it last)
  if (bookingConfirmed) {
    dynamicSystem += `\n\n---\n\nCRITICAL — BOOKING ALREADY CONFIRMED:\nThe conversation is over. Do NOT answer any question or continue the conversation.\n- For ANY message — thank-you, question, or anything else — respond with ONE sentence redirecting to Ozzi, then add [NOTIFY_OWNER]\n- Required format: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]"\n- NEVER generate [BOOK:...] under any circumstance\n- NEVER answer questions about time, address, arrival, or any topic\n- NEVER say any slot is taken or unavailable\n- NEVER use any person's name other than Ozzi`;
  }

  // REPAIR REQUEST standing → the no-repairs block, read last (Priti, 2026-08-24).
  if (repairRequestActive(messages)) {
    console.log("[AI] Repair request active — injecting the no-repairs block");
    dynamicSystem += `\n\n---\n\n${REPAIR_REQUEST_NOTE}`;
  }

  let response;
  try {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      // 300 was tight: a slightly longer (often Spanish/Portuguese) reply hit the
      // cap and was returned cut mid-sentence, which we then shipped as a half
      // message. 600 leaves headroom for the rare long reply while normal 1-2
      // sentence answers are unaffected; the stop_reason guard below salvages any
      // reply that still hits the limit.
      max_tokens: 600,
      // Three cache breakpoints (all zero-behavior-change, billing only):
      // 1. Stable system block — shared by EVERY conversation on EVERY channel,
      //    so any message from any client within the TTL of the previous one
      //    reads the big base prompt at ~10% price.
      // 2. Last message — caches the per-client system remainder + conversation
      //    history, so a client's next reply in an active back-and-forth re-reads
      //    the whole conversation prefix from cache instead of re-billing it.
      // (2b. The dynamic block also carries a breakpoint: for brand-new leads it
      // is byte-identical across conversations — memory/corrections empty, just
      // the FINAL REMINDERS — so its ~5K tokens are shared cache too; for
      // returning clients it caches across that client's own turns.)
      // TTL is 1h, NOT the default 5m: measured over 72h of production traffic
      // (535 calls), only 69% of calls arrive within 5min of the previous one —
      // the other 31% found the 5m cache expired and paid full price PLUS the
      // 1.25x write premium. 98% of calls arrive within 1h of the previous one.
      // The 1h write costs 2x (vs 1.25x) but happens ~once an hour instead of
      // dozens of times a day, so the effective input price drops from ~0.46x
      // to ~0.14x of list. Same bytes, same model, same replies — billing only.
      system: [
        { type: "text" as const, text: stableSystem, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
        { type: "text" as const, text: dynamicSystem, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } },
      ],
      messages: messages.map((m, i) =>
        i === messages.length - 1
          ? { role: m.role, content: [{ type: "text" as const, text: m.content, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] }
          : { role: m.role, content: m.content }
      ),
    });
  } catch (err) {
    if (isLowCreditError(err)) {
      // Loud, unmistakable marker for the owner/logs: the bot is silent for
      // EVERYONE until credits are added at console.anthropic.com → Billing.
      console.error("🚨🚨 ANTHROPIC OUT OF CREDITS — add credits at console.anthropic.com (Plans & Billing). The AI cannot reply to ANY client until then. 🚨🚨");
    }
    throw err;
  }

  const block = response.content[0];
  if (block.type === "text") {
    // If the model hit the token cap, salvage to the last complete sentence so we
    // never send a half-finished message to the client.
    const rawText = response.stop_reason === "max_tokens"
      ? trimTruncatedResponse(block.text)
      : block.text;
    if (response.stop_reason === "max_tokens") {
      console.warn("[AI] response hit max_tokens — trimmed to last complete sentence");
    }
    let cleaned = mergeLeadingGreeting(stripWrappingQuotes(removeEmojis(removeDashes(rawText))));
    const hadDash = rawText !== cleaned;

    // Never ship the model's internal monologue ("Wait, let me redo this…",
    // "Since the client accepted the quote, I'll escalate.") to a client.
    cleaned = stripReasoningLeak(cleaned);

    // The ONLY phone number allowed in client-facing text is (561) 674-8334 —
    // never echo the client's own number back ([BOOK:{...}] tags are untouched).
    // Exception: the seller's number our own installation confirmation already
    // gave this client (the prompt directs reschedules/changes to that contact).
    cleaned = scrubForeignPhones(cleaned, installConfirmationPhones(messages));

    // ZIP já dado pelo cliente → o pedido de dados não repete "with the zip code".
    if (isAskingForBookingInfo(cleaned) && /zip|postal|\bcep\b/i.test(cleaned) && clientAlreadyGaveZip(messages)) {
      const noReask = stripZipReask(cleaned);
      if (noReask !== cleaned) {
        cleaned = noReask;
        console.log("[AI] zip re-ask backstop: client already typed the zip, dropped 'with the zip code' from the details ask");
      }
    }

    // Showroom: nunca "we don't have a showroom" — temos o MOBILE showroom.
    {
      const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user");
      if (lastUser && isShowroomQuestion(lastUser.content || "")) {
        const fixed = fixShowroomDenial(cleaned, detectLang(lastUser.content || ""));
        if (fixed !== cleaned) {
          cleaned = fixed;
          console.log("[AI] showroom backstop: replaced 'no showroom' denial with the mobile showroom answer");
        }
      }
    }

    // Strip any [SEND_IMAGES: ...] tags the AI may still generate
    if (/\[SEND_IMAGES[^\]]*\]/i.test(cleaned)) {
      cleaned = cleaned.replace(/\[SEND_IMAGES[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
      // Ensure the links are present if not already
      if (!cleaned.includes("ozzifloors.com")) {
        cleaned += "\n\nYou can browse all our options at ozzifloors.com and on our Instagram @ozzi.floors.";
      }
      console.log("[AI v4] [SEND_IMAGES] tag stripped from response");
    }

    // LARGE LEAD RULE backstop: the client signaled 500+ sqft somewhere in this
    // conversation, so no $1,000+ total may ever ship, no matter what the model
    // (or a contaminated learning) produced. See stripLargeLeadPrices above.
    if (conversationHasLargeLead(messages) && BIG_DOLLAR.test(cleaned)) {
      const noPrices = stripLargeLeadPrices(cleaned);
      if (noPrices !== cleaned) {
        cleaned = noPrices;
        console.log("[AI] large-lead price backstop: stripped a $1,000+ total from the reply");
      }
    }

    // Anti-pressure: if the previous assistant turn already pushed scheduling and
    // the client did NOT engage scheduling (they asked an info question instead),
    // drop the repeated trailing scheduling push so we never pressure two in a row.
    // ENGLISH ONLY: the push patterns (SLOT_OFFER/SCHEDULING_QUESTION) are
    // English. On a Spanish reply they fail to detect the Spanish question but
    // still strip the time ("a las 3pm"), leaving a dangling fragment like
    // "cuál te queda mejor?". So skip the whole mechanism for Spanish replies.
    const looksSpanish = /[ñáéíóú¿¡]|\b(?:tengo|mañana|hoy|hora|funciona|queda|puedo|disponible|sábado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|gracias|para|esta|este|qu[eé]|cu[aá]l|cu[aá]ndo|d[ií]a|cita|piso|precio)\b/i.test(cleaned);
    if (!looksSpanish && !/\[BOOK:/i.test(cleaned) && antiPressureShouldFire(messages)) {
      const stripped = stripSchedulingPush(cleaned);
      // Only apply the strip when something SUBSTANTIVE remains (>= 40 chars
      // of real text). If the whole reply was a scheduling push, KEEP the
      // original — sending a generic non-answer was worse than letting the
      // scheduling answer through. The 40-char floor exists because a client
      // said "I cant during the week, i work", the model correctly offered
      // weekend slots, and the strip reduced the reply to a dead-end
      // "No problem." (2026-07-08 review) — a mangled two-word reply is
      // always worse than an extra slot offer.
      const substance = stripped.replace(/\[[^\]]*\]/g, "").trim();
      if (stripped && stripped !== cleaned && substance.length >= 40) {
        cleaned = stripped;
        console.log("[AI] anti-pressure: stripped repeated scheduling push");
      }
    }

    // NO-REPAIRS backstop inside the brain itself (Priti Budhrani, IG 2026-08-24):
    // with the slot already "held" and the details in hand, the model follows
    // the VISIT CONFIRMATION SEQUENCE and writes [BOOK] even with the CRITICAL
    // block in front of it (repair-verify [2b]). While the client's standing
    // request is a repair, any [BOOK], visit offer or booking-details ask is
    // replaced by the deterministic decline, for every caller of getAIResponse
    // (the three webhooks keep their own copy of this guard as a second net).
    if (repairVisitOfferLeak(messages, cleaned)) {
      console.warn("[AI] repair request — model offered a visit / [BOOK]; replaced with the no-repairs decline");
      cleaned = repairDeclineMessage(detectLang(messages.filter((m) => m.role === "user").map((m) => m.content).join(" ")));
    }

    // Regra do dono (28/08/2026): nada de ¿ / ¡ em espanhol — só ? e ! no final.
    cleaned = stripInvertedPunctuation(cleaned);

    // With prompt caching on, usage.input_tokens counts ONLY the uncached
    // remainder — the true prompt size is the sum of the three fields. Report
    // the sum so conversation metrics stay comparable with before, and log the
    // split so cache health is verifiable in the logs (cacheRead > 0 on steady
    // traffic means the ~90% input discount is working).
    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
    console.log(
      `[AI v4] dash removed: ${hadDash} | tokens in=${response.usage.input_tokens} cacheRead=${cacheRead} cacheWrite=${cacheWrite} out=${response.usage.output_tokens} | preview: ${cleaned.slice(0, 60)}`
    );
    return { text: cleaned, inputTokens: response.usage.input_tokens + cacheRead + cacheWrite, outputTokens: response.usage.output_tokens };
  }
  return { text: "Sorry, I couldn't generate a response.", inputTokens: 0, outputTokens: 0 };
}

// ─── Image analysis via Claude claude-haiku-4-5 (vision) ──────────────────────────
export async function analyzeImageFromBase64(base64DataUrl: string): Promise<string> {
  try {
    const anthropic = getAnthropic();

    // Extract base64 content and media type
    const match = base64DataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return "Image received but could not be processed.";
    const mediaType = match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const base64Data = match[2];

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Data },
            },
            {
              type: "text",
              text: `This is a floor plan image sent by a flooring client for a quote.

READ ALL TEXT AND NUMBERS visible in the image carefully.

If it's a FLOOR PLAN:
1. List every room label and its dimensions exactly as written (e.g. "Sala 3.00x3.00m", "Cozinha 1.90x3.00m")
2. Calculate each room area (length × width = m²)
3. Sum all areas: Total sqm × 10.76 = sqft
4. State clearly: "Total: ~Xm² (~Ysqft)"
5. If total is under 500 sqft → state "SMALL PROJECT"
6. If total is over 500 sqft → state "LARGE PROJECT"

If measurements are not visible, describe the rooms you can see.
If it's a photo of existing floors: describe floor type and condition.

Be specific and always calculate when dimensions are visible. Under 120 words.`,
            },
          ],
        },
      ],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "Image analyzed but no description generated.";
  } catch (err) {
    console.error("analyzeImageFromBase64 error:", err);
    return "Image received but could not be analyzed.";
  }
}

// ─── Download image and convert to base64 (for Instagram CDN URLs) ─────────
async function imageToBase64(imageUrl: string): Promise<string> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  const urlWithToken = imageUrl.includes("?")
    ? `${imageUrl}&access_token=${token}`
    : `${imageUrl}?access_token=${token}`;

  const attempts: [string, RequestInit][] = [
    [urlWithToken, {}],
    [imageUrl, { headers: { Authorization: `Bearer ${token}` } }],
    [imageUrl, {}],
  ];

  for (const [url, options] of attempts) {
    try {
      const res = await fetch(url, { ...options, redirect: "follow" });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("text/html")) {
        const html = await res.text();
        const ogImage =
          html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] ??
          html.match(/content="([^"]+)"\s+property="og:image"/)?.[1];
        if (ogImage) return imageToBase64(ogImage);
        throw new Error("No og:image found");
      }

      if (!contentType.startsWith("image/")) continue;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 2000) continue;
      const base64 = Buffer.from(buffer).toString("base64");
      return `data:${contentType.split(";")[0]};base64,${base64}`;
    } catch {
      continue;
    }
  }
  throw new Error("Could not download image");
}

// ─── Analyze image from URL (fetches then analyzes) ────────────────────────
export async function analyzeImage(imageUrl: string): Promise<string> {
  try {
    const dataUrl = await imageToBase64(imageUrl);
    return analyzeImageFromBase64(dataUrl);
  } catch (err) {
    console.error("Image analysis error:", err);
    return "Image received but could not be analyzed. Please describe what you need.";
  }
}

// ─── Transcribe audio via OpenAI Whisper ────────────────────────────────────
export async function transcribeAudioFromBuffer(
  buffer: ArrayBuffer,
  contentType: string
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "[Voice message received — please type your message]";
  try {
    const ext = contentType.includes("ogg")
      ? "ogg"
      : contentType.includes("mpeg") || contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("wav")
      ? "wav"
      : "m4a";
    const audioFile = new File([buffer], `audio.${ext}`, { type: contentType });
    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });
    const text = transcription.text?.trim();
    console.log("Transcription:", text?.slice(0, 100));
    return text || "[Voice message — no speech detected]";
  } catch (err) {
    console.error("transcribeAudioFromBuffer error:", err);
    return "[Voice message received — please type your message]";
  }
}

export async function transcribeAudio(audioUrl: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "[Voice message received — please type your message]";
  try {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
    const urlWithToken = audioUrl.includes("?")
      ? `${audioUrl}&access_token=${token}`
      : `${audioUrl}?access_token=${token}`;

    const fetchAttempts: [string, RequestInit][] = [
      [urlWithToken, {}],
      [audioUrl, { headers: { Authorization: `Bearer ${token}` } }],
      [audioUrl, {}],
    ];

    let audioBuffer: ArrayBuffer | null = null;
    let contentType = "audio/mp4";

    for (const [url, opts] of fetchAttempts) {
      try {
        const res = await fetch(url, { ...opts, redirect: "follow" });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.startsWith("audio/") && !ct.startsWith("video/") && !ct.includes("octet-stream")) continue;
        audioBuffer = await res.arrayBuffer();
        contentType = ct.split(";")[0] || "audio/mp4";
        if (audioBuffer.byteLength > 1000) break;
      } catch {
        continue;
      }
    }

    if (!audioBuffer || audioBuffer.byteLength < 1000) {
      return "[Voice message received — please type your message]";
    }

    return transcribeAudioFromBuffer(audioBuffer, contentType);
  } catch (err) {
    console.error("Transcription error:", err);
    return "[Voice message received — please type your message]";
  }
}

// ─── TTS via OpenAI ──────────────────────────────────────────────────────────
export async function generateSpeech(text: string): Promise<Buffer | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const openai = getOpenAI();
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
      response_format: "mp3",
    });
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error("TTS error:", err);
    return null;
  }
}
