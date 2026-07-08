import { readFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getAIResponse, type ChatMessage } from "../lib/ai";

// ── stripSlotConflictLanguage — copy of the production safety net ─────────
function stripSlotConflictLanguage(text: string): string {
  let cleaned = text
    .replace(/[^.!?\n]*\b(?:slot|time\s*slot|appointment|visit|horário|hora)\b[^.!?\n]*\b(?:taken|unavailable|booked|not\s+available|no\s+longer\s+available|just\s+got\s+taken|already\s+(?:taken|booked)|foi\s+ocupad|ocupad)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/[^.!?\n]*\b(?:can|could|would)\b[^.!?\n]*\b(?:pick|choose|select|suggest|prefer)\b[^.!?\n]*\b(?:another|different|other)\b[^.!?\n]*\b(?:time|day|slot|date|hora|dia)\b[^.!?\n]*[.!?]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (
    /\b(?:slot|appointment|horário|hora)\b[^.!?\n]{0,60}\b(?:taken|unavailable|booked|not\s+available|no\s+longer)\b/i.test(cleaned) ||
    /\b(?:taken|unavailable|booked)\b[^.!?\n]{0,60}\b(?:slot|appointment|horário)\b/i.test(cleaned) ||
    /\bcan you (?:pick|choose|suggest|select) (?:another|a different)\b/i.test(cleaned)
  ) {
    cleaned = "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]";
  }

  return cleaned || "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]";
}
import { WHAT_IS_INCLUDED_RESPONSE } from "../lib/system-prompt";

// Load .env.local so API keys are available when running as a script
function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

// ── Terminal colors ────────────────────────────────────────────────────────

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ── Deterministic graders ──────────────────────────────────────────────────
// Each grader returns true = PASS. Fast, free, zero API calls.

const GRADERS = {
  noEmDash: {
    label: 'No em/en dash (— or –)',
    check: (t: string) => !/[—–‒―]/.test(t),
  },
  noWrappingQuotes: {
    label: 'Message is not wrapped in quotation marks',
    check: (t: string) => {
      const s = t.trim();
      if (!s) return true;
      const f = s[0];
      const l = s[s.length - 1];
      // Fails if the whole message is wrapped in a matching quote pair.
      return !(
        (f === '"' && l === '"') ||
        (f === "“" && l === "”") ||
        (f === "'" && l === "'") ||
        (f === "«" && l === "»")
      );
    },
  },
  noForbiddenTags: {
    label: 'No [SEND_IMAGES] tag',
    check: (t: string) => !/\[SEND_IMAGES/i.test(t),
  },
  hasPrice: {
    label: 'Contains $5 pricing',
    check: (t: string) => t.includes("$5"),
  },
  hasWhatIsIncluded: {
    label: 'Exact "what is included" response text',
    check: (t: string) => t.includes(WHAT_IS_INCLUDED_RESPONSE),
  },
  noOldVerboseIncluded: {
    label: 'Does NOT send the old verbose $5/$2/over-1,000-sqft "what is included" message',
    check: (t: string) => !/over\s+1,?000\s*sqft/i.test(t) && !/\$\s*2\s*per\s*sqft/i.test(t) && !/\$\s*5\s*per\s*sqft/i.test(t),
  },
  hasOzziUrl: {
    label: 'Mentions ozzifloors.com or @ozzi.floors',
    check: (t: string) => /ozzifloors\.com|@ozzi\.floors/i.test(t),
  },
  hasCorrectPhone: {
    label: 'Phone number is (561) 674-8334',
    check: (t: string) => t.includes("(561) 674-8334"),
  },
  noInventedPhone: {
    label: 'No invented phone numbers',
    check: (t: string) => {
      const found = t.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [];
      return found.every(p => p.replace(/\D/g, "") === "5616748334");
    },
  },
  noSlotConflict: {
    label: 'No "slot taken / unavailable / just got taken" language',
    check: (t: string) => !/\b(?:slot|appointment|horário|hora)\b.{0,80}\b(?:taken|unavailable|booked|not\s+available|no\s+longer)\b/i.test(t) &&
      !/\b(?:taken|unavailable|booked)\b.{0,80}\b(?:slot|appointment|horário)\b/i.test(t) &&
      !/just\s+got\s+taken/i.test(t),
  },
  noBookTag: {
    label: 'No [BOOK:...] generated after booking confirmed',
    check: (t: string) => !/\[BOOK:/i.test(t),
  },
  isWarmOneliner: {
    label: 'Response is one short warm sentence (post-booking ack)',
    check: (t: string) => {
      const stripped = t.replace(/\[.*?\]/g, "").trim();
      const sentences = (stripped.match(/[.!?](?:\s|$)/g) ?? []).length;
      return sentences <= 1 && stripped.length < 120;
    },
  },
  hasNotifyOwner: {
    label: 'Redirects to owner with [NOTIFY_OWNER] (post-booking)',
    check: (t: string) => /\[NOTIFY_OWNER\]/i.test(t),
  },
  atMostThreeSentences: {
    label: 'Opener is at most 3 short sentences',
    check: (t: string) => {
      const stripped = t.replace(/\[.*?\]/g, "").trim();
      const sentences = (stripped.match(/[.!?](?:\s|$)/g) ?? []).length;
      return sentences <= 3;
    },
  },
  asksScope: {
    label: 'Asks one area or whole house (classification)',
    check: (t: string) => /one area|whole house|entire house|just one|the whole|single room/i.test(t),
  },
  asksFlooringType: {
    label: 'Asks which flooring type (tile / vinyl / hardwood)',
    check: (t: string) => /tile/i.test(t) && /vinyl/i.test(t) && /hardwood/i.test(t),
  },
  noPrice: {
    label: 'Does NOT quote any dollar amount',
    check: (t: string) => !/\$\s?\d/.test(t),
  },
  isSilent: {
    label: 'No message sent to client (empty response after stripping tags)',
    check: (t: string) => t.replace(/\[[^\]]*\]/g, "").trim() === "",
  },
  noEmojis: {
    label: 'No emojis in response',
    check: (t: string) => !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F900}-\u{1F9FF}]/u.test(t),
  },
  proposesVisit: {
    label: 'Proposes in-person visit (large project)',
    check: (t: string) => /visit|in.?person|come by|measure|stop by/i.test(t),
  },
  proposesVisitOrAsksType: {
    // For a large lead whose flooring type is still UNKNOWN, the type-first
    // feature correctly asks the type first (price-free) instead of proposing the
    // visit right away; once the type is known it proposes the visit. Both are
    // valid, no-DM-price responses, so accept either.
    label: 'Proposes a visit OR asks the flooring type (large lead, no DM price)',
    check: (t: string) =>
      /visit|in.?person|come by|measure|stop by/i.test(t) ||
      (/tile/i.test(t) && /vinyl/i.test(t) && /hardwood/i.test(t)),
  },
  noColorNames: {
    label: 'No specific color/product names listed (redirect to website)',
    check: (t: string) => !/\b(White Knight|Coastal Mist|Forged Brown|Mocha|Grey Shield|Nordic Shadow|Lia\s+in\s+marble|marble\s+white)\b/i.test(t),
  },
  noConflictingSlot: {
    label: 'No daytime WEEKDAY slot offered when client said "only after 6pm or weekends"',
    // Fails only if a weekday (Mon–Fri) is paired with a time before 6pm or "morning".
    // Saturday/Sunday are always allowed (client said "weekends" are OK).
    check: (t: string) => {
      const weekdayThenDaytime = /\b(monday|tuesday|wednesday|thursday|friday)\b[^.!?\n]*\b(\d{1,2}(?::\d{2})?\s*am|(?:12|1|2|3|4|5)(?::\d{2})?\s*pm|morning|noon|afternoon)\b/i;
      const daytimeThenWeekday = /\b(\d{1,2}(?::\d{2})?\s*am|(?:12|1|2|3|4|5)(?::\d{2})?\s*pm|morning|noon|afternoon)\b[^.!?\n]*\b(monday|tuesday|wednesday|thursday|friday)\b/i;
      return !weekdayThenDaytime.test(t) && !daytimeThenWeekday.test(t);
    },
  },
  hasOzziUrlInOptions: {
    label: 'Redirects to ozzifloors.com or @ozzi.floors for options',
    check: (t: string) => /ozzifloors\.com|@ozzi\.floors|ozzi\.floors/i.test(t),
  },
  redirectsToWhatsApp: {
    label: 'Redirects to team WhatsApp (561) 674-8334, no website',
    check: (t: string) => /674[-\s]?8334/.test(t) && !/ozzifloors\.com|@ozzi\.floors/i.test(t),
  },
  noSchedulingPush: {
    label: 'No scheduling pressure (no clock time, no "what time/which works", no slot-menu re-offer)',
    check: (t: string) => {
      const SCHEDULING_QUESTION = /(?:what|which)\s+(?:time|day)\b|works?\s+(?:best\s+)?for\s+you|get\s+started\s+right\s+away|which\s+works\b|what\s+works\b/i;
      const CLOCK_TIME = /\b\d{1,2}\s*(?:am|pm)\b/i;
      const SLOT_OFFER = /\b(?:i\s+have|i'?ve\s+got|i\s+can\s+(?:do|come|stop|swing)|we\s+have|we'?ve\s+got|open(?:ings)?|i'?m\s+available|availab|free\s+on)\b[^.!?]*\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm)|morning|afternoon|evening)\b/i;
      return !SCHEDULING_QUESTION.test(t) && !CLOCK_TIME.test(t) && !SLOT_OFFER.test(t);
    },
  },
  acknowledgesObstacle: {
    label: 'Acknowledges the obstacle and does NOT steamroll with a slot list',
    check: (t: string) => {
      const timeTokens = (t.match(/\b\d{1,2}\s*(?:am|pm)\b/gi) ?? []).length;
      const acknowledges = /access|owner|occupied|coordinate|understand|no\s+(?:problem|worries)|connect you|ozzi|work (?:with|around)|reach out|once you|when you|whenever|after you|no rush/i.test(t);
      return timeTokens < 2 && acknowledges;
    },
  },
  describesVinyl: {
    label: 'Describes the product as luxury vinyl (waterproof/resistant + warranty)',
    check: (t: string) =>
      /\bvinyl\b/i.test(t) &&
      /water\s?proof|resist/i.test(t) &&
      /warranty|20[\s-]?year|20\s*yr/i.test(t),
  },
  noLinkRedirect: {
    label: 'Sends NO link (no website, Instagram, or WhatsApp) for a "what is it" question',
    check: (t: string) => !/ozzifloors\.com|@?ozzi\.floors|674[-\s]?8334|instagram/i.test(t),
  },
  describesVinylOrListsTypes: {
    label: 'Describes vinyl (waterproof+warranty) OR lists the types (vinyl/tile/hardwood)',
    check: (t: string) =>
      (/\bvinyl\b/i.test(t) && /water\s?proof|resist/i.test(t) && /warranty|20[\s-]?year|20\s*yr/i.test(t)) ||
      (/vinyl/i.test(t) && /tile/i.test(t) && /hardwood/i.test(t)),
  },
  confirmsVinyl: {
    label: 'Confirms it IS vinyl (no link, no deflection)',
    check: (t: string) =>
      /\bvinyl\b/i.test(t) &&
      !/ozzifloors\.com|@?ozzi\.floors|674[-\s]?8334/i.test(t) &&
      !/don'?t|do not|can'?t/i.test(t.split(/[.!?]/)[0] ?? ""),
  },
  confirmsPermits: {
    label: 'Confirms WE handle permits (never "homeowner/contractor side", never "we don\'t")',
    check: (t: string) =>
      // must NOT deflect permit responsibility onto the client / contractor
      !/\b(?:don'?t|do not|cannot|can'?t|won'?t)\b[^.!?\n]*\bpermit/i.test(t) &&
      !/\bpermit[^.!?\n]*\b(?:homeowner|contractor|owner'?s|your)\b[^.!?\n]*\b(?:side|responsibility|job|on you)\b/i.test(t) &&
      !/\b(?:that'?s|typically|usually)\b[^.!?\n]*\bon the\b[^.!?\n]*\b(?:homeowner|contractor)\b/i.test(t) &&
      // must affirmatively say we take care of it
      /\b(?:we|i)\b[^.!?\n]*\b(?:take care of|handle|cover|pull|manage|deal with|take(?:s)? care)\b[^.!?\n]*\bpermit/i.test(t),
  },
  declinesOutOfArea: {
    label: 'Declines out-of-area city (says only serve Miami / don\'t cover), no visit/price',
    check: (t: string) =>
      /don'?t service|do not service|not service that area|only serve|don'?t cover|do not cover|outside our (?:area|service)|miami area|east coast/i.test(t) &&
      !/\bvisit|come (?:by|out|measure)|stop by|in.?person\b/i.test(t),
  },
  noPermitPriceByDM: {
    label: 'No permit price/fee quoted by DM',
    check: (t: string) => !/permit[^.!?\n]{0,40}\$\s*\d/i.test(t) && !/\$\s*\d[^.!?\n]{0,40}permit/i.test(t),
  },
  noDanglingConnector: {
    label: 'No dangling lead-in fragment ("Since you get off at 5:30.")',
    // A sentence that is JUST a leading connector clause with no comma has no
    // main clause — it is the anti-pressure stripper leaving a fragment. The
    // legit version ("Since you get off at 5:30, I can come later that day.")
    // has a comma + main clause and is fine.
    check: (t: string) => {
      const LEAD = /^(?:since|because|so|as|when|if|while|after|before|once|and|but|or|plus|also|that\s+way|so\s+that|which\s+is\s+why|therefore|then)\b/i;
      const sentences = t.replace(/\[[^\]]*\]/g, "").split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
      return !sentences.some(s => LEAD.test(s) && !s.includes(","));
    },
  },
  noDMPriceForLargeProject: {
    label: 'No final price quote by DM (large project)',
    // Fails if response contains a total project cost ($500+) without "approximate/rough/estimate"
    // Allows per-sqft unit prices like "$5/sqft" (value < 100)
    check: (t: string) => {
      const priceMatches = [...t.matchAll(/\$\s*([\d,]+)/g)];
      const hasTotalProjectPrice = priceMatches.some(m => {
        const num = parseInt(m[1].replace(/,/g, ""), 10);
        return num >= 500; // $500+ is a total project cost, not a unit price
      });
      return !hasTotalProjectPrice || /approximate|rough|estimate/i.test(t);
    },
  },
  confirmsBathroomRemodel: {
    label: 'Confirms YES we do bathroom remodels (affirms, does not decline)',
    check: (t: string) => {
      const affirms = /\b(yes|yeah|yep|absolutely|of course|sure|we do|we can|we handle|we offer|claro|s[ií]m?|com certeza|fazemos|podemos|oferecemos|hacemos)\b/i.test(t);
      const declines = /\b(?:don'?t|do not|cannot|can'?t|won'?t)\s+(?:do|offer|handle)\b|only\s+(?:do|offer|handle)\s+(?:flooring|floors|installations?)|installations?\s+only|n[aã]o\s+fazemos|no\s+hacemos/i.test(t);
      return affirms && !declines;
    },
  },
  proposesVisitBilingual: {
    label: 'Proposes the in-person visit to check the space (EN/PT/ES)',
    check: (t: string) => /visit|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|measure|see\s+(?:the|your)\s+(?:space|bathroom)|take\s+a\s+look|visita|presencial|pessoalmente|medir|ver\s+(?:o|el)\s+(?:espa[çc]o|ba[ñn]o|local)/i.test(t),
  },
  declinesSmallJob: {
    // Decline language + no price proves the sub-200 flooring job was NOT routed
    // into a remodel visit (a remodel reply has no decline and proposes a visit).
    // A friendly "reach out for a remodel" invite is fine, so do NOT fail on the
    // mere word "remodel".
    label: 'Declines a sub-200 sqft flooring job (no price)',
    check: (t: string) =>
      /don'?t take|do not take|under 200|focus on larger|too small|won'?t be able|not able to take|we only (?:do|work|focus|take)|larger (?:projects|installations|jobs)/i.test(t) &&
      !/\$\s?\d/.test(t),
  },
  declinesRepair: {
    // Mirrors run-tests.mjs T34: a repair stays "installations only". Mentioning
    // a remodel as a future invite is acceptable, so we do NOT fail on the word
    // "remodel" (that was a false positive that flagged correct, friendly copy).
    label: 'Declines a repair (installations only)',
    check: (t: string) =>
      /installations?\s+only|only\s+(?:do|handle)\s+install|don'?t\s+do\s+(?:small\s+)?repair|do not do (?:small )?repair|only.*install/i.test(t),
  },
} satisfies Record<string, { label: string; check: (t: string) => boolean }>;

type GraderKey = keyof typeof GRADERS;

// ── LLM Judge (Haiku) — only for subjective quality checks ────────────────

async function judgeWithHaiku(
  scenarioName: string,
  lastClientMessage: string,
  response: string
): Promise<{ passed: boolean; detail: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { passed: false, detail: "No API key for judge" };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are quality-checking an AI sales agent for OzziFloors, a flooring company in Miami, FL.

Scenario: ${scenarioName}
Client said: "${lastClientMessage}"
Agent replied: "${response}"

Evaluate (yes/no each):
1. short: Is the response 2 sentences or fewer? (strict — 3 sentences = false)
2. natural: Sounds like a real person, not robotic or scripted?
3. advances: Moves the conversation forward appropriately for this scenario?

Respond ONLY with valid JSON: {"short": true/false, "natural": true/false, "advances": true/false, "verdict": "PASS" or "FAIL", "reason": "one sentence"}`;

  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content[0].type === "text" ? res.content[0].text : "{}";
    const json = JSON.parse(text.match(/\{[\s\S]*?\}/)?.[0] ?? "{}");
    const passed = json.verdict === "PASS";
    const detail = `${json.verdict ?? "?"} — ${json.reason ?? "no reason"} [short:${json.short}, natural:${json.natural}, advances:${json.advances}]`;
    return { passed, detail };
  } catch (e) {
    return { passed: false, detail: `Judge error: ${e}` };
  }
}

// ── Test scenarios — each maps to a real bug caught in production ──────────

interface Scenario {
  name: string;
  messages: ChatMessage[];
  graders: GraderKey[];
  bookingConfirmed?: boolean;
  llmJudge?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    // The "what is included" answer is the VINYL package (material included), so it
    // is only correct once the type is known to be vinyl. With the type-first
    // feature, an unknown-type "what is included?" asks the type instead (covered
    // by ad-type-verify), so this scenario names vinyl to test the exact vinyl
    // included text with NO verbose $5/$2/over-1,000-sqft breakdown.
    name: '"What is included?" (vinyl known) → exact hardcoded text, NO prices',
    messages: [{ role: "user", content: "For vinyl, what is included in the package?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noWrappingQuotes", "hasWhatIsIncluded", "noOldVerboseIncluded"],
  },
  {
    // Regression: AI was generating [SEND_IMAGES] and sending image links
    name: 'Photo request → redirect to WhatsApp, no [SEND_IMAGES], no website',
    messages: [{ role: "user", content: "Can you send me photos of your floors?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "redirectsToWhatsApp"],
  },
  {
    // New opener: we advertise tile/vinyl/hardwood at different rates and can't
    // tell which ad a lead came from, so the bot must ask the flooring type
    // FIRST and quote no price until it knows the type. "How much per sqft?"
    // with the type unknown → ask the type, do not assume vinyl/$5.
    name: 'Per-sqft price question (type unknown) → asks flooring type, no price',
    messages: [{ role: "user", content: "How much does it cost per square foot?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noWrappingQuotes", "asksFlooringType", "noPrice", "atMostThreeSentences"],
    llmJudge: false,
  },
  {
    // KEY NEW TEST: 500 sqft explicitly stated → visit required, no final price by DM
    name: '500 sqft price question (type unknown) → asks type or proposes visit, no final DM price',
    messages: [{ role: "user", content: "How much does the flooring cost including installation? For 500 sqft." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "proposesVisitOrAsksType", "noDMPriceForLargeProject"],
    llmJudge: false,
  },
  {
    // KEY NEW TEST: large project (type already known) → visit proposed, no price.
    // Type is stated ("vinyl") so this isolates the large-lead visit behavior;
    // the type-first opener is covered by other tests.
    name: 'Large project (2000 sqft, vinyl) → visit proposed, no final DM price',
    messages: [{ role: "user", content: "Hi! I need vinyl flooring for my whole house, around 2000 square feet." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noWrappingQuotes", "proposesVisit", "noDMPriceForLargeProject"],
  },
  {
    // KEY NEW TEST: client explicitly refuses visit for large project → approximate ok + still offer visit
    name: 'Client refuses visit (large project) → approximate given with visit offer',
    messages: [
      { role: "user", content: "I need flooring for my whole house, about 1500 sqft." },
      { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price. I bring the floor samples so you can pick right there. When would work for you?" },
      { role: "user", content: "I don't want a visit, just give me a rough estimate." },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "proposesVisit"],
  },
  {
    // Regression: AI was continuing to sell after farewell
    name: 'Client farewell → short response, no upselling',
    messages: [
      { role: "user", content: "How much does it cost?" },
      { role: "assistant", content: "Our promo is $5/sqft, flooring and labor included. Are you looking to do one area or the whole house?" },
      { role: "user", content: "Thanks, I'll think about it." },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags"],
  },
  {
    // Critical: must give exact phone, never invent one
    name: 'Phone request → must give (561) 674-8334 only',
    messages: [{ role: "user", content: "Can I call you? What's your phone number?" }],
    graders: ["noEmDash", "noEmojis", "hasCorrectPhone", "noInventedPhone"],
  },
  {
    // Regression: em dashes appearing in general responses
    name: 'Open-ended question → zero dashes and zero emojis',
    messages: [{ role: "user", content: "Tell me about your luxury vinyl flooring" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags"],
  },

  // ── CLIENT AVAILABILITY CONSTRAINT BUG REGRESSION TEST ───────────────────
  // Bug: client said "only after 6pm or weekends" but bot still offered
  // "Tuesday at 3pm or Wednesday morning" — ignored the stated constraint.
  {
    name: '[BUG FIX] Client says "only after 6pm or weekends" → must NOT offer daytime/morning slots',
    messages: [
      { role: "user", content: "My condo 1000 sq ft maybe 990 I need it done but have tile now is that an issue. I'm in Boca Raton." },
      { role: "assistant", content: "Not an issue at all, in most cases we can install directly over existing tile as long as it's flat and in good condition. For 1,000 sqft I'd love to come out to Boca Raton, measure everything, and bring samples so you can pick the style on the spot, all free. I have Tuesday at 3pm or Wednesday at 9am, which works better for you?" },
      { role: "user", content: "Not flat. I'm only home after 6pm or weekends" },
    ],
    graders: ["noEmDash", "noEmojis", "noConflictingSlot"],
  },

  // ── MATERIAL OPTIONS / SPECIFIC FLOOR → redirect to WhatsApp ──────────────
  // Owner rule: questions about which floors/colors/options we have, or a
  // specific floor, must redirect to our WhatsApp — no website, no photos, no
  // color names, no answer. (Capability questions are answered; tile → F&D.)
  // Owner correction (2026-06-06): "what is the material / what kind of materials
  // / material allowance / what options" are PRODUCT-TYPE questions → describe the
  // luxury vinyl, send NO link. Only explicit "show me / photos / colors" requests
  // get the WhatsApp redirect. The screenshot bug was a material question that got
  // a website/Instagram link instead of the product description.
  {
    // Updated 2026-07-08: the newer TYPE-GATING owner rule (2026-07-03, reminder
    // 10b) says with the flooring type still UNKNOWN the bot must NOT assume
    // vinyl — asking "tile, vinyl, or hardwood?" is now equally correct here,
    // so this accepts either the vinyl description or the type question.
    name: '[BUG FIX] "what kind of materials, what is the material allowance?" → describe vinyl or ask type, NO link',
    messages: [
      { role: "assistant", content: "Hi Aj! Need help with flooring installation? Let's discuss your project!" },
      { role: "user", content: "what kind of materials what is the material allowance?" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "describesVinylOrListsTypes", "noLinkRedirect"],
  },
  {
    name: '[BUG FIX] "What are the material options you have" → vinyl or list types, NO link',
    messages: [{ role: "user", content: "What are the material options you have" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "describesVinylOrListsTypes", "noLinkRedirect"],
  },
  {
    name: '[BUG FIX] "What flooring options do you have?" → vinyl or list types, NO link',
    messages: [{ role: "user", content: "What flooring options do you have?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "describesVinylOrListsTypes", "noLinkRedirect"],
  },
  {
    name: '[NEW] "Is this really vinyl? It looks like marble" → confirm vinyl, NO link',
    messages: [
      { role: "assistant", content: "This floor is our luxury vinyl, it's waterproof and highly resistant, and we give a 20-year warranty. I offer a free quote, are you planning to do just one area or the whole house?" },
      { role: "user", content: "wait is this really vinyl? the marble one looks like real stone" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsVinyl"],
  },
  {
    // The "see" case still redirects — explicit photo request → WhatsApp.
    name: '[KEEP] "Can you send photos of your floors?" → redirect to WhatsApp (explicit see request)',
    messages: [{ role: "user", content: "Can you send me photos of your floors?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "redirectsToWhatsApp"],
  },
  {
    // Color/style request is a "see" request → still redirects.
    name: '[KEEP] "What colors do you have?" → redirect to WhatsApp (color = see request)',
    messages: [{ role: "user", content: "What colors do you have?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "redirectsToWhatsApp"],
  },

  // ── NO-PRESSURE REGRESSION TESTS ─────────────────────────────────────────
  // Bug (2026-06-06): after proposing the visit, the bot pressured the client by
  // ending EVERY message with "What time Thursday works for you after closing so we
  // can get started right away?" and even ignored the client's obstacle ("I don't
  // have access, it's owner occupied") to keep dumping the same slot list.
  {
    name: '[BUG FIX] Info question after visit already proposed → answer, NO scheduling push',
    messages: [
      { role: "user", content: "I need flooring for my whole house, about 1500 sqft." },
      { role: "assistant", content: "For that size I do a free in-person visit, I measure everything and bring samples so you can pick on the spot. I have Sunday at 1pm or Monday at 3pm, what works for you?" },
      { role: "user", content: "Okay I appreciate it. What material do you use? What are the specs?" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "describesVinyl", "noSchedulingPush"],
  },
  {
    name: '[BUG FIX] Second info question in a row → still NO repeated scheduling push',
    messages: [
      { role: "user", content: "Whole house, around 1500 sqft." },
      { role: "assistant", content: "For that size I do a free in-person visit, I measure everything and bring samples. I have Sunday at 1pm or Monday at 3pm, what works for you?" },
      { role: "user", content: "What material do you use?" },
      { role: "assistant", content: "We use a stone composite core luxury vinyl, 100% waterproof, highly resistant, with a 20-year warranty." },
      { role: "user", content: "What is the thickness and wear layer?" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noSchedulingPush"],
  },
  {
    name: '[BUG FIX] Client raises obstacle (owner occupied, no access) → acknowledge, do NOT steamroll slots',
    messages: [
      { role: "user", content: "Whole house about 1500 sqft, closing on it Thursday." },
      { role: "assistant", content: "For that size I do a free in-person visit so I can measure and give you the final price on the spot. I have Thursday at 9am, 11am, 1pm, 3pm, 5pm or 7pm, which works best for you?" },
      { role: "user", content: "I don't have access to the house since it is owner occupied" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "acknowledgesObstacle"],
  },

  // ── DANGLING SCHEDULING FRAGMENT REGRESSION TEST ─────────────────────────
  // Bug (screenshot 2026-06-14): after the bot already proposed the visit with
  // slots, the client asked about the promo AND said "I usually get off about
  // 5:30". The anti-pressure stripper did not recognize "5:30" / "get off" as
  // scheduling engagement, fired, deleted the slot clauses, and left the broken
  // fragment "...all in one price. Since you get off at 5:30." The reply must
  // state the $5 promo and contain NO dangling lead-in fragment.
  {
    name: '[BUG FIX] promo question + "I get off about 5:30" → no dangling "Since..." fragment',
    messages: [
      { role: "user", content: "I want to redo my whole house, about 1577 sqft." },
      { role: "assistant", content: "For a house at 1,577 sqft, I need to come measure in person to give you the best price. I bring floor samples so you can pick right there, and the visit is completely free. I have Monday the 15th at 3pm or 5pm, which works better for you?" },
      { role: "user", content: "What promotional package do you have right now? And I usually get off about 5:30" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noWrappingQuotes", "hasPrice", "noDanglingConnector"],
  },

  // ── SERVICE AREA REGRESSION TESTS ────────────────────────────────────────
  // Owner: we only serve Homestead/Miami up to Jupiter. Port St. Lucie (and the
  // Treasure Coast north of Jupiter) is OUT of area, must decline.
  {
    name: '[BUG FIX] Port St. Lucie → decline, out of service area',
    messages: [{ role: "user", content: "Do you guys come out to Port St. Lucie? Whole house about 1800 sqft." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "declinesOutOfArea"],
  },
  {
    name: '[BUG FIX] Stuart (north of Jupiter) → decline, out of service area',
    messages: [{ role: "user", content: "I'm in Stuart, can you do my floors?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "declinesOutOfArea"],
  },

  // ── PERMITS BUG REGRESSION TESTS ─────────────────────────────────────────
  // Bug: client in Miami Beach asked "What about permits" and the bot replied
  // "We don't handle permits, that's typically on the homeowner or contractor
  // side." Owner: WE DO handle permits and do all the work they require.
  {
    name: '[BUG FIX] "What about permits" → confirm WE handle it, no permit price by DM',
    messages: [
      { role: "assistant", content: "Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. Are you planning to do just one area, or will it be the entire house?" },
      { role: "user", content: "What about permits I'm in Miami Beach and getting rid of old flooring which is laminate. Also baseboards" },
    ],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsPermits", "noPermitPriceByDM"],
  },
  {
    name: '[BUG FIX] "Do you handle permits?" → confirm yes, never deflect to homeowner',
    messages: [{ role: "user", content: "Do you handle permits or is that on me?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsPermits"],
  },

  // ── BOOKING BUG REGRESSION TESTS ─────────────────────────────────────────
  // These reproduce the exact bug: after booking confirmed, follow-up triggered
  // "That slot just got taken. Can you pick another time?" — the bug we fixed.

  {
    name: '[POST-BOOKING] "ok thank you" → silêncio total, nada enviado ao cliente',
    messages: [
      { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi." },
      { role: "user", content: "Ok thank you" },
    ],
    bookingConfirmed: true,
    graders: ["noBookTag", "isSilent"],
  },
  {
    name: '[POST-BOOKING] "Obrigado" → silêncio total, nada enviado ao cliente',
    messages: [
      { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi." },
      { role: "user", content: "Obrigado!" },
    ],
    bookingConfirmed: true,
    graders: ["noBookTag", "isSilent"],
  },
  {
    name: '[POST-BOOKING] Pergunta após booking → silêncio total, nada enviado ao cliente',
    messages: [
      { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi." },
      { role: "user", content: "What time will you arrive exactly?" },
    ],
    bookingConfirmed: true,
    graders: ["noBookTag", "isSilent"],
  },
  {
    name: '[POST-BOOKING] "thanks, see you then" → silêncio total, nada enviado ao cliente',
    messages: [
      { role: "assistant", content: "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi." },
      { role: "user", content: "Thanks, see you then!" },
    ],
    bookingConfirmed: true,
    graders: ["noBookTag", "isSilent"],
  },

  // ── BATHROOM REMODELING (new feature) ────────────────────────────────────
  // Owner: we DO bathroom remodels. When asked, confirm YES, say we must check
  // the space in person to quote, and propose the free visit (same flow as a
  // large flooring lead). Never quote a remodel price by DM, any size.
  {
    name: '[BATHROOM REMODEL] "Do you do bathroom remodeling?" → yes + propose visit, no DM price',
    messages: [{ role: "user", content: "Hi, do you do bathroom remodeling?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noWrappingQuotes", "confirmsBathroomRemodel", "proposesVisitBilingual", "noPrice"],
  },
  {
    name: '[BATHROOM REMODEL] "Do you remodel bathrooms or just floors?" → yes + visit, no DM price',
    messages: [{ role: "user", content: "Do you guys remodel bathrooms or do you only do floors?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsBathroomRemodel", "proposesVisitBilingual", "noPrice"],
  },
  {
    name: '[BATHROOM REMODEL] "I want to gut and redo my master bathroom" → yes + visit, no DM price',
    messages: [{ role: "user", content: "I want to gut and redo my master bathroom completely" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsBathroomRemodel", "proposesVisitBilingual", "noPrice"],
  },
  {
    name: '[BATHROOM REMODEL] PT "Vocês fazem reforma de banheiro?" → sim + visita, sem preço no DM',
    messages: [{ role: "user", content: "Oi, vocês fazem reforma de banheiro?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "confirmsBathroomRemodel", "proposesVisitBilingual", "noPrice"],
  },

  // ── REGRESSIONS — the remodel rule must NOT hijack these existing flows ───
  {
    // FLOORING in a bathroom under 200 sqft is STILL a declined small flooring
    // job, NOT the new remodel visit path. (Mirrors policy-verify.ts.)
    name: '[REGRESSION] "vinyl flooring for my bathroom, 150 sqft" → declines (not a remodel)',
    messages: [{ role: "user", content: "I need vinyl flooring for my bathroom, it's about 150 square feet." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "declinesSmallJob"],
  },
  {
    // A small repair stays "installations only" — the remodel rule must not flip
    // a repair into a yes. (Mirrors run-tests.mjs T34.)
    name: '[REGRESSION] "repair a few broken tiles in my bathroom" → installations only (not a remodel)',
    messages: [{ role: "user", content: "Hi, can you repair a few broken tiles in my bathroom?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "declinesRepair"],
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  console.log(c.bold("\nOzziFloors DM Agent — Eval Suite"));
  console.log(c.dim(`${SCENARIOS.length} scenarios | deterministic graders + Haiku judge\n`));
  console.log(c.dim("Rules under test: no emojis, 2 sentences max, 500+ sqft = visit (no DM price)\n"));

  let totalPassed = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  for (const scenario of SCENARIOS) {
    console.log(c.bold(`▶ ${scenario.name}`));

    let response: string;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const result = await getAIResponse(scenario.messages, null, null, null, scenario.bookingConfirmed);
      response = result.text;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    } catch (e) {
      console.log(c.red(`  ERROR calling AI: ${e}\n`));
      totalFailed++;
      failures.push(`${scenario.name}: API error`);
      continue;
    }

    const preview = response.replace(/\n+/g, " ").slice(0, 110);
    console.log(c.dim(`  Response (${inputTokens}in/${outputTokens}out tokens): "${preview}${response.length > 110 ? "…" : ""}"`));

    let scenarioPassed = true;

    // Deterministic checks
    for (const key of scenario.graders) {
      const grader = GRADERS[key];
      const passed = grader.check(response);
      console.log(`  ${passed ? c.green("✓") : c.red("✗")} ${grader.label}`);
      if (!passed) {
        scenarioPassed = false;
        failures.push(`${scenario.name} | ${grader.label}`);
      }
    }

    // LLM quality check (Haiku)
    if (scenario.llmJudge) {
      const lastUserMsg = [...scenario.messages].reverse().find(m => m.role === "user")?.content ?? "";
      const { passed, detail } = await judgeWithHaiku(scenario.name, lastUserMsg, response);
      console.log(`  ${passed ? c.green("✓") : c.red("✗")} ${c.yellow("[Haiku judge]")} ${detail}`);
      if (!passed) {
        scenarioPassed = false;
        failures.push(`${scenario.name} | Haiku judge: ${detail}`);
      }
    }

    if (scenarioPassed) {
      totalPassed++;
      console.log(c.green("  → PASSED\n"));
    } else {
      totalFailed++;
      console.log(c.red("  → FAILED\n"));
    }
  }

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log("─".repeat(60));
  console.log(c.bold(`Results: ${c.green(`${totalPassed} passed`)}  ${c.red(`${totalFailed} failed`)}  of ${SCENARIOS.length} total  (${elapsedSec}s)`));

  if (failures.length > 0) {
    console.log(c.red("\nFailed checks:"));
    for (const f of failures) console.log(c.red(`  • ${f}`));
  }

  console.log();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Eval runner crashed:", e);
  process.exit(1);
});
