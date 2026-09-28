import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import { sanitizeOutbound, followupPolicyViolation, type FollowupLang } from "@/lib/quote-followup";
import { QUOTE_CTX_PREFIX, isQuoteRefusal } from "@/lib/quote-reply";
import { normalizeSmartPunct } from "@/lib/ai";

// ─── Pedido de REVIEW + programa de INDICAÇÃO (28/09/2026) ───────────────────
// A Ozzi Plataforma decide QUEM recebe (cliente com obra concluída) e QUANDO;
// ela manda o texto pronto por POST /api/enviar tipo "review" e NÓS enviamos
// pelo mesmo WhatsApp da conversa, gravando o marcador
// [SYSTEM: REVIEW_REQUEST {...}] no histórico (só no banco, nunca no WhatsApp).
//
// Quando ESSE cliente responde, o wa-webhook cai aqui em vez do funil de venda
// nova (ele já é cliente: nunca oferecer visita, preço, financiamento):
//  • FOTO/print → é a prova do review: avisa o dono (com a imagem) e a
//    plataforma (review_foto_recebida) para o dono pagar a recompensa;
//  • texto → cérebro estreito: agradece, pede o print, explica a indicação,
//    registra a indicação (nome/telefone do amigo) e repassa ao Ozzi o resto;
//  • "ok"/obrigado → só 👍; recusa ("stop") → a plataforma marca recusou.

export const REVIEW_CTX_PREFIX = "[SYSTEM: REVIEW_REQUEST ";
export const REVIEW_HANDOFF_MARK = "[SYSTEM: REVIEW_HANDOFF]";
export const REVIEW_HANDOFF_SUFFIX = "\n\n" + REVIEW_HANDOFF_MARK;

export type ReviewEtapa = "pedido" | "lembrete";

export type ReviewCtx = {
  idioma: FollowupLang;
  google_url: string;
  yelp_url: string;
  valor_google: number;
  valor_yelp: number;
  comissao_pct: number;
  etapa: ReviewEtapa;
  chave: string | null; // idempotency key da plataforma
  marcado_em: string; // created_at da mensagem com o marcador
};

const OZZI_PHONE = "(561) 674-8334";

function urlSegura(raw: unknown): string | null {
  const u = typeof raw === "string" ? raw.trim() : "";
  return /^https:\/\/[^\s\[\]]+$/.test(u) ? u : null;
}

function numeroPositivo(v: unknown, padrao: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
}

// Marcador gravado junto de cada mensagem de review (só no banco). Uma linha
// só, JSON curto, para o parse ser trivial.
export function buildReviewCtxMarker(ctx: {
  idioma: FollowupLang;
  google_url: string;
  yelp_url: string;
  valor_google: number;
  valor_yelp: number;
  comissao_pct: number;
  etapa: ReviewEtapa;
  chave?: string | null;
}): string {
  return `\n\n${REVIEW_CTX_PREFIX}${JSON.stringify({
    i: ctx.idioma,
    g: ctx.google_url,
    y: ctx.yelp_url,
    vg: ctx.valor_google,
    vy: ctx.valor_yelp,
    c: ctx.comissao_pct,
    e: ctx.etapa,
    ...(ctx.chave ? { k: ctx.chave } : {}),
  })}]`;
}

export function parseReviewCtxMarker(content: string, createdAt: string): ReviewCtx | null {
  const i = content.indexOf(REVIEW_CTX_PREFIX);
  if (i === -1) return null;
  const rest = content.slice(i + REVIEW_CTX_PREFIX.length);
  const end = rest.indexOf("]");
  if (end === -1) return null;
  try {
    const j = JSON.parse(rest.slice(0, end)) as Record<string, unknown>;
    return {
      idioma: j.i === "es" ? "es" : "en",
      google_url: urlSegura(j.g) ?? "",
      yelp_url: urlSegura(j.y) ?? "",
      valor_google: numeroPositivo(j.vg, 25),
      valor_yelp: numeroPositivo(j.vy, 25),
      comissao_pct: numeroPositivo(j.c, 10),
      etapa: j.e === "lembrete" ? "lembrete" : "pedido",
      chave: typeof j.k === "string" && j.k ? j.k : null,
      marcado_em: createdAt,
    };
  } catch {
    return null;
  }
}

// Quantos dias depois do pedido o cliente ainda é tratado como "cliente de
// review" ao responder. Depois disso a conversa volta ao fluxo normal.
const REVIEW_MODE_MAX_AGE_DAYS = 45;

// Último marcador de review desta conversa (≤45 dias) — e só quando ele é
// MAIS NOVO que o último follow-up de orçamento: se a plataforma mandou um
// follow-up de quote depois do pedido de review (não deveria: quem tem obra
// concluída está fora daquela cadência), a resposta é sobre o quote.
export async function findReviewContext(conversationId: string): Promise<ReviewCtx | null> {
  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .like("content", `%${REVIEW_CTX_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  const ageDays = (Date.now() - Date.parse(data.created_at)) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays > REVIEW_MODE_MAX_AGE_DAYS) return null;
  const ctx = parseReviewCtxMarker(data.content, data.created_at);
  if (!ctx) return null;
  const { data: quote } = await supabaseAdmin
    .from("instagram_messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .like("content", `%${QUOTE_CTX_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (quote && Date.parse(quote.created_at) > Date.parse(data.created_at)) return null;
  return ctx;
}

// A plataforma reenviou o mesmo pedido (timeout ambíguo)? A chave de
// idempotência vem no marcador; se já está gravada nas últimas 48h, não manda
// de novo — um cliente nunca pode receber o pedido duas vezes.
export async function reviewAlreadySent(phone: string, chave: string): Promise<boolean> {
  const { data: conv } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id")
    .eq("igsid", `wa_${phone}`)
    .maybeSingle();
  if (!conv) return false;
  const desde = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("id")
    .eq("conversation_id", conv.id)
    .eq("role", "assistant")
    .gte("created_at", desde)
    .like("content", `%"k":${JSON.stringify(chave)}%`)
    .limit(1);
  return (data ?? []).length > 0;
}

// Já repassamos este cliente ao Ozzi desde a última troca? (mesma lógica do
// quote-reply: o marcador na última rodada de mensagens nossas decide; um novo
// pedido/lembrete de review no meio zera o repasse.)
export function reviewHandoffActive(history: Array<{ role: string; content: string }>): boolean {
  let i = (history ?? []).length - 1;
  while (i >= 0 && history[i].role === "user") i--;
  if (i < 0) return false;
  for (let j = i; j >= 0 && history[j].role === "assistant"; j--) {
    const c = history[j].content || "";
    if (c.includes(REVIEW_HANDOFF_MARK)) return true;
    if (c.includes(REVIEW_CTX_PREFIX)) return false;
  }
  return false;
}

// Recusa explícita = a mesma régua estreita do follow-up de orçamento ("stop",
// "not interested", "wrong number"...). Nunca um "depois eu faço".
export function isReviewRefusal(text: string): boolean {
  return isQuoteRefusal(text);
}

// "Já deixei o review" / "done" / "ya la hice": pede o print (sem modelo).
const REVIEW_DONE =
  /(?:\b(?:just|already|i)\s+(?:left|posted|wrote|did|submitted|gave)\s+(?:you\s+|the\s+|a\s+|my\s+|it\s+)?(?:5\s*stars?|review|reviews|one|it)\b|\breview\s+(?:is\s+)?(?:done|posted|submitted|up|left)\b|^\s*(?:done|posted|listo|hecho|feito)\s*[.!]*\s*$|\bya\s+(?:la|lo|las|los)?\s*(?:hice|dej[eé]|puse|publiqu[eé]|escrib[ií])\b|\b(?:dej[eé]|puse|publiqu[eé]|escrib[ií])\s+(?:la|mi|una|el)\s+(?:rese[ñn]a|review|comentario)\b|\brese[ñn]a\s+(?:hecha|lista|publicada)\b|\bj[aá]\s+(?:deixei|fiz|postei)\s+(?:o|a|um|uma)\s+(?:review|avalia[çc][ãa]o)\b)/i;

export function isReviewDoneClaim(text: string): boolean {
  const t = normalizeSmartPunct(text || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  return REVIEW_DONE.test(t);
}

// ─── Textos fixos ────────────────────────────────────────────────────────────
// Sem modelo, sem risco: nunca oferecem horário, preço nem prometem prazo de
// pagamento. Quem paga é o Ozzi; a mensagem só confirma o recebimento.
export function reviewPhotoReply(lang: FollowupLang): string {
  return lang === "es"
    ? `Muchas gracias! Recibimos tu captura de pantalla, Ozzi se encarga de enviarte tu recompensa. Cualquier duda sobre el pago, escríbele al ${OZZI_PHONE}.`
    : `Thank you so much! We got your screenshot, Ozzi will take care of sending your reward. Any question about the payment, just text him at ${OZZI_PHONE}.`;
}

export function reviewAskScreenshotReply(lang: FollowupLang): string {
  return lang === "es"
    ? "Muchas gracias! Para enviarte la recompensa solo necesitamos una captura de pantalla de la reseña publicada, puedes mandarla aquí mismo."
    : "Thank you so much! To send your reward we just need a screenshot of the posted review, you can send it right here.";
}

export const REVIEW_PHOTO_ALERT =
  "REVIEW: o cliente mandou a foto/print do review. Confira e pague a recompensa ($25 Google / $25 Yelp). A foto está logo abaixo e também na tela Follow-up > Reviews da plataforma.";
export const REVIEW_REFERRAL_ALERT =
  "INDICAÇÃO: cliente de review indicou alguém (ou quer indicar). Veja o nome/telefone na conversa e entre em contato com o indicado. Lembre: 10% de comissão sobre o lucro do trabalho se fechar.";
export const REVIEW_HANDOFF_ALERT =
  "Cliente de review precisa de você (dúvida, reclamação ou pagamento). O agente repassou ao Ozzi e NÃO vai responder mais nada nesta conversa.";
export const REVIEW_AFTER_HANDOFF_ALERT =
  "Cliente de review escreveu DEPOIS do repasse ao Ozzi. O agente ficou em silêncio de propósito. Responda você.";

const fmtMoney = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const SYSTEM = `You are Ozzi's assistant for Ozzi Floors (flooring installation, South Florida), texting on WhatsApp with a client whose flooring job is ALREADY FINISHED. We recently asked them for a Google and Yelp review (we give a cash reward per review, paid by Ozzi once they send a screenshot of the posted review) and told them about our referral program. The client just replied, write the next message.

Write ONLY the message text (plus an optional tag at the very end). No preamble, no quotes around it, no signature.

HARD RULES:
1. Match the client's language (English or Spanish; if unclear, use the conversation's language).
2. One or two short sentences, like a real person texting. No emoji, no dashes of any kind (use commas or periods), no markdown, no lists.
3. This client is NOT a lead. NEVER offer a visit, an estimate, a quote, a price, a discount or financing, and NEVER use scheduling phrases ("works for you", "what day", "which time", "what works", any clock time). Their job is done.
4. If the client says they posted or will post a review: thank them and ask them to send a screenshot of the posted review right here so the reward can be sent. Do not paste the links again unless they ask where to post.
5. If the client asks where or how to leave the review: give the Google link and/or the Yelp link EXACTLY as written in the context, each at most once, nothing added around the URL.
6. Reward facts you may state: the amounts in the context (one per review, Google and Yelp are separate), the screenshot is the proof, and Ozzi sends the reward personally. NEVER promise a date, a payment method or anything else about the payment. If they ask HOW or WHEN they get paid, say Ozzi handles the payment directly and they can text him at ${OZZI_PHONE}, and end with [NOTIFY_OWNER].
7. Referral facts you may state: if they refer a friend or family member and that person closes a job with us, the client earns the commission percentage in the context, calculated on that job's profit. They can send the friend's name and phone number here, or the friend can mention them. Never state any other term.
8. If the client GIVES a referral (a name, a phone number, "my neighbor wants floors", etc.): thank them warmly, confirm we will get in touch with that person, and end with [NOTIFY_OWNER].
9. If the client has a complaint, a problem with the floor, a warranty question, asks about a pending payment or invoice, or anything about the job itself: apologize briefly in one sentence if it is a complaint, never argue, give Ozzi's direct number ${OZZI_PHONE} so they call or text him, and end with [NOTIFY_OWNER].
10. If the client asks anything else you cannot answer from the context: short warm handoff to Ozzi's direct number ${OZZI_PHONE}, and end with [NOTIFY_OWNER].
11. If the client says they are not interested, do not want to review, or asks to stop: thank them graciously in one sentence, no insisting, no tag.
12. If the client's message is ONLY an acknowledgment or a thank-you ("ok", "okay", "perfect", "got it", "sounds good", "thanks", "gracias", a thumbs up) with no question and no request, output EXACTLY [REACT_ONLY] and nothing else.
13. If the client asks who this is: identify naturally as Ozzi Floors, the company that installed their floors, in the same sentence as the rest of your reply.
14. NEVER invent facts, names, dates, or company details. Never pressure.

The ONLY tags you may output are [NOTIFY_OWNER] (always at the very end, when a rule above asks for it) and [REACT_ONLY] (alone, rule 12).`;

function buildUser(ctx: ReviewCtx, history: Array<{ role: string; content: string }>, clientText: string): string {
  const lines = [
    `Google review link: ${ctx.google_url || "not on file, say they can find us on Google Maps"}`,
    `Yelp review link: ${ctx.yelp_url || "not on file, say they can find us on Yelp"}`,
    `Reward per Google review: ${fmtMoney(ctx.valor_google)}`,
    `Reward per Yelp review: ${fmtMoney(ctx.valor_yelp)}`,
    `Referral commission: ${ctx.comissao_pct}% of that job's profit`,
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

export type ReviewReplyResult = {
  text: string;
  notifyOwner: boolean;
  reactOnly?: boolean;
  source: "ai" | "ai-retry" | "handoff" | "ask-screenshot";
};

const HANDOFF: Record<FollowupLang, string> = {
  en: `Thanks for your message, for that the best is to reach Ozzi directly at ${OZZI_PHONE}.`,
  es: `Gracias por tu mensaje, para eso lo mejor es que contactes a Ozzi directamente al ${OZZI_PHONE}.`,
};

const CORRECTIVE =
  'Your previous attempt broke a hard rule: it used a phrase our system reads as scheduling ("works for you", "what day", "which time", a clock time), or it offered a visit, a price, a discount or financing. Rewrite the SAME reply with none of that, keeping the substance.';

// Links devem sair EXATAMENTE como a plataforma mandou: se o modelo retocar um
// (o Google tem "!" e "?" no meio), troca pelo canônico; sem link no contexto,
// nada de URL inventada.
function fixLinks(text: string, ctx: ReviewCtx): string {
  let out = text;
  out = out.replace(/https?:\/\/(?:www\.)?google\.com\/\S*/gi, ctx.google_url || "");
  out = out.replace(/https?:\/\/(?:www\.)?yelp\.com\/\S*/gi, ctx.yelp_url || "");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

export async function composeReviewReply(params: {
  ctx: ReviewCtx;
  history: Array<{ role: string; content: string }>;
  clientText: string;
}): Promise<ReviewReplyResult> {
  const { ctx, history, clientText } = params;

  // Determinístico: "já fiz o review" → pede o print. Sem modelo, sem custo.
  if (isReviewDoneClaim(clientText)) {
    return { text: reviewAskScreenshotReply(ctx.idioma), notifyOwner: false, source: "ask-screenshot" };
  }

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
      const notifyOwner = /\[NOTIFY_OWNER\]/.test(raw);
      // sanitizeOutbound tira travessões (o link do Yelp tem hífen: preservado,
      // removeDashes só mexe em " - " e nos travessões tipográficos).
      const text = fixLinks(sanitizeOutbound(raw), ctx);
      if (/\[REACT_ONLY\]/i.test(raw) && text.length < 5) {
        console.log("[REVIEW-REPLY] react-only (attempt " + attempt + ")");
        return { text: "", notifyOwner: false, reactOnly: true, source: attempt === 1 ? "ai" : "ai-retry" };
      }
      if (text.length < 5) continue;
      // Mesma régua do follow-up de orçamento: frase de agendamento ou desconto
      // derruba a tentativa. URL do Google carrega "!" — a régua não olha links.
      const semLinks = text.replace(/https?:\/\/\S+/g, "");
      const violation = followupPolicyViolation(semLinks);
      if (violation) {
        console.warn(`[REVIEW-REPLY] attempt ${attempt} rejeitado (${violation}): ${text.slice(0, 90)}`);
        continue;
      }
      console.log(`[REVIEW-REPLY] ok (attempt ${attempt}) notify=${notifyOwner} | ${text.slice(0, 80)}`);
      return { text, notifyOwner, source: attempt === 1 ? "ai" : "ai-retry" };
    } catch (err) {
      console.error(`[REVIEW-REPLY] attempt ${attempt} failed:`, err);
      break;
    }
  }
  return { text: HANDOFF[ctx.idioma], notifyOwner: true, source: "handoff" };
}
