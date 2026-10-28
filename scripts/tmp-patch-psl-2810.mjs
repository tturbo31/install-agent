// PATCH (28/10/2026): Port St. Lucie pela METRAGEM (regra do dono).
//   1.000 sq ft ou mais = visita marcada pelo chat, só no primeiro horário da manhã ou a partir das 5pm;
//   abaixo de 1.000 = número do Ozzi, o cliente liga; sem metragem = pergunta a metragem.
// Edita scheduler.ts, ai.ts, os 3 webhooks, system-prompt.ts e dreaming.ts. Aborta sem escrever nada se um trecho não bater.
import { readFileSync, writeFileSync } from "fs";
import { applyPatches } from "./tmp-patch-lib.mjs";

const SCHED = "src/lib/scheduler.ts";
const AI = "src/lib/ai.ts";
const PROMPT = "src/lib/system-prompt.ts";
const DREAM = "src/lib/dreaming.ts";
const WH = { FB: "src/app/api/fb-webhook/route.ts", WA: "src/app/api/wa-webhook/route.ts", IG: "src/app/api/webhook/route.ts" };

// ── 1. ai.ts: the PSL block, spliced between two markers ─────────────────────
const PSL_BLOCK = String.raw`// ─── PORT ST. LUCIE (owner rule 2026-09-26, rewritten 2026-10-28) ────────────
// 2026-09-26: we started serving Port St. Lucie, but the chat never booked
// there: every lead got "Ozzi, the owner, will reach out to you directly to
// arrange your quote" plus the owners' WhatsApp alert, and waited. 2026-10-28
// (owner, after Jesus Rivera on Messenger, fb_38098546056458916: "1500 S/F???
// in Port St Lucie." got that line and the owner had to take over by hand):
// the SIZE decides now.
//   - 1,000 sq ft or more: the chat books the free visit like anywhere else,
//     but ONLY at the first time of the morning or in the late afternoon (5pm
//     or later), never in the middle of the day. The schedule the model reads
//     and every canned re-offer are filtered (scheduler portStLucieHourAllowed)
//     and a [BOOK] at a midday hour is blocked in the three webhooks.
//   - under 1,000 sq ft: the client gets Ozzi's number and is asked to call
//     him. No price, no visit, no slot, no [BOOK].
//   - size unknown: one short question for the square feet first.
// A whole house / home with no figure counts as 1,000+ (houses there are
// bigger than that). After two size questions with no figure, the client gets
// Ozzi's number instead of a third one. Nothing in this flow promises that
// Ozzi will reach out anymore, so the 2026-09-14 redirect to his number runs
// for Port St. Lucie too. Only the client's own words count (the city / ZIP
// and the size).
const PORT_ST_LUCIE_RE = /(?<![a-zà-ÿ])(?:port\s*(?:st\.?|saint|santa?|s\.)\s*luc[ií][ae]|porto\s+s[aã]o\s+l[uú]cio|puerto\s+san(?:ta)?\s+luc[ií]a|psl|(?:st\.?|saint)\s*lucie\s+(?:west|county))(?![a-zà-ÿ])/i;
// PORT_ST_LUCIE_ZIPS lives in zip-text.ts (shared with the service-area gate).
export function isPortStLucieMention(text: string): boolean {
  const t = clientTextOnly(text);
  if (!t) return false;
  if (PORT_ST_LUCIE_RE.test(normalizeSmartPunct(t))) return true;
  return zipsInText(t).some((z) => PORT_ST_LUCIE_ZIPS.has(z));
}
export function portStLucieStanding(history: Array<{ role: string; content: string }>): boolean {
  return (history ?? []).some((m) => m.role === "user" && isPortStLucieMention(m.content));
}
// The 2026-09-26 handoff ("Ozzi, the owner, will reach out"), still in the
// history of the Port St. Lucie leads of 26/09 to 28/10.
const PORT_ST_LUCIE_HANDOFF_RE = /\bozzi\b[^.!?\n]{0,60}\b(?:owner|dueñ[oa]|dono)\b|\b(?:owner|dueñ[oa]|dono)\b[^.!?\n]{0,60}\bozzi\b/i;
export function isPortStLucieHandoff(text: string): boolean {
  const t = text || "";
  return /port\s*st\.?\s*lucie/i.test(t) && PORT_ST_LUCIE_HANDOFF_RE.test(t);
}
const PSL_PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/;

export const PSL_VISIT_MIN_SQFT = 1000;

// Our size question ("About how many square feet is the project?", "Cuántos
// pies cuadrados tiene?", "Quantos pés quadrados?"): a QUESTION sentence with
// a size word and a quantity word. "For 875 sqft I need to measure in person.
// What's the zip code?" is not one (the size word sits outside the question).
const SIZE_WORD_RE = /\b(?:square\s*f(?:ee|oo)t|sq\.?\s*ft|sqft|s\/f|pies\s+cuadrados|p[eé]s\s+quadrados|metros?\s+(?:cuadrados|quadrados)|tama[ñn]o|tamanho|metragem|how\s+big)\b/i;
const SIZE_QTY_RE = /\b(?:how\s+(?:many|much|big)|about|approximately|roughly|cu[aá]nt[oa]s?|m[aá]s\s+o\s+menos|quant[oa]s?|mais\s+ou\s+menos|what(?:'s|\s+is)\s+the\s+(?:size|total|square)|qu[eé]\s+tama[ñn]o|qual\s+(?:[eé]\s+)?(?:o\s+)?tamanho)\b/i;
export function isSizeAsk(text: string): boolean {
  const t = normalizeSmartPunct((text || "").split(/\n\n?\[SYSTEM:/)[0]);
  return (t.match(/[^.!?\n]*\?/g) ?? []).some((q) => SIZE_WORD_RE.test(q) && SIZE_QTY_RE.test(q));
}
// "1,600", "about 1200", "1700 the whole house", "1.500" right after our size
// question. Not a size: money, a clock time, a street address, a phone.
const BARE_SIZE_NUM = /(?<![\d.,$#])(\d{1,2}[.,]\d{3}|\d{3,4})(?!\d|[.,]\d)/;
const NOT_A_SIZE_CTX = /\$|\d\s*(?:am|pm|a\.\s?m|p\.\s?m)\b|\d:\d{2}|\b(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|ter|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|trl|trail|apt|unit|suite|calle|avenida|rua)\b|\b(?:dollars?|d[oó]lares?|reais|budget|bucks)\b/i;
function bareSizeAnswer(text: string): number | null {
  const s = (text || "").trim();
  if (!s || s.length > 90 || NOT_A_SIZE_CTX.test(s) || PSL_PHONE_RE.test(s)) return null;
  const m = s.match(BARE_SIZE_NUM);
  if (!m) return null;
  const v = parseSqNum(m[1]);
  return v >= 100 && v <= 20000 ? Math.round(v) : null;
}
const WHOLE_HOME_RE = /\b(?:whole|entire|full|complete)\s+(?:house|home)\b|\ball\s+(?:the\s+|of\s+the\s+|my\s+)?(?:house|home)\b|\btoda\s+(?:a|la|mi|minha|nuestra|nossa)\s+casa\b|\bcasa\s+(?:toda|inteira|entera|completa)\b/i;

// The project size the client gave, newest statement wins: a figure with a
// unit (clientSqftSignals: "1500 S/F", "875 sg ft", "about 1,200 sqft", "12x14
// kitchen", metric), the floor-plan analysis total, or a bare number answering
// our size question. Several figures in ONE message are summed; "over N"
// counts as N, "under N" as N - 1. A later "whole house" with no figure marks
// the home as 1,000+ (wholeHome), a later figure clears it.
export function portStLucieSize(history: Array<{ role: string; content: string }>): { sqft: number | null; wholeHome: boolean } {
  let sqft: number | null = null;
  let wholeHome = false;
  let lastAssistant = "";
  for (const m of history ?? []) {
    if (m.role === "assistant") { lastAssistant = m.content || ""; continue; }
    if (m.role !== "user") continue;
    const raw = m.content || "";
    const t = clientTextOnly(raw);
    let sum = 0;
    let stated = false;
    for (const s of [...clientSqftSignals(t), ...analysisSqftSignals(raw)]) {
      const v = s.q === "under" ? s.v - 1 : s.v;
      if (v > 0) { sum += v; stated = true; }
    }
    if (!stated && t && isSizeAsk(lastAssistant)) {
      const b = bareSizeAnswer(t);
      if (b !== null) { sum = b; stated = true; }
    }
    if (stated) { sqft = sum; wholeHome = false; }
    else if (t && WHOLE_HOME_RE.test(t)) wholeHome = true;
  }
  return { sqft, wholeHome };
}

export type PortStLucieMode = "ask_size" | "call_ozzi" | "visit";
// null = no Port St. Lucie in the client's words.
export function portStLucieMode(history: Array<{ role: string; content: string }>): PortStLucieMode | null {
  if (!portStLucieStanding(history)) return null;
  const { sqft, wholeHome } = portStLucieSize(history);
  if (wholeHome) return "visit";
  if (sqft !== null) return sqft >= PSL_VISIT_MIN_SQFT ? "visit" : "call_ozzi";
  const asks = (history ?? []).filter((m) => m.role === "assistant" && isSizeAsk(m.content)).length;
  return asks >= 2 ? "call_ozzi" : "ask_size";
}
// The two modes where the flow is NOT the normal booking (the referral-style
// guards of getAIResponse step aside for them, like for the other referrals).
export function portStLucieReferral(history: Array<{ role: string; content: string }>): boolean {
  const m = portStLucieMode(history);
  return m === "ask_size" || m === "call_ozzi";
}
// We already told this client that we serve Port St. Lucie (the 26/09 handoff
// or any line of this flow): the next canned line skips the intro.
export function portStLucieIntroGiven(history: Array<{ role: string; content: string }>): boolean {
  return (history ?? []).some((m) => m.role === "assistant" && /port\s*st\.?\s*lucie/i.test(m.content || ""));
}
// Ozzi's number already went out (our line or the model's; the WhatsApp photo
// redirect carries it too but is not this referral).
export function portStLucieCallSent(history: Array<{ role: string; content: string }>): boolean {
  return (history ?? []).some((m) => m.role === "assistant" && OZZI_DIRECT_NUMBER.test(m.content || "") && !/whatsapp/i.test(m.content || ""));
}
// The deterministic line for the current mode (first turn, [BOOK] guard, leak net).
export function portStLucieReply(history: Array<{ role: string; content: string }>, lang: "en" | "es" | "pt"): string {
  const mode = portStLucieMode(history);
  const intro = !portStLucieIntroGiven(history);
  if (mode === "call_ozzi") {
    return portStLucieCallSent(history) ? portStLucieCallOzziInsistMessage(lang) : portStLucieCallOzziMessage(lang, portStLucieSize(history).sqft, intro);
  }
  if (mode === "visit") return portStLucieVisitMessage(lang, intro, clientAlreadyGaveZip(history));
  return portStLucieSizeAskMessage(lang, intro);
}
// Post-model backstop. Size unknown: a slot / visit offer, an address or zip
// ask, a [BOOK] or a decline. Under 1,000: the same plus any dollar figure or
// booking-details ask, or the first reply after the size without Ozzi's
// number. 1,000+: only a decline (the rest is the normal flow; the hours are
// filtered upstream and the [BOOK] guard checks the hour).
const OUT_OF_AREA_DENIAL = /\b(?:outside|out\s+of)\s+(?:our|the)\s+(?:service\s+)?(?:area|range|zone)|\b(?:don'?t|do\s+not|can'?t|cannot|won'?t)\s+(?:currently\s+)?(?:serve|cover|service|reach|go\s+(?:up|out)\s+(?:there|that\s+far))\b|\bnorth\s+of\s+jupiter\b|\bonly\s+(?:serve|cover|service)\b|\bfuera\s+de\s+(?:nuestra\s+)?(?:zona|[aá]rea)|\bno\s+(?:cubrimos|atendemos|llegamos|damos\s+servicio)\b|\bfora\s+da\s+(?:nossa\s+)?(?:[aá]rea|zona)|\bn[aã]o\s+(?:atendemos|cobrimos|chegamos)\b/i;
export function portStLucieLeak(history: Array<{ role: string; content: string }>, aiText: string): boolean {
  const mode = portStLucieMode(history);
  if (!mode) return false;
  const t = aiText || "";
  const declines = OUT_OF_AREA_DENIAL.test(normalizeSmartPunct(t));
  if (mode === "visit") return declines;
  if (declines || /\[BOOK:/i.test(t) || containsSchedulingOffer(t) || VISIT_OFFER.test(t)) return true;
  if (mode === "ask_size") {
    return t.includes("?") && /\b(?:address|property\s+address|zip(?:\s*code)?|postal\s+code|c[oó]digo\s+postal|cep|direcci[oó]n|endere[çc]o)\b/i.test(t);
  }
  if (/\$\s?\d/.test(t) || isAskingForBookingInfo(t)) return true;
  return !portStLucieCallSent(history) && !OZZI_DIRECT_NUMBER.test(t);
}
// Size unknown and the reply answered without asking anything: the size
// question goes at the end (no intro). A reply that already asks something,
// or carries a tag, is left alone.
export function portStLucieEnsureSizeAsk(history: Array<{ role: string; content: string }>, reply: string, lang: "en" | "es" | "pt"): string {
  if (portStLucieMode(history) !== "ask_size") return reply;
  const t = reply || "";
  if (!t.trim() || t.includes("?") || /\[[A-Z_]+/.test(t)) return reply;
  return t.trimEnd() + " " + portStLucieSizeAskMessage(lang, false);
}
// The line on top of the owners' WhatsApp alert when a [NOTIFY_OWNER] goes
// out in a Port St. Lucie conversation (no accents on purpose, like the rest
// of that message).
export const PORT_ST_LUCIE_ALERT = "LEAD DE PORT ST. LUCIE (regra 28/10): 1000 sq ft ou mais = visita marcada pelo chat so no primeiro horario da manha ou a partir das 5pm; abaixo de 1000 o cliente foi mandado ligar pro Ozzi.";
// The dynamic note for the current mode (null outside Port St. Lucie).
export function portStLucieNote(history: Array<{ role: string; content: string }>): string | null {
  const mode = portStLucieMode(history);
  if (!mode) return null;
  const { sqft, wholeHome } = portStLucieSize(history);
  const head = "CRITICAL, PORT ST. LUCIE (owner rule 2026-10-28): the client is in Port St. Lucie. We DO serve Port St. Lucie, it is the ONE exception north of Jupiter: NEVER say we don't cover it and never call it outside our area. There the SIZE decides: 1,000 square feet or more = the free visit, booked by you here, only at the first time of the morning or in the late afternoon; under 1,000 = the client calls Ozzi, the owner, directly at (561) 674-8334. NEVER say that Ozzi will reach out, call or contact them.";
  if (mode === "visit") {
    return [
      head,
      "This project is " + (wholeHome ? "the whole house" : "about " + sqft + " square feet") + ", so it is a VISIT:",
      "1. Follow your normal flow exactly as for any client in our area: the free visit, the zip code or the full address, two times, the phone, [BOOK:...]. Do NOT send the client to Ozzi's number.",
      "2. VISIT HOURS: in Port St. Lucie the visit is ONLY at the first time of the morning or in the late afternoon (5pm or later), never in the middle of the day. The schedule lines in this context already show ONLY those times for this client: offer from them exactly as your schedule rules say. If the client asks for a midday time (11am, 1pm, 3pm...), say in a few words that in Port St. Lucie the visit is first thing in the morning or late in the afternoon, and offer the listed times.",
      "3. Never mention the 1,000 square feet rule to the client.",
    ].join("\n");
  }
  if (mode === "call_ozzi") {
    const sent = portStLucieCallSent(history);
    return [
      head,
      sqft !== null ? "This project is about " + sqft + " square feet, UNDER 1,000, so the client calls Ozzi:" : "The client did not give the size after two questions, so the client calls Ozzi:",
      "1. " + (sent ? "You ALREADY gave Ozzi's number in this conversation, keep it short. " : "") + "Tell the client, in their language, that for this project in Port St. Lucie Ozzi, the owner, handles it directly, and ask them to call him at (561) 674-8334. One or two short sentences.",
      "2. NEVER give a price, a total, a rate or an estimate. NEVER propose, offer or set up a visit. NEVER offer times. NEVER ask for the name, address, zip or phone. NEVER generate [BOOK:...].",
      "3. If the client insists on doing it here or on a price, do not give in: say you are not able to set that one up through here, it has to be with Ozzi directly, and repeat the number.",
      "4. If the same message asks something unrelated (is it waterproof, what floors we install), answer that briefly and still give Ozzi's number.",
      "5. Only if the client corrects the size to 1,000 square feet or more, or says it is the whole house, does the visit flow return.",
    ].join("\n");
  }
  return [
    head,
    "The client has NOT given the size yet:",
    "1. Do NOT offer times, do NOT propose the visit yet, do NOT ask for the address or the zip code, NEVER generate [BOOK:...] and do not send them to Ozzi.",
    "2. Answer what the client asked in one short sentence and ask, in their language, about how many square feet the project is. If they say it is the whole house, that is enough, no number needed.",
    "3. Never mention the 1,000 square feet rule to the client.",
  ].join("\n");
}

`;

{
  const raw = readFileSync(AI, "utf-8");
  const crlf = /\r\n/.test(raw);
  let text = raw.replace(/\r\n/g, "\n");
  const start = "// ─── PORT ST. LUCIE (owner rule 2026-09-26) ──";
  const end = "// ─── OUT-OF-AREA ZIP (service area gate by code, 2026-10-21)";
  const i = text.indexOf(start), j = text.indexOf(end);
  if (i < 0 || j < 0 || j < i || text.split(start).length !== 2 || text.split(end).length !== 2) {
    console.error("ABORT: PSL block markers not found exactly once in ai.ts"); process.exit(1);
  }
  const old = text.slice(i, j);
  if (!/export const PORT_ST_LUCIE_NOTE = \[/.test(old) || !/export function portStLucieLeak/.test(old)) { console.error("ABORT: PSL block content unexpected"); process.exit(1); }
  text = text.slice(0, i) + PSL_BLOCK + text.slice(j);
  writeFileSync(AI, crlf ? text.replace(/\n/g, "\r\n") : text);
  console.log("spliced PSL block in " + AI);
}

// ── 2. everything else: exact-string patches ─────────────────────────────────
const P = [];

// ai.ts — imports from the scheduler
P.push({ file: AI,
  find: "mobileHomeDeclineMessage, portStLucieHandoffMessage, portStLucieAckMessage, outOfAreaDeclineMessage } from \"@/lib/scheduler\";",
  replace: "mobileHomeDeclineMessage, portStLucieSizeAskMessage, portStLucieCallOzziMessage, portStLucieCallOzziInsistMessage, portStLucieVisitMessage, outOfAreaDeclineMessage } from \"@/lib/scheduler\";" });

// ai.ts — sizes written "1500 S/F", "875 sg ft", "1500 sq"
P.push({ file: AI,
  find: String.raw`|square\s*met(?:er|re)s?\b` + "`;\nconst SQ_LESS",
  replace: String.raw`|square\s*met(?:er|re)s?\b|s\s*\/\s*f(?:t)?\b|sg\.?\s*(?:ft|feet)\b|sq\b(?!\.?\s*m)` + "`;\nconst SQ_LESS" });
P.push({ file: AI,
  find: String.raw`const sqftMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqft|sq\.?\s*ft\.?|square\s+feet?)/i);`,
  replace: String.raw`const sqftMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqft|sq\.?\s*ft\.?|square\s+feet?|s\s*\/\s*f\b|sg\.?\s*ft)/i);` });
P.push({ file: AI,
  find: String.raw`  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet|foot)?\.?|sf\b|sqft|square\s*(?:feet|foot|ft)|ft2|ft²|pies(?:\s+cuadrados)?|m2|m²|mts?2|metros?(?:\s+cuadrados)?)/gi;`,
  replace: String.raw`  const re = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(sq\.?\s*(?:ft|feet|foot)?\.?|sf\b|s\s*\/\s*f\b|sg\.?\s*ft|sqft|square\s*(?:feet|foot|ft)|ft2|ft²|pies(?:\s+cuadrados)?|m2|m²|mts?2|metros?(?:\s+cuadrados)?)/gi;` });

// ai.ts — first contact: a Port St. Lucie burst never gets a canned opener
P.push({ file: AI,
  find: "    const mobileHomeFirstMessage = isMobileHomeRequest(burst);\n",
  replace: "    const mobileHomeFirstMessage = isMobileHomeRequest(burst);\n    // PORT ST. LUCIE (owner rule 2026-10-28): the size decides the flow there,\n    // so a first message from Port St. Lucie never gets a canned opener.\n    const pslFirstMessage = portStLucieStanding(messages);\n" });
P.push({ file: AI,
  find: "    if (!largeFirstMessage && !smallFirstMessage && !bathroomFirstMessage && !mobileHomeFirstMessage && !carpetFirstMessage && !rejectionish && !needsReading) {",
  replace: "    if (!largeFirstMessage && !smallFirstMessage && !bathroomFirstMessage && !mobileHomeFirstMessage && !carpetFirstMessage && !pslFirstMessage && !rejectionish && !needsReading) {" });
P.push({ file: AI,
  find: "    if (!largeFirstMessage && !smallFirstMessage && !bathroomFirstMessage && !mobileHomeFirstMessage && !carpetFirstMessage && !rejectionish && !needsReading && !faqPlusTyped",
  replace: "    if (!largeFirstMessage && !smallFirstMessage && !bathroomFirstMessage && !mobileHomeFirstMessage && !carpetFirstMessage && !pslFirstMessage && !rejectionish && !needsReading && !faqPlusTyped" });

// ai.ts — the early return
P.push({ file: AI,
  find: `  // PORT ST. LUCIE (owner rule 2026-09-26): the turn the client says they are
  // there gets the deterministic handoff + the owner alert (both WhatsApps); a
  // later turn that carries their phone gets the short thank-you + alert.
  // Everything else in that flow goes to the model with the PSL note and the
  // leak net below.
  if (portStLucieStanding(messages)) {
    if (!portStLucieHandoffGiven(messages)) {
      console.log("[AI] Port St. Lucie — sending the owner handoff + owner alert");
      return { text: portStLucieHandoffMessage(usersLang(), portStLucieAskPhone(messages)) + "[NOTIFY_OWNER]", inputTokens: 0, outputTokens: 0 };
    }
    if (lastClientBubbleHasPhone(messages)) {
      console.log("[AI] Port St. Lucie — client sent the phone; thank-you + owner alert");
      return { text: portStLucieAckMessage(usersLang()) + "[NOTIFY_OWNER]", inputTokens: 0, outputTokens: 0 };
    }
  }
`,
  replace: `  // PORT ST. LUCIE (owner rule 2026-09-26, rewritten 2026-10-28): the size
  // decides. Size unknown → the first time, the deterministic size question;
  // under 1,000 sq ft → the first reply is Ozzi's number, the client calls him;
  // 1,000+ → the normal flow with the PSL visit-hours note and the filtered
  // schedule (no early return). Later turns go to the model with the mode's
  // note and the leak net below.
  const pslMode = portStLucieMode(messages);
  if (pslMode === "ask_size" && !messages.some((m) => m.role === "assistant" && isSizeAsk(m.content))) {
    console.log("[AI] Port St. Lucie, size unknown — asking the square feet");
    return { text: portStLucieSizeAskMessage(usersLang(), !portStLucieIntroGiven(messages)), inputTokens: 0, outputTokens: 0 };
  }
  if (pslMode === "call_ozzi" && !portStLucieCallSent(messages)) {
    console.log("[AI] Port St. Lucie under 1,000 sq ft (or no size after two asks) — Ozzi's number, the client calls him");
    return { text: portStLucieReply(messages, usersLang()), inputTokens: 0, outputTokens: 0 };
  }
` });

// ai.ts — canned intercepts step aside while the PSL flow is a referral
P.push({ file: AI,
  find: `  } else if (hardcoded && mobileHomeStanding(messages)) {
    console.log("[AI] Hard-coded intercept skipped — a trailer / mobile home stands; the model declines");
  } else if (hardcoded) {`,
  replace: `  } else if (hardcoded && mobileHomeStanding(messages)) {
    console.log("[AI] Hard-coded intercept skipped — a trailer / mobile home stands; the model declines");
  } else if (hardcoded && portStLucieReferral(messages)) {
    console.log("[AI] Hard-coded intercept skipped — Port St. Lucie without a visit-size project; the model answers with the PSL note");
  } else if (hardcoded) {` });

// ai.ts — the note
P.push({ file: AI,
  find: `  // PORT ST. LUCIE standing → the owner-sets-up-the-quote block (owner rule
  // 2026-09-26): never a decline, never a slot, the owner reaches out.
  if (portStLucieStanding(messages)) {
    console.log("[AI] Port St. Lucie stands — injecting the owner-handles-it block");
    dynamicSystem += "\\n\\n---\\n\\n" + PORT_ST_LUCIE_NOTE;
  }`,
  replace: `  // PORT ST. LUCIE standing → the block of its mode (owner rule 2026-10-28):
  // size unknown = ask it; under 1,000 = Ozzi's number; 1,000+ = the visit,
  // only at the first morning time or 5pm and later. Never a decline.
  const pslNote = portStLucieNote(messages);
  if (pslNote) {
    console.log("[AI] Port St. Lucie stands (" + portStLucieMode(messages) + ") — injecting its block");
    dynamicSystem += "\\n\\n---\\n\\n" + pslNote;
  }` });

// ai.ts — the five referral guards: a PSL visit is a normal lead
P.push({ file: AI, find: "!portStLucieStanding(messages)", replace: "!portStLucieReferral(messages)", count: 5 });

// ai.ts — the leak net
P.push({ file: AI,
  find: `    // PORT ST. LUCIE backstop (owner rule 2026-09-26): while the client is in
    // Port St. Lucie, a slot / visit offer, a price, a details ask, a [BOOK] or
    // a decline is replaced by the owner handoff (no alert again: it fired on
    // the turn the city came up).
    if (portStLucieLeak(messages, cleaned)) {
      console.warn("[AI] Port St. Lucie — model offered a visit / priced / declined; replaced with the owner handoff. Was: " + cleaned.replace(/\\s+/g, " ").slice(0, 220));
      cleaned = portStLucieHandoffMessage(usersLang(), portStLucieAskPhone(messages));
    }`,
  replace: `    // PORT ST. LUCIE backstop (owner rule 2026-10-28): size unknown → no slot,
    // visit, address ask, [BOOK] or decline; under 1,000 → Ozzi's number and
    // nothing else; 1,000+ → never a decline. The swap is the mode's line.
    if (portStLucieLeak(messages, cleaned)) {
      console.warn("[AI] Port St. Lucie (" + portStLucieMode(messages) + ") — reply broke the flow; replaced with the mode's line. Was: " + cleaned.replace(/\\s+/g, " ").slice(0, 220));
      cleaned = portStLucieReply(messages, usersLang());
    } else {
      const withSize = portStLucieEnsureSizeAsk(messages, cleaned, usersLang());
      if (withSize !== cleaned) {
        console.warn("[AI] Port St. Lucie, size unknown — reply asked nothing; appended the size question");
        cleaned = withSize;
      }
    }` });

// ── scheduler.ts ─────────────────────────────────────────────────────────────
P.push({ file: SCHED,
  find: `export function offerPair(times: string[]): string[] {
  const t = times ?? [];
  return t.length <= 2 ? [...t] : [t[0], t[t.length - 1]];
}
`,
  replace: `export function offerPair(times: string[]): string[] {
  const t = times ?? [];
  return t.length <= 2 ? [...t] : [t[0], t[t.length - 1]];
}

// ─── PORT ST. LUCIE VISIT HOURS (owner rule 2026-10-28) ──────────────────────
// "Se for marcar visita [em Port St. Lucie], ela tem que marcar os primeiros
// horários da manhã ou da tarde. Ela não pode marcar no meio do dia." The
// seller drives up there at the start or at the end of the day, so a Port St.
// Lucie visit is ONLY at the first time of the morning (before 10am: 9am on
// the grids of 2026-10-28) or in the late afternoon (5pm or later). Every
// schedule a Port St. Lucie client sees goes through this filter (the model's
// schedule lines, the canned re-offers) and the three webhooks block a [BOOK]
// at any other hour (ai.ts portStLucieMode decides who is in that flow).
export const PSL_MORNING_END_MIN = 10 * 60;
export const PSL_LATE_START_MIN = 17 * 60;
export function portStLucieHourAllowed(time: string | null | undefined): boolean {
  const m = /^(\\d{1,2}):(\\d{2})$/.exec(hhmm(time));
  if (!m) return false;
  const min = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return min < PSL_MORNING_END_MIN || min >= PSL_LATE_START_MIN;
}
` });

P.push({ file: SCHED,
  find: `export async function getRealAvailabilityContext(opts?: { history?: Array<{ role: string; content: string }> }): Promise<string> {`,
  replace: `export async function getRealAvailabilityContext(opts?: { history?: Array<{ role: string; content: string }>; portStLucie?: boolean }): Promise<string> {` });
P.push({ file: SCHED,
  find: `    const lines: string[] = ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):"];
`,
  replace: `    const lines: string[] = ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):"];
    // Port St. Lucie client (owner rule 2026-10-28): every line below keeps
    // only the first morning time and the 5pm-and-later times.
    const pslOnly = (s: string[]) => (opts?.portStLucie ? s.filter(portStLucieHourAllowed) : s);
    if (opts?.portStLucie) {
      lines.push("PORT ST. LUCIE CLIENT (owner rule 2026-10-28): the visit there is ONLY at the first time of the morning or in the late afternoon (5pm or later), never in the middle of the day, so the lines below already show ONLY those times. A midday time (11am, 1pm, 3pm...) does not exist for this client, even if the client asks for it: say in a few words that in Port St. Lucie the visit is first thing in the morning or late in the afternoon, and offer from these lines.");
    }
` });
P.push({ file: SCHED,
  find: `      const slots = openHoursForDay(sellers, dateStr, weekday, bookings, daysOff, notBefore);
      if (slots.length > 0) {
        hasAnySlot = true;`,
  replace: `      const slots = pslOnly(openHoursForDay(sellers, dateStr, weekday, bookings, daysOff, notBefore));
      if (slots.length > 0) {
        hasAnySlot = true;` });
P.push({ file: SCHED,
  find: `          const slots = openHoursForDay(sellers, d, weekday, r.bookings, r.daysOff, undefined);`,
  replace: `          const slots = pslOnly(openHoursForDay(sellers, d, weekday, r.bookings, r.daysOff, undefined));` });

P.push({ file: SCHED,
  find: `export async function getNextOpenSlots(
  maxDays = 21
): Promise<Array<{ dateStr: string; weekday: number; times: string[] }>> {`,
  replace: `export async function getNextOpenSlots(
  maxDays = 21,
  opts?: { portStLucie?: boolean }
): Promise<Array<{ dateStr: string; weekday: number; times: string[] }>> {` });
P.push({ file: SCHED,
  find: `    const times = openHoursForDay(sellers, dateStr, weekday, bookings, daysOff, notBefore);
    if (times.length > 0) out.push({ dateStr, weekday, times });`,
  replace: `    const all = openHoursForDay(sellers, dateStr, weekday, bookings, daysOff, notBefore);
    const times = opts?.portStLucie ? all.filter(portStLucieHourAllowed) : all;
    if (times.length > 0) out.push({ dateStr, weekday, times });` });

P.push({ file: SCHED,
  find: `export async function slotConflictRecoveryMessage(
  lang: Lang,
  requestedDate?: string,
  history?: Array<{ role: string; content: string }>,
  requestedTime?: string
): Promise<string | null> {`,
  replace: `export async function slotConflictRecoveryMessage(
  lang: Lang,
  requestedDate?: string,
  history?: Array<{ role: string; content: string }>,
  requestedTime?: string,
  opts?: { portStLucie?: boolean }
): Promise<string | null> {` });
P.push({ file: SCHED,
  find: `        let slots = (await getPreferredSlots(requestedDate)).filter((s) => {
          if (failedMin === null) return true;`,
  replace: `        let slots = (await getPreferredSlots(requestedDate)).filter((s) => {
          if (opts?.portStLucie && !portStLucieHourAllowed(s)) return false;
          if (failedMin === null) return true;` });
P.push({ file: SCHED,
  find: `      const open = await getNextOpenSlots(21);
      if (open.length === 0) return null;`,
  replace: `      const open = await getNextOpenSlots(21, opts);
      if (open.length === 0) return null;` });

P.push({ file: SCHED,
  find: `export async function needTimeChoiceMessage(lang: Lang, dateStr: string): Promise<string> {
  try {
    let slots = await getPreferredSlots(dateStr);`,
  replace: `export async function needTimeChoiceMessage(lang: Lang, dateStr: string, opts?: { portStLucie?: boolean }): Promise<string> {
  try {
    let slots = await getPreferredSlots(dateStr);
    if (opts?.portStLucie) {
      slots = slots.filter(portStLucieHourAllowed);
      if (slots.length === 0) return portStLucieHoursMessage(lang, dateStr);
    }` });

P.push({ file: SCHED,
  find: `// PORT ST. LUCIE (owner rule 2026-09-26): we are starting to serve it, but the
// quote there is arranged by the owner himself, never by the chat. Sent by the
// brain on the turn the client says they are there (with [NOTIFY_OWNER]) and
// by the brain / the webhooks whenever a slot, a visit, a price, a [BOOK] or a
// decline leaks while it stands. \`askPhone\` adds the number question on
// Instagram / Messenger when the client has not typed one (WhatsApp already
// has it). No "visit" / "free estimate" / "pessoalmente" words: those trip the
// leak detectors. The "will reach out" promise is deliberate here, the
// webhooks skip the 2026-09-14 redirect for this flow.
export function portStLucieHandoffMessage(lang: Lang, askPhone: boolean): string {
  if (lang === "pt") return "Port St. Lucie a gente atende sim, estamos começando por aí. O Ozzi, dono da empresa, vai entrar em contato com você direto para combinar o orçamento" + (askPhone ? ", qual o melhor número para falar com você?" : ".");
  if (lang === "es") return "Port St. Lucie sí lo atendemos, estamos empezando en esa zona. Ozzi, el dueño de la empresa, se va a comunicar con usted directamente para coordinar el presupuesto" + (askPhone ? ", cuál es el mejor número para contactarlo?" : ".");
  return "Port St. Lucie works, we're just starting to serve that area. Ozzi, the owner, will reach out to you directly to arrange your quote" + (askPhone ? ", what's the best number to reach you?" : ".");
}
export function portStLucieAckMessage(lang: Lang): string {
  if (lang === "pt") return "Perfeito, anotado. O Ozzi, dono da empresa, vai entrar em contato com você em breve para combinar o orçamento.";
  if (lang === "es") return "Perfecto, anotado. Ozzi, el dueño de la empresa, se va a comunicar con usted en breve para coordinar el presupuesto.";
  return "Perfect, got it. Ozzi, the owner, will reach out to you shortly to arrange your quote.";
}
`,
  replace: `// PORT ST. LUCIE (owner rule 2026-09-26, rewritten 2026-10-28): the size
// decides (ai.ts portStLucieMode). Size unknown → portStLucieSizeAskMessage;
// under 1,000 sq ft → portStLucieCallOzziMessage (the client calls Ozzi, no
// "Ozzi will reach out", no "?" and no visit words, so the leak detectors and
// the 2026-09-14 promise redirect leave it alone); 1,000+ → the normal flow,
// with portStLucieVisitMessage only as the swap for a decline and
// portStLucieHoursMessage when a midday hour was picked. No dashes, no ¿ ¡.
const PSL_INTRO: Record<Lang, string> = {
  en: "Port St. Lucie works, we're just starting to serve that area. ",
  es: "Port St. Lucie sí lo atendemos, estamos empezando en esa zona. ",
  pt: "Port St. Lucie a gente atende sim, estamos começando por aí. ",
};
export function portStLucieSizeAskMessage(lang: Lang, intro = true): string {
  const i = intro ? PSL_INTRO[lang] : "";
  if (lang === "pt") return i + "Mais ou menos quantos pés quadrados tem o projeto?";
  if (lang === "es") return i + "Más o menos cuántos pies cuadrados tiene el proyecto?";
  return i + "About how many square feet is the project?";
}
export function portStLucieCallOzziMessage(lang: Lang, sqft: number | null, intro = true): string {
  const i = intro ? PSL_INTRO[lang] : "";
  if (lang === "pt") {
    return i + (sqft !== null
      ? "Para projetos com menos de 1.000 pés quadrados aí, quem cuida é o Ozzi, dono da empresa, direto. Liga pra ele no (561) 674-8334."
      : "Para combinar aí, o melhor é falar direto com o Ozzi, dono da empresa. Liga pra ele no (561) 674-8334.");
  }
  if (lang === "es") {
    return i + (sqft !== null
      ? "Para proyectos de menos de 1,000 pies cuadrados allá, lo atiende Ozzi, el dueño, directamente. Llámelo al (561) 674-8334."
      : "Para coordinarlo allá, lo mejor es hablar directo con Ozzi, el dueño. Llámelo al (561) 674-8334.");
  }
  return i + (sqft !== null
    ? "For projects under 1,000 square feet up there, Ozzi, the owner, handles them directly. Please give him a call at (561) 674-8334."
    : "For that one, the best is to set it up with Ozzi, the owner, directly. Please give him a call at (561) 674-8334.");
}
export function portStLucieCallOzziInsistMessage(lang: Lang): string {
  if (lang === "pt") return "Esse eu não consigo fechar por aqui, em Port St. Lucie tem que ser direto com o Ozzi. Liga pra ele no (561) 674-8334.";
  if (lang === "es") return "Ese no lo puedo coordinar por aquí, en Port St. Lucie tiene que ser directo con Ozzi. Llámelo al (561) 674-8334.";
  return "I'm not able to set that one up through here, in Port St. Lucie it has to be with Ozzi directly. Please call him at (561) 674-8334.";
}
export function portStLucieVisitMessage(lang: Lang, intro = true, zipKnown = false): string {
  const i = intro ? PSL_INTRO[lang] : "";
  if (lang === "pt") return i + "Para esse tamanho eu meço aí e passo o preço exato, a visita é grátis. " + (zipKnown ? "Qual dia fica melhor para você?" : "Qual é o zip code do imóvel?");
  if (lang === "es") return i + "Para ese tamaño mido en persona y le doy el precio exacto, la visita es gratis. " + (zipKnown ? "Qué día le queda mejor?" : "Cuál es el código postal de la propiedad?");
  return i + "For that size I measure in person and give you the exact price, the visit is free. " + (zipKnown ? "What day works best for you?" : "What's the zip code of the property?");
}
// A midday hour was picked / booked for a Port St. Lucie visit: say when the
// visits there are and offer the real Port St. Lucie times, that same day
// first (its earliest and its latest), else the soonest day that has any.
export async function portStLucieHoursMessage(lang: Lang, requestedDate?: string, failedTime?: string): Promise<string> {
  const lead = lang === "pt"
    ? "Em Port St. Lucie a visita é logo cedo de manhã ou no fim da tarde"
    : lang === "es"
      ? "En Port St. Lucie la visita es a primera hora de la mañana o al final de la tarde"
      : "In Port St. Lucie the visit is first thing in the morning or late in the afternoon";
  const ask = lang === "pt" ? "qual fica melhor para você?" : lang === "es" ? "cuál le queda mejor?" : "which works better for you?";
  try {
    const todayStr = easternTodayStr();
    const failed = failedTime ? hhmm(failedTime) : null;
    if (requestedDate && /^\\d{4}-\\d{2}-\\d{2}$/.test(requestedDate)) {
      let slots = (await getPreferredSlots(requestedDate)).filter((s) => portStLucieHourAllowed(s) && s !== failed);
      if (requestedDate === todayStr) {
        const nowET = easternNowHM();
        slots = slots.filter((s) => !isSameDaySlotTooSoon(s, nowET.hour * 60 + nowET.minute));
      }
      if (slots.length > 0) {
        const list = joinTimes(lang, offerPair(slots).map(fmt12));
        if (lang === "pt") return \`\${lead}, nesse dia tenho \${list}, \${ask}\`;
        if (lang === "es") return \`\${lead}, ese día tengo \${list}, \${ask}\`;
        return \`\${lead}, that day I have \${list}, \${ask}\`;
      }
    }
    const open = (await getNextOpenSlots(21, { portStLucie: true })).filter((d) => !(failed && d.dateStr === requestedDate && d.times.length === 1 && d.times[0] === failed));
    if (open.length > 0) {
      const first = open[0];
      let offer = \`\${dayPhrase(lang, first.dateStr, todayStr)} \${lang === "en" ? "at" : lang === "es" ? "a las" : "às"} \${joinTimes(lang, offerPair(first.times).map(fmt12))}\`;
      if (first.times.length === 1 && open[1]) {
        const sep = lang === "en" ? " or " : lang === "es" ? " o " : " ou ";
        offer += sep + \`\${dayPhrase(lang, open[1].dateStr, todayStr)} \${lang === "en" ? "at" : lang === "es" ? "a las" : "às"} \${fmt12(open[1].times[0])}\`;
      }
      if (lang === "pt") return \`\${lead}, o mais cedo que tenho é \${offer}, \${ask}\`;
      if (lang === "es") return \`\${lead}, lo más pronto que tengo es \${offer}, \${ask}\`;
      return \`\${lead}, the soonest I have is \${offer}, \${ask}\`;
    }
  } catch (err) {
    console.error("portStLucieHoursMessage error:", err);
  }
  if (lang === "pt") return \`\${lead}, e esses horários estão cheios nas próximas semanas. Liga pro Ozzi no (561) 674-8334 para combinar.\`;
  if (lang === "es") return \`\${lead}, y esos horarios están llenos las próximas semanas. Llame a Ozzi al (561) 674-8334 para coordinarlo.\`;
  return \`\${lead}, and those times are full for the next few weeks. Please call Ozzi at (561) 674-8334 to set it up.\`;
}
` });

// ── the three webhooks ───────────────────────────────────────────────────────
for (const [tag, file] of Object.entries(WH)) {
  const askArg = tag === "WA" ? "false" : "portStLucieAskPhone(history)";
  // imports
  P.push({ file, find: "portStLucieStanding, portStLucieLeak, portStLucieAskPhone, PORT_ST_LUCIE_ALERT,", replace: "portStLucieStanding, portStLucieLeak, portStLucieMode, portStLucieReply, PORT_ST_LUCIE_ALERT," });
  P.push({ file, find: "mobileHomeDeclineMessage, portStLucieHandoffMessage, outOfAreaDeclineMessage,", replace: "mobileHomeDeclineMessage, portStLucieHourAllowed, portStLucieHoursMessage, outOfAreaDeclineMessage," });
  // [BOOK] guard by mode
  P.push({ file,
    find: `  // PORT ST. LUCIE guard (owner rule 2026-09-26): we serve it, but the owner
  // sets up the quote himself. A [BOOK] while the client is there is replaced
  // by the owner handoff (the alert already fired on the turn the city came up).
  if (portStLucieStanding(history)) {
    console.warn("[${tag}] booking blocked — Port St. Lucie (the owner sets up the quote); sending the owner handoff");
    return { response: portStLucieHandoffMessage(lang, ${askArg}), booked: false };
  }
`,
    replace: `  // PORT ST. LUCIE guard (owner rule 2026-10-28): the size decides. Size
  // unknown or under 1,000 sq ft → no [BOOK], the mode's line (the size
  // question / Ozzi's number). 1,000+ → booked like anywhere else, but only at
  // the first morning time or 5pm and later (pslHours, checked below).
  const pslMode = portStLucieMode(history);
  if (pslMode && pslMode !== "visit") {
    console.warn("[${tag}] booking blocked — Port St. Lucie (" + pslMode + "); sending the mode's line");
    return { response: portStLucieReply(history, lang), booked: false };
  }
  const pslHours = pslMode === "visit";
` });
  // midday hour guard
  P.push({ file,
    find: `    const slotHistory = isReschedule ? history : bookingEpisodeHistory(history);
`,
    replace: `    const slotHistory = isReschedule ? history : bookingEpisodeHistory(history);
    // PORT ST. LUCIE VISIT HOURS (owner rule 2026-10-28): a Port St. Lucie
    // visit is only at the first morning time or 5pm and later. A [BOOK] at a
    // midday hour is blocked and the real Port St. Lucie times are offered.
    if (pslHours && bookingData.time && !portStLucieHourAllowed(bookingData.time)) {
      console.warn("[${tag}] booking blocked — Port St. Lucie visit at " + bookingData.time + " (midday); offering the morning / late-afternoon times");
      return { response: await portStLucieHoursMessage(lang, bookingData.date, bookingData.time), booked: false };
    }
` });
  // canned re-offers keep the PSL hours
  P.push({ file, find: "await needTimeChoiceMessage(lang, bookingData.date)", replace: "await needTimeChoiceMessage(lang, bookingData.date, { portStLucie: pslHours })", count: 2 });
  P.push({ file, find: "await needTimeChoiceMessage(lang, pm.promisedDate ?? bookingData.date)", replace: "await needTimeChoiceMessage(lang, pm.promisedDate ?? bookingData.date, { portStLucie: pslHours })" });
  P.push({ file, find: "await slotConflictRecoveryMessage(lang, bookingData.date, history, bookingData.time)", replace: "await slotConflictRecoveryMessage(lang, bookingData.date, history, bookingData.time, { portStLucie: pslHours })" });
  // the schedule the model reads
  P.push({ file, find: "await getRealAvailabilityContext({ history })", replace: "await getRealAvailabilityContext({ history, portStLucie: portStLucieStanding(history) })" });
  // the webhook leak net
  const v = tag === "IG" ? "safeAiText" : "safeResponse";
  P.push({ file,
    find: `    // PORT ST. LUCIE backstop (owner rule 2026-09-26): a slot / visit offer, a
    // price, a details ask, a [BOOK] or a decline while the client is there is
    // replaced by the owner handoff.
    if (!isBookingConfirmed && portStLucieLeak(history, ${v})) {
      console.warn("[${tag}] Port St. Lucie — model offered a visit / priced / declined; replacing with the owner handoff");
      ${v} = portStLucieHandoffMessage(lang, ${askArg});
    }`,
    replace: `    // PORT ST. LUCIE backstop (owner rule 2026-10-28): size unknown → no slot,
    // visit, address ask, [BOOK] or decline; under 1,000 → Ozzi's number only;
    // 1,000+ → never a decline. Replaced by the mode's line.
    if (!isBookingConfirmed && portStLucieLeak(history, ${v})) {
      console.warn("[${tag}] Port St. Lucie (" + portStLucieMode(history) + ") — reply broke the flow; replacing with the mode's line");
      ${v} = portStLucieReply(history, lang);
    }` });
  // the 2026-09-14 redirect runs for Port St. Lucie again
  P.push({ file,
    find: `    // Port St. Lucie (owner rule 2026-09-26) is the one flow where "Ozzi will
    // reach out" is the intended answer: no redirect to his number there.
`,
    replace: `    // Port St. Lucie (owner rule 2026-10-28) no longer promises a callback:
    // the redirect to his number runs there too.
` });
  P.push({ file, find: "stripForbiddenTags(portStLucieStanding(history) ? afterNotify : redirectOwnerPromiseToPhone(afterNotify, lang))", replace: "stripForbiddenTags(redirectOwnerPromiseToPhone(afterNotify, lang))" });
}

// ── base prompt + Dreaming lock ──────────────────────────────────────────────
P.push({ file: PROMPT,
  find: "The ONE exception is Port St. Lucie (owner rule 2026-09-26): we serve it, but Ozzi, the owner, arranges the quote there himself, so follow the PORT ST. LUCIE note when the client is there and never decline it, never offer times and never book it.",
  replace: "The ONE exception is Port St. Lucie (owner rule 2026-09-26, sizes 2026-10-28): we serve it and never decline it; when the client is there, follow the PORT ST. LUCIE note (the size decides between the free visit and Ozzi's number)." });
P.push({ file: PROMPT,
  find: "Outside corridor (Port St. Lucie, Stuart, Fort Pierce, Vero Beach, Orlando, Tampa, Jacksonville, etc.):",
  replace: "Outside corridor (Stuart, Fort Pierce, Vero Beach, Orlando, Tampa, Jacksonville, etc.; Port St. Lucie is served, see above):" });
P.push({ file: DREAM,
  find: "14. PORT ST. LUCIE IS SERVED, AND THE OWNER SETS UP THE QUOTE (owner rule 2026-09-26): when a client is in Port St. Lucie the agent says we serve it, tells them Ozzi, the owner, will reach out to arrange the quote, adds [NOTIFY_OWNER], and never offers times, never books and never declines it. Conversations before 2026-09-26 that declined Port St. Lucie as \"north of Jupiter\" are history, not a pattern. Never write a learning that declines Port St. Lucie or that books a visit there.",
  replace: "14. PORT ST. LUCIE IS SERVED AND THE SIZE DECIDES (owner rule 2026-09-26, sizes 2026-10-28): when a client is in Port St. Lucie the agent never declines it. Size unknown: it asks about how many square feet. 1,000 square feet or more (or the whole house): it books the free visit like anywhere else, but ONLY at the first time of the morning or in the late afternoon (5pm or later), never in the middle of the day. Under 1,000: it gives Ozzi's number, (561) 674-8334, and asks the client to call him, with no price, no visit and no times. Conversations before 2026-10-28 where the agent told Port St. Lucie clients that Ozzi, the owner, would reach out are the old rule, not a pattern; conversations before 2026-09-26 that declined Port St. Lucie are history. Never write a learning that declines Port St. Lucie, that promises Ozzi will reach out, that books a midday visit there, or that books a visit there under 1,000 square feet." });

applyPatches(P);
