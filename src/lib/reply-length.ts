// ─── Reply length: short, human texts instead of a wall of text ─────────────
// Owner, 2026-09-21: "ela está com uma conversão muito baixa… deixa ela mais
// humanizada e faça ela colocar as respostas mais curtas, não ficar escrevendo
// textão." Measured on 14 days of production (2,514 model-written replies): the
// prompt already said "never 3 sentences", yet 24% of the replies had 3+
// sentences, 27% ran past 220 characters and 8% past 300 (the record was 851).
// The model obeys a length rule about as well as any other soft rule in an
// 89KB prompt, so the rule gets a deterministic net: a reply that comes back
// too long is rewritten ONCE by the same model with the same rules in front of
// it, and the rewrite only ships when every fact the rest of the pipeline reads
// (times, days, prices and what they cover, phone, links, tags, the pending
// question, the details request) survived. Anything else keeps the original,
// so the worst case is exactly what shipped before this file existed.
//
// Pure (no SDK, no I/O): the API call lives in ai.ts, the judgment lives here
// so the eval can hammer it offline.

/** What the prompt asks the model to aim for. */
export const REPLY_TARGET_CHARS = 160;
/** Above this the reply is rewritten shorter (once). */
export const REPLY_TIGHTEN_OVER = 220;
/** The rewrite must be at least this much shorter to be worth shipping. */
const MIN_SHRINK = 0.85;

// [BOOK:{...}] carries JSON with free text, so it is matched as a whole, exactly
// like PROTECTED_TAG in ai.ts. Any other [UPPER_CASE] token is an internal tag.
const BOOK_TAG = /\[BOOK:\s*\{[\s\S]*?\}\]/g;
const PLAIN_TAG = /\[[A-Z][A-Z_]{2,}\]/g;
const URL_RE = /https?:\/\/[^\s)]+/gi;

/** Characters the client actually reads: tags and links do not count. */
export function visibleLength(text: string): number {
  return (text || "").replace(BOOK_TAG, " ").replace(PLAIN_TAG, " ").replace(URL_RE, " ").replace(/\s+/g, " ").trim().length;
}

/**
 * True when the reply is long enough to be rewritten. A reply that books,
 * cancels or stays silent is never touched: the text in front of [BOOK] is
 * already capped at five words, and a rewrite must never sit between the model
 * and a booking.
 */
export function needsTightening(text: string): boolean {
  const t = text || "";
  if (/\[BOOK:|\[CANCEL_BOOKING\]|\[REACT_ONLY\]/i.test(t)) return false;
  return visibleLength(t) > REPLY_TIGHTEN_OVER;
}

/** The note the model gets right after its own draft. */
export function tightenInstruction(draftChars: number): string {
  return (
    `[SYSTEM: Your draft above is ${draftChars} characters, too long for a text message: the owner wants short replies because clients stop reading a long one and stop answering. ` +
    `Rewrite it as the message you will actually send: under ${REPLY_TARGET_CHARS} characters if you can, never over ${REPLY_TIGHTEN_OVER}, in short plain sentences (never one long sentence stuffed with commas). ` +
    "KEEP exactly as they are: the direct answer to what the client asked, every dollar amount together with what it covers (included material, or labor only and the client supplies it), every day and clock time you offered, any phone number, any link, any [TAG], the request for the address with the zip code and the phone if the draft asks for it, and the ONE question that moves the conversation forward. " +
    "DROP everything else: warm-up or empathy phrases, recaps of the offer, selling points already said earlier in this conversation, rates or facts the client did not ask about, a second question. " +
    "Do not add anything that is not in the draft. Same language as the draft, same rules as always (no dashes, no emojis, no inverted Spanish marks). " +
    "Output ONLY the rewritten message, with nothing before or after it.]"
  );
}

const deaccent = (s: string) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** "9am", "11:30 am", "5 p.m." → "9:00a"; "a las 5" / "às 17" → "5:00?". */
export function clockTokens(text: string): Set<string> {
  const out = new Set<string>();
  const raw = (text || "").toLowerCase().replace(/(\d)\s*:\s*(\d{2})/g, "$1:$2");
  for (const m of raw.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b\.?/g)) out.add(`${Number(m[1])}:${m[2] ?? "00"}${m[3]}`);
  // Bare Spanish / Portuguese hours. "às" keeps its accent on purpose: the
  // English "as 2 rooms" must never read as a clock time.
  for (const m of raw.matchAll(/(?:\ba\s+las?|(?:^|\s)às)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*[ap]\.?\s*m\b)/g)) out.add(`${Number(m[1])}:${m[2] ?? "00"}?`);
  if (/\bnoon\b|\bmediod[ií]a\b|\bmeio[\s-]?dia\b/.test(raw)) out.add("12:00p");
  return out;
}

const DAY_WORDS: Array<[RegExp, string]> = [
  [/\b(?:monday|lunes|segunda)\b/, "mon"], [/\b(?:tuesday|martes|terca)\b/, "tue"], [/\b(?:wednesday|miercoles|quarta)\b/, "wed"],
  [/\b(?:thursday|jueves|quinta)\b/, "thu"], [/\b(?:friday|viernes|sexta)\b/, "fri"], [/\b(?:saturday|sabado)\b/, "sat"],
  [/\b(?:sunday|domingo)\b/, "sun"], [/\b(?:today|tonight|hoy|hoje)\b/, "today"], [/\b(?:tomorrow|manana|amanha)\b/, "tomorrow"],
];
/** Weekdays and today / tomorrow named in the text (EN/ES/PT). */
export function dayTokens(text: string): Set<string> {
  const t = deaccent(text);
  const out = new Set<string>();
  for (const [re, key] of DAY_WORDS) if (re.test(t)) out.add(key);
  return out;
}

/** "$4.50", "$ 1,200" → "4.50", "1200". */
export function dollarTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text || "").matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) out.add(m[1].replace(/,/g, "").replace(/\.0+$/, ""));
  return out;
}

function phoneTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text || "").replace(BOOK_TAG, " ").matchAll(/(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g)) out.add(m[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""));
  return out;
}

function urlTokens(text: string): Set<string> {
  return new Set([...(text || "").matchAll(URL_RE)].map((m) => m[0].replace(/[.,;!?]+$/, "").toLowerCase()));
}

function tagTokens(text: string): string[] {
  return [...(text || "").matchAll(PLAIN_TAG)].map((m) => m[0]).sort();
}

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

// What a price covers. The owner's rules make this mandatory next to the price
// ("labor only, you supply the tile" / "includes the flooring"), so a rewrite
// that keeps the dollar figure and loses the clarifier is rejected. All of
// these run on de-accented lowercase text. "installation labor" alone is NOT
// labor-only: the vinyl promo "includes the flooring, the installation labor
// and the quarter round".
const LABOR_ONLY = /\blabor only\b|\bonly (?:the |for the )?(?:installation )?labor\b|\bfor the (?:installation )?labor\b|\bjust (?:the )?labor\b|\binstall(?:ation)? only\b|\byou (?:supply|provide|buy|bring)\b|\bclient (?:supplies|provides|buys)\b|\b(?:solo|solamente|so|apenas) (?:la |a )?mano de obra\b|\b(?:so|apenas) (?:a )?mao de obra\b|\b(?:tu|usted|voce) (?:pone|pones|trae|traes|compra|compras|fornece)\b/;
const INCLUDES = /\binclud|\bincluy|\binclui|\ball in\b|\btodo incluido\b|\btudo incluso\b/;
const ZIP_WORD = /\bzip\b|\bcodigo postal\b|\bcep\b/;
// Only the "approximate" that qualifies a PRICE counts: "cuantos pies cuadrados
// tiene aproximadamente?" is about the size (replay 2026-09-21, ab2dcacd).
const APPROX_PRICE = /(?:\bapprox\w*|\baproximad\w*)[^.!?]{0,50}\$|\$[^.!?]{0,50}(?:\bapprox\w*|\baproximad\w*)/;
const APPROX = /\bapprox|\baproximad/;
const FREE_WORD = /\bfree\b|\bgratis\b|\bgratuit|\bsin costo\b|\bsem custo\b/;
// A decline of the JOB or the AREA. "we only do the installation labor" and "we
// don't sell tile material" describe the offer, they decline nothing (replay
// 2026-09-21, e1f42680).
const DECLINE = /\bwe (?:don'?t|do not) (?:do|cover|service|serve|work|take|install in)\b|\bwe only (?:serve|cover|do (?:full|new))\b|\bunfortunately\b|\b(?:isn'?t|is not|not) something we\b|\boutside (?:our|of our|the) (?:area|range|service)\b|\bno (?:hacemos|cubrimos|trabajamos|atendemos)\b|\bfuera de nuestra\b|\bnao (?:fazemos|atendemos|trabalhamos|cobrimos)\b|\bfora da nossa\b/;
// A rewrite that talks ABOUT the rewrite instead of being the message.
const META = /^\s*(?:here(?:'s| is)|shorter|rewritten|rewrite|revised|draft|sure[,!]|okay[,!]|ok[,!]\s+here|aqui (?:esta|va|vai)|version corta|versao curta)\b|\bcharacters?\b|\bcaracteres\b|\bthe draft\b|\bmy draft\b/i;

export type TightenVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decides whether the shorter rewrite may replace the model's original reply.
 * Every check protects something a guard, a webhook or an owner rule reads in
 * the outbound text. `asksForDetails` is ai.ts' isAskingForBookingInfo, passed
 * in so this file stays free of the SDK import chain; `freeAlreadySaid` is true
 * when an earlier message of ours already told this client the visit is free.
 */
export function tightenedIsSafe(
  original: string,
  rewrite: string,
  opts: { asksForDetails?: (text: string) => boolean; freeAlreadySaid?: boolean; clientAskedPrice?: boolean } = {}
): TightenVerdict {
  const asksForDetails = opts.asksForDetails ?? (() => false);
  const o = original || "";
  const r = (rewrite || "").trim();
  if (!r) return { ok: false, reason: "empty rewrite" };
  const oLen = visibleLength(o);
  const rLen = visibleLength(r);
  if (rLen < 20) return { ok: false, reason: "rewrite too short to be a message" };
  if (rLen > oLen * MIN_SHRINK) return { ok: false, reason: `not shorter enough (${oLen} -> ${rLen})` };
  if (META.test(deaccent(r))) return { ok: false, reason: "rewrite talks about the rewrite" };
  if (/\[BOOK:|\[CANCEL_BOOKING\]|\[REACT_ONLY\]/i.test(r)) return { ok: false, reason: "rewrite introduced a booking / silence tag" };
  if (/[\u2012\u2013\u2014\u2015]| - /.test(r)) return { ok: false, reason: "dash in the rewrite" };
  if (tagTokens(o).join("|") !== tagTokens(r).join("|")) return { ok: false, reason: "tags changed" };

  // A draft past 400 characters is never a normal reply: it is a rate table, a
  // lecture, or the model thinking out loud (replay 2026-09-21, af2eb7cc: 737
  // characters listing every hour of the schedule). There the rewrite may DROP
  // times and days, it may never ADD one; a normal long reply keeps them all.
  const runaway = oLen > 400;
  const oClock = clockTokens(o);
  const rClock = clockTokens(r);
  if (runaway ? !subset(rClock, oClock) : !sameSet(oClock, rClock)) return { ok: false, reason: "clock times changed" };
  const oDays = dayTokens(o);
  const rDays = dayTokens(r);
  if (oClock.size > 0 && !runaway ? !sameSet(oDays, rDays) : !subset(rDays, oDays)) return { ok: false, reason: "days changed" };

  const oDollar = dollarTokens(o);
  const rDollar = dollarTokens(r);
  if (!subset(rDollar, oDollar)) return { ok: false, reason: "a dollar amount that was not in the original" };
  // ONE amount in the original is the answer itself ("vinyl" -> "$5 per sqft,
  // floor, labor and quarter round included"): it stays. A LIST of two or more
  // rates is the model reciting the price table, usually before it even knows
  // the flooring type (owner rule: no price before the type), so the rewrite
  // may drop the list, unless the client asked about price in this burst.
  if (rDollar.size === 0 && (oDollar.size === 1 || (oDollar.size > 1 && opts.clientAskedPrice))) return { ok: false, reason: "the price was dropped" };

  if (!sameSet(phoneTokens(o), phoneTokens(r))) return { ok: false, reason: "phone numbers changed" };
  if (!sameSet(urlTokens(o), urlTokens(r))) return { ok: false, reason: "links changed" };

  const od = deaccent(o);
  const rd = deaccent(r);
  if (rDollar.size > 0 && LABOR_ONLY.test(od) && !LABOR_ONLY.test(rd)) return { ok: false, reason: "price lost its labor-only clarifier" };
  if (rDollar.size > 0 && INCLUDES.test(od) && !LABOR_ONLY.test(od) && !INCLUDES.test(rd)) return { ok: false, reason: "price lost what it includes" };
  if (APPROX_PRICE.test(od) && rDollar.size > 0 && !APPROX.test(rd)) return { ok: false, reason: "approximate price lost the word approximate" };
  if (ZIP_WORD.test(od) && !ZIP_WORD.test(rd)) return { ok: false, reason: "zip code request dropped" };
  if (asksForDetails(o) && !asksForDetails(r)) return { ok: false, reason: "booking details request dropped" };
  if (DECLINE.test(od) && !DECLINE.test(rd)) return { ok: false, reason: "a decline stopped reading as a decline" };
  // "The visit is free" is the one selling point the FIRST proposal must keep;
  // once the client has read it, repeating it is exactly the padding we cut.
  if (oClock.size > 0 && !opts.freeAlreadySaid && FREE_WORD.test(od) && !FREE_WORD.test(rd)) return { ok: false, reason: "first visit proposal lost the word free" };
  if (/\?/.test(o) && !/\?/.test(r)) return { ok: false, reason: "the forward question was dropped" };
  return { ok: true };
}

const PRICE_ASK = /\bhow much\b|\bprices?\b|\bpricing\b|\bcosts?\b|\bquote\b|\bestimate\b|\brates?\b|\bper sq|\bcheap|\bcuanto\b|\bprecios?\b|\bcuesta\b|\bcosto\b|\bpresupuesto\b|\bcotiza|\bquanto\b|\bprecos?\b|\bcusta\b|\bvalor\b|\borcamento\b|\$/;
/** True when the client's un-answered burst asks about price. */
export function clientAskedPrice(history: Array<{ role: string; content: string }>): boolean {
  const h = history ?? [];
  let burst = "";
  for (let i = h.length - 1; i >= 0 && h[i].role === "user"; i--) burst = (h[i].content || "").split(/\n\n?\[SYSTEM:/)[0] + "\n" + burst;
  return PRICE_ASK.test(deaccent(burst));
}

/** True when an earlier message of ours already said the visit / estimate is free. */
export function freeAlreadySaid(history: Array<{ role: string; content: string }>): boolean {
  return (history ?? []).some((m) => m.role === "assistant" && FREE_WORD.test(deaccent(m.content)));
}
