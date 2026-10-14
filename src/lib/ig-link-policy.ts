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
// Policy (pure text helpers, no I/O — delivery.ts holds the marker, instagram.ts
// the send):
//   • a reply that fails with 508 goes out again WITHOUT the link, in the same
//     language, and the text that actually reached the client is what the
//     producers store (stored ≠ sent turns the IG echo into "[Treino]" +
//     mode=human, see stored-vs-sent rule);
//   • our site link becomes "our website (link in our bio)" — the bio is the
//     one place Instagram always lets us keep a link;
//   • any other link (financing, contract, review) is dropped and the reply
//     ends with "text me at (561) 674-8334 and I'll send it there", the same
//     owner line every handoff in this project uses.

export const IG_LINK_BLOCK_CODE = 508;

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

const SITE_TOKEN = "\u0001SITE\u0001";
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
  const t = (text || "").toLowerCase();
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
// Owner line, same number every handoff uses. No "¿" (Spanish rule 2026-08-28).
const OTHER_FALLBACK: Record<ReplyLang, string> = {
  en: "Instagram is blocking links on my end right now, so text me at (561) 674-8334 and I'll send it there.",
  es: "Instagram no me deja mandar links ahora mismo, escríbeme al (561) 674-8334 y te lo envío por ahí.",
  pt: "O Instagram não está deixando eu mandar link agora, me escreve no (561) 674-8334 que eu te mando por lá.",
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
  t = t.replace(URL_RE, (m) => {
    const core = m.replace(/[.,;:!?]+$/, "");
    const tail = m.slice(core.length);
    if (SITE_RE.test(core)) return SITE_TOKEN + tail;
    other++;
    return OTHER_TOKEN + tail;
  });

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

  t = tidy(t).replace(/\u0002(\d+)\u0002/g, (_, i) => emails[Number(i)] ?? "");
  return t;
}
