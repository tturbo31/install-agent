// ─── Instagram link-sharing restriction (Graph error 508) ───────────────────
// 2026-10-14 23:00 UTC: the reply "We actually do have a website at
// https://ozzifloors.company, but thanks for reaching out" came back from
// graph.instagram.com/me/messages as {code: 508, message: "Invalid message id"}
// (subcode 2534122). In the same 48h, 215 link-free Instagram replies delivered
// normally, two replies WITH the link delivered on 10/13, and the token checked
// out valid on /me — so this is not the token and not the channel. The message
// text is misleading: 508 is Instagram refusing to deliver a LINK from this
// account (a temporary "link sharing" restriction the account gets after many
// link DMs or a Community Standards flag; it shows in the Instagram app under
// Settings > Account status > Features you can't use, and usually lifts within
// 1-3 days once the link volume drops). The owner alert told him to mint a new
// token; he did, nothing changed, and the client stayed mute.
//
// OWNER RULE 2026-10-17 — INSTAGRAM NEVER CARRIES A LINK. What started as the
// fallback for the 508 block is now the Instagram policy itself: the bot sends
// NO link of any kind on Instagram Direct (Messenger and WhatsApp unchanged).
// When the client asks about the floors we have, the answer is our website,
// "the link is in our bio"; when the client wants to talk about financing, the
// answer is Ozzi's number, (561) 674-8334 (no application link, no details).
//
// Policy (pure text helpers, no I/O — instagram.ts applies it on EVERY send,
// the IG webhook puts IG_CHANNEL_NOTE in the model's context so the reply is
// written that way in the first place, and delivery.ts keeps the 508 marker as
// a record):
//   • every link in an Instagram reply is neutralized before the send, and the
//     text that actually reached the client is what the producers store
//     (stored ≠ sent turns the IG echo into "[Treino]" + mode=human, see the
//     stored-vs-sent rule);
//   • our site link becomes "our website (link in our bio)" — the bio is the
//     one place Instagram always lets us keep a link;
//   • a financing link (Hearth) takes its whole sentence with it and the reply
//     ends with "for financing, call or text Ozzi at (561) 674-8334";
//   • any other link (contract, review) is dropped and the reply ends with
//     "text Ozzi at (561) 674-8334 and he'll send it to you".
//   • the panel (the owner typing by hand) may keep its links: the rule is
//     about the AI, and the 508 fallback still covers that path.

export const IG_LINK_BLOCK_CODE = 508;

// The channel note the Instagram webhook appends to the client's last message
// (same mechanism as [WHATSAPP CHANNEL]). The stable prompt holds the matching
// INSTAGRAM exceptions (STEP 2 and FINANCING) keyed on this exact tag.
export const IG_CHANNEL_TAG = "[INSTAGRAM CHANNEL";
export const IG_CHANNEL_NOTE =
  "[INSTAGRAM CHANNEL: You are chatting on Instagram Direct. NEVER write any link or URL here, not our website address, not the financing application, nothing (owner rule 2026-10-17). When the client asks about the floors we have, our colors, styles, samples, photos, a catalog or our website, tell them our floors are on our website and the link is in our bio, in their language, and keep the rest of the normal answer (samples at the free visit, the next step). When the client asks about financing, payment plans or paying monthly, say we do offer financing through our partner and that for the financing they should call or text Ozzi directly at (561) 674-8334, never explain the application and never send a link, then continue the normal flow in the same message.]";

export function isInstagramChannel(messages: Array<{ role: string; content: string }>): boolean {
  return (messages ?? []).some((m) => m.role === "user" && (m.content || "").includes(IG_CHANNEL_TAG));
}

export type ReplyLang = "en" | "es" | "pt";

// Graph answers a blocked link with code 508 and the misleading text
// "Invalid message id". Only the code is trusted — the text has nothing to do
// with links and Meta may change it.
export function isIgLinkBlockError(code: number | undefined | null): boolean {
  return code === IG_LINK_BLOCK_CODE;
}

// Emails must never be read as links ("ozzifloors@gmail.com" ends in a domain).
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Explicit URLs, plus bare domains on the TLDs we actually send (Instagram
// linkifies "ozzifloors.company" on its own, so a bare domain is a link too).
// The lookbehind keeps "@gmail.com" tails and path fragments out.
const URL_RE =
  /(?:https?:\/\/|www\.)[^\s<>"'()]+|(?<![\w@./-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|company|net|org|app|co|io|us|info|biz|site|online|shop)(?:\/[^\s<>"'()]*)?(?![\w@])/gi;
const SITE_RE = /ozzifloors\.(?:company|com)/i;
// Financing application (Hearth), including the misspellings the model once
// produced ("gerhearth", "gohearth" — quote-followup.ts canonicalizes them).
const FINANCING_LINK_RE = /g\w*hearth\.com/i;

const SITE_TOKEN = "\u0001SITE\u0001";
const FIN_TOKEN = "\u0001FIN\u0001";
const OTHER_TOKEN = "\u0001LINK\u0001";

function withoutEmails(text: string): string {
  return text.replace(EMAIL_RE, " ");
}

export function containsLink(text: string): boolean {
  URL_RE.lastIndex = 0;
  return URL_RE.test(withoutEmails(text || ""));
}

// Language of the reply itself (the send has no conversation context). Scored
// on words that only one of the three languages uses; ties fall to English.
// \b is ASCII-only in JS, so accented words are bounded by hand.
function count(t: string, words: string[]): number {
  let n = 0;
  for (const w of words) if (new RegExp(`(?:^|[^a-zà-ÿ])${w}(?=$|[^a-zà-ÿ])`).test(t)) n++;
  return n;
}
export function replyLang(text: string): ReplyLang {
  // Links and emails are scored out: "gethearth.com" read as the Portuguese
  // "com" and a URL-only reply came back in Portuguese.
  URL_RE.lastIndex = 0;
  const t = withoutEmails(text || "").replace(URL_RE, " ").toLowerCase();
  const pt = count(t, ["você", "voce", "não", "nao", "nosso", "nossa", "nossos", "nossas", "obrigado", "obrigada", "também", "tambem", "orçamento", "orcamento", "em", "com", "é", "amostras", "pra", "seu", "sua", "eu"]);
  const es = count(t, ["puedes", "puede", "nuestro", "nuestra", "nuestros", "nuestras", "gracias", "también", "tambien", "presupuesto", "aquí", "en", "con", "es", "usted", "muestras", "página", "pagina", "sitio", "te", "lo", "los", "las"]);
  const en = count(t, ["you", "our", "the", "website", "visit", "free", "samples", "floors", "can", "and", "at", "here", "link", "we", "is"]);
  if (pt > es && pt > en) return "pt";
  if (es > en) return "es";
  return "en";
}

const SITE_PHRASE: Record<ReplyLang, string> = {
  en: "our website (link in our bio)",
  es: "nuestra página web (el link está en nuestra bio)",
  pt: "nosso site (o link está na nossa bio)",
};
const SITE_WITH_PREP: Record<ReplyLang, string> = {
  en: "on our website (link in our bio)",
  es: "en nuestra página web (el link está en nuestra bio)",
  pt: "no nosso site (o link está na nossa bio)",
};
const BIO_TAIL: Record<ReplyLang, string> = {
  en: "(link in our bio)",
  es: "(el link está en nuestra bio)",
  pt: "(o link está na nossa bio)",
};
// Owner lines, same number every handoff uses. No "¿" (Spanish rule 2026-08-28).
// Financing on Instagram = talk to Ozzi (owner rule 2026-10-17), never the
// application link, never the details.
export const IG_FINANCING_LINE: Record<ReplyLang, string> = {
  en: "For financing, just call or text Ozzi at (561) 674-8334.",
  es: "Para el financiamiento, llama o escríbele a Ozzi al (561) 674-8334.",
  pt: "Para o financiamento, é só ligar ou mandar mensagem pro Ozzi no (561) 674-8334.",
};
const OTHER_FALLBACK: Record<ReplyLang, string> = {
  en: "Text Ozzi at (561) 674-8334 and he'll send it to you.",
  es: "Escríbele a Ozzi al (561) 674-8334 y él te lo manda.",
  pt: "Manda mensagem pro Ozzi no (561) 674-8334 que ele te envia.",
};

function tidy(text: string): string {
  return text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/:\s*([.,;!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function endsSentence(text: string): string {
  const t = text.replace(/[\s:,;-]+$/, "");
  if (!t) return "";
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

// The same reply with every link neutralized so Instagram will deliver it.
// Returns the input unchanged when it carries no link.
export function neutralizeLinks(text: string, lang?: ReplyLang): string {
  const original = text || "";
  if (!containsLink(original)) return original;
  const L = lang ?? replyLang(original);

  // Protect emails, tokenize links (trailing punctuation stays in the sentence).
  const emails: string[] = [];
  let t = original.replace(EMAIL_RE, (m) => {
    emails.push(m);
    return `\u0002${emails.length - 1}\u0002`;
  });
  let other = 0;
  let financing = 0;
  t = t.replace(URL_RE, (m) => {
    const core = m.replace(/[.,;:!?]+$/, "");
    const tail = m.slice(core.length);
    if (SITE_RE.test(core)) return SITE_TOKEN + tail;
    if (FINANCING_LINK_RE.test(core)) {
      financing++;
      return FIN_TOKEN + tail;
    }
    other++;
    return OTHER_TOKEN + tail;
  });

  // ── Financing link: the whole sentence that carried it goes ("You can apply
  // for financing here: URL" says nothing without the link) and the reply ends
  // with Ozzi's number for the financing (owner rule 2026-10-17).
  if (financing > 0) {
    t = t.replace(/[^.!?\n]*\u0001FIN\u0001[^.!?\n]*[.!?]*[ \t]*/g, " ");
  }

  // ── Our site: "website at URL" → "website (link in our bio)", "at URL" →
  // "on our website (link in our bio)", anything else → "our website (…)".
  const S = SITE_TOKEN;
  if (L === "es") {
    t = t.replace(/\b(página web|pagina web|sitio web|sitio|página|pagina|web)\s*(?:en|es|:)?\s*\u0001SITE\u0001/gi, `$1 ${BIO_TAIL.es}`);
    t = t.replace(/\ben\s+\u0001SITE\u0001/gi, SITE_WITH_PREP.es);
    t = t.replace(/(?:^|[^a-zà-ÿ])(?:aquí|aqui)[:\s]*\u0001SITE\u0001/gi, (m) => `${m.startsWith(S) ? "" : m[0]}${SITE_WITH_PREP.es}`);
  } else if (L === "pt") {
    t = t.replace(/\b(site)\s*(?:em|é|e|:)?\s*\u0001SITE\u0001/gi, `$1 ${BIO_TAIL.pt}`);
    t = t.replace(/\b(?:em|no)\s+\u0001SITE\u0001/gi, SITE_WITH_PREP.pt);
    t = t.replace(/\baqui[:\s]*\u0001SITE\u0001/gi, SITE_WITH_PREP.pt);
  } else {
    t = t.replace(/\b(website|site)\s*(?:at|is|:)?\s*\u0001SITE\u0001/gi, `$1 ${BIO_TAIL.en}`);
    t = t.replace(/\b(?:at|on|in)\s+\u0001SITE\u0001/gi, SITE_WITH_PREP.en);
    t = t.replace(/\bhere[:\s]*\u0001SITE\u0001/gi, SITE_WITH_PREP.en);
  }
  t = t.split(S).join(SITE_PHRASE[L]);

  // ── Any other link: drop it with its lead-in word and close with the owner
  // line, so the client still has a way to get it.
  if (other > 0) {
    t = t.replace(/\s*(?:\b(?:here|at|on|is|link|aquí|aqui|en|em|no|es|é)\b)?:?\s*\u0001LINK\u0001/gi, "");
    t = `${endsSentence(tidy(t))} ${OTHER_FALLBACK[L]}`.trim();
  }
  if (financing > 0 && !OZZI_NUMBER_RE.test(t)) {
    t = withLineBeforeClosingQuestion(tidy(t), IG_FINANCING_LINE[L]);
  }

  t = tidy(t).replace(/\u0002(\d+)\u0002/g, (_, i) => emails[Number(i)] ?? "");
  return t;
}

// Puts `line` ahead of the closing question (even when the question is all
// that is left), so the reply still ends asking it; a reply without a closing
// question just gets the line at the end.
function withLineBeforeClosingQuestion(prose: string, line: string): string {
  const p = (prose || "").trim();
  if (!p) return line;
  const sentences = p.match(/[^.!?\n]+(?:[.!?]+|$)\s*/g) ?? [p];
  const last = sentences.length - 1;
  if (/\?\s*$/.test(sentences[last])) {
    return `${sentences.slice(0, last).join("").trimEnd()} ${line} ${sentences[last].trim()}`.trim();
  }
  return `${endsSentence(p)} ${line}`;
}

// ─── Financing on Instagram → Ozzi's number (owner rule 2026-10-17) ─────────
// The prompt (FINANCING, INSTAGRAM EXCEPTION) and IG_CHANNEL_NOTE tell the
// model; this is the deterministic backstop the IG webhook runs on the final
// reply: the client's unanswered burst asked about financing and the reply
// carries no Ozzi number → the financing line goes in ahead of the closing
// question, so the reply still ends asking it.

export const OZZI_NUMBER_RE = /\(?\s*561\s*\)?[\s.-]*674[\s.-]*8334/;

// "the link is in our bio" in any of the three languages — a reply that already
// says it has "the website" for the purposes of the site backstops in ai.ts.
export function mentionsBioLink(text: string): boolean {
  const t = (text || "").toLowerCase();
  return /(?:link|enlace)[^.!?\n]{0,40}(?<![a-zà-ÿ])bio(?![a-zà-ÿ])|(?<![a-zà-ÿ])bio(?![a-zà-ÿ])[^.!?\n]{0,20}(?:link|enlace)/.test(t);
}

// Client intent: financing, a payment plan, paying monthly / in installments.
// "credit card", "pay by check" and plain "payment" are NOT financing. \b is
// ASCII-only in JS, so accented words are bounded by hand.
const FINANCING_ASK =
  /(?<![a-zà-ÿ])(?:financ[a-zà-ÿ]*|payment\s+plans?|pay(?:ing|ment)?\s+(?:it\s+)?(?:monthly|in\s+installments|in\s+payments|over\s+time)|monthly\s+payments?|installments?|(?:a\s+)?plazos|cuotas|mensualidad(?:es)?|pagar\s+(?:mensual|por\s+mes|a\s+plazos|en\s+cuotas|parcelado)|parcel[a-zà-ÿ]*|(?<!tarjeta\s+de\s+)(?<!cart[aã]o\s+de\s+)cr[eé]dito(?!\s+card)|hearth|affirm|klarna)(?![a-zà-ÿ])/i;
const NOT_FINANCING = /(?<![a-zà-ÿ])(?:credit\s+cards?|tarjetas?\s+de\s+cr[eé]dito|cart[aã]o\s+de\s+cr[eé]dito)(?![a-zà-ÿ])/i;
export function asksAboutFinancing(clientText: string): boolean {
  const t = (clientText || "").split(/\n\n?\[SYSTEM:/)[0];
  if (!t.trim()) return false;
  const cleaned = t.replace(NOT_FINANCING, " ");
  return FINANCING_ASK.test(cleaned);
}

// `clientText` is the client's unanswered burst (unansweredUserBurst in ai.ts,
// [SYSTEM:] notes already split off). Returns the reply unchanged when the client did not ask about financing or
// the reply already carries Ozzi's number. Trailing tags ([NOTIFY_OWNER],
// [BOOK:...]) stay last; a tag-only reply (deliberate silence) is untouched.
export function ensureIgFinancingHandoff(reply: string, clientText: string, lang: ReplyLang): string {
  const original = reply || "";
  if (!asksAboutFinancing(clientText)) return original;
  if (OZZI_NUMBER_RE.test(original)) return original;
  const tailMatch = original.match(/(?:\s*\[[^\]]*\])+\s*$/);
  const tail = tailMatch ? tailMatch[0] : "";
  const prose = original.slice(0, original.length - tail.length).trim();
  if (!prose) return original;
  const out = withLineBeforeClosingQuestion(prose, IG_FINANCING_LINE[lang] ?? IG_FINANCING_LINE.en);
  return (tidy(out) + (tail ? " " + tail.trim() : "")).trim();
}
