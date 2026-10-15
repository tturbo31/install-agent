// ─── Reel/post forwarded from someone else's feed, with no words (14/10/2026) ──
// Meta delivers a forwarded reel/post/link as an attachment with NO text and,
// on Instagram, NO referral: ig_reel {reel_video_id, title, url}, ig_post
// {ig_post_media_id, title, url}; on Messenger reel/post/fallback {title, url}.
// That is exactly the shape the webhooks turned into "[Client replied to our
// ad]", so every forwarded meme, prayer or political clip got the "tile, vinyl,
// or hardwood?" nudge: 365 reels + 125 posts in one week on IG, 106 threads in
// 30 days where the client never typed a word (NA CY GOGARTY: 62 reels, 62 bot
// replies; Stephen Bell: 17 reels, 13 replies). Owner's rule (14/10): do not
// answer those people.
//
// What still counts as an ad reply: OUR ad post/reel forwarded with no words
// (62 of 63 such people typed real text afterwards). Ours is decided by the ad
// caption signature or by the platform's media→ad map (the same lookup the
// funnel uses). Third-party FLOORING content goes to the model as a note.
// Everything else is dropped before it is stored: no message row, no funnel
// lead, no reply. The ad card ("template", 8 of 17 booked), stories,
// disappearing photos, images, audio and video are NOT feed shares and keep
// their existing paths.

export type FeedShare = { type: string; title: string; url: string; mediaIds: string[] };
export type MediaLookup = { ok: boolean; ours: boolean };
export type FeedShareVerdict =
  | { kind: "none" }
  | { kind: "ours"; share: FeedShare; via: "caption" | "platform" | "unverifiable-ad-click" }
  | { kind: "flooring"; share: FeedShare; note: string }
  | { kind: "unrelated"; share: FeedShare };

// Attachment types Meta uses for content forwarded from a feed (IG: ig_reel,
// ig_post, share; Messenger: reel, post, fallback = external link card).
const FEED_SHARE_TYPES = new Set(["ig_reel", "ig_post", "share", "reel", "post", "fallback"]);

export function feedShareOf(message: unknown): FeedShare | null {
  const msg = (message ?? {}) as { attachments?: Array<{ type?: string; payload?: Record<string, unknown> }> };
  const att = (msg.attachments ?? []).find((a) => FEED_SHARE_TYPES.has(String(a?.type ?? "")));
  if (!att) return null;
  const p = att.payload ?? {};
  const title = typeof p.title === "string" ? p.title.replace(/\s+/g, " ").trim() : "";
  const url = typeof p.url === "string" ? p.url : "";
  const ids = new Set<string>();
  for (const k of ["reel_video_id", "ig_post_media_id", "media_id"]) {
    const v = p[k];
    if (typeof v === "string" && /^\d{8,}$/.test(v)) ids.add(v);
  }
  const m = /asset_id=(\d{8,})/.exec(url) ?? /facebook\.com\/reel\/(\d{8,})/.exec(url);
  if (m) ids.add(m[1]);
  return { type: String(att.type), title, url, mediaIds: [...ids] };
}

// Our ad captions, verbatim from the forwarded posts: "✨ 1000 sq.ft. FOR JUST
// $2,350 ❌ materials ✨ 1000 sq.ft. ONLY $5,100 ✅ with materials ..." and the
// Messenger card "Ozzi floors added a new photo." Deliberately narrow: a bare
// "only $9.99" is any shop's reel; the sq.ft. price line and the ❌/✅ materials
// marks are ours. Anything else goes through the platform's media→ad map.
export const OUR_AD_CAPTION_RE = /\bozzi\b|sq\.?\s?ft\.?\s*(?:for just|only)\s*\$\s?\d|❌\s*materia|✅\s*(?:with|con|com)\s*materia/i;
// Third-party content that is still about floors (a look the client likes).
// A bare "floor"/"piso" is NOT enough: "Senate floor", "casa de dos pisos" came
// through. \b is ASCII in JS, so the boundaries are accent-safe by hand.
export const FLOORING_CAPTION_RE = /(?<![a-zà-ÿ])(?:vinyl|vinilo|vin[ií]lico|tiles?|porcelain|porcelanato|hardwood|laminate|laminado|flooring|floors|herringbone|chevron|lvp|sq\.?\s?ft|backsplash|baseboards?|rodap[ée]s?)(?![a-zà-ÿ])/i;

// The note the model reads instead of the ad placeholder. It starts with
// "[Client shared a post" on purpose: ai.ts strips that family as non-client
// words (NON_CLIENT_TAGS) and the ad-placeholder regexes do NOT match it, so
// no ad note and no re-tap nudge are triggered by a third-party reel.
export const FLOORING_SHARE_NOTE_PREFIX = "[Client shared a post/reel about flooring";
export function flooringShareNote(share: FeedShare): string {
  const t = share.title.replace(/[\[\]"]/g, "").slice(0, 120).trim();
  return t ? `${FLOORING_SHARE_NOTE_PREFIX}: "${t}"]` : `${FLOORING_SHARE_NOTE_PREFIX}]`;
}
export function isFlooringShareNote(text: string): boolean {
  return (text ?? "").trim().startsWith(FLOORING_SHARE_NOTE_PREFIX);
}

// Pure verdict. `lookup` is the platform's answer for the share's media ids
// (null = nothing to ask / not asked).
export function judgeFeedShare(
  share: FeedShare | null,
  ctx: { hasText: boolean; hasPostback: boolean; hasReferral: boolean; lookup: MediaLookup | null }
): FeedShareVerdict {
  // The client typed something (or tapped an icebreaker): the words decide,
  // the attachment is only context. Unchanged flow.
  if (!share || ctx.hasText || ctx.hasPostback) return { kind: "none" };
  if (OUR_AD_CAPTION_RE.test(share.title)) return { kind: "ours", share, via: "caption" };
  if (ctx.lookup?.ours) return { kind: "ours", share, via: "platform" };
  // An ad click whose media we could not check (platform down, no token, no
  // media id) keeps the old benefit of the doubt. A referral the platform DID
  // answer "not ours" for is Messenger re-attaching the thread's original ad
  // referral to a forwarded meme: it proves nothing about this share.
  if (ctx.hasReferral && !ctx.lookup?.ok) return { kind: "ours", share, via: "unverifiable-ad-click" };
  if (FLOORING_CAPTION_RE.test(share.title)) return { kind: "flooring", share, note: flooringShareNote(share) };
  return { kind: "unrelated", share };
}

// Webhook entry point: reads the attachment (or the pasted link), asks the
// platform only when the caption did not already settle it, never throws.
// Words decide only when they carry client intent (CLIENT_INTENT_RE below): a
// pasted URL or a "lol" riding on the reel is not the client talking to us.
export async function classifyFeedShare(
  message: unknown,
  ctx: { hasText: boolean; hasPostback: boolean; hasReferral: boolean },
  consultar: (ids: string[]) => Promise<{ ok: boolean; resolvidas: Record<string, unknown> }>
): Promise<FeedShareVerdict> {
  const text = String((message as { text?: unknown } | null | undefined)?.text ?? "").trim();
  const typed = ctx.hasText && !!text && !isBareLink(text) && textCarriesClientIntent(text);
  if (ctx.hasPostback || typed) return { kind: "none" };
  const share = feedShareOf(message) ?? linkShareOf(text);
  if (!share) return { kind: "none" };
  // A pasted link is never an ad click, whatever referral the thread carries.
  const base = { hasText: false, hasPostback: false, hasReferral: share.type === "link" ? false : ctx.hasReferral };
  if (OUR_AD_CAPTION_RE.test(share.title)) return judgeFeedShare(share, { ...base, lookup: null });
  let lookup: MediaLookup | null = null;
  if (share.mediaIds.length) {
    try {
      const r = await consultar(share.mediaIds);
      lookup = { ok: r.ok, ours: share.mediaIds.some((id) => !!r.resolvidas?.[id]) };
    } catch {
      lookup = { ok: false, ours: false };
    }
  }
  return judgeFeedShare(share, { ...base, lookup });
}

// ─── A pasted link as the whole message, and the caption bubble (15/10/2026) ─
// Jesus Lizasuain (IG 1517409400191916) pasted 28 reel/story/YouTube links as
// plain text and got 28 "can't open that link, but check our floors at…"
// replies; across both channels 53 bare-link texts in 7 days → 53 replies and
// 0 visits. And the caption of a forwarded reel arrives as a SECOND bubble one
// or two seconds after the reel ("LIKE SHARE N COMMENT", "😂😂he's funny",
// "N", "CNN"), so the dropped reel was followed by the opener anyway.
// Rule: a message that is nothing but URL(s) is a feed share, judged like a
// forwarded reel (our site/ad → ad reply, flooring words in the URL → note,
// anything else → silence); words typed within SHARE_CAPTION_WINDOW_MS of a
// dropped share are its caption unless they carry client intent.
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;

export function isBareLink(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || !t.match(URL_RE)) return false;
  // Nothing but whitespace, punctuation and emoji may remain once the URLs go.
  return !/[a-z0-9à-ÿ]/i.test(t.replace(URL_RE, ""));
}

// The words hidden in the URLs (host, path, the target of a Facebook redirect
// l.facebook.com/l.php?u=…), separators turned into spaces, so the caption
// regexes can read "homedepot com p Lifeproof Vinyl Plank" or "ozzifloors".
function urlWords(urls: string[]): string {
  const parts: string[] = [];
  for (const raw of urls) {
    let u = raw;
    try {
      const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const target = parsed.searchParams.get("u");
      u = `${parsed.hostname}${parsed.pathname}${target ? " " + target : ""}`;
    } catch { /* keep the raw string */ }
    try { u = decodeURIComponent(u); } catch { /* keep as is */ }
    parts.push(u.replace(/https?:\/\//gi, " ").replace(/[\/\-_+.?=&%#:,]+/g, " "));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
}

export function linkShareOf(text: string): FeedShare | null {
  if (!isBareLink(text)) return null;
  const urls = (text ?? "").match(URL_RE) ?? [];
  const words = urlWords(urls);
  // Our own site pasted back to us is about us: let the ad-reply path answer.
  const title = /ozzi/i.test(words) ? `Ozzi floors link: ${words}` : words;
  return { type: "link", title, url: urls[0] ?? "", mediaIds: [] };
}

// What makes a few words a MESSAGE to a flooring company rather than the
// caption of a meme: a question, a number (zip, phone, sqft, time), a price,
// a flooring/service/money/visit word, a greeting, an answer ("ok", "yes",
// "Thursday 5pm works"), or a mention of us. Broad on purpose: a false
// positive is one more reply (the old behavior); a miss silences a lead.
// \b is ASCII in JS, so the word boundaries are accent-safe by hand.
const INTENT_WORDS = [
  // flooring, surfaces, services
  "floors?", "flooring", "pisos?", "suelos?", "vinyl", "vinilo", "vin[ií]lico", "tiles?", "porcelain", "porcelanato", "cer[aá]mic[ao]s?", "ceramic", "hardwood", "laminate", "laminado", "carpet", "carpete", "alfombra", "herringbone", "chevron", "lvp", "baseboards?", "rodap[ée]s?", "backsplash", "stairs?", "escaleras?", "escadas?", "subfloor", "planks?", "wood", "madera", "madeira",
  "install\\w*", "instala\\w*", "removal", "remove", "remo[çc][aã]o", "demolition", "demolici[oó]n", "demoli[çc][aã]o", "repairs?", "reparar", "reparaci[oó]n", "conserto",
  // money
  "quote", "quotes", "cotiza\\w*", "presupuesto", "or[çc]amento", "estimate", "estimates", "estimado", "estimativa", "price", "prices", "pricing", "precio", "precios", "pre[çc]o", "cost", "costs", "costo", "custo", "how much", "cu[aá]nto", "quanto", "promo", "promotion", "promoci[oó]n", "promo[çc][aã]o", "discount", "descuento", "desconto", "financ\\w*", "barato",
  // the job
  "sq\\.?\\s?ft", "sqft", "square", "pies", "metros", "m2", "rooms?", "kitchen", "bathroom", "bedroom", "living", "house", "home", "apartment", "apt", "condo", "garage", "casa", "cocina", "ba[ñn]o", "cuarto", "sala", "apartamento", "quarto", "cozinha", "banheiro",
  "address", "direcci[oó]n", "endere[çc]o", "zip", "zipcode", "schedule", "appointment", "visit", "visita", "cita", "agendar", "samples?", "muestras?", "amostras?", "measure", "medir", "medida",
  // intent and answers
  "interested", "interesad[oa]s?", "interessad[oa]s?", "need", "necesito", "necesitamos", "preciso", "want", "quiero", "queremos", "quero", "looking", "busco", "buscando", "procuro", "procurando", "info", "information", "informaci[oó]n", "informa[çc][aã]o", "details", "detalles", "detalhes",
  "can you", "could you", "do you", "will you", "pueden", "puedes", "podem", "pode", "fazem", "hacen", "hace", "faz",
  "call me", "call us", "ll[aá]mame", "ll[aá]menme", "llamar", "ligar", "ligue", "me liga", "text me", "mensaje", "mensagem", "contact", "contacto", "contato", "whatsapp", "phone", "tel[eé]fono", "telefone", "number", "n[uú]mero",
  "ozzi", "you guys", "your (?:ad|ads|company|team|floors?|promo|price|prices|work|service|services|post|page)", "ustedes", "voc[eê]s", "anuncio", "an[uú]ncio",
  "hi", "hey", "hello", "hola", "buenas", "buenos d[ií]as", "oi", "ol[aá]", "bom dia", "boa tarde", "boa noite", "good (?:morning|afternoon|evening)",
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "s[ií]", "sim", "claro", "dale", "perfect", "perfecto", "perfeito", "works", "sounds good",
  "today", "tomorrow", "hoy", "ma[ñn]ana", "hoje", "amanh[ãa]", "morning", "afternoon", "evening", "noon", "tarde", "noche", "noite", "weekend", "week", "semana",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "lunes", "martes", "mi[eé]rcoles", "jueves", "viernes", "s[aá]bado", "domingo", "segunda", "ter[çc]a", "quarta", "quinta", "sexta",
];
export const CLIENT_INTENT_RE = new RegExp(
  "\\?|\\$\\s?\\d|\\d{5,}|(?:\\d[\\s().-]*){7,}|\\d{1,2}:\\d{2}|\\d{1,2}\\s?(?:am|pm|hs?|hrs)(?![a-z])|(?:at|a las|[àa]s) \\d{1,2}(?![0-9])|(?<![a-zà-ÿ])(?:" + INTENT_WORDS.join("|") + ")(?![a-zà-ÿ])",
  "i"
);
export function textCarriesClientIntent(text: string): boolean {
  return CLIENT_INTENT_RE.test((text ?? "").split("\n\n[SYSTEM:")[0]);
}

// How long after a dropped share a wordless-intent bubble still counts as its
// caption. The caption lands 1-2s later; 3 min also covers "lol" typed after
// watching it again. Past that, words are judged on their own as before.
export const SHARE_CAPTION_WINDOW_MS = 3 * 60 * 1000;
export function isShareCaption(text: string, droppedAtMs: number | null, nowMs: number): boolean {
  if (droppedAtMs === null || !Number.isFinite(droppedAtMs)) return false;
  if (nowMs - droppedAtMs > SHARE_CAPTION_WINDOW_MS || nowMs < droppedAtMs - 60_000) return false;
  return !textCarriesClientIntent(text);
}
