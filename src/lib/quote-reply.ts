import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import {
  sanitizeOutbound,
  followupPolicyViolation,
  HEARTH_URL_PADRAO,
  type FollowupLang,
} from "@/lib/quote-followup";

// ─── Replies to QUOTE FOLLOW-UP clients (2026-07-17) ────────────────────────
// Before this module, a client who already had the in-person visit (booked →
// booking_confirmed=true) got TOTAL SILENCE from the bot on any reply: the
// wa-webhook only notified the owner. That killed the whole point of the quote
// follow-up campaign — a client replying "yes, tell me about financing" heard
// nothing back.
//
// Now: when the platform's follow-up goes out through /api/enviar, the message
// recorded in history carries a [SYSTEM: QUOTE_FOLLOWUP {...}] marker with the
// quote context. When such a client replies, the webhook routes the reply HERE
// instead of going silent. This brain is deliberately NARROW:
//  • answers questions about the quote and the financing (Hearth) only,
//  • never negotiates or hints the price can move (owner rule 31 → handoff),
//  • never uses scheduling phrasing (the reschedule-detector trap),
//  • never invents facts beyond the context the platform supplied,
//  • hands off to Ozzi with [NOTIFY_OWNER] whenever the client wants a human,
//    wants to close, negotiates, or asks something it cannot answer.

export type QuoteReplyCtx = {
  valor: number | null;
  parcela: number | null;
  idioma: FollowupLang;
  url: string; // financing application link
  marcado_em: string; // created_at of the marker message
};

export const QUOTE_CTX_PREFIX = "[SYSTEM: QUOTE_FOLLOWUP ";

// Builds the marker suffix appended (DB only, never sent) to each follow-up we
// record in history. Kept tiny and on one line so parsing stays trivial.
export function buildQuoteCtxMarker(ctx: { valor: number | null; parcela: number | null; idioma: FollowupLang; url: string }): string {
  return `\n\n${QUOTE_CTX_PREFIX}${JSON.stringify({ v: ctx.valor, p: ctx.parcela, i: ctx.idioma, u: ctx.url })}]`;
}

export function parseQuoteCtxMarker(content: string, createdAt: string): QuoteReplyCtx | null {
  const i = content.indexOf(QUOTE_CTX_PREFIX);
  if (i === -1) return null;
  const rest = content.slice(i + QUOTE_CTX_PREFIX.length);
  const end = rest.indexOf("]");
  if (end === -1) return null;
  try {
    const j = JSON.parse(rest.slice(0, end)) as { v?: unknown; p?: unknown; i?: unknown; u?: unknown };
    return {
      valor: typeof j.v === "number" && Number.isFinite(j.v) && j.v > 0 ? j.v : null,
      parcela: typeof j.p === "number" && Number.isFinite(j.p) && j.p > 0 ? j.p : null,
      idioma: j.i === "es" ? "es" : "en",
      url: typeof j.u === "string" && /^https:\/\/\S+$/.test(j.u) ? j.u : HEARTH_URL_PADRAO,
      marcado_em: createdAt,
    };
  } catch {
    return null;
  }
}

const QUOTE_MODE_MAX_AGE_DAYS = 60;

// Latest quote-follow-up marker in this conversation (≤60 days old), or null.
export async function findQuoteFollowupContext(conversationId: string): Promise<QuoteReplyCtx | null> {
  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .like("content", `%${QUOTE_CTX_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const ageDays = (Date.now() - Date.parse(data.created_at)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > QUOTE_MODE_MAX_AGE_DAYS) return null;
  return parseQuoteCtxMarker(data.content, data.created_at);
}

const fmtMoney = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const SYSTEM = `You are Ozzi's assistant for Ozzi Floors (flooring installation, South Florida), texting on WhatsApp with a client who ALREADY had their free in-person visit and ALREADY has their quote. We recently followed up offering financing. The client just replied, write the next message.

Write ONLY the message text (plus an optional tag at the very end). No preamble, no quotes around it, no signature.

HARD RULES:
1. Match the client's language (English or Spanish; if unclear, use the conversation's language).
2. One or two short sentences, like a real person texting. No emoji, no dashes of any kind (use commas or periods), no markdown, no lists.
3. NEVER negotiate, discount, hint the price could change, or promise a better deal. If the client asks for a lower price, wants to negotiate, or makes a counteroffer: say Ozzi himself will talk to them about it and end with [NOTIFY_OWNER].
4. NEVER offer, propose, or ask about appointment days, times, or slots, and never use phrases like "works for you", "what day", "which time", "what works", "get started right away". The visit already happened. To invite a reply, ask about the quote or the financing instead.
5. NEVER invent facts, prices, dates, timelines, or terms. Only use the quote figures given below. For financing you may say ONLY: the application is online, takes about 2 minutes, checking options does not affect their credit score, and once approved Ozzi will personally reach out to finalize everything. NEVER promise approval, rates, or specific terms.
6. If the client sounds interested in financing or asks how to apply, share the financing link exactly as given, once.
7. If the client says they applied, got approved, want to move forward, want to pay, or want to sign: confirm warmly that Ozzi will personally reach out to finalize, and end with [NOTIFY_OWNER].
8. If the client says they will pay in full or don't need financing: that is GOOD news but do NOT celebrate the financing angle, do not mention financing again, and do not repeat the quote pitch. One short sentence: acknowledge ("Of course, no financing needed") and confirm Ozzi will personally reach out to finalize. End with [NOTIFY_OWNER].
9. If the client says they already paid, already signed, already closed the deal, the work was already done, or that this message doesn't apply to them: apologize briefly for the mix-up in one sentence, thank them, do NOT sell anything, say Ozzi will follow up personally if anything is pending, and end with [NOTIFY_OWNER]. Never insist the quote is still open, never say "we recently sent your quote" to someone telling you the project already happened.
10. If the client asks to RESEND the quote, says they never received it, or asks what their quote was: when the quote total is on file below, restate it directly in this message ("Your quote total is $X") so they are never left waiting, add that Ozzi will also send them the full quote document personally, and end with [NOTIFY_OWNER]. Never reply with only a promise to resend when the total is on file. If the total is NOT on file, use the handoff of rule 11.
11. If the client asks anything you cannot answer from the context (product details, warranty claims, permits, project changes, new measurements, complaints), or asks to talk to a person: give a short warm handoff ("I'll have Ozzi reach out to you directly") and end with [NOTIFY_OWNER].
12. If the client says they are not interested, hired someone else, or asks to stop: thank them graciously in one sentence, no selling, and end with [NOTIFY_OWNER].
13. If the client asks who this is or who is texting: identify naturally as Ozzi Floors, the flooring company that gave them their quote, in the same sentence as the rest of your reply.
14. Never pressure. Warm, helpful, zero pushiness.

The ONLY tag you may output is [NOTIFY_OWNER], always at the very end when a rule above asks for it.`;

function buildUser(ctx: QuoteReplyCtx, history: Array<{ role: string; content: string }>, clientText: string): string {
  const lines = [
    `Quote total we already gave this client: ${ctx.valor ? fmtMoney(ctx.valor) : "not on file, NEVER state a total"}`,
    `Financing monthly figure (36 months, illustrative): ${ctx.parcela ? `about ${fmtMoney(ctx.parcela)}/month` : "not on file, NEVER state a monthly figure"}`,
    `Financing application link: ${ctx.url}`,
    `Conversation language so far: ${ctx.idioma === "es" ? "Spanish" : "English"}`,
    "",
    "Recent conversation (oldest first):",
    ...history.slice(-10).map((m) => `${m.role === "user" ? "Client" : "Us"}: ${m.content.split("\n\n[SYSTEM:")[0].slice(0, 400)}`),
    "",
    `Client's new message: """${clientText.slice(0, 800)}"""`,
    "",
    "Write our reply now.",
  ];
  return lines.join("\n");
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 2, timeout: 30_000 });
  }
  return _anthropic;
}

export type QuoteReplyResult = {
  text: string;
  notifyOwner: boolean;
  source: "ai" | "ai-retry" | "handoff";
};

// Fixed handoff used when the model is down or keeps violating the gate. It can
// never trip the scheduling detector and always brings the owner in.
const HANDOFF: Record<FollowupLang, string> = {
  en: "Thanks for your message, I'll have Ozzi reach out to you directly to help with that.",
  es: "Gracias por tu mensaje, Ozzi se comunicará contigo directamente para ayudarte con eso.",
};

const CORRECTIVE =
  'Your previous attempt broke a hard rule: it used a phrase our system reads as scheduling ("works for you", "what day", "which time", a clock time) or it hinted the price could change. Rewrite the SAME reply with neither, keeping the substance.';

export async function composeQuoteReply(params: {
  ctx: QuoteReplyCtx;
  history: Array<{ role: string; content: string }>;
  clientText: string;
}): Promise<QuoteReplyResult> {
  const { ctx, history, clientText } = params;
  const user = buildUser(ctx, history, clientText);

  for (const attempt of [1, 2] as const) {
    try {
      const res = await getAnthropic().messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: "user" as const, content: attempt === 2 ? `${user}\n\n${CORRECTIVE}` : user }],
      });
      const block = res.content[0];
      const raw = block?.type === "text" ? block.text : "";
      // Detect the tag BEFORE sanitizing (sanitizeOutbound strips every tag).
      const notifyOwner = /\[NOTIFY_OWNER\]/.test(raw);
      const text = sanitizeOutbound(raw);
      if (text.length < 5) continue;
      const violation = followupPolicyViolation(text);
      if (violation) {
        console.warn(`[QUOTE-REPLY] attempt ${attempt} rejeitado (${violation}): ${text.slice(0, 90)}`);
        continue;
      }
      console.log(`[QUOTE-REPLY] ok (attempt ${attempt}) notify=${notifyOwner} | ${text.slice(0, 80)}`);
      return { text, notifyOwner, source: attempt === 1 ? "ai" : "ai-retry" };
    } catch (err) {
      console.error(`[QUOTE-REPLY] attempt ${attempt} failed:`, err);
      break; // API down — go straight to the handoff.
    }
  }

  return { text: HANDOFF[ctx.idioma], notifyOwner: true, source: "handoff" };
}
