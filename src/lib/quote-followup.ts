import Anthropic from "@anthropic-ai/sdk";
import {
  removeDashes,
  removeEmojis,
  stripWrappingQuotes,
  stripReasoningLeak,
} from "@/lib/ai";

// ─── Quote follow-ups written by the agent, driven by the Ozzi Plataforma ────
// The platform knows WHICH client is due for WHICH touch (D1..D30 after the
// quote); it calls POST /api/enviar and WE write the actual words. This keeps
// one voice across every channel instead of the platform shipping its own copy.
//
// These clients already had the in-person visit and hold a real quote, so the
// rules here are deliberately narrower than the main sales brain:
//  • never negotiate, discount, or hint the price is movable (owner rule 31 —
//    price decisions belong to Ozzi, and a bot that hints at a discount by DM is
//    exactly the failure that rule exists to prevent),
//  • never offer time slots or propose a visit. Beyond being wrong (the visit
//    already happened), a slot offer would make the WhatsApp webhook read the
//    client's reply as a RESCHEDULE request (containsSchedulingOffer on our last
//    message) and try to move a visit that is already done,
//  • never invent anything not supplied by the platform (no dates, no sqft, no
//    extra services, no company facts).

export type FollowupLang = "en" | "es";
export const FOLLOWUP_STAGES = ["D1", "D3", "D7", "D14", "D30"] as const;
export type FollowupStage = (typeof FOLLOWUP_STAGES)[number];

export type QuoteFollowupInput = {
  idioma: FollowupLang;
  etapa: FollowupStage;
  cliente?: { nome?: string | null; primeiro_nome?: string | null } | null;
  quote?: {
    valor?: number | string | null;
    parcela_36x?: number | string | null;
    dias_desde_orcamento?: number | string | null;
  } | null;
  sugestao_texto?: string | null;
};

// WhatsApp hard-caps a text body at 4096 chars; our own copy should never come
// close, so this is only a runaway guard.
export const MAX_MESSAGE_LENGTH = 4096;

// What each touch is FOR. The model gets this as the intent of the message so
// D1 and D30 do not read like the same nudge five times.
const STAGE_INTENT: Record<FollowupStage, string> = {
  D1: "One day after the quote. Thank them for the time, make sure the quote arrived, and open the door for questions. Warm, zero pressure.",
  D3: "Three days after the quote. Ask if they had a chance to look it over and offer to clear up any doubt about the quote or the product.",
  D7: "One week after the quote. Remind them the quote still stands and, ONLY if a monthly payment figure was supplied, mention that financing can spread it out. Ask if they want to move forward.",
  D14: "Two weeks after the quote. Light touch: ask if anything is holding them back, and offer to help with whatever the blocker is.",
  D30: "One month after the quote. Final, graceful touch. No pressure at all, just let them know we are here whenever they are ready.",
};

const LANG_NAME: Record<FollowupLang, string> = { en: "English", es: "Spanish" };

function formatMoney(v: number | string | null | undefined): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// The context block the model is allowed to draw on. Anything absent is simply
// omitted, so the model can never reference a field the platform did not send.
export function buildFollowupContext(input: QuoteFollowupInput): string {
  const firstName = (input.cliente?.primeiro_nome || input.cliente?.nome || "").toString().trim().split(/\s+/)[0] || null;
  const valor = formatMoney(input.quote?.valor);
  const parcela = formatMoney(input.quote?.parcela_36x);
  const diasRaw = input.quote?.dias_desde_orcamento;
  const dias = diasRaw === null || diasRaw === undefined || diasRaw === "" ? null : Number(diasRaw);

  const lines = [
    `Language to write in: ${LANG_NAME[input.idioma]}`,
    `Touch: ${input.etapa}. ${STAGE_INTENT[input.etapa]}`,
    firstName ? `Client first name (use it once, naturally): ${firstName}` : `Client first name: unknown, do NOT invent one and do NOT use any placeholder`,
    valor ? `Quote total we already gave them: ${valor}` : `Quote total: not supplied, so NEVER mention any price or figure`,
    parcela ? `Monthly payment if financed over 36 months: ${parcela}` : `Monthly payment: not supplied, so NEVER mention financing or any monthly figure`,
    Number.isFinite(dias as number) ? `Days since we sent the quote: ${dias}` : null,
    input.sugestao_texto?.trim()
      ? `Draft from the platform, use it as a STARTING POINT and rewrite it in our voice (keep its intent, improve the wording, never copy it verbatim if it breaks a rule below):\n"""${input.sugestao_texto.trim().slice(0, 1200)}"""`
      : null,
  ].filter(Boolean);

  return lines.join("\n");
}

const SYSTEM = `You are Ozzi's assistant for Ozzi Floors, a flooring installation company in South Florida. You write ONE short WhatsApp follow-up message to a client who ALREADY had the free in-person visit and ALREADY received their quote.

Write ONLY the message text. No preamble, no explanation, no quotes around it, no signature.

HARD RULES:
1. Write in the requested language only.
2. One or two sentences. Never three. Short and human, like a real person texting.
3. Zero dashes, no -, no en dash, no em dash. Use commas or periods.
4. Zero emojis. Plain text only.
5. NEVER negotiate, offer, hint at, or promise a discount, a better price, a deal, a price match, or that the price could come down. The quote is the quote. Price decisions belong to Ozzi alone.
6. NEVER offer, propose, or ask about appointment times, days, slots, or scheduling a visit. The visit already happened. Never ask "what day works" or name any day or hour.
7. NEVER invent facts. Only use the figures given to you below. No square footage, no dates, no timelines, no warranties, no company history, no invented names.
8. Only mention the price if a quote total is supplied. Only mention financing or a monthly payment if a monthly payment figure is supplied.
9. Do not open with a standalone greeting sentence. Merge it: "Hi Maria, just making sure..." not "Hi Maria! Just making sure...".
10. Never use a bracket tag of any kind.
11. Never pressure. If they do not reply, that is fine. This is a warm nudge, not a sales push.
12. Do not repeat the exact opening of our generic nudge ("just checking in, want me to get your free estimate").`;

// Strip EVERY internal bracket tag ([NOTIFY_OWNER], [BOOK:{...}], [REACT_ONLY],
// [CANCEL_BOOKING], [SEND_IMAGES]...). Deliberately NOT ai.ts's
// stripForbiddenTags: that one only knows [SEND_IMAGES] and, worse, APPENDS the
// "browse at ozzifloors.com" line — a website plug tacked onto a quote follow-up
// is exactly the kind of thing the owner does not want going out. Our copy never
// uses square brackets (rule 10), so an uppercase-tag strip is safe here and
// cannot eat real words.
function stripAllTags(text: string): string {
  return text.replace(/\[[A-Z_]+(?::[\s\S]*?)?\]/g, "").replace(/\s{2,}/g, " ").trim();
}

export function sanitizeOutbound(text: string): string {
  let out = stripReasoningLeak(stripAllTags(stripWrappingQuotes(removeEmojis(removeDashes(text ?? "")))));
  out = out.replace(/[ \t]{3,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return out.slice(0, MAX_MESSAGE_LENGTH);
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 3, timeout: 30_000 });
  }
  return _anthropic;
}

export type ComposeResult = { text: string; source: "ai" | "sugestao"; inputTokens: number; outputTokens: number };

// Writes the follow-up. Falls back to the platform's own draft (sanitized) if the
// model is unavailable, so an Anthropic blip degrades to "the platform's wording"
// instead of dropping the client's touch entirely. Throws only when there is
// nothing safe left to send.
export async function composeQuoteFollowup(input: QuoteFollowupInput): Promise<ComposeResult> {
  const context = buildFollowupContext(input);
  try {
    const res = await getAnthropic().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      // COST: this prompt is ~500 tokens, i.e. BELOW Anthropic's 1024-token
      // minimum cacheable length, so a cache_control breakpoint here would be
      // silently ignored and buys nothing. We deliberately do not set one. This
      // call is ~500 in / ~60 out per follow-up (fractions of a cent) and, being
      // a separate system prefix, it CANNOT disturb the main brain's 3 cached
      // breakpoints in ai.ts — that shared ~11K stable block is untouched.
      system: SYSTEM,
      messages: [{ role: "user" as const, content: context }],
    });
    const block = res.content[0];
    const raw = block?.type === "text" ? block.text : "";
    const text = sanitizeOutbound(raw);
    if (text.length >= 15) {
      console.log(`[ENVIAR] follow-up ${input.etapa}/${input.idioma} written by AI | in=${res.usage.input_tokens} cacheRead=${res.usage.cache_read_input_tokens ?? 0} out=${res.usage.output_tokens} | ${text.slice(0, 70)}`);
      return { text, source: "ai", inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0), outputTokens: res.usage.output_tokens };
    }
    console.warn("[ENVIAR] AI returned an unusably short follow-up, falling back to the platform draft");
  } catch (err) {
    console.error("[ENVIAR] follow-up generation failed, falling back to the platform draft:", err);
  }

  const fallback = sanitizeOutbound(input.sugestao_texto ?? "");
  if (fallback.length >= 5) return { text: fallback, source: "sugestao", inputTokens: 0, outputTokens: 0 };
  throw new Error("nao foi possivel gerar a mensagem e nenhum sugestao_texto utilizavel foi enviado");
}
