// ─── Reasoning-leak net: shape detection + salvage (pure, SDK-free) ─────────
// WHY THIS FILE EXISTS (Julie, WhatsApp 2026-09-21 09:04 ET): the client asked
// "Do you have Wed at 6:00 pm or 7:00pm Or Thursday or Friday" and received
// 1,245 characters of the model arguing with the schedule note: "Wednesday has
// 7pm in parenthesis (open if asked), so I can accept it… Since the client
// specifically asked… Actually let me re-read… I'll keep it simple… Let me offer
// Wednesday 7pm or Thursday 6pm… Then ask for the address. Wednesday at 7pm or
// Thursday at 6pm, which works better for you? And what's the full property
// address with the zip code so I can hold it?"
//
// It was the 7th monologue shipped in 35 days (13,714 replies). Each earlier one
// was answered with new PHRASES in the sentence blacklist of ai.ts
// (REASONING_LEAK_SENTENCE), and each new leak simply used new words: run over
// the Julie text, the blacklist as deployed that same afternoon still let 11 of
// the 16 monologue sentences through. Two structural defects, both fixed here:
//
// 1. DETECTION BY PHRASE. A monologue is recognisable by its SHAPE, whatever
//    the words: it talks ABOUT the client in the third person ("the client
//    specifically asked", "they also asked", "their address"), it quotes the
//    plumbing a client never sees ("in parenthesis", "open if asked", "per rule
//    35", "the schedule shows") and it gives itself orders ("let me re-read",
//    "I'll keep it simple", "Then ask for the address").
// 2. FAIL OPEN. With the monologue sentences removed one by one, whatever sat
//    between them survived ("So Thursday 6pm and 7pm are both open."), and when
//    too little survived the ORIGINAL text shipped. A monologue is never the
//    right thing to fail open to.
//
// THE SALVAGE RULE comes from reading all seven: the model plans, second-guesses
// and then WRITES THE REAL REPLY LAST. So when a reply is a heavy leak (two or
// more monologue sentences, or a monologue that is most of the text), the whole
// span from the first to the last monologue sentence goes, not just the
// sentences that matched. A light leak (one stray sentence in a real reply)
// just loses that sentence, as before. And whenever the draft is not trustworthy as a whole (heavy, a
// self-correction such as "Wait, I already have your name", a draft followed by
// its re-draft, or nothing clean left) the caller REGENERATES the turn, keeps
// the salvage as the fallback, and if neither is clean the turn goes to the
// owner ([NOTIFY_OWNER]) instead of to the client. Every signal below was run
// against the 13,714 real replies of the last 35 days: it fires on the leaks and
// on nothing else (scripts/tmp-leak-corpus-2109.mts).

// Sentence split that never breaks inside a decimal price ("$4.50").
export function splitSentences(prose: string): string[] {
  return prose.match(/(?:[^.!?\n]|\.(?=\d))+[.!?]*\s*/g) ?? [prose];
}

// The material-supply sentences are the one client-facing place where "the
// client" is normal English/Spanish ("tile is labor only, the client buys the
// material"): never a leak.
const SUPPLY_VERBS_EN = "(?:buys?|provides?|suppl(?:y|ies)|purchases?|handles?|takes?\\s+care|gets?|brings?|pays?|covers?|is\\s+responsible|picks?\\s+(?:out|up)|chooses?\\s+(?:the|their|his|her))";
const SUPPLY_VERBS_ES = "(?:compra|pone|provee|suministra|paga|consigue|trae|aporta|se\\s+encarga|elige\\s+(?:el|su))";
const SUPPLY_VERBS_PT = "(?:compra|fornece|paga|traz|providencia|escolhe\\s+(?:o|seu)|fica\\s+respons[aá]vel)";

// Talks ABOUT the client instead of TO the client. Skipped when the person we
// are talking to brought a third party into the chat themselves (a realtor or a
// contractor writing about "my client": "when can the client be home?" is then
// a real question). A bare "since they" is NOT here: "the tiles, since they are
// in good shape" and "landings, since they vary in size" are real replies.
const THIRD_PERSON = new RegExp(
  [
    `\\bthe\\s+client(?:'s)?\\b(?!\\s+${SUPPLY_VERBS_EN}\\b)`,
    `\\bel\\s+cliente\\b(?!\\s+${SUPPLY_VERBS_ES}(?![a-zà-ÿ]))`,
    `\\bo\\s+cliente\\b(?!\\s+${SUPPLY_VERBS_PT}(?![a-zà-ÿ]))`,
    /\bthey\s+(?:also\s+|already\s+|just\s+|specifically\s+|only\s+|never\s+)?(?:asked|said|want|wanted|sent|gave|picked|chose|mentioned|replied|answered|haven'?t|didn'?t)\b/.source,
    /\btheir\s+(?:request|message|question|reply|answer|name|address|phone|number|zip)\b/.source,
    /\bi\s+(?:still\s+)?need\s+their\b|\bget\s+their\b/.source,
  ].join("|"),
  "i"
);

// The plumbing: words that exist only in the notes the model reads.
const INTERNAL_VOCAB = new RegExp(
  [
    /parenthes[ei]s|par[eé]ntesis|par[eê]nteses?/.source,
    /\bif\s+asked\b|\bopen\s+only\s+if\b/.source,
    /\b(?:the\s+)?schedule\s+(?:shows|says|lists|line|note|block)\b/.source,
    /\b(?:per|under|by|following|despite)\s+(?:the\s+)?rule\s+\d/.source,
    /\brule\s+\d{1,2}[a-z]?\b/.source,
    /\bsystem\s+(?:note|prompt|message|context)\b/.source,
    /\bfinal\s+reminders?\b/.source,
    /\bthe\s+(?:prompt|instructions?)\s+(?:says?|tells?|states?)\b/.source,
    /\bdifferently[-\s]worded\b/.source,
  ].join("|"),
  "i"
);

// The model giving itself orders or grading its own draft.
const SELF_TALK = new RegExp(
  [
    /\blet\s+me\s+(?:re-?read|re-?check|redo|recalculate|reconsider|think|look\s+again)\b/.source,
    /\blet\s+me\s+offer\b/.source,
    /\blet\s+me\s+ask\s+(?:for|which|about|them)\b/.source,
    /\bi\s+need\s+to\s+ask\s+(?:which|for|about|them)\b/.source,
    /\bi(?:'ll|\s+will)\s+keep\s+(?:it|this)\s+(?:simple|short|brief)\b/.source,
    /\bi\s+can\s+accept\s+(?:it|that|those|them|this)\b/.source,
    /\bactually,?\s+(?:let\s+me|they|the\s+client)\b/.source,
    /(?:^|[.!?]\s+)then\s+ask\s+(?:for|about|which|them)\b/.source,
    /\bthe\s+soonest\s+match\b/.source,
    /\bclearest\s+options?\b/.source,
    /\bmatching\s+their\b/.source,
    /\bi(?:'ll|\s+will)\s+give\s+a\s+(?:brief|short|quick)\b/.source,
    /\bd[eé]jame\s+(?:releer|repensar)\b|\bdeixa\s+eu\s+(?:reler|repensar)\b/.source,
  ].join("|"),
  "i"
);

// The model correcting ITSELF mid-reply. What stands before the marker is the
// draft it just abandoned (a wrong link, a data re-ask it then takes back, six
// times instead of two), so the reply as a whole is not trustworthy: the caller
// regenerates instead of shipping the patchwork.
const SELF_CORRECTION = /(?:^|[\s,.!?])(?:wait|hmm+|actually),?\s+(?:let\s+me|i\s|we\s|that|no\b)|\blet\s+me\s+(?:redo|re-?read|re-?check|recalculate|reconsider|start\s+over|try\s+(?:this|that)\s+again|fix\s+that|give\s+(?:you\s+)?(?:the\s+)?(?:right|correct|two\s+clean))\b|\bscratch\s+that\b|\bespera,?\s+d[eé]jame\b|\bd[eé]jame\s+(?:recalcular|rehacer|corregir)\b/i;

// "…those same hours, actually, let me give you two clean options: Tuesday at
// 9am or 11am, which works?" (868bf420, IG 2026-08-19): the marker and what
// follows the colon share ONE sentence. The part after the colon is the
// corrected text and is judged on its own; the part before it is the draft.
const CORRECTION_COLON = /^([\s\S]*?\b(?:(?:actually|wait|hmm+),?\s+)?(?:let\s+me\s+[^:.!?\n]{0,70}|i(?:'ll|\s+will)\s+keep\s+(?:it|this)\s+(?:simple|short|brief)\s*)):\s*(\S[\s\S]*)$/i;

export type LeakOptions = {
  // The client brought a third party into the chat ("my client", "the
  // tenant"): third-person talk is then not a signal.
  thirdPartyContext?: boolean;
};

// Which shape signal a sentence trips, or null. The name goes to the log.
export function monologueSignal(sentence: string, opts: LeakOptions = {}): string | null {
  if (INTERNAL_VOCAB.test(sentence)) return "internal-vocabulary";
  if (SELF_TALK.test(sentence)) return "self-talk";
  if (!opts.thirdPartyContext && THIRD_PERSON.test(sentence)) return "third-person";
  return null;
}

export function hasSelfCorrection(text: string): boolean {
  return SELF_CORRECTION.test(text || "");
}

// The person we talk to is writing about someone else (a realtor or contractor
// about "my client", anyone about a husband, a landlord, the HOA): "the client"
// / "they said" is then ordinary conversation, and only the other two signals
// and the phrase list of ai.ts judge the reply.
export function mentionsThirdParty(clientText: string): boolean {
  return /\b(?:my|our|a|the)\s+(?:clients?|customers?|tenants?|landlord|buyers?|sellers?|owners?|husband|wife|spouse|partner|fianc[eé]e?|boyfriend|girlfriend|mom|mother|dad|father|parents|son|daughter|brother|sister|boss|contractor|designer|realtor|agent|property\s+manager|hoa|association|condo\s+board)\b|\bmis?\s+(?:clientes?|inquilinos?|espos[oa]|marido|mujer|pareja|novi[oa]|mam[aá]|pap[aá]|padres|hij[oa]s?|herman[oa]|jefe)(?![a-zà-ÿ])|\bmeus?\s+(?:clientes?|inquilinos?|marido|esposo|pais?|filh[oa]s?|irm[ãa]o?|chefe|namorad[oa])(?![a-zà-ÿ])|\bminha\s+(?:esposa|mulher|m[ãa]e|filha|irm[ãa]|chefe|namorada)(?![a-zà-ÿ])|\b(?:el|la)\s+(?:due[ñn][oa]|propietari[oa]|inquilin[oa]|administraci[oó]n|asociaci[oó]n)(?![a-zà-ÿ])|\b[oa]\s+(?:propriet[aá]ri[oa]|inquilin[oa]|s[ií]ndic[oa]|condom[ií]nio)(?![a-zà-ÿ])/i.test(clientText || "");
}

// Same floor the scrubber always had: under 20 characters is a fragment.
const substance = (s: string) => s.replace(/\[[^\]]*\]/g, "").trim().length;

export type Salvage = {
  text: string;          // the best text the draft yields ("" when nothing clean survived)
  removed: number;       // monologue sentences found
  mode: "clean" | "light" | "heavy" | "unsalvageable";
  signals: string[];
  // The draft as a whole is not trustworthy: regenerate, keep `text` as the fallback.
  regenerate: boolean;
};

// `isLeak` is the sentence judge (the phrase blacklist of ai.ts OR a shape
// signal). Tag placeholders ([#TAG0#], see withTagsProtected) never get lost:
// a [BOOK] that sat in a dropped part of the text rides along on the result.
// `strict` is the same judge with every signal on: once a reply is known to be
// a heavy monologue, third-person talk inside it is monologue too, even in a
// chat where the client brought up a husband or a tenant.
export function salvageFromLeak(prose: string, isLeak: (sentence: string) => string | null, strict: (sentence: string) => string | null = isLeak): Salvage {
  // A self-correction with a colon is split in two, so the corrected half can
  // survive while the abandoned half goes.
  const parts = splitSentences(prose).flatMap((s) => {
    const m = CORRECTION_COLON.exec(s);
    if (!m || !isLeak(m[1])) return [s];
    const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    return [m[1] + ": ", rest];
  });
  const verdicts = parts.map((s) => isLeak(s));
  const flagged = verdicts.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const redraft = hasRedraftedOffer(prose);
  if (flagged.length === 0) {
    if (!redraft) return { text: prose, removed: 0, mode: "clean", signals: [], regenerate: false };
    // A draft and its re-draft with no known monologue word between them: the
    // fallback keeps the text from the LAST version of the offer onwards.
    const at = lastRedraftIndex(parts);
    const tags = (prose.match(/\[#TAG\d+#\]/g) ?? []).join("");
    const latest = parts.slice(at).join("").trim();
    return { text: latest + tags.replace(/\[#TAG\d+#\]/g, (t) => (latest.includes(t) ? "" : t)), removed: 0, mode: "light", signals: ["redrafted-offer"], regenerate: !tags };
  }
  const signals = [...new Set(verdicts.filter((v): v is string => !!v))];
  const total = parts.join("").length || 1;
  const flaggedChars = flagged.reduce((n, i) => n + parts[i].length, 0);
  const heavy = flagged.length >= 2 || flaggedChars / total >= 0.4;
  const corrected = flagged.some((i) => hasSelfCorrection(parts[i]));

  const hasTag = (s: string) => /\[#TAG\d+#\]/.test(s);
  const keepTags = (result: string) => {
    let out = result;
    for (const tag of prose.match(/\[#TAG\d+#\]/g) ?? []) if (!out.includes(tag)) out += tag;
    return out.replace(/[ \t]{2,}/g, " ").trim();
  };
  // A reply that carries a tag and no clean sentence ships the tag alone: the
  // webhook writes the confirmation of a [BOOK] / [CANCEL_BOOKING] itself and a
  // bare [NOTIFY_OWNER] alerts the owner. The visit is never lost to a leak.
  const tagsOnly = (prose.match(/\[#TAG\d+#\]/g) ?? []).join("");
  // A turn that carries a tag is never regenerated: the second sample may not
  // write the [BOOK] again, and the visit matters more than the wording.
  const done = (text: string, mode: Salvage["mode"], regenerate: boolean): Salvage => ({ text, removed: flagged.length, mode, signals, regenerate: regenerate && !tagsOnly });

  if (!heavy) {
    const kept = parts.filter((_, i) => !flagged.includes(i)).join("");
    if (substance(kept) >= 20 || hasTag(kept)) return done(keepTags(kept), "light", corrected || redraft);
    return done("", "unsalvageable", true);
  }
  // Heavy: the whole span from the first to the last monologue sentence goes,
  // with whatever sat between them ("So Thursday 6pm and 7pm are both open.").
  // The real reply is what the model wrote AFTER it stopped thinking. What it
  // wrote BEFORE it started survives too, unless the span holds a "Wait, …":
  // then the head is the draft the model abandoned ("Which time works better,
  // 11am or 2pm? Wait, I notice… Which one works for you, the 11am or the
  // 2pm?", Keky), and only the tail is the reply.
  const span = parts.map((s, i) => (strict(s) ? i : -1)).filter((i) => i >= 0);
  const first = span[0];
  const last = span[span.length - 1];
  const head = parts.slice(0, first).join("");
  const tail = parts.slice(last + 1).join("");
  const abandonedHead = parts.slice(first, last + 1).some((s) => hasSelfCorrection(s));
  const ok = (s: string) => substance(s) >= 20 || hasTag(s);
  const kept = abandonedHead ? tail : head + tail;
  if (ok(kept)) return done(keepTags(kept), "heavy", true);
  // Nothing after the monologue: the reply came first and the second-guessing
  // trailed it ("All set![BOOK] Wait, let me re-check the date…").
  if (abandonedHead && ok(head)) return done(keepTags(head), "heavy", true);
  if (tagsOnly) return done(tagsOnly, "heavy", false);
  return done("", "unsalvageable", true);
}

// Two QUESTIONS in one reply offering the same clock times = a draft and its
// re-draft ("Which time works better, 11am or 2pm? … Which one works for you,
// the 11am or the 2pm?", Keky WA 2026-08-29). A signal on its own, for the
// monologue that uses none of the known words.
const offerKey = (sentence: string): string | null => {
  if (!sentence.includes("?")) return null;
  const times = [...sentence.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)].map((m) => `${m[1]}:${m[2] ?? "00"}${m[3].toLowerCase()}`);
  return times.length < 2 ? null : [...new Set(times)].sort().join("|");
};

// Index of the sentence that repeats an offer already made in the same reply
// (the last such one), or -1.
function lastRedraftIndex(parts: string[]): number {
  const seen = new Set<string>();
  let at = -1;
  parts.forEach((s, i) => {
    const key = offerKey(s.replace(/\[[^\]]*\]/g, " "));
    if (!key) return;
    if (seen.has(key)) at = i;
    seen.add(key);
  });
  return at;
}

export function hasRedraftedOffer(text: string): boolean {
  return lastRedraftIndex(splitSentences(text || "")) >= 0;
}

// The note a regeneration carries. Appended to the client's last message, read
// last. It names no step of the sales flow on purpose (a rule that names a step
// pulls the model towards it, measured 2026-09-21).
export const CLEAN_REPLY_NOTE =
  "Your previous draft for this turn contained your own analysis and was discarded. Output ONLY the exact message the client will read, written to them in the second person, in their language. No analysis, no notes to yourself, no mention of the schedule's layout or of any rule, and never refer to the client as 'the client' or 'they'.";
