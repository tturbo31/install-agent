import Anthropic from "@anthropic-ai/sdk";
import {
  removeDashes,
  removeEmojis,
  stripWrappingQuotes,
  stripReasoningLeak,
  containsSchedulingOffer,
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
  // Financiamento (Hearth): quando oferecer=true este toque LIDERA com a oferta
  // de financiamento e inclui o link da aplicação; quando só a url vem (sem
  // oferecer), o link já foi enviado antes — pode lembrar de leve, sem repetir.
  financiamento?: { url?: string | null; oferecer?: boolean } | null;
};

// Link público do formulário de financiamento (Hearth) — fallback quando a
// plataforma não mandar a URL no payload.
export const HEARTH_URL_PADRAO = "https://app.gethearth.com/partners/ozzifloors";

// URL segura para ir numa mensagem: https, sem espaços, sem colchetes e sem
// travessões (que a sanitização converteria e quebraria o link).
function urlSegura(raw: unknown): string | null {
  const u = typeof raw === "string" ? raw.trim() : "";
  if (!/^https:\/\/[^\s\[\]—–]+$/.test(u)) return null;
  return u;
}

export function financiamentoDe(input: QuoteFollowupInput): { url: string; oferecer: boolean } | null {
  const f = input.financiamento;
  if (!f) return null;
  const url = urlSegura(f.url) ?? HEARTH_URL_PADRAO;
  return { url, oferecer: f.oferecer === true };
}

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

  const fin = financiamentoDe(input);
  if (fin?.oferecer) {
    lines.push(
      `FINANCING OFFER, THIS OVERRIDES THE TOUCH INTENT ABOVE: lead the message with our financing option. Tell them they do not need to pay everything at once${
        formatMoney(input.quote?.parcela_36x) ? `, mention the monthly figure above` : ""
      }, say the application takes about 2 minutes online and that checking their options does not affect their credit score, and include this exact link once, exactly as written, nothing added around it: ${fin.url} , inviting them to fill it out. Up to three short sentences are allowed for this message only.`
    );
  } else if (fin) {
    lines.push(
      `Financing exists and this client ALREADY received our financing application link in an earlier message. You may briefly remind them that financing is available if it fits naturally, but do NOT paste any link again.`
    );
  }

  return lines.join("\n");
}

// ─── Financiamento: 2ª mensagem fixa e template de segurança ─────────────────
// A 2ª mensagem (enviada logo após a oferta com o link) avisa o próximo passo.
// Determinística de propósito: zero risco, zero custo, e NUNCA pode disparar o
// detector de agendamento (é a última mensagem nossa na conversa).
const APPROVAL_NOTE: Record<FollowupLang, string> = {
  en: "As soon as your application is approved, Ozzi will personally reach out to you to finalize everything.",
  es: "En cuanto tu solicitud sea aprobada, Ozzi se comunicará contigo personalmente para finalizar todo.",
};

export function financingApprovalNote(lang: FollowupLang): string {
  return APPROVAL_NOTE[lang];
}

// Último recurso da mensagem de OFERTA de financiamento (IA fora do ar): já sai
// com o link. {url} é substituído pela URL segura.
const SAFE_FINANCING: Record<FollowupLang, string> = {
  en: "Hi, good news about your flooring quote: you can finance the project instead of paying everything at once. Checking your options takes about 2 minutes and does not affect your credit score, just fill out this form: {url}",
  es: "Hola, buenas noticias sobre tu cotización: puedes financiar el proyecto en vez de pagar todo de una vez. Ver tus opciones toma unos 2 minutos y no afecta tu crédito, solo llena este formulario: {url}",
};

export function safeFinancingTemplate(lang: FollowupLang, url: string): string {
  return SAFE_FINANCING[lang].replaceAll("{url}", url);
}

const SYSTEM = `You are Ozzi's assistant for Ozzi Floors, a flooring installation company in South Florida. You write ONE short WhatsApp follow-up message to a client who ALREADY had the free in-person visit and ALREADY received their quote.

Write ONLY the message text. No preamble, no explanation, no quotes around it, no signature.

HARD RULES:
1. Write in the requested language only.
2. One or two sentences. Never three. Short and human, like a real person texting. EXCEPTION: when the context asks you to include the financing application link, up to three short sentences are allowed.
2b. Never include any link or URL, EXCEPT the exact financing link when the context explicitly tells you to include it, copied character for character, exactly once.
3. Zero dashes, no -, no en dash, no em dash. Use commas or periods.
4. Zero emojis. Plain text only.
5. NEVER negotiate, offer, hint at, or promise a discount, a better price, a deal, a price match, or that the price could come down. The quote is the quote. Price decisions belong to Ozzi alone.
6. NEVER offer, propose, or ask about appointment times, days, slots, or scheduling a visit. The visit already happened. Never name any day or hour, and never use any of these phrases or anything close to them: "works for you", "works best for you", "what day", "which day", "what time", "which time", "what works", "which works", "get started right away". They read as scheduling to our system and would send the client into a booking flow by mistake. To invite a reply, ask about the QUOTE instead ("any questions?", "want to move forward?", "anything I can clarify?").
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

// ─── The scheduling-phrase trap (found by adversarial review, 2026-07-15) ────
// A quote follow-up must NEVER read as a scheduling offer. This is not a style
// preference, it is a correctness invariant: for a client whose visit is already
// booked, all three webhooks do
//     if (containsSchedulingOffer(lastAssistantMessage)) engageReschedule = true
// so if our follow-up ends with a phrase like "let me know if that works for
// you", the client's next message is routed into RESCHEDULE MODE and the bot
// starts trying to MOVE a visit that already happened. "works for you" is an
// entirely natural thing to write in a follow-up, so the prompt rule alone is
// not enough — we verify the produced text and fall back to copy that provably
// cannot trip the detector.
//
// SAFE_TEMPLATE is the last resort, never the first choice: every line here is
// asserted against containsSchedulingOffer in enviar-verify.ts.
const SAFE_TEMPLATE: Record<FollowupLang, Record<FollowupStage, string>> = {
  en: {
    D1: "Hi, just making sure our quote reached you, any questions at all?",
    D3: "Hi, did you get a chance to look over the quote? Happy to clear up anything about it.",
    D7: "Hi, your quote still stands, want to move forward or is there anything I can clarify first?",
    D14: "Hi, is there anything holding you back on the quote? Happy to help with whatever it is.",
    D30: "Hi, we are here whenever you are ready, just reach out and we will take it from there.",
  },
  es: {
    D1: "Hola, solo para confirmar que recibiste tu cotización, cualquier duda me avisas.",
    D3: "Hola, ¿pudiste revisar la cotización? Con gusto te aclaro cualquier detalle.",
    D7: "Hola, tu cotización sigue en pie, ¿quieres seguir adelante o te aclaro algo primero?",
    D14: "Hola, ¿hay algo que te detenga con la cotización? Con gusto te ayudo con lo que sea.",
    D30: "Hola, aquí estamos cuando estés listo, solo escríbeme y seguimos desde ahí.",
  },
};

export function safeFollowupTemplate(lang: FollowupLang, stage: FollowupStage): string {
  return SAFE_TEMPLATE[lang][stage];
}

// True when the text would be misread as a scheduling offer by the webhooks.
export function tripsSchedulingDetector(text: string): boolean {
  return containsSchedulingOffer(text || "");
}

// ─── Discount promises (owner rule 31) ──────────────────────────────────────
// Price decisions belong to Ozzi. The bot must never volunteer, hint at, or
// promise a lower/better number. This matters most on the FALLBACK path: if
// Anthropic is down (out of credits / 529 — a documented recurring failure here)
// every follow-up in that window becomes the platform's raw draft, and a draft
// like "we could take a bit off the price" would otherwise ship untouched.
// Deliberately does NOT match financing ("brings it to $125 a month"), which is
// allowed when the platform supplies the monthly figure.
const DISCOUNT_PROMISE =
  /\b(?:discount|descuento|rebaja[rs]?|price\s*match|match\s+(?:that|their|the)\s+(?:price|quote|number)|beat\s+(?:that|their|the|any)\s+(?:price|quote|number|offer)|knock\s+(?:off|down)|take\s+(?:a\s+bit|some|a\s+little|something|\$?\d+)?\s*off\b|lower\s+(?:the|your)?\s*price|drop\s+(?:the|your)?\s*price|reduce\s+(?:the|your)?\s*price|better\s+(?:price|deal|number|offer)|special\s+deal|cut\s+(?:you\s+)?a\s+deal|work\s+(?:something|with\s+you)\s+on\s+the\s+price|bajar\s+(?:el\s+)?precio|mejor\s+(?:precio|oferta|n[uú]mero)|m[aá]s\s+barato|hacer(?:lo|te)?\s+un\s+descuento|oferta\s+especial)\b/i;

export function promisesDiscount(text: string): boolean {
  return DISCOUNT_PROMISE.test(text || "");
}

// The single policy gate every outbound follow-up must clear, whatever wrote it
// (model, model retry, or the platform's draft). Returns the reason it failed,
// or null when the text is safe to send.
export function followupPolicyViolation(text: string): string | null {
  if (tripsSchedulingDetector(text)) return "parece oferta de horario (dispararia o fluxo de remarcacao)";
  if (promisesDiscount(text)) return "promete desconto ou preco melhor (regra 31 do dono)";
  return null;
}

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 3, timeout: 30_000 });
  }
  return _anthropic;
}

export type ComposeResult = {
  text: string;
  source: "ai" | "ai-retry" | "sugestao" | "template";
  inputTokens: number;
  outputTokens: number;
};

// One model call. Returns the sanitized text plus usage.
async function askModel(context: string, corrective: string | null) {
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
    messages: [{ role: "user" as const, content: corrective ? `${context}\n\n${corrective}` : context }],
  });
  const block = res.content[0];
  const raw = block?.type === "text" ? block.text : "";
  return {
    text: sanitizeOutbound(raw),
    inputTokens: res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0),
    outputTokens: res.usage.output_tokens,
  };
}

const CORRECTIVE =
  'Your previous attempt broke a hard rule: it either used a phrase our system reads as scheduling ("works for you", "what day", "which time", "get started right away", a clock time) or it hinted at a discount or a better price. Rewrite the SAME message with neither. Invite a reply about the QUOTE instead, for example "any questions?" or "want to move forward?", and never suggest the price could change.';

// Writes the follow-up. Degrades in this order, never dropping the touch:
//   AI → AI retry (if the first trips the scheduling detector) → the platform's
//   own draft (if it is clean) → a safe canned template.
// Throws only if even the template is somehow unusable.
export async function composeQuoteFollowup(input: QuoteFollowupInput): Promise<ComposeResult> {
  const context = buildFollowupContext(input);
  const fin = financiamentoDe(input);
  let tokensIn = 0;
  let tokensOut = 0;

  for (const attempt of [1, 2] as const) {
    try {
      const r = await askModel(context, attempt === 2 ? CORRECTIVE : null);
      tokensIn += r.inputTokens;
      tokensOut += r.outputTokens;
      if (r.text.length < 15) {
        console.warn(`[ENVIAR] attempt ${attempt}: model returned an unusably short follow-up`);
        continue;
      }
      const violation = followupPolicyViolation(r.text);
      if (violation) {
        console.warn(`[ENVIAR] attempt ${attempt}: rejeitado (${violation}): ${r.text.slice(0, 90)}`);
        continue;
      }
      // Oferta de financiamento SEM o link intacto não cumpre o objetivo do
      // toque (o cliente precisa conseguir clicar) — trata como tentativa ruim.
      if (fin?.oferecer && !r.text.includes(fin.url)) {
        console.warn(`[ENVIAR] attempt ${attempt}: oferta de financiamento sem o link intacto`);
        continue;
      }
      console.log(`[ENVIAR] follow-up ${input.etapa}/${input.idioma} written by AI (attempt ${attempt}) | in=${tokensIn} out=${tokensOut} | ${r.text.slice(0, 70)}`);
      return { text: r.text, source: attempt === 1 ? "ai" : "ai-retry", inputTokens: tokensIn, outputTokens: tokensOut };
    } catch (err) {
      console.error(`[ENVIAR] attempt ${attempt}: follow-up generation failed:`, err);
      break; // API is down — retrying the same call buys nothing, go to fallbacks.
    }
  }

  // OFERTA de financiamento: o rascunho da plataforma não tem o link, então o
  // fallback correto é o template de financiamento (já traz o link e passa no
  // portão por construção — verificado em enviar-verify).
  if (fin?.oferecer) {
    const t = safeFinancingTemplate(input.idioma, fin.url);
    if (followupPolicyViolation(t) === null) {
      console.warn(`[ENVIAR] falling back to the safe financing ${input.idioma} template`);
      return { text: t, source: "template", inputTokens: tokensIn, outputTokens: tokensOut };
    }
  }

  // The platform's own draft — but it is UNTRUSTED copy that never passed our
  // rules, so it must clear the exact same gate as the model's output. This is
  // the path that runs when Anthropic is down, i.e. when EVERY follow-up in the
  // window would ship it: a draft promising a discount or a time slot must be
  // dropped in favour of the template, not forwarded to a real client.
  const draft = sanitizeOutbound(input.sugestao_texto ?? "");
  if (draft.length >= 15) {
    const draftViolation = followupPolicyViolation(draft);
    if (!draftViolation) {
      console.warn("[ENVIAR] falling back to the platform draft");
      return { text: draft, source: "sugestao", inputTokens: tokensIn, outputTokens: tokensOut };
    }
    console.warn(`[ENVIAR] platform draft rejeitado (${draftViolation}), indo para o template seguro`);
  }

  const template = safeFollowupTemplate(input.idioma, input.etapa);
  if (!template) throw new Error("nao foi possivel gerar a mensagem do follow-up");
  console.warn(`[ENVIAR] falling back to the safe ${input.idioma}/${input.etapa} template`);
  return { text: template, source: "template", inputTokens: tokensIn, outputTokens: tokensOut };
}
