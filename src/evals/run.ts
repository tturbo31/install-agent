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
  noForbiddenTags: {
    label: 'No [SEND_IMAGES] tag',
    check: (t: string) => !/\[SEND_IMAGES/i.test(t),
  },
  hasPrice: {
    label: 'Contains $5 pricing',
    check: (t: string) => t.includes("$5"),
  },
  noPriceInIncluded: {
    label: 'No price ($X) in "what is included" response',
    check: (t: string) => !/\$\d/.test(t),
  },
  hasWhatIsIncluded: {
    label: 'Exact "what is included" response text',
    check: (t: string) => t.includes(WHAT_IS_INCLUDED_RESPONSE),
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
  noColorNames: {
    label: 'No specific color/product names listed (redirect to website)',
    check: (t: string) => !/\b(White Knight|Coastal Mist|Forged Brown|Mocha|Grey Shield|Nordic Shadow|Lia\s+in\s+marble|marble\s+white)\b/i.test(t),
  },
  hasOzziUrlInOptions: {
    label: 'Redirects to ozzifloors.com or @ozzi.floors for options',
    check: (t: string) => /ozzifloors\.com|@ozzi\.floors|ozzi\.floors/i.test(t),
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
    // Regression: AI was adding price to this response
    name: '"What is included?" → exact hardcoded text, no price',
    messages: [{ role: "user", content: "What is included in the package?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noPriceInIncluded", "hasWhatIsIncluded"],
  },
  {
    // Regression: AI was generating [SEND_IMAGES] and sending image links
    name: 'Photo request → redirect to website, no [SEND_IMAGES]',
    messages: [{ role: "user", content: "Can you send me photos of your floors?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "hasOzziUrl"],
  },
  {
    // Core behavior: correct pricing for small project (< 500 sqft)
    name: 'Small project price question → $5/sqft by DM, short, no emojis',
    messages: [{ role: "user", content: "How much does it cost per square foot?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "hasPrice"],
    llmJudge: true,
  },
  {
    // KEY NEW TEST: 500 sqft explicitly stated → visit required, no final price by DM
    name: '500 sqft price question → visit proposed, no final DM price',
    messages: [{ role: "user", content: "How much does the flooring cost including installation? For 500 sqft." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "proposesVisit", "noDMPriceForLargeProject"],
    llmJudge: false,
  },
  {
    // KEY NEW TEST: large project → visit proposed, no price
    name: 'Large project (2000 sqft) → visit proposed, no final DM price',
    messages: [{ role: "user", content: "Hi! I need flooring for my whole house, around 2000 square feet." }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "proposesVisit", "noDMPriceForLargeProject"],
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

  // ── MATERIAL OPTIONS BUG REGRESSION TEST ─────────────────────────────────
  // Bug: AI was listing specific color names (White Knight, Coastal Mist, etc.)
  // Fix: must redirect to website/Instagram without naming any colors.
  {
    name: '[BUG FIX] "Material options" → redirect to website, no color names listed',
    messages: [{ role: "user", content: "What are the material options you have" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "hasOzziUrlInOptions"],
  },
  {
    name: '[BUG FIX] "What flooring options do you have?" → redirect, no color names',
    messages: [{ role: "user", content: "What flooring options do you have?" }],
    graders: ["noEmDash", "noEmojis", "noForbiddenTags", "noColorNames", "hasOzziUrlInOptions"],
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
