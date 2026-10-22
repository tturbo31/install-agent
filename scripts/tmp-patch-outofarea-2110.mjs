// Trava de área de atendimento por ZIP (21/10/2026): Davenport FL 33837 (07/10) e
// Windermere FL 34786 (21/10) foram agendados com "we cover that area". Aplica em
// zip-text.ts, ai.ts, scheduler.ts, system-prompt.ts, dreaming.ts e nos 3 webhooks.
import { applyPatches } from "./tmp-patch-lib.mjs";

const AI_BLOCK = String.raw`  "4. Do NOT tell the client to call or message Ozzi themselves: in this flow the owner contacts them.",
].join("\n");

// ─── OUT-OF-AREA ZIP (service area gate by code, 2026-10-21) ─────────────────
// The prompt alone was the gate and it failed twice. "We cover that area, I
// have Thursday the 8th at 9am or 2pm" for 33837 (Davenport, Orlando side;
// WhatsApp wa_13478203091, 2026-10-07, the visit was cancelled by hand) and
// "That's Windermere, we cover that area. ... Does Thursday at 11am or 7pm
// work?" for 34786 (Messenger fb_29035927539368442, 2026-10-21: the model had
// just declined 34686 as Clearwater, then booked Windermere because Central
// Florida was on no list and "every ZIP in our area starts with 33" is wrong
// in both directions). Our area is exactly the ZIPs 330xx-334xx (zip-text.ts).
// The client's LATEST typed ZIP decides (34686 then 34786 = 34786; an
// out-of-area ZIP followed by an in-area one = in area). While it stands the
// model gets the decline note, and a slot / visit offer, a details ask, a
// [BOOK] or a "we cover that area" line is replaced by outOfAreaDeclineMessage;
// the webhooks also refuse the [BOOK] (by this standing and by the ZIP in the
// tag's address). Port St. Lucie ZIPs are excluded here, they have their own flow.
export function outOfAreaZipStanding(history: Array<{ role: string; content: string }>): string | null {
  let latest: string | null = null;
  for (const m of history ?? []) {
    if (m.role !== "user") continue;
    const zips = zipsInText(clientTextOnly(m.content));
    if (zips.length) latest = zips[zips.length - 1];
  }
  return latest && isOutOfAreaZip(latest) ? latest : null;
}
// "We cover that area" / "cubrimos esa zona" / "atendemos essa área", never
// when negated ("we don't cover that area") or restricted ("we only cover...").
const COVERAGE_CLAIM = /\b(?:we|i)\s+(?:do\s+|definitely\s+|absolutely\s+|also\s+)?(?:cover|serve|service|reach)\s+(?:that|this|your)\s+(?:area|zone|zip|neighborhood|city)\b|(?<!\b(?:no|solo|s[oó]lo)\s)\b(?:cubrimos|atendemos|llegamos\s+a)\s+(?:esa|esta|tu|su)\s+(?:zona|[aá]rea|ciudad)\b|(?<!\b(?:n[aã]o|s[oó])\s)\batendemos\s+(?:essa|esta|sua)\s+(?:[aá]rea|regi[aã]o|cidade)\b/i;
export function claimsCoverage(text: string): boolean {
  return COVERAGE_CLAIM.test(normalizeSmartPunct(text || ""));
}
export function outOfAreaLeak(history: Array<{ role: string; content: string }>, aiText: string): boolean {
  if (!outOfAreaZipStanding(history)) return false;
  const t = aiText || "";
  return /\[BOOK:/i.test(t) || containsSchedulingOffer(t) || VISIT_OFFER.test(t) || isAskingForBookingInfo(t) || claimsCoverage(t);
}
export function outOfAreaNote(zip: string): string {
  return [
    "CRITICAL, OUT OF OUR SERVICE AREA (ZIP " + zip + "):",
    "The client's property ZIP code is " + zip + ". Our service area is EXACTLY the ZIP codes 33000 to 33499 (Miami-Dade, Broward and Palm Beach, from Homestead to Jupiter). " + zip + " is outside it, so we do NOT cover that property, whatever city you think it is in (Central Florida, the Gulf coast, the Treasure Coast and other states are all outside).",
    "1. Say so politely in the client's language, in one or two short sentences: that zip code is outside our service area, we only cover South Florida's east coast from Homestead to Jupiter, and close warmly (if they ever have a project on this side, happy to help). Do NOT name the city you think the ZIP belongs to and NEVER say \"we cover that area\".",
    "2. NEVER propose, offer or set up a visit, an estimate or a measure. NEVER offer time slots. NEVER ask for the address or the phone. NEVER quote a price for that property. NEVER generate [BOOK:...].",
    "3. If the same message also asks something else (is the vinyl waterproof, does it go over tile), answer that part briefly and still give the decline.",
    "4. If earlier in this conversation a visit was offered, a slot was \"held\" or booking details were collected for this ZIP, that was a MISTAKE: do not confirm it, do not write [BOOK:...], apologize briefly and give the decline instead.",
    "5. Only if the client sends a DIFFERENT zip code inside 33000-33499 (a property on the Miami side) return to the normal flow.",
  ].join("\n");
}
`;

const webhook = (tag, leakVar, pslAsk) => [
  { file: `src/app/api/${tag === "FB" ? "fb-webhook" : tag === "WA" ? "wa-webhook" : "webhook"}/route.ts`,
    find: String.raw`portStLucieStanding, portStLucieLeak, portStLucieAskPhone, PORT_ST_LUCIE_ALERT,`,
    replace: String.raw`portStLucieStanding, portStLucieLeak, portStLucieAskPhone, PORT_ST_LUCIE_ALERT, outOfAreaZipStanding, outOfAreaLeak,` },
  { file: `src/app/api/${tag === "FB" ? "fb-webhook" : tag === "WA" ? "wa-webhook" : "webhook"}/route.ts`,
    find: String.raw`portStLucieHandoffMessage, getUpcomingBookingRecord,`,
    replace: String.raw`portStLucieHandoffMessage, outOfAreaDeclineMessage, bookingAddressOutOfArea, getUpcomingBookingRecord,` },
  { file: `src/app/api/${tag === "FB" ? "fb-webhook" : tag === "WA" ? "wa-webhook" : "webhook"}/route.ts`,
    find: String.raw`  if (mobileHomeStanding(history)) {
    console.warn("[${tag}] booking blocked — trailer / mobile home`,
    replace: String.raw`  // OUT-OF-AREA ZIP guard (2026-10-21): the client's latest typed ZIP is outside
  // the service area (330xx-334xx). Davenport FL 33837 (WA, 2026-10-07) and
  // Windermere FL 34786 (FB, 2026-10-21) were booked as "we cover that area";
  // a [BOOK] while such a ZIP stands is replaced by the decline.
  const outOfAreaZip = outOfAreaZipStanding(history);
  if (outOfAreaZip) {
    console.warn("[${tag}] booking blocked — ZIP " + outOfAreaZip + " is outside the service area (330xx-334xx); sending the decline");
    return { response: outOfAreaDeclineMessage(lang), booked: false };
  }
  if (mobileHomeStanding(history)) {
    console.warn("[${tag}] booking blocked — trailer / mobile home` },
  { file: `src/app/api/${tag === "FB" ? "fb-webhook" : tag === "WA" ? "wa-webhook" : "webhook"}/route.ts`,
    find: String.raw`      return { response: needZipMessage(lang), booked: false };
    }`,
    replace: String.raw`      return { response: needZipMessage(lang), booked: false };
    }
    // The ZIP in the [BOOK] address must be inside the service area as well
    // (the standing above reads the client's bubbles, this reads the tag).
    const tagZipOutOfArea = bookingAddressOutOfArea(bookingData.address);
    if (tagZipOutOfArea) {
      console.warn("[${tag}] booking blocked — the [BOOK] address ZIP " + tagZipOutOfArea + " is outside the service area (" + JSON.stringify(bookingData.address ?? null) + "); sending the decline");
      return { response: outOfAreaDeclineMessage(lang), booked: false };
    }` },
  { file: `src/app/api/${tag === "FB" ? "fb-webhook" : tag === "WA" ? "wa-webhook" : "webhook"}/route.ts`,
    find: String.raw`      ${leakVar} = portStLucieHandoffMessage(lang, ${pslAsk});
    }`,
    replace: String.raw`      ${leakVar} = portStLucieHandoffMessage(lang, ${pslAsk});
    }

    // OUT-OF-AREA ZIP backstop (2026-10-21): while the client's latest ZIP is
    // outside 330xx-334xx, a slot / visit offer, a details ask, a [BOOK] or a
    // "we cover that area" is replaced by the decline.
    if (!isBookingConfirmed && outOfAreaLeak(history, ${leakVar})) {
      console.warn("[${tag}] ZIP " + outOfAreaZipStanding(history) + " out of area — model offered a visit / asked details / claimed coverage; replacing with the decline");
      ${leakVar} = outOfAreaDeclineMessage(lang);
    }` },
];

applyPatches([
  // ── zip-text.ts: 32xxx também conta como ZIP digitado + helpers de área ──
  { file: "src/lib/zip-text.ts",
    find: String.raw`// → "33130"). Here a 5-digit token counts as a ZIP when it starts with 33 or 34
// (South Florida), is not glued to "$" / digits, is not an apartment or unit`,
    replace: String.raw`// → "33130"). Here a 5-digit token counts as a ZIP when it starts with 32, 33 or
// 34 (a Florida ZIP; 32xxx added 2026-10-21 so an Orlando / Vero Beach ZIP also
// counts as "the client typed a ZIP" and reaches the service-area gate below),
// is not glued to "$" / digits, is not an apartment or unit` },
  { file: "src/lib/zip-text.ts",
    find: String.raw`const re = /(?<![\d$,.#-])\b(3[34]\d{3})(?:-\d{4})?\b`,
    replace: String.raw`const re = /(?<![\d$,.#-])\b(3[2-4]\d{3})(?:-\d{4})?\b` },
  { file: "src/lib/zip-text.ts",
    find: String.raw`    out.push(zip);
  }
  return out;
}`,
    replace: String.raw`    out.push(zip);
  }
  return out;
}

// ─── Service area by ZIP (owner rule: Homestead to Jupiter) ──────────────────
// Miami-Dade, Broward and Palm Beach are exactly the ZIPs 33000-33499 (330xx,
// 331xx, 332xx, 333xx, 334xx). Everything else is out of area: 335xx-339xx are
// Tampa Bay, Lakeland, Davenport and Fort Myers; 32xxx and 34xxx are Central
// and North Florida, the Gulf coast and the Treasure Coast (Orlando, Windermere,
// Kissimmee, Clearwater, Sarasota, Naples, Vero Beach...). The ONE exception is
// Port St. Lucie (owner rule 2026-09-26: served, the owner sets up the quote).
// Two visits were booked out of area while the prompt ("every ZIP in our area
// starts with 33") was the only check: Davenport FL 33837 (wa_13478203091,
// 2026-10-07, "We cover that area") and Windermere FL 34786
// (fb_29035927539368442, 2026-10-21, "That's Windermere, we cover that area").
export const PORT_ST_LUCIE_ZIPS = new Set(["34952", "34953", "34983", "34984", "34985", "34986", "34987", "34988"]);
export function isServiceAreaZip(zip: string | null | undefined): boolean {
  return /^33[0-4]\d{2}$/.test((zip ?? "").trim());
}
/** A 5-digit ZIP that is neither in the Homestead-to-Jupiter area nor Port St. Lucie. */
export function isOutOfAreaZip(zip: string | null | undefined): boolean {
  const z = (zip ?? "").trim();
  return /^\d{5}$/.test(z) && !isServiceAreaZip(z) && !PORT_ST_LUCIE_ZIPS.has(z);
}` },

  // ── ai.ts ──
  { file: "src/lib/ai.ts",
    find: String.raw`import { zipsInText } from "./zip-text";`,
    replace: String.raw`import { zipsInText, isOutOfAreaZip, PORT_ST_LUCIE_ZIPS } from "./zip-text";` },
  { file: "src/lib/ai.ts",
    find: String.raw`mobileHomeDeclineMessage, portStLucieHandoffMessage, portStLucieAckMessage } from "@/lib/scheduler";`,
    replace: String.raw`mobileHomeDeclineMessage, portStLucieHandoffMessage, portStLucieAckMessage, outOfAreaDeclineMessage } from "@/lib/scheduler";` },
  { file: "src/lib/ai.ts",
    find: String.raw`const PORT_ST_LUCIE_ZIPS = new Set(["34952", "34953", "34983", "34984", "34985", "34986", "34987", "34988"]);
`,
    replace: String.raw`// PORT_ST_LUCIE_ZIPS lives in zip-text.ts (shared with the service-area gate).
` },
  { file: "src/lib/ai.ts",
    find: String.raw`  "4. Do NOT tell the client to call or message Ozzi themselves: in this flow the owner contacts them.",
].join("\n");
`,
    replace: AI_BLOCK },
  { file: "src/lib/ai.ts", count: 5,
    find: String.raw`!mobileHomeStanding(messages) && !portStLucieStanding(messages)`,
    replace: String.raw`!mobileHomeStanding(messages) && !portStLucieStanding(messages) && outOfAreaZipStanding(messages) === null` },
  { file: "src/lib/ai.ts",
    find: String.raw`    console.log("[AI] Port St. Lucie stands — injecting the owner-handles-it block");
    dynamicSystem += "\n\n---\n\n" + PORT_ST_LUCIE_NOTE;
  }`,
    replace: String.raw`    console.log("[AI] Port St. Lucie stands — injecting the owner-handles-it block");
    dynamicSystem += "\n\n---\n\n" + PORT_ST_LUCIE_NOTE;
  }

  // OUT-OF-AREA ZIP standing (2026-10-21, Davenport 33837 / Windermere 34786
  // booked as "we cover that area") → the decline block with the ZIP.
  const outOfAreaStandingZip = outOfAreaZipStanding(messages);
  if (outOfAreaStandingZip) {
    console.log("[AI] ZIP " + outOfAreaStandingZip + " is outside the service area — injecting the decline block");
    dynamicSystem += "\n\n---\n\n" + outOfAreaNote(outOfAreaStandingZip);
  }` },
  { file: "src/lib/ai.ts",
    find: String.raw`      cleaned = portStLucieHandoffMessage(usersLang(), portStLucieAskPhone(messages));
    }`,
    replace: String.raw`      cleaned = portStLucieHandoffMessage(usersLang(), portStLucieAskPhone(messages));
    }

    // OUT-OF-AREA ZIP backstop (2026-10-21): while the client's latest ZIP is
    // outside 330xx-334xx, a slot / visit offer, a details ask, a [BOOK] or a
    // "we cover that area" is replaced by the decline (Davenport 33837 and
    // Windermere 34786 got times and a [BOOK] from the model).
    if (outOfAreaLeak(messages, cleaned)) {
      console.warn("[AI] ZIP " + outOfAreaZipStanding(messages) + " out of area — model offered a visit / asked details / claimed coverage; replaced with the decline. Was: " + cleaned.replace(/\s+/g, " ").slice(0, 220));
      cleaned = outOfAreaDeclineMessage(usersLang());
    }` },
  { file: "src/lib/ai.ts",
    find: String.raw`nor north of Jupiter (Treasure Coast), nor the Florida Keys south of Homestead. BEFORE proposing a visit, offering any time slot`,
    replace: String.raw`nor Central and North Florida (Orlando, Windermere, Kissimmee, Davenport, Clermont, Lakeland, Ocala, Jacksonville), nor north of Jupiter (Treasure Coast), nor the Florida Keys south of Homestead. By ZIP code our area is exactly 33000-33499 (330xx-334xx): any other ZIP is out of area, Port St. Lucie excepted, whatever city you think it is, and the city of a ZIP is never asserted. BEFORE proposing a visit, offering any time slot` },

  // ── scheduler.ts ──
  { file: "src/lib/scheduler.ts",
    find: String.raw`import { zipsInText } from "./zip-text";`,
    replace: String.raw`import { zipsInText, isOutOfAreaZip } from "./zip-text";` },
  { file: "src/lib/scheduler.ts",
    find: String.raw`  return "Perfect, got it. Ozzi, the owner, will reach out to you shortly to arrange your quote.";
}
`,
    replace: String.raw`  return "Perfect, got it. Ozzi, the owner, will reach out to you shortly to arrange your quote.";
}

// OUT OF AREA BY ZIP (2026-10-21): the service area is exactly the ZIPs
// 330xx-334xx (zip-text.ts isServiceAreaZip); Port St. Lucie has its own flow.
// Sent by the brain and the webhooks whenever the client's latest typed ZIP is
// outside it and the model still offered a visit, asked details, wrote a
// [BOOK] or said "we cover that area" (Davenport FL 33837, 2026-10-07;
// Windermere FL 34786, 2026-10-21). Never names the city (the model guesses
// it), no dashes, no ¿ ¡, must not read as a scheduling push or a details ask.
export function outOfAreaDeclineMessage(lang: Lang): string {
  if (lang === "pt") return "Esse zip code fica fora da nossa área de atendimento, a gente só atende a costa leste do sul da Flórida, de Homestead até Jupiter. Se um dia tiver um projeto por aqui, é só me chamar!";
  return lang === "es"
    ? "Ese código postal está fuera de nuestra zona de servicio, solo cubrimos la costa este del sur de la Florida, de Homestead a Jupiter. Si algún día tiene un proyecto por acá, con gusto le ayudo."
    : "That zip code is outside our service area, we only cover South Florida's east coast from Homestead to Jupiter. If you ever have a project on this side, I'm happy to help!";
}
// The ZIP inside a [BOOK] address that is outside the service area (and not
// Port St. Lucie), or null. Read by the webhooks right after bookingAddressHasZip.
export function bookingAddressOutOfArea(address?: string | null): string | null {
  const zip = extractZip(address);
  return zip && isOutOfAreaZip(zip) ? zip : null;
}
` },

  // ── system-prompt.ts ──
  { file: "src/lib/system-prompt.ts",
    find: String.raw`ZIP CODE TEST: every ZIP in our service area starts with 33. A ZIP starting with 34 or 32 is OUTSIDE the area (except the Port St. Lucie ZIPs, see the note): decline politely right there, do NOT keep selling, do NOT offer a visit, and do NOT tell them to "come back once you have measurements".`,
    replace: String.raw`ZIP CODE TEST: our service area is EXACTLY the ZIP codes 33000 to 33499 (they start with 330, 331, 332, 333 or 334: Miami-Dade, Broward and Palm Beach). ANY other ZIP is OUTSIDE the area: 335xx to 339xx are Tampa Bay, Lakeland, Davenport and Fort Myers; 32xxx and 34xxx are Central and North Florida, the Gulf coast and the Treasure Coast (Orlando, Windermere, Kissimmee, Clermont, Ocala, Clearwater, Sarasota, Naples, Vero Beach), all OUTSIDE (except the Port St. Lucie ZIPs, see the note). For a ZIP outside 330-334 decline politely right there, do NOT keep selling, do NOT offer a visit, and do NOT tell them to "come back once you have measurements". NEVER say "we cover that area" for such a ZIP, and never name the city you think a ZIP belongs to (you are often wrong, and it changes nothing): "that zip code is outside our service area" is the whole answer. A ZIP is NOT covered just because its city is missing from the lists below: the lists are examples, the ZIP range is the rule.` },
  { file: "src/lib/system-prompt.ts",
    find: String.raw`We also do NOT serve the Florida Keys (Key Largo, Islamorada, Marathon, Key West) south of Homestead.`,
    replace: String.raw`We also do NOT serve the Florida Keys (Key Largo, Islamorada, Marathon, Key West) south of Homestead, nor Central and North Florida: Orlando and everything around it (Windermere, Kissimmee, Davenport, Clermont, Winter Garden, Ocoee, Apopka, Sanford), Lakeland, Ocala, The Villages, Melbourne, Daytona, Jacksonville and Tallahassee are all OUTSIDE our area. Not being on these lists does not make a place covered: when in doubt, the ZIP range decides.` },

  // ── dreaming.ts: trava 18 ──
  { file: "src/lib/dreaming.ts",
    find: String.raw`not a pattern.
A past learning that violated constraint 1 spread`,
    replace: String.raw`not a pattern.
18. OUR SERVICE AREA IS EXACTLY THE ZIP CODES 330xx-334xx (gate added 2026-10-21): Miami-Dade, Broward and Palm Beach, Homestead to Jupiter. Any other ZIP (335xx-339xx Tampa Bay / Lakeland / Davenport / Fort Myers, 32xxx and 34xxx Central and North Florida, the Gulf coast and the Treasure Coast, Port St. Lucie excepted) is declined politely, never visited and never booked, and the city of a ZIP is never asserted. "We cover that area" plus a visit for Davenport FL 33837 (2026-10-07) and Windermere FL 34786 (2026-10-21) were mistakes, not patterns: never write a learning that confirms coverage for, offers times to or books a visit at a ZIP outside 330xx-334xx.
A past learning that violated constraint 1 spread` },

  // ── webhooks ──
  ...webhook("FB", "safeResponse", "portStLucieAskPhone(history)"),
  ...webhook("WA", "safeResponse", "false"),
  ...webhook("IG", "safeAiText", "portStLucieAskPhone(history)"),
]);
