// ─── One-shot follow-up for hot leads that went quiet mid-scheduling ────────
// The 2026-07-09 six-day review found the single biggest booking leak: leads
// who engaged (named their floor type / got the visit offer) and then simply
// went silent — the bot never spoke again and the lead died. 221 engaged leads
// → 113 visit offers → only 46 bookings in 6 days. This module sends AT MOST
// ONE gentle follow-up per conversation, ever, to exactly that segment.
//
// HARD GUARDS (all must pass — this must never become spam):
//  • last message in the convo is OURS and is a scheduling ask/offer
//  • the client actually engaged (≥1 real, non-FAQ-button message after our
//    first reply — ad-button ghosts and accidental taps are never followed up)
//  • the client did NOT defer/decline ("I'll reach out when ready", "no
//    thanks", "te aviso", "vou falar com meu marido" → we respect it, no nudge)
//  • our last message is not already a handoff/deferral-ack
//  • timing (owner rule 2026-09-27): only after 2 FULL DAYS of client silence,
//    then at most one more nudge 2 days later, never a third. The 45-minute
//    nudge of 17/09 sent 97 messages in two days (median 1.1h after the client
//    went quiet, 55 of them to one-tap ad ghosts) for 8 replies, 3 of them
//    "not interested", and the owner called it spam: "não é para ficar mandando
//    mensagens toda hora".
//  • channel window: Meta's 24h standard-messaging window closes long before
//    the 2-day mark, so Instagram and Messenger get NO follow-up at all (a
//    tagged send would be a policy violation); WhatsApp via Z-API has no window.
//  • mode=agent, not booked, platform not paused, ET daytime only, ≤25/run
import { containsSchedulingOffer } from "@/lib/ai";

export type FollowupMsg = { role: string; content: string; created_at: string };
export type Channel = "instagram" | "facebook" | "whatsapp";
export type Lang = "en" | "es" | "pt";

export function channelOfIgsid(igsid: string): Channel {
  if (igsid.startsWith("wa_")) return "whatsapp";
  if (igsid.startsWith("fb_")) return "facebook";
  return "instagram";
}

// The nudge, per language. Short and human (owner, 2026-09-27: "respostas
// mais curtas e humanizadas"), no prices, no invented slots, no dashes/emoji.
// The opening phrase doubles as the dedup MARKER — never reword it without
// updating FOLLOWUP_MARKER.
export function followupTemplate(lang: Lang): string {
  if (lang === "pt") return "Oi, ainda pensando no piso? Se quiser, marco sua visita gratuita de orçamento, é só me dizer.";
  if (lang === "es") return "Hola, sigue pensando en el piso? Si quiere le agendo la visita gratis del estimado, solo me avisa.";
  return "Hi, still thinking about the floors? Happy to set up your free estimate visit whenever works for you, just let me know.";
}

// The SECOND (and last) touch, two more days later, when the first nudge got
// no answer: one graceful goodbye, the door stays open, nothing to answer.
export function lastTouchTemplate(lang: Lang): string {
  if (lang === "pt") return "Oi, só um último toque. Se o piso novo ainda está nos planos, estou aqui quando quiser a visita gratuita.";
  if (lang === "es") return "Hola, un último mensaje. Si el piso nuevo sigue en sus planes, aquí estoy cuando quiera la visita gratis.";
  return "Hi, just one last check in. If new floors are still on your list, I'm here whenever you're ready for the free visit.";
}

// ─── FANTASMA DO BOTÃO (17/09/2026, pedido do dono) ─────────────────────────
// 44% das conversas de anúncio são um toque no botão de FAQ, a resposta
// automática e silêncio (578 em duas semanas, a maior perda do funil). Este
// segmento era PROIBIDO aqui ("one-tap ghost"); agora recebe UMA mensagem
// 45 min depois oferecendo a visita gratuita desta semana. Sem IA (texto
// fixo, o que mantém a varredura rápida) e com o mesmo teto de 1 por conversa.
export function ghostTemplate(lang: Lang): string {
  if (lang === "pt") return "Oi, ainda procurando piso novo? Posso marcar uma visita gratuita de orçamento quando quiser, é só me avisar.";
  if (lang === "es") return "Hola, sigue buscando piso nuevo? Puedo agendar una visita gratis para el estimado cuando quiera, solo me avisa.";
  return "Hi, still looking into new floors? I can set up a free estimate visit whenever you want, just let me know.";
}

// ─── SUMIU DEPOIS DO PREÇO (17/09/2026, pedido do dono) ─────────────────────
// 94 conversas em duas semanas morreram logo depois de o bot dizer o valor.
// A nudge de quem já ouviu o preço traz a linha do FINANCIAMENTO (pagar por
// mês, pelo parceiro), sem prometer aprovação nem citar taxas ou parcelas.
export function financingTemplate(lang: Lang): string {
  if (lang === "pt") return "Oi, ficou alguma dúvida sobre o piso? Também temos financiamento pelo nosso parceiro para pagar por mês, e a visita de orçamento é gratuita se quiser marcar.";
  if (lang === "es") return "Hola, quedó alguna duda sobre el piso? También tenemos financiamiento con nuestro socio para pagar mensual, y la visita del estimado es gratis si quiere agendar.";
  return "Hi, any questions about the floors? We also offer financing through our partner to pay monthly, and the estimate visit is free if you want to set one up.";
}

// Detects a follow-up we already sent (any language, old and new wording).
// A nudge escrita pela IA é gravada no banco com o sufixo [SYSTEM: FOLLOWUP_NUDGE]
// (nunca enviado ao cliente), então o marcador também o reconhece.
export const FOLLOWUP_MARKER = /just checking in, want me to get your free estimate|solo para dar seguimiento|passando s[oó] para saber se quer agendar|want me to check a time this week|quieres que busque un horario|quer que eu veja um hor[aá]rio|just checking if you had any questions|solo para saber si qued|passando para saber se ficou|still thinking about the floors\?|sigue pensando en el piso\?|ainda pensando no piso\?|still looking into new floors|sigue buscando piso nuevo|ainda procurando piso novo|any questions about the floors\? we also|qued[oó] alguna duda sobre el piso\? tambi|ficou alguma d[uú]vida sobre o piso\? tamb|just one last check in|un [uú]ltimo mensaje|s[oó] um [uú]ltimo toque|\[SYSTEM: FOLLOWUP_NUDGE\]/i;
export const FOLLOWUP_DB_SUFFIX = "\n\n[SYSTEM: FOLLOWUP_NUDGE]";

// Meta ad FAQ quick-reply buttons — a tap is NOT genuine engagement. A lead
// whose only "messages" are these templates is a browse/mis-tap ghost and must
// never receive a follow-up (58% of leads are one-tap ghosts per the review).
const FAQ_BUTTON = /^\s*(?:what type of materials are included|what is the installation process|do you offer any discounts for larger spaces|do you offer any discounts or promotions|is labor cost included in the price|is labor cost also \$?4,?500|can i customize the design|what is included in the materials package|is installation cost included in the price|is installation labor cost extra|schedule a quote)\s*\??\s*$/i;

export function isAdFaqButton(text: string): boolean {
  return FAQ_BUTTON.test((text || "").split(/\n\n?\[SYSTEM:/)[0]);
}

// Client told us their plan — respect it, never nudge. EN/ES/PT.
const CLIENT_DEFERRAL = /\b(?:no,?\s+thanks?|not interested|stop|unsubscribe|wrong (?:person|number)|by accident|accidentally|didn'?t mean|just browsing|no longer|already (?:hired|found|done|booked)|i'?ll?\s+(?:reach|call|text|message|contact|get back|let (?:you|u) know|think about|keep you in mind|be in touch)|will (?:reach|call|contact|get back|let you know)|when (?:i'?m|we'?re|i am|it'?s) ready|out of town|on vacation|next (?:week|month|year)|talk to my|ask my (?:husband|wife|partner)|check with my|keep in touch|keep you posted|no me interesa|equivocad\w*|sin querer|te aviso|les? avis(?:o|amos)|luego (?:te|les?)|cuando (?:regrese|vuelva|est[ée]|lo consulte|consulte)|consultar(?:lo)? con|lo pienso|d[ée]jame pensarlo|depois (?:eu )?(?:aviso|falo|chamo|entro em contato)|te aviso|aviso voc[eê]s?|sem interesse|cliquei sem querer|vou (?:pensar|ver|falar com))\b/i;

// A bare "No" / "None" / "not now" as the client's last word is a decline too
// (fb_28352172931070216 and fb_28208613102057585, 27/09/2026: both got a nudge).
const BARE_NEGATIVE = /^[\s.,!¡¿?]*(?:no+|nope|nah|none|nothing|not\s+now|not\s+yet|not\s+interested|no\s+gracias|n[aã]o|nada)[\s.,!]*(?:thanks?|thank\s+(?:you|u)|ty|gracias|obrigad[oa])?[\s.,!?]*$/i;
export function isClientDeferral(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  return CLIENT_DEFERRAL.test(t) || BARE_NEGATIVE.test(t.trim());
}

// Our own last line already acknowledged a deferral or handed off to a human —
// a nudge on top of "no problem, reach out whenever!" contradicts ourselves.
const BOT_CLOSED_LOOP = /\breach out (?:when(?:ever)?|as soon as|any\s?time)|when(?:ever)? you(?:'re| are) ready|just (?:message|text|reach out to) me|no (?:problem|rush|worries),? just|team (?:will |to )?reach(?:es)? out|someone will (?:get|reach|contact)|connect you with ozzi|reach ozzi directly|we don'?t (?:cover|service|serve)|outside our (?:area|service)|only serve the miami|don'?t take projects under|me avisa|cuando (?:lo )?consulten|les aviso|puedes? contactar|contact[aá]|entra em contato|s[oó] (?:me )?(?:chamar|avisar)|qualquer coisa/i;

export function botClosedTheLoop(text: string): boolean {
  return BOT_CLOSED_LOOP.test(text || "");
}

// Our last message keeps the door open on scheduling: a slot offer/scheduling
// question (containsSchedulingOffer), a visit/estimate proposal, or one of our
// qualifying asks (floor type / scope). These are the "waiting on the client"
// shapes worth one nudge.
const SCHEDULING_ASK = /\b(?:free|in.?person)\s+(?:visit|estimate|quote)\b|\bcome (?:by|out|over|measure)\b|\bmeasure (?:everything|in person)\b|\bvisit\b[^.!?]{0,60}\bfree\b|one area or (?:the )?(?:whole|entire) house|whole house or|tile[^.!?]{0,30}vinyl[^.!?]{0,30}hardwood|which (?:one|type|floor)[^.!?]{0,40}\?|square (?:feet|footage)[^.!?]{0,30}\?|s[oó] uma [aá]rea ou|una sola [aá]rea o|visita (?:gratis|gratuita)/i;

export function isSchedulingAsk(text: string): boolean {
  const t = text || "";
  return containsSchedulingOffer(t) || SCHEDULING_ASK.test(t);
}

// Conversa em que TUDO que o cliente mandou foi botão de FAQ do anúncio (ou
// vazio) e o bot já respondeu: o "fantasma do botão" (17/09/2026).
export function isFaqGhost(messages: FollowupMsg[]): boolean {
  const strip = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  const users = messages.filter((m) => m.role === "user");
  if (users.length === 0 || !messages.some((m) => m.role === "assistant")) return false;
  return users.every((m) => strip(m.content).length === 0 || isAdFaqButton(m.content));
}

// O bot já disse um valor em dólar nesta conversa ("$5 per sqft", "$4,500").
export const PRICE_STATED = /\$\s?\d/;
export function priceWasStated(messages: FollowupMsg[]): boolean {
  return messages.some((m) => m.role === "assistant" && PRICE_STATED.test((m.content || "").split(/\n\n?\[SYSTEM:/)[0]));
}

// Language of the conversation. The client's own words decide when they carry
// a signal; when they don't (a bare address, a name, FAQ-button English), we
// trust the language of OUR OWN last reply — the model already language-matched
// the client, so following up in a different language than the running
// conversation is always wrong (caught on the 2026-07-09 dry run: a Spanish
// lead whose last messages were just her address was about to get English).
// "gratuita" saiu da lista PT (31/08/2026): é a MESMA palavra em espanhol
// ("la visita gratuita") e mandava conversa ES para o nudge em português.
// \b do JS é ASCII: depois de "você" (ê) não há boundary, então a palavra que
// segurava o PT nessas frases era justamente "gratuita" — âncoras acento-seguras.
const PT_SIGNALS = /(?:^|[\s!.,?¡¿])(?:olá|oi|bom dia|boa (?:tarde|noite))(?![a-zà-ÿ])|[ãõç]|(?:^|[^a-zà-ÿ])(?:você|voce|obrigad\w*|orçamento|orcamento|preciso de|banheiro|cozinha|amostras para você)(?![a-zà-ÿ])/i;
// Desde 28/08/2026 as respostas do bot em espanhol NÃO têm mais ¿ ¡ — este
// detector dependia deles para reconhecer o idioma da NOSSA última resposta e
// passou a devolver inglês para conversa em espanhol (fb 4125ccfb, 27/08:
// "Parece que estás por tomar posesión…" → nudge em inglês). Marcadores do
// vocabulário do próprio bot em ES cobrem o buraco.
const ES_SIGNALS = /[¿¡]|(?:^|[\s!.,?])(?:hola|buenas|buenos)(?![a-zà-ÿ])|\b(?:cu[aá]nto|cu[aá]ndo|cu[aá]l|precio|cuesta|necesito|quiero|busco|porcelanato|cer[aá]mica|cotizaci[oó]n|presupuesto|gracias|cita|pueden?|darme|horarios?|muestras|pie cuadrado|pies\s+cuadrados|escoja?s?|viernes|jueves|lunes|martes|s[aá]bado|domingo|est[aá]s|qu[eé]\s+tipo|te\s+interesa|instalaci[oó]n|visita\s+gratis|c[oó]digo\s+postal|mano\s+de\s+obra|tambi[eé]n|ma[ñn]ana)\b/i;

export function pickLang(userTexts: string[], lastBotText?: string): Lang {
  const blob = userTexts.slice(-6).join(" ");
  // PT first (mirrors ai.ts: PT context beats the shared piso/casa vocabulary).
  if (PT_SIGNALS.test(blob)) return "pt";
  if (ES_SIGNALS.test(blob)) return "es";
  // Client text carries no signal → follow the conversation's existing language.
  const bot = lastBotText || "";
  if (PT_SIGNALS.test(bot)) return "pt";
  if (ES_SIGNALS.test(bot)) return "es";
  return "en";
}

const H = 3600_000;
// Timing (owner rule 2026-09-27, replacing the 45 minutes of 17/09): the first
// nudge only after 2 full days of client silence, a second one 2 days after the
// first when it got no answer, and never a third. Channel windows are measured
// from the CLIENT's last message: Meta's 24h standard-messaging window closes
// before the 2-day mark (22h keeps margin), so Instagram and Messenger never
// qualify; WhatsApp via Z-API has no window, capped at 5 days so a sweep that
// was down for a while never wakes a week-old lead.
export const FOLLOWUP_DELAY_H = 48;
// 29/09/2026 (revisão da conversão): o lead ENGAJADO (conversou de verdade e
// sumiu depois da oferta/pergunta de agendamento, ou logo depois do preço)
// volta ao ritmo anterior a 17/09: UMA nudge após 3h de silêncio, dentro da
// janela do canal (Instagram e Messenger ≤22h). A regra de 2 dias do dono
// (27/09) continua valendo para o fantasma do botão, que era o spam.
export const ENGAGED_DELAY_H = 3;
export const NUDGE_GAP_H = 48;
export const MAX_NUDGES_PER_CONVERSATION = 2;
const WINDOW_H: Record<Channel, { max: number }> = {
  instagram: { max: 22 },
  facebook: { max: 22 },
  whatsapp: { max: 5 * 24 },
};

// engaged = o alvo original (conversou, recebeu a oferta de visita, sumiu);
// faq_ghost = só tocou no botão do anúncio; after_price = sumiu logo depois do
// valor. `financing` = o preço já foi dito, a nudge leva a linha do parceiro.
export type FollowupKind = "engaged" | "faq_ghost" | "after_price" | "last_touch";
export type FollowupDecision = { eligible: boolean; reason: string; lang: Lang; kind: FollowupKind; financing: boolean };

// Pure eligibility decision for one conversation. `messages` must be the FULL
// history in ascending order; `nowMs` injected for testability.
export function decideFollowup(igsid: string, messages: FollowupMsg[], nowMs: number): FollowupDecision {
  const strip = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];
  const lastBot = [...messages].reverse().find((m) => m.role === "assistant");
  const lang = pickLang(
    messages.filter((m) => m.role === "user").map((m) => strip(m.content)),
    lastBot?.content
  );
  const financing = priceWasStated(messages);
  const no = (reason: string): FollowupDecision => ({ eligible: false, reason, lang, kind: "engaged", financing });

  if (!messages.length) return no("empty");
  const win = WINDOW_H[channelOfIgsid(igsid)];
  const priorNudges = messages.filter((m) => m.role === "assistant" && FOLLOWUP_MARKER.test(m.content)).length;
  if (priorNudges >= MAX_NUDGES_PER_CONVERSATION) return no("max-nudges-reached");

  const last = messages[messages.length - 1];
  if (last.role !== "assistant") return no("client-has-last-word"); // unanswered client msg is a different problem

  // Second touch: our last message IS the first nudge and it got no answer.
  // Two more days of silence, then one last graceful note, nothing after it.
  if (priorNudges > 0) {
    if (!FOLLOWUP_MARKER.test(last.content)) return no("bot-spoke-after-the-nudge");
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return no("no-user-message");
    if (isClientDeferral(lastUserMsg.content)) return no("client-deferred");
    if (messages.some((m) => m.role === "user" && isHostileRejection(strip(m.content)))) return no("client-rejected");
    const clientAgeH = (nowMs - Date.parse(lastUserMsg.created_at)) / H;
    if (!Number.isFinite(clientAgeH)) return no("bad-timestamp");
    if (clientAgeH > win.max) return no("window-closed(" + clientAgeH.toFixed(1) + "h)");
    const nudgeAgeH = (nowMs - Date.parse(last.created_at)) / H;
    if (!Number.isFinite(nudgeAgeH)) return no("bad-timestamp");
    if (nudgeAgeH < NUDGE_GAP_H) return no("second-touch-too-soon(" + nudgeAgeH.toFixed(1) + "h)");
    return { eligible: true, reason: "ok", lang, kind: "last_touch", financing: false };
  }

  if (botClosedTheLoop(last.content)) return no("bot-closed-loop");

  // Qual dos três alvos é esta conversa (17/09/2026):
  //   fantasma do botão → texto fixo da visita gratuita;
  //   sumiu logo depois do preço (a ÚLTIMA fala nossa traz o valor e não é
  //   oferta de horário) → nudge com financiamento;
  //   o alvo original: nossa última fala é uma oferta/pergunta de agendamento.
  let kind: FollowupKind = "engaged";
  if (isFaqGhost(messages)) kind = "faq_ghost";
  else if (!isSchedulingAsk(last.content)) {
    if (PRICE_STATED.test(strip(last.content))) kind = "after_price";
    else return no("last-bot-msg-not-a-scheduling-ask");
  }

  // Silêncio mínimo por alvo: fantasma do botão só depois de 2 dias (regra do
  // dono 27/09, o que ele chamou de spam); lead engajado após 3h (ritmo
  // anterior a 17/09).
  const minSilenceH = kind === "faq_ghost" ? FOLLOWUP_DELAY_H : ENGAGED_DELAY_H;
  if (minSilenceH > win.max) return no("channel-window-closes-before-2-days");

  if (kind !== "faq_ghost") {
    // Genuine engagement: at least one real (non-FAQ-button) client message
    // AFTER our first reply (the ghost path above is the only exception).
    const firstBotIdx = messages.findIndex((m) => m.role === "assistant");
    const engaged = messages.some(
      (m, i) => i > firstBotIdx && m.role === "user" && strip(m.content).trim().length > 0 && !isAdFaqButton(m.content)
    );
    if (!engaged) return no("never-genuinely-engaged");
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return no("no-user-message");
  if (isClientDeferral(lastUser.content)) return no("client-deferred");

  // A client who told us to go away / stop messaging / threatened a spam
  // report — ANYWHERE in the history — is never nudge-eligible (2026-08-22,
  // "No. Get away from me" case). A re-engagement text to that person is
  // exactly the spam they threatened to report.
  if (messages.some((m) => m.role === "user" && isHostileRejection(strip(m.content)))) return no("client-rejected");

  const ageH = (nowMs - Date.parse(lastUser.created_at)) / H;
  if (!Number.isFinite(ageH)) return no("bad-timestamp");
  if (ageH < minSilenceH) return no(`too-fresh(${ageH.toFixed(1)}h)`);
  if (ageH > win.max) return no(`window-closed(${ageH.toFixed(1)}h)`);
  // Our own last line must also have gone the same silence with no answer.
  const botAgeH = (nowMs - Date.parse(last.created_at)) / H;
  if (Number.isFinite(botAgeH) && botAgeH < minSilenceH) return no(`bot-msg-too-fresh(${botAgeH.toFixed(1)}h)`);

  return { eligible: true, reason: "ok", lang, kind, financing };
}

// Daytime guard: only message clients 9:00–20:59 America/New_York.
export function isEtDaytime(nowMs: number): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(nowMs))
  );
  return hour >= 9 && hour <= 20;
}

// ─── The sweep: query, decide, send ─────────────────────────────────────────
// Framework-free so the /api/followup route stays thin AND a local
// `npx tsx` dry-run can exercise the exact production path with zero sends.
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "@/lib/supabase";
import { sendFacebookMessage } from "@/lib/facebook";
import { sendInstagramMessage } from "@/lib/instagram";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";
import { removeDashes, removeEmojis, stripWrappingQuotes, isHostileRejection, replyStillLeaks } from "@/lib/ai";
import { promisesDiscount } from "@/lib/quote-followup";

// ─── Nudge personalizada pela IA (2026-07-17) ───────────────────────────────
// Pedido do dono: o follow-up do Direct deve primeiro ENTENDER o contexto da
// conversa (por que o cliente não seguiu) e falar disso, não mandar sempre a
// mesma frase. A IA lê o final da conversa e escreve 1-2 frases retomando
// exatamente o ponto que ficou aberto; o template fixo vira fallback (IA fora
// do ar / texto reprovado nos guardas). Os guardas de ELEGIBILIDADE (deferral,
// janela de 24h da Meta, 1 nudge por conversa, ≤25/run) continuam idênticos.
const NUDGE_SYSTEM = `You are Ozzi's assistant for Ozzi Floors (flooring installation, South Florida). A potential client was mid-conversation about their floors, we offered to schedule the free in-person estimate visit, and they went quiet TWO DAYS AGO or more. Write ONE short re-engagement message.

Write ONLY the message text. Rules:
1. Write in the language you are told. 1 or 2 short sentences, under 140 characters in total (owner rule: clients stop reading a long text), like a real person texting a friend. No emoji, no dashes (use commas or periods), no links, no markdown, no bracket tags, no "Still thinking about" opener.
2. START from what THEY left hanging: their last question, the floor type or area they mentioned, the thing they were deciding. Reference it naturally so it feels personal, never generic.
3. END by warmly inviting them to schedule the free estimate visit. Two days have passed: NEVER name any day, date, or time (any slot we offered is gone), never say "today", "tomorrow", "yesterday" or "earlier".
4. NEVER mention, offer, or hint at a discount, deal, or better price. NEVER invent prices, sizes, or facts not present in the conversation. You may repeat a price WE already stated there.
5. No pressure, one gentle nudge.`;

// Quem já ouviu o preço recebe a linha do financiamento (17/09/2026): é a
// objeção mais comum de quem some depois do valor, e o dono quer que a
// retomada a responda antes de o cliente perguntar.
const NUDGE_FINANCING_RULE = `
6. The client already heard our price in this conversation. Add ONE short sentence saying we offer financing through our partner so they can pay monthly. NEVER promise approval, NEVER quote interest rates, terms, credit requirements, or monthly amounts. Financing goes alongside the free estimate visit, never instead of it.`;

let _nudgeAnthropic: Anthropic | null = null;
function nudgeClient(): Anthropic {
  if (!_nudgeAnthropic) {
    _nudgeAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 2, timeout: 25_000 });
  }
  return _nudgeAnthropic;
}

const LANG_LABEL: Record<Lang, string> = { en: "English", es: "Spanish", pt: "Portuguese" };

function sanitizeNudge(text: string): string {
  return stripWrappingQuotes(removeEmojis(removeDashes(text ?? "")))
    .replace(/\[[A-Z_]+(?::[\s\S]*?)?\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Escreve a nudge personalizada; devolve null quando o texto não passa nos
// guardas (aí o chamador usa o template fixo comprovado).
export async function composeColdLeadNudge(messages: FollowupMsg[], lang: Lang, financing = false): Promise<string | null> {
  try {
    const tail = messages
      .slice(-10)
      .map((m) => `${m.role === "user" ? "Client" : "Us"}: ${(m.content || "").split(/\n\n?\[SYSTEM:/)[0].slice(0, 350)}`)
      .join("\n");
    const res = await nudgeClient().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      system: financing ? NUDGE_SYSTEM + NUDGE_FINANCING_RULE : NUDGE_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: `Language to write in: ${LANG_LABEL[lang]}\n\nConversation (oldest first):\n${tail}\n\nWrite the re-engagement message now.`,
        },
      ],
    });
    const block = res.content[0];
    const text = sanitizeNudge(block?.type === "text" ? block.text : "");
    if (text.length < 20 || text.length > 220) return null;
    // Two days later, a named day or clock time is stale by construction (Toni,
    // IG 26/09/2026: "we had Monday at 2 lined up"; "visita de mañana" sent at
    // the very minute of that visit). The fixed template has none.
    if (/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|yesterday|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[ñn]ana|ayer|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa]|ontem)\b/i.test(text)) return null;
    // Julie (WA 21/09/2026): texto com o raciocínio do modelo nunca sai; o
    // chamador cai no template fixo comprovado.
    if (replyStillLeaks(text)) return null;
    if (promisesDiscount(text)) return null;
    if (/https?:\/\//i.test(text)) return null;
    // financiamento: nunca taxa, parcela ou aprovação (o modelo não sabe)
    if (financing && /\b\d+(?:[.,]\d+)?\s?%|\bapproved?\b|\baprovad|\bmonthly payment of|\bpor m[eê]s de|\bmensual de\b|\bcuota de\b/i.test(text)) return null;
    // financiamento pedido e não mencionado: o template garante a linha
    if (financing && !/financ/i.test(text)) return null;
    return text;
  } catch (err) {
    console.error("[FOLLOWUP] nudge AI failed, using template:", err);
    return null;
  }
}

// hard cap — a bug can never mass-message. 60 → 25 em 27/09/2026: com o
// mínimo de 2 dias e só WhatsApp elegível, uma varredura legítima manda poucas.
const MAX_SENDS_PER_RUN = 25;
// Conversas tocadas nos últimos 6 dias (a janela do WhatsApp é de 5 dias).
const SCAN_WINDOW_H = 6 * 24;

type ConvRow = { id: string; igsid: string; name: string | null; username: string | null; mode: string; booking_confirmed: boolean | null; updated_at: string };

export type SweepResult = {
  ranAt: string;
  dry: boolean;
  quietHours?: boolean;
  scanned: number;
  eligible: number;
  sent: Array<{ igsid: string; channel: Channel; name: string; lang: Lang; kind?: FollowupKind; ok: boolean; error?: string }>;
  skippedReasons: Record<string, number>;
};

async function isChannelPaused(channel: Channel): Promise<boolean> {
  if (channel === "instagram" && process.env.INSTAGRAM_PAUSED === "true") return true;
  if (channel === "facebook" && process.env.MESSENGER_PAUSED === "true") return true;
  try {
    const { data } = await supabaseAdmin.from("platform_settings").select("paused").eq("platform", channel).single();
    return data?.paused === true;
  } catch {
    return false; // missing row = not paused (matches webhook behavior)
  }
}

export async function runFollowupSweep(opts: { dry: boolean; now?: number }): Promise<SweepResult> {
  const now = opts.now ?? Date.now();
  const result: SweepResult = { ranAt: new Date(now).toISOString(), dry: opts.dry, scanned: 0, eligible: 0, sent: [], skippedReasons: {} };
  const skip = (reason: string) => { result.skippedReasons[reason] = (result.skippedReasons[reason] || 0) + 1; };

  // Live sends only during ET daytime; a dry run may inspect at any hour.
  if (!opts.dry && !isEtDaytime(now)) {
    result.quietHours = true;
    return result;
  }

  const paused: Record<Channel, boolean> = {
    instagram: await isChannelPaused("instagram"),
    facebook: await isChannelPaused("facebook"),
    whatsapp: await isChannelPaused("whatsapp"),
  };

  const cutoff = new Date(now - SCAN_WINDOW_H * 3600_000).toISOString();
  const { data: convs, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id, igsid, name, username, mode, booking_confirmed, updated_at")
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`followup conv query: ${error.message}`);

  const candidates = ((convs ?? []) as ConvRow[]).filter((c) => {
    if (c.mode !== "agent") { skip("mode-human"); return false; }
    if (c.booking_confirmed === true) { skip("already-booked"); return false; }
    if (paused[channelOfIgsid(c.igsid)]) { skip("channel-paused"); return false; }
    return true;
  });
  result.scanned = candidates.length;

  // Fetch every candidate's messages in chunked bulk queries, group by convo.
  const byConv = new Map<string, FollowupMsg[]>();
  for (let i = 0; i < candidates.length; i += 80) {
    const ids = candidates.slice(i, i + 80).map((c) => c.id);
    const { data: msgs, error: mErr } = await supabaseAdmin
      .from("instagram_messages")
      .select("conversation_id, role, content, created_at")
      .in("conversation_id", ids)
      .order("created_at", { ascending: true });
    if (mErr) throw new Error(`followup msg query: ${mErr.message}`);
    for (const m of msgs ?? []) {
      const arr = byConv.get(m.conversation_id) ?? [];
      arr.push({ role: m.role, content: m.content, created_at: m.created_at });
      byConv.set(m.conversation_id, arr);
    }
  }

  for (const conv of candidates) {
    if (result.sent.length >= MAX_SENDS_PER_RUN) { skip("run-cap-reached"); continue; }
    const messages = byConv.get(conv.id) ?? [];
    const decision = decideFollowup(conv.igsid, messages, now);
    if (!decision.eligible) { skip(decision.reason.replace(/\(.*\)/, "")); continue; }

    result.eligible++;
    const channel = channelOfIgsid(conv.igsid);
    const name = conv.name || conv.username || conv.igsid;
    if (opts.dry) {
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, kind: decision.kind, ok: false, error: "DRY-RUN (not sent)" });
      continue;
    }
    // Fantasma do botão: texto fixo (sem IA, sem contexto para personalizar).
    // Os outros: IA personaliza a partir da conversa, com a linha do
    // financiamento quando o preço já foi dito; template comprovado é o fallback.
    let text: string;
    if (decision.kind === "last_touch") text = lastTouchTemplate(decision.lang);
    else if (decision.kind === "faq_ghost") text = ghostTemplate(decision.lang);
    else
      text =
        (await composeColdLeadNudge(messages, decision.lang, decision.financing)) ??
        (decision.financing ? financingTemplate(decision.lang) : followupTemplate(decision.lang));
    // O modelo já escreveu o nudge em PORTUGUÊS para uma cliente de espanhol
    // (Alicia, WA 27/08/2026: "Ficou com dúvida sobre instalar por cima da
    // losa…"). Idioma errado = template comprovado no idioma certo.
    if (decision.lang !== "pt" && PT_SIGNALS.test(text)) {
      console.warn(`[FOLLOWUP] composed nudge came out in Portuguese for a ${decision.lang} conversation — using the template instead`);
      text = decision.financing ? financingTemplate(decision.lang) : followupTemplate(decision.lang);
    }
    try {
      if (channel === "whatsapp") {
        const r = await sendWhatsAppMessage(conv.igsid.slice(3), text);
        if (!r.ok) { result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: r.error }); continue; }
      } else if (channel === "facebook") {
        const r = await sendFacebookMessage(conv.igsid.slice(3), text);
        if (!r.ok) { result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: r.error }); continue; }
      } else {
        const r = await sendInstagramMessage(conv.igsid, text);
        if (!r.ok) { result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: r.error }); continue; }
      }
      // Record it exactly like the webhooks do, so the panel shows it and the
      // FOLLOWUP_MARKER dedup can never let a second nudge through. O sufixo
      // [SYSTEM: FOLLOWUP_NUDGE] (só no banco) garante o dedup mesmo com texto
      // personalizado pela IA.
      // O texto GRAVADO tem que ser idêntico ao ENVIADO: sendXMessage passa por
      // stripInvertedPunctuation (regra do dono 28/08, espanhol sem ¿¡) e o eco
      // do Messenger/IG volta já limpo — sem limpar aqui, norm() não bate, o
      // followup vira "[Treino]" e a conversa é pausada (mode=human).
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: stripInvertedPunctuation(text) + FOLLOWUP_DB_SUFFIX });
      await supabaseAdmin.from("instagram_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conv.id);
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, kind: decision.kind, ok: true });
      console.log(`[FOLLOWUP] sent (${channel}/${decision.lang}/${decision.kind}${decision.financing ? "+financing" : ""}) to ${name}`);
    } catch (err) {
      result.sent.push({ igsid: conv.igsid, channel, name, lang: decision.lang, ok: false, error: String(err).slice(0, 200) });
      console.error(`[FOLLOWUP] send failed for ${conv.igsid}:`, err);
    }
  }

  console.log(`[FOLLOWUP] sweep done: scanned=${result.scanned} eligible=${result.eligible} sent=${result.sent.filter((s) => s.ok).length} dry=${opts.dry}`);
  return result;
}
