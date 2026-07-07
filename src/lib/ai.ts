import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { SYSTEM_PROMPT, WHAT_IS_INCLUDED_RESPONSE, WHAT_IS_INCLUDED_TILE_RESPONSE, WHAT_IS_INCLUDED_HARDWOOD_RESPONSE, WHAT_IS_INCLUDED_ASK_TYPE, OPENER_EN, OPENER_ES, OPENER_PT } from "@/lib/system-prompt";

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

export type ChatMessage = { role: "user" | "assistant"; content: string };

// ─── Hard-coded intercepts — bypass AI for specific question patterns ─────────
// These override the AI completely because the model cannot be reliably
// instructed to omit pricing from "what's included" type questions.

const HARDCODED_RESPONSES: Array<{ id?: string; patterns: RegExp[]; response: string; skipIfSubstantive?: boolean }> = [
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
    response: "Para isso é melhor falar direto com a nossa equipe pelo WhatsApp no (561) 674-8334, que a gente te ajuda a encontrar o piso ideal![NOTIFY_OWNER]",
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
    response: "For that, the best is to message our team directly on WhatsApp at (561) 674-8334 and we'll help you find the right floor![NOTIFY_OWNER]",
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
  if (!adType && !SUBSTANTIVE_PRODUCT_Q.test(text)) {
    const vinylProne =
      PRODUCT_TYPE_Q.test(text) ||
      /\bhow\s+(?:much|does\s+(?:it|this|that|your|the)|do\s+you\s+(?:charge|price|work))\b/i.test(text) ||
      isFlooringInquiry(text);
    // FIRST-CONTACT ONLY: the canned type-ask opener is a safety net for a
    // brand-new lead whose type we do not know. Mid-conversation we must NOT
    // re-fire it — the full-context model answers what the client asked and folds
    // in the type question naturally, instead of blurting the identical canned
    // "which one, tile, vinyl, or hardwood?" line again (the robotic-loop bug).
    if (vinylProne && !messages.some((m) => m.role === "assistant")) return openerMessage(last.content);
  }
  // Capability questions (waterproof, durable, climate...) get a real answer;
  // "what is the material / is it vinyl" product-type questions get the luxury
  // vinyl description; tile questions get the Floor & Decor answer. All three
  // must bypass the "redirect to WhatsApp" options deflection.
  const skipDeflection = SUBSTANTIVE_PRODUCT_Q.test(text) || PRODUCT_TYPE_Q.test(text) || /\b(tile|porcelain|ceramic)\b/i.test(text);
  for (const rule of HARDCODED_RESPONSES) {
    if (rule.patterns.some((p) => p.test(text))) {
      if (rule.skipIfSubstantive && skipDeflection) continue;
      if (rule.id === "what_included") {
        // Known type → its exact inclusions.
        if (adType) return whatIsIncludedResponseFor(adType);
        // Type still unknown → ask which type first (tile is labor only, vinyl
        // includes the material). But ask AT MOST ONCE: if we already asked the
        // type, hand the repeat to the full-context model so it never resends the
        // identical canned ask-type line ("what's included?" x3 → same line x3
        // was the loop). First time through, the deterministic ask is safe.
        if (assistantAlreadyAskedType(messages)) return null;
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
const AD_HARDWOOD = /\b(hardwoods?|solid\s*(?:hard)?wood|engineered\s*(?:wood|hardwood|floors?|flooring))\b/i;

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
  return `[AD_FLOORING_TYPE: vinyl]\n[AD TYPE KNOWN — VINYL: This client replied to one of our VINYL ads, so you ALREADY know they want vinyl. Do NOT ask whether they want tile, vinyl, or hardwood. Our vinyl promotion is $5 per square foot and that already includes the flooring, the installation labor, and the quarter round. Offer the free quote and ask one area or the whole house, unless the size is already 500 sqft or more, then propose the free in-person visit.]`;
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

function removeEmojis(text: string): string {
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

function removeDashes(text: string): string {
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

// A lone surviving clause that opens with one of these connectors is a dangling
// lead-in to the scheduling clause we just removed ("Since you get off at 5:30",
// "So that we can get started", "And I have Monday open"), NOT a standalone
// thought. Emitting it produces the broken fragment "...all in one price. Since
// you get off at 5:30." Drop it instead.
const LEADING_CONNECTOR = /^(?:since|because|so|as|when|if|while|after|before|once|and|but|or|plus|also|that\s+way|so\s+that|which\s+is\s+why|therefore|then)\b/i;

// Remove every scheduling push (in any position) so the bot never pushes the
// appointment two messages in a row (the "stop pressuring the client" rule).
// Sentences carrying a tag ([NOTIFY_OWNER], [BOOK:...], etc.) are always kept.
function stripSchedulingPush(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    if (s.includes("[") || !isSchedulingPush(s)) {
      kept.push(s);
      continue;
    }
    // Sentence contains a push: salvage the non-push comma clauses (the info).
    const clauses = s.split(/,\s*/).filter((cl) => cl.includes("[") || !isSchedulingPush(cl));
    // If the only thing left is a single leading-connector clause, it is a
    // dangling lead-in to the removed scheduling clause, not a real sentence.
    // Drop it so we never send a fragment like "Since you get off at 5:30."
    if (clauses.length === 1 && LEADING_CONNECTOR.test(clauses[0].trim())) continue;
    const rebuilt = clauses.join(", ").trim().replace(/[,\s]+$/, "");
    if (rebuilt) kept.push(/[.!?]$/.test(rebuilt) ? rebuilt : rebuilt + ".");
  }
  return kept.join(" ").trim();
}

// True when the client's own latest message engages scheduling (asks about a
// time/day/availability, names a clock time, or accepts a slot). The injected
// [SYSTEM: ...] note (which contains availability slots) is excluded so its
// am/pm tokens never count as the client engaging scheduling.
function clientEngagedScheduling(userText: string): boolean {
  const clientText = userText.split(/\n\n?\[SYSTEM:/)[0];
  // Includes timing-adjustment phrases ("can you come earlier", "anything before
  // 3", "what about after 5", "sooner") so a client negotiating the time is never
  // mistaken for ignoring scheduling — which used to nuke the bot's reply into a
  // generic non-answer. Also catches a bare clock time ("5:30", no am/pm) and
  // availability phrases ("I get off at 5:30", "after work", "off work") — these
  // ARE the client engaging scheduling, so the anti-pressure guard must not fire
  // and mangle the bot's slot reply into a dangling fragment.
  return /(?:\bwhat|which)\s+(?:time|day)|schedul|appointment|availab|\bbook\b|\b\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:get|gets|getting)\s+off\b|\boff\s+(?:at|about|around|by|work)\b|\bafter\s+work\b|\bget\s+home\b|\bfinish(?:ed)?\s+(?:work|at|by)\b|\bdone\s+(?:at|by|with\s+work)\b|\bfree\s+(?:after|at|around|by)\b|\bleave\s+work\b|works\s+for\s+me|let'?s\s+do|that\s+works|sounds\s+good|morning|afternoon|evening|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\b(?:earlier|sooner|later)\b|\b(?:before|after)\b|can\s+you\s+(?:come|do|make|swing|stop)|any(?:thing)?\s+(?:earlier|sooner|else|other\s+time)|\b(?:hoy|mañana|ma[ñn]ana|tarde|noche|hora|cita|disponible|temprano|m[aá]s\s+tarde|puede\s+ser|no\s+puedo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b|\ba\s+las\s+\d/i.test(clientText);
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
const ASKING_BOOKING_INFO = /\b(?:address|property\s+address|phone|phone\s+number|callback\s+number|best\s+(?:number|phone)|direcci[oó]n|tel[eé]fono|n[uú]mero(?:\s+de\s+(?:tel[eé]fono|contacto))?|endere[çc]o|telefone)\b/i;
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

// Pick the first-contact opener in the language of the greeting itself (the
// greeting word is the most reliable language signal), so a "Hola" gets Spanish
// and an "Olá" gets Portuguese.
export function openerMessage(text: string): string {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].toLowerCase();
  // Accent-safe boundaries: JS \b does not work around accented letters, so a
  // trailing \b after "olá" never matches. Anchor on start/space/punctuation and
  // a "not-a-letter-next" lookahead instead.
  // Accented "olá" / "oi" / "bom dia" are clearly Portuguese; bare "ola" (no H,
  // no accent) is far more often a Spanish speaker dropping the H of "hola". A few
  // non-greeting words also pin the language for a no-greeting inquiry.
  if (/(?:^|[\s!.,?¡¿])(?:olá|oi|bom\s+dia|boa\s+(?:tarde|noite)|al[oô])(?![a-zà-ÿ])/.test(t) || /\b(você|voce|obrigad|reforma|quanto custa|orçamento|gostaria)\b/.test(t)) return OPENER_PT;
  if (/(?:^|[\s!.,?¡¿])(?:hola|ola|buenas|buenos|saludos|qu[eé]\s+tal)(?![a-zà-ÿ])/.test(t) || /\b(cu[aá]nto|precio|cuesta|necesito|quiero|busco|interesad|promoci[oó]n|presupuesto)\b/.test(t)) return OPENER_ES;
  return OPENER_EN;
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
const SPECIFIC_TYPE = /\b(tiles?|v[iy]n[iy]ls?|laminate[ds]?|laminad[oa]s?|hardwoods?|solid\s*(?:hard)?wood|engineered\s*(?:wood|hardwood|floors?|flooring)|porcelains?|porcelanatos?|ceramics?|cer[aâ]mic[ao]s?|carpet|carpete|marble|m[aá]rmol|m[aá]rmore|azulejos?|lvp|lvt|spc)\b/i;
const SEE_OR_COLOR = /\b(photo|picture|image|catalog|colou?r|grey|gray|style|sample|show me|wood.?look|stone.?look|tile.?look|marble.?look|website|instagram)\b/i;
const OTHER_TOPIC = /\b(bathroom|ba[ñn]o|banheiro|remodel|reforma|renovat|permit|licen[çc]|repair|fix\b|hiring|\bjob\b|trabajo|emprego)\b/i;

export function isFlooringInquiry(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t || t.length > 200) return false;
  if (SPECIFIC_TYPE.test(t)) return false;
  if (SUBSTANTIVE_PRODUCT_Q.test(t)) return false;
  if (SEE_OR_COLOR.test(t)) return false;
  if (OTHER_TOPIC.test(t)) return false;
  if (PROMO_PRICE.test(t) || HOW_WORK.test(t)) return true;
  return FLOORING_CTX.test(t) && INQUIRY_INTENT.test(t);
}

// A courtesy "thanks" that ALSO carries a real answer — a flooring type, a
// room/scope, or a "yes please" to proceed — is the client ANSWERING our
// qualifying question, never a pure closing. Silencing it was the screenshot
// bug: we asked "tile, vinyl, or hardwood?", the client replied "Thank you!
// Either vinyl or laminate", and because the message opened with "Thank you!"
// the pure-closing backstop discarded the reply and the bot went silent on a
// hot lead. When any of this substance is present, it is NOT a closing.
// Question words ("how much", "sqft", "quote"...) are already handled by
// QUESTION_SIGNALS; this catches DECLARATIVE answers that carry no question.
const SUBSTANTIVE_CONTENT = /\b(v[iy]n[iy]ls?|laminate[ds]?|laminad[oa]s?|hardwoods?|wood|madeira|tile|tiles|porcelains?|porcelanatos?|ceramics?|cer[aâ]mic[ao]s?|azulejos?|lvp|lvt|spc|carpet|carpete|marble|m[aá]rmore|floor|flooring|piso|kitchen|bedroom|bathroom|living\s*room|cozinha|quarto|banheiro|sala|house|casa|home|apartment|apartamento|condo|garage|garagem|office|escrit[oó]rio|whole\s+(?:house|home|place|thing)|one\s+(?:area|room)|both|either\b|yes\s+please|s[ií]\s+por\s+favor|sim\s+por\s+favor|go\s+ahead|let'?s\s+do)\b/i;

export function hasSubstantiveContent(text: string): boolean {
  return SUBSTANTIVE_CONTENT.test(text || "");
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
];

export function isRescheduleRequest(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return RESCHEDULE_PATTERNS.some((p) => p.test(t));
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

export function isPureClosing(text: string): boolean {
  const t = (text || "").trim();
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
  const strip = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];
  // The latest bubble must itself be a pure closing, or there is nothing to skip.
  if (!isPureClosing(strip(last.content))) return false;
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
    // The lead came from an ad but we could NOT detect its type (no
    // [AD_FLOORING_TYPE] marker, just the ad-reply note / placeholder). This is
    // exactly the "clicked the tile ad → got the vinyl $5 pitch" case: ask the
    // type deterministically instead of letting the model pitch the vinyl package.
    // "what's included" is excluded so it routes to its own ask-type intercept.
    const adContext = /\[AD REPLY:|\[Client replied to our ad\]|Client shared a post\/reel from our ad/i.test(lastMsg.content);
    const excludedTopic =
      SPECIFIC_TYPE.test(t) || SUBSTANTIVE_PRODUCT_Q.test(t) || SEE_OR_COLOR.test(t) ||
      OTHER_TOPIC.test(t) || /\bincluded?\b|what(?:'?s| is| does)\b.{0,25}\bpackage\b|come with/i.test(t);
    if (isBareGreeting(lastMsg.content) || isFlooringInquiry(lastMsg.content) || (adContext && !excludedTopic)) {
      const opener = openerMessage(lastMsg.content);
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
  dynamicSystem += `\n\n---\n\nFINAL REMINDERS:\n1. Zero dashes — no -, –, or — anywhere. Replace with commas or periods.\n2. Zero emojis — no emoji, no decorative symbol, nothing. Plain text only.\n3. LENGTH RULE: Use 1 sentence when the message is complete with just the answer. Use 2 sentences ONLY when you genuinely need both an answer AND a forward question. Never 3 sentences. NEVER use a standalone opener like "Perfect!", "Great!", "Sounds good!", "Hello!", or "Hi!" as its own sentence — always merge it with a comma: "Perfect, your project comes to about $1,500." not "Perfect! Your project comes to about $1,500."\n4. SQFT RULE: If the client mentions a specific number of 500 sqft or more, NEVER give a price. Always propose the free in-person visit. This overrides everything else.\n5. SCOPE ALREADY ANSWERED RULE: If the client has already mentioned in this conversation which areas, rooms, or project scope (kitchen, bedroom, whole house, one room, etc.), NEVER ask "one area or whole house?" again. That question is asked ONCE at the very start. When the client asks about scheduling, availability, pricing, or anything else AFTER already stating scope, answer their question directly without re-attaching the classification question.\n6. BOOKING DONE RULE: If [BOOKING ALREADY CONFIRMED] appears in the system context, the conversation is over. Do NOT answer any question. For ANY client message, respond with ONE sentence redirecting to Ozzi and add [NOTIFY_OWNER] — example: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]" NEVER generate [BOOK:...]. NEVER answer questions directly. NEVER mention appointment details.\n7. SLOT CONFIRMATION RULE: Ask for address and phone ONLY after the client explicitly names a specific day and time (e.g., "Monday at 3pm works"). Vague replies like "Okay", "Sounds good", "Alright", "I'll let you know" mean they are still deciding — respond with ONE sentence only and wait. NEVER use "No problem!" as a standalone sentence — merge it: "No problem, just let me know which day works!" Never push for address/phone when the slot is not confirmed.\n8. PRE-BOOKING TEXT RULE: The text before [BOOK:...] must be 5 words or fewer. NEVER repeat the date, time, or address in that text. The system sends the confirmation automatically. Write ONLY something like "Perfect, see you then!" or "All set!" before the tag.\n8b. WHATSAPP NO-PHONE RULE: If a [WHATSAPP CHANNEL] note is in context, you ALREADY have the client's phone number. NEVER ask for a phone, a callback number, or the "best number" on WhatsApp. The MOMENT you have a confirmed day/time AND the property address, generate [BOOK:...] immediately using the WhatsApp number, do not ask for anything else.\n9. WHAT IS INCLUDED — TYPE GATED: The "${WHAT_IS_INCLUDED_RESPONSE}" answer is the VINYL offer (material included). Give it EXACTLY only when you ALREADY KNOW the client wants vinyl and they ask "what is included" / "is labor included" / "does it include installation". If the flooring type is still UNKNOWN, do NOT give it (tile and hardwood include NO material, only labor) — ask which type they want: tile, vinyl, or hardwood. If you know they want TILE or HARDWOOD, say the promotion covers the installation labor only and they provide the material. For any other package question, answer naturally.\n10. Colors: plain text only, no tags or brackets of any kind.\n10b. MATERIAL vs SEE RULE: Two cases. CASE A, the client asks WHAT the product is ("what kind of materials", "what is the material", "what is the material allowance", "what flooring do you use", "what kind of floor", "what are the material/flooring options", "what do you offer", "is it vinyl") then, IF you already know the client wants vinyl, DESCRIBE it directly and send NO link: say it is our luxury vinyl, waterproof and highly resistant, with a 20-year warranty, then mention the free quote and ask one area or whole house. If the flooring type is still UNKNOWN, do NOT describe it as vinyl, instead ask which type they want first: tile, vinyl, or hardwood (or propose the visit if the size is already 500+ sqft). NEVER list color or product names. CASE B, the client asks you to SEND or show photos/pictures/images/catalog, asks which COLORS/styles you have, names a SPECIFIC color/style, or asks for your website or Instagram, then redirect with EXACTLY: "For that, the best is to message our team directly on WhatsApp at (561) 674-8334 and we'll help you find the right floor!" and add [NOTIFY_OWNER]; never send the website/Instagram link unless they specifically ask for it. CASE B EXCEPTION (propose the visit, do NOT redirect): if the client just wants to SEE the product or floors in person or as soon as possible ("would love to see it", "see the product asap", "can I see it soon", "want to see what you have") WITHOUT asking you to SEND photos and WITHOUT naming a specific color, treat it as a buying signal: say you bring all the samples to the free in-person visit so they can see everything and pick right there, and move to scheduling (ask one area or whole house if size unknown, or propose the visit if already 500+ sqft). If the client asks whether it is really vinyl (some marble-finish floors we advertise are still luxury vinyl), confirm yes, it is luxury vinyl. EXCEPTION 1: real PRODUCT CAPABILITY questions (waterproof, durable, humid/tropical climate, over tile, warranty) are answered directly. EXCEPTION 2: tile questions ("do you have tile that looks like wood") get the Floor & Decor answer.\n11. If the client asks for a phone number or contact: use ONLY (561) 674-8334. The owner's name is Ozzi. NEVER invent a number.\n12. LARGE LEAD RULE: For projects 500 sqft or more: NEVER give a total price or dollar estimate by DM. Always push for the free in-person visit. Asking "how much?" or "what's the price per sqft?" does NOT mean the client refuses a visit — it means they want information. Give the visit offer, not a price.\n13. TILE RULE: When the client mentions "tile", "tiles", "porcelain", or "ceramic" — this is a TILE installation job, NOT luxury vinyl. NEVER quote $5/sqft for a tile job. Tile labor only is $4.50/sqft. Tile pricing is ALWAYS exactly sqft x $4.50 with NOTHING added: the +$500 small-job surcharge is EXCLUSIVE to luxury vinyl (LVP) and must NEVER be applied to a tile job (250 sqft tile = $1,125 not $1,625; 300 sqft tile = $1,350 not $1,850). Tile demo/removal is $1.50/sqft extra, only if asked. For tile projects 500 sqft or more, NEVER give a total DM price — always propose the free visit.\n14. NO INVENTED SLOTS RULE: If you do NOT see [REAL-TIME SCHEDULE] with actual time slots in this conversation context, you have ZERO schedule information. NEVER say "I have Thursday at 2pm" or any specific day/time. The ONLY correct answer when asked about availability is: "Let me check what I have open. What day works best for you?" — then stop. Do not invent or guess any slot.
18. SMALL-JOB PRICING RULE: UNDER 200 sqft we DO NOT take the job, under any circumstance — never quote a price, never propose a visit, just politely decline in one short sentence and invite them back for a bigger area (example: "We focus on larger installations, so we don't take projects under 200 square feet, but reach out anytime you have a bigger area!"). For a LUXURY VINYL (LVP) project you quote by DM that is 200 to 400 sqft, the total MUST be (sqft x $5) + $500, presented as ONE final number with the $500 already baked in. This +$500 add-on is for luxury vinyl ONLY: NEVER apply it to a tile, porcelain, or ceramic job (tile is always sqft x $4.50 with no add-on). NEVER reveal, itemize, mention, or hint at the $500, and do NOT show any per-sqft breakdown for these small jobs (no "$5/sqft", no "$5 x N"). Example: 200 sqft -> say about $1,500 (not $1,000). Example: 300 sqft -> about $2,000. For 401 to 499 sqft use plain $5/sqft with no add-on. For 500 sqft or more NEVER give a DM price, propose the free visit. The pricing tiers are INTERNAL: never explain them, never mention any range/band/tier, never narrate your calculation or self-correct out loud (no "let me give the right answer", no "480 is between 401 and 499"). Reply with ONLY the final total in one clean sentence.
23. JOB SEEKER RULE: If the message is from someone seeking a job or offering their own labor/services (installer, painter, laborer, helper, carpenter, "are you hiring", "looking for work", "I'm an installer", "busco trabajo", "soy instalador", "procuro emprego", "sou pintor"), this is NOT a customer. Output EXACTLY [REACT_ONLY] and nothing else, no greeting, no pitch. A real customer asking about our service ("do you have installers?", "I need my floor installed") is NOT a job seeker, answer them normally.
19. HOW IT WORKS RULE: When the client asks how the promotion works or how you charge, state that it is $5 per square foot and that price already includes the floor and the installation, and that installation only (client supplies the material) is $2 per square foot. Keep it short. Do not reveal the small-job surcharge.
21. ANSWER PRODUCT QUESTIONS RULE: When the client asks a real question about the product, ALWAYS answer it directly and helpfully FIRST — never deflect a genuine product question to "browse our website". Key facts you can state: our luxury vinyl is 100% waterproof, has a stone composite (SPC) core, a 20-year warranty, is highly scratch and water resistant, performs great in humid and tropical climates, and can usually be installed right over existing tile. If they ask you to recommend something, give a brief direction based on their style and then invite them to browse for the exact look. If the client is OUTSIDE South Florida (another state, the Caribbean, the West Indies, another country) and is asking about the PRODUCT, still answer their product question helpfully; only mention that our installation service covers South Florida if they specifically ask US to install or visit. NEVER dismiss an out-of-area client with "we can't help you" — answer what they asked.
20. TILE MATERIAL RULE: We do NOT sell tile material. If the client asks whether you offer, sell, have, or carry tile, or tile/porcelain that looks like wood (wood-look tile), respond with EXACTLY this and nothing more: "We don't sell tile materials. We only do the installation. However, you can find wood-look tiles at stores like Floor & Decor." Do NOT append, add, or tack on a luxury vinyl / LVP suggestion or any upsell after it — give only those sentences and stop. NEVER respond to a TILE question by pitching luxury vinyl wood-look as if it were the same thing. (Wood-look luxury VINYL is only the right answer when the client asks about vinyl or wood-look floors generally, not tile.)
17. PURE CLOSING RULE: If the client's latest message is ONLY a thank-you, farewell, acknowledgment, or a statement that they will act later ("I'll call you tomorrow", "I'll let you know", "ok thanks", "got it", "sounds good", a heart or a thumbs up) and contains NO new question or request, output EXACTLY [REACT_ONLY] and nothing else. Do NOT repeat the phone number, do NOT add any sentence, do NOT keep selling. The system will simply react to their message. EXCEPTION: if the message mixes a thanks with a real new question (example: "thanks, do you do screens?"), OR with an ANSWER to something you just asked (you asked "tile, vinyl, or hardwood?" and they say "Thank you! Either vinyl or laminate"; you asked the scope and they say "thanks, the whole house"; you offered the quote and they say "yes please"), ignore the thanks and respond to the substance normally — NEVER [REACT_ONLY]. Also do NOT use [REACT_ONLY] for a vague reply while you are still waiting for the client to pick a time slot, treat that per the SLOT CONFIRMATION RULE.
16. DATE INTEGRITY RULE: When you name a weekday to the client (Friday, viernes, etc.), the date MUST be the exact [YYYY-MM-DD] shown next to that same weekday in the REAL-TIME SCHEDULE. NEVER compute or guess a date yourself, and NEVER pair a weekday with a date from a different schedule line. Before writing [BOOK:...], re-read the schedule line for the weekday you promised and copy its [YYYY-MM-DD] and only a time listed on that line. Example: if the schedule shows "Friday ... [2026-06-05]: 9am, 1pm", then "Friday at 1pm" books date 2026-06-05 and time 13:00, NEVER 2026-06-06. Saturday is a different line with different times. If the time the client wants is not listed under the exact date you promised, tell them it is not open and offer a time that IS listed for that date.
15. CLIENT AVAILABILITY RULE: If the client states when they are available (examples: "only after 6pm", "I'm only home after 6", "only on weekends", "evenings only", "I work until 5", "only Saturday", "only Sunday", "no mornings"), you MUST filter all slot options to ONLY those that match their constraint. NEVER propose a time that contradicts what the client said. Examples: if the client says "after 6pm", offer ONLY 6pm or later slots on weekdays. If they say "only weekends", offer ONLY Saturday or Sunday slots. If they say "after 6pm or weekends", that means weekdays ONLY after 6pm AND weekends at any time — do NOT offer a weekday slot before 6pm, but a Saturday or Sunday at any hour is fine. If no slots in the schedule match their constraint, acknowledge it directly and ask what flexibility they have. This rule overrides the general "offer 2 available slots" instruction — always honor the client's stated availability first.
22. NO PRESSURE RULE: Propose the visit and offer time slots ONCE. After you have already proposed the visit, do NOT tack a scheduling push onto the end of every message ("what time works for you", "what day works", "so we can get started right away", or a list of slots). When the client asks an informational question (materials, specs, thickness, wear layer, lighting, timeline, etc.), ANSWER that question and stop, with no scheduling pressure appended. Re-offer specific slots or re-ask "what time works" ONLY when the client signals readiness to book or themselves asks about scheduling or availability. NEVER end two messages in a row with the same scheduling question, that is pressuring the client and is forbidden. When the client raises an obstacle ("I don't have access", "it's owner occupied", "I can't be there", "I'm just researching", "not this week"), acknowledge it and adapt, NEVER ignore it and keep offering the same slots; if a visit is genuinely blocked, hand to Ozzi with [NOTIFY_OWNER] instead of pushing.
24. NEVER SAY A SLOT WAS TAKEN: You must NEVER tell a client that a time or slot "just got taken", "is no longer available", "is unavailable", or ask them to "pick another time". This is forbidden in EVERY situation, including follow-up or clarification messages after a booking. If a time the client wants is not in the schedule, just offer a different time that IS listed, in a normal friendly way. If you ever cannot complete a booking, hand it to Ozzi with [NOTIFY_OWNER], never blame the slot.
25. CAN BOOK ANY LISTED DAY, INCLUDING FUTURE WEEKS: The REAL-TIME SCHEDULE covers about three weeks ahead. You CAN and SHOULD book next week or the week after when the client wants it. NEVER say you cannot see, access, or open the calendar for a future week, and never say you can only book this week. Any date shown in the schedule is bookable. If the same weekday appears more than once, use the soonest one unless the client says "next week" or names a specific date.
26. SERVICE AREA HARD GATE (overrides scheduling): We serve ONLY the Miami / South Florida EAST coast, from Homestead up to Jupiter (Miami-Dade, Broward, Palm Beach). We do NOT serve the Gulf / WEST coast at all (Tampa, St. Petersburg, Clearwater, Sarasota, Bradenton, Fort Myers, Cape Coral, Lehigh Acres, Estero, Bonita Springs, Naples, Marco Island, Port Charlotte, Punta Gorda), nor north of Jupiter (Treasure Coast), nor the Florida Keys south of Homestead. BEFORE proposing a visit, offering any time slot, confirming an appointment, or generating [BOOK:...], you MUST check the client's stated city/address. If it is on the west/Gulf coast or otherwise outside Homestead-to-Jupiter, you MUST NOT book — politely say we only serve the Miami area (the South Florida east coast from Homestead to Jupiter) and we do not cover their area. NEVER generate [BOOK:...] for an out-of-area address under any circumstance. This rule overrides every scheduling instruction.
27. NO SQFT ARITHMETIC / NO INVENTED TOTALS: NEVER add, subtract, or recompute the client's stated square footage into a different number, and NEVER narrate a calculation out loud (forbidden examples: "that puts you at about 1,600 sqft to cover", "1900 minus 300", "so that's X sqft total"). Do NOT assume some rooms (bathrooms, laundry, kitchen) get a different material and subtract them, the whole job is the same flooring unless the client says otherwise. If you need to reference the size, repeat the client's own number back unchanged. For ANY job of 500 sqft or more, do NOT compute, quote, or restate any sqft total at all, just acknowledge warmly and move to the free in-person visit. Math errors and invented totals destroy trust, so when unsure, say nothing about the number and propose the visit.
28. BATHROOM REMODELING RULE: We DO bathroom remodels (reforma de banheiro), not only flooring. When the client asks if we do, offer, or want a bathroom remodel or renovation (remodel, renovate, redo, or gut the bathroom), confirm YES we do it, explain that for a remodel we first need to check the space in person to give an accurate quote, and propose the FREE in-person visit exactly like a large lead: never quote a remodel price by DM, and never decline it for being small (it always goes to the visit, any size). This does NOT apply to a request for FLOORING in a bathroom (that is a normal flooring job under the usual sqft rules, including the under-200-sqft decline) or to a small tile/patch repair (we do not do repairs).
29. ASK THE FLOORING TYPE AT MOST ONCE, NEVER LOOP IT: When you ask which flooring type the client wants, name all three (tile, vinyl, or hardwood) and quote NO price until you know it. Ask this AT MOST ONCE in the whole conversation. If you have already asked it, do NOT ask again and NEVER resend the same "which one, tile, vinyl, or hardwood?" line, that robotic repeat is the single worst thing you can do here. When the type is still unknown and the client asks something specific, first ACKNOWLEDGE or briefly answer what you can, then fold the type question into that SAME short message, so the client never feels ignored, and quote NO dollar figure until you know the type. For a "what is included / what materials / is labor extra" question, give the real reason it depends on the type instead of a bare re-ask, for example: "Good question, it depends on the floor, our vinyl promo already includes the material while tile and hardwood cover the installation labor only, which one are you interested in?" (no prices). For a "how much / how does the pricing work" question with the type still unknown, briefly say the rate depends on the floor type and ask which they want, with NO dollar figure yet. For a process/timeline/warranty/over-tile/service-area question, just ANSWER it and add the type question only if it still fits naturally. If the client keeps replying without naming a type ("ok", "yes", "sure"), STOP asking the type entirely: pivot warmly in one sentence to offering a FREE in-person estimate so we confirm everything and give the exact price on site. NEVER send the client two identical messages.
30. ANSWER, DON'T DEFLECT-LOOP: When the client asks a real question you can answer (installation process, timeline, warranty, over-tile, service area, website), ANSWER it directly and move forward. Do NOT reply to a specific question with only a generic promotional line or a repeated question, and never hand an easily answerable question to "our specialist / our team". Escalate to Ozzi only for things you genuinely cannot answer, never as a way to avoid a normal question.`;

  // Inject booking-confirmed block directly into system prompt (highest priority — model reads it last)
  if (bookingConfirmed) {
    dynamicSystem += `\n\n---\n\nCRITICAL — BOOKING ALREADY CONFIRMED:\nThe conversation is over. Do NOT answer any question or continue the conversation.\n- For ANY message — thank-you, question, or anything else — respond with ONE sentence redirecting to Ozzi, then add [NOTIFY_OWNER]\n- Required format: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]"\n- NEVER generate [BOOK:...] under any circumstance\n- NEVER answer questions about time, address, arrival, or any topic\n- NEVER say any slot is taken or unavailable\n- NEVER use any person's name other than Ozzi`;
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

    // Strip any [SEND_IMAGES: ...] tags the AI may still generate
    if (/\[SEND_IMAGES[^\]]*\]/i.test(cleaned)) {
      cleaned = cleaned.replace(/\[SEND_IMAGES[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
      // Ensure the links are present if not already
      if (!cleaned.includes("ozzifloors.com")) {
        cleaned += "\n\nYou can browse all our options at ozzifloors.com and on our Instagram @ozzi.floors.";
      }
      console.log("[AI v4] [SEND_IMAGES] tag stripped from response");
    }

    // Anti-pressure: if the previous assistant turn already pushed scheduling and
    // the client did NOT engage scheduling (they asked an info question instead),
    // drop the repeated trailing scheduling push so we never pressure two in a row.
    // ENGLISH ONLY: the push patterns (SLOT_OFFER/SCHEDULING_QUESTION) are
    // English. On a Spanish reply they fail to detect the Spanish question but
    // still strip the time ("a las 3pm"), leaving a dangling fragment like
    // "cuál te queda mejor?". So skip the whole mechanism for Spanish replies.
    const looksSpanish = /[ñáéíóú¿¡]|\b(?:tengo|mañana|hoy|hora|funciona|queda|puedo|disponible|sábado|domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|gracias|para|esta|este|qu[eé]|cu[aá]l|cu[aá]ndo|d[ií]a|cita|piso|precio)\b/i.test(cleaned);
    if (!looksSpanish && !/\[BOOK:/i.test(cleaned)) {
      // Look back over the last few assistant turns: once the visit/scheduling
      // was already pushed, the client may ask several info questions in a row,
      // and we must not re-push on any of them. The push is often not the most
      // recent assistant message (that may be an info answer), so scan a window.
      const recentAssistantPushed = [...messages]
        .filter((m) => m.role === "assistant")
        .slice(-3)
        .some((m) => isSchedulingPush(m.content));
      const lastMsg = messages[messages.length - 1];
      if (
        recentAssistantPushed &&
        lastMsg?.role === "user" && !clientEngagedScheduling(lastMsg.content)
      ) {
        const stripped = stripSchedulingPush(cleaned);
        // Only apply the strip when something substantive remains. If the whole
        // reply was a scheduling push, KEEP the original — sending a generic
        // "Happy to answer any other questions" non-answer (the old fallback) was
        // worse than just letting the scheduling answer through, and it repeated
        // on short client replies the detector missed (e.g. "You cant before?").
        if (stripped && stripped !== cleaned) {
          cleaned = stripped;
          console.log("[AI] anti-pressure: stripped repeated scheduling push");
        }
      }
    }

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
