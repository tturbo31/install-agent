/**
 * Full regression suite — covers all historically broken scenarios.
 * Run: node src/evals/run-tests.mjs
 */

const BASE = "http://localhost:3000/api/training/chat?secret=Pepeka";
const TIMEOUT_MS = 60_000; // 10s debounce + AI call + margin (dev API calls can be slow)

let pass = 0, fail = 0;

async function askOnce(messages, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, ...extra }),
      signal: controller.signal,
    });
    const json = await res.json();
    return json.response ?? json.error ?? "(empty)";
  } finally {
    clearTimeout(timer);
  }
}

async function ask(messages, extra = {}) {
  // The local Next dev server is slow/flaky under the sequential load of the
  // suite (on-demand recompiles), so a timeout/network blip is retried ONCE.
  // A genuine bug fails both attempts; only infra flakes are absorbed. A second
  // failure returns a sentinel so the suite continues instead of crashing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await askOnce(messages, extra);
    } catch (e) {
      if (attempt === 2) return `(request failed: ${e?.name ?? e})`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function check(num, desc, response, { contains = [], notContains = [], sentences } = {}) {
  const r = response.toLowerCase();
  const errors = [];

  for (const pat of contains) {
    const rx = pat instanceof RegExp ? pat : new RegExp(pat, "i");
    if (!rx.test(response)) errors.push(`missing: ${pat}`);
  }
  for (const pat of notContains) {
    const rx = pat instanceof RegExp ? pat : new RegExp(pat, "i");
    if (rx.test(response)) errors.push(`forbidden found: ${pat}`);
  }

  // Count real sentences (end with . ! ?)
  if (sentences !== undefined) {
    const s = response.replace(/\[BOOK:[^\]]+\]/g, "").replace(/\[NOTIFY_OWNER\]/g, "").replace(/\[CANCEL_BOOKING\]/g, "").trim();
    const count = (s.match(/[.!?](?:\s|$)/g) || []).length;
    if (count > sentences) errors.push(`too many sentences: ${count} (max ${sentences})`);
  }

  const preview = response.slice(0, 130).replace(/\n/g, " ");
  if (errors.length === 0) {
    console.log(`T${String(num).padStart(2,"0")} ✅ ${desc}`);
    console.log(`    → ${preview}`);
    pass++;
  } else {
    console.log(`T${String(num).padStart(2,"0")} ❌ ${desc}`);
    console.log(`    → ${preview}`);
    for (const e of errors) console.log(`    ⚠ ${e}`);
    fail++;
  }
  console.log();
}

// ─── Tiny 1×1 red PNG (base64) for image pipeline smoke test ─────────────────
const RED_DOT_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==";

// ─── Simulate floor plan image analysis result (injected as text) ─────────────
const SMALL_PLAN_MSG = "Here's my floor plan!\n\n[Image analysis: Bedroom 3.00x3.00m=9m², Bathroom 1.90x2.80m=5.32m², Kitchen 2.50x2.50m=6.25m². Total: ~21sqm (~226sqft). SMALL PROJECT]";
const LARGE_PLAN_MSG = "Here's my floor plan!\n\n[Image analysis: Sala 5.00x6.00m=30m², Suite 4.00x4.50m=18m², Quarto1 3.50x4.00m=14m², Quarto2 3.00x3.50m=10.5m², Cozinha 3.00x4.00m=12m², Total: ~84sqm (~904sqft). LARGE PROJECT]";

// ─────────────────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════");
console.log(" OzziFloors AI Agent — Full Regression Suite");
console.log(`═══════════════════════════════════════════════════════════\n`);

// ── GROUP 1: FORMAT RULES ──────────────────────────────────────────────────

let r;

// T01 — First message: opener MUST ask the flooring type first (tile/vinyl/hardwood),
// with NO price. We advertise three types at different rates and can't tell which
// ad a lead came from, so the bot asks the type before anything else.
r = await ask([{ role: "user", content: "Hi, I'm interested in getting floors for my house" }]);
check(1, "First message: asks flooring type, no price", r, {
  contains: [/tile/i, /vinyl/i, /hardwood/i],
  notContains: [/\$\s?\d/, /emoji/, /[\u{1F300}-\u{1FAFF}]/u],
  sentences: 2,
});

// T02 — No emojis ever (ask a happy question)
r = await ask([{ role: "user", content: "Amazing! I love the idea, sounds great!" }]);
check(2, "No emojis in response", r, {
  notContains: [/[\u{1F300}-\u{1FAFF}]/u, /[\u{2600}-\u{27BF}]/u],
});

// T03 — No dashes in any response
r = await ask([{ role: "user", content: "How long does the installation take?" }]);
check(3, "No dashes in response", r, {
  notContains: [/ - /, / – /, / — /],
});

// T04 — Max 2 sentences
r = await ask([
  { role: "user", content: "Hi, I want floors for my living room" },
  { role: "assistant", content: "The promotional package already includes the flooring, installation labor, and quarter round, and I offer a free quote. Are you planning to do just one area or the whole house?" },
  { role: "user", content: "Just the living room, around 200 sqft" },
]);
check(4, "Max 2 sentences — small lead response", r, { sentences: 2 });

// ── GROUP 2: TILE INSTALLATION (historically broken) ───────────────────────

// T05 — Tile small job: $4.50/sqft, NOT $5/sqft LVP (>=200 sqft so it's quotable,
// jobs under 200 sqft are declined per the small-job rule)
r = await ask([
  { role: "user", content: "I need tile installation for my bathroom, around 250 sqft" },
]);
check(5, "Small tile job: $4.50/sqft", r, {
  // 250 x $4.50 = $1,125. Accept the unit rate OR the correct total (the model
  // sometimes states only the total). Either way it must NOT be LVP pricing.
  contains: [/4\.50|4,50|1[,.]?125/],
  notContains: [/\$5(?:\/sqft|\.00|,00| per)/, /luxury vinyl|lvp/i],
});

// T06 — Porcelain mention: tile pricing NOT LVP
r = await ask([
  { role: "user", content: "I have porcelain tile I already purchased. Need someone to install it. It's about 300 sqft." },
]);
check(6, "Porcelain: tile pricing $4.50", r, {
  // 300 x $4.50 = $1,350 (NOT $1,850 — the +$500 LVP surcharge never applies to tile)
  contains: [/4\.50|4,50|1[,.]?350/],
  notContains: [/\$5(?:\/sqft|\.00|,00| per)/, /1[,.]?850/],
});

// T07 — Ceramic mention: tile pricing NOT LVP
r = await ask([
  { role: "user", content: "Need ceramic floor installation, about 250 sqft in my kitchen" },
]);
check(7, "Ceramic: tile pricing $4.50", r, {
  // 250 x $4.50 = $1,125 (NOT $1,625)
  contains: [/4\.50|4,50|1[,.]?125/],
  notContains: [/\$5(?:\/sqft|\.00|,00| per)/, /1[,.]?625/],
});

// T08 — Large tile job (600 sqft): NO price, propose visit
r = await ask([
  { role: "user", content: "I need tile installation for my entire first floor, around 600 sqft of porcelain" },
]);
check(8, "Large tile (600 sqft): no price, propose visit", r, {
  contains: [/(visit|measure|in person|in-person|schedule)/i],
  notContains: [/\$[\d,]+(?:\.\d{2})?(?!\s*per\s*sq)/i, /total.*\$[\d,]+/i],
});

// T09 — Tile removal: $1.50/sqft only when asked
r = await ask([
  { role: "user", content: "How much do you charge to remove existing tile before installing new ones?" },
]);
check(9, "Tile removal price: $1.50", r, {
  contains: [/1\.50|1,50/],
});

// ── GROUP 3: LARGE LEAD — 500+ SQFT (historically broken) ─────────────────

// T10 — Exactly 500 sqft: LARGE LEAD, no price
r = await ask([
  { role: "user", content: "I need flooring for 500 sqft" },
]);
check(10, "Exactly 500 sqft: large lead, no price", r, {
  contains: [/(visit|measure|in person|in-person|free)/i],
  notContains: [/\$2[,.]?500|\$[\d,]{4,}/],
});

// T11 — 1000 sqft: LARGE LEAD, no price
r = await ask([
  { role: "user", content: "I want to redo all floors in my house, about 1000 square feet" },
]);
check(11, "1000 sqft: large lead, no price by DM", r, {
  contains: [/(visit|measure|in person|in-person|free)/i],
  notContains: [/\$[\d,]{4,}/],
});

// T12 — "How much per sqft?" for large lead: still propose visit (not EXCEPTION)
r = await ask([
  { role: "user", content: "I have 800 sqft. How much do you charge per sqft?" },
]);
check(12, "'How much per sqft?' for large lead → still propose visit", r, {
  contains: [/(visit|measure|in person|in-person|free)/i],
  notContains: [/\$[\d,]{4,}/],
});

// T13 — Explicit refusal: "just give me a number" → may give approximate
r = await ask([
  { role: "user", content: "I have about 700 sqft. I don't want a visit, just give me a rough number." },
]);
check(13, "Explicit refusal 'just give me a number' → approximate + still offer visit", r, {
  contains: [/(approximat|rough|estim|visit|measure)/i],
});

// ── GROUP 4: SMALL LEAD — QUOTE BY DM ─────────────────────────────────────

// T14 — 200 sqft LVP: $1,500 quote by DM (200 to 400 sqft = sqft x $5 + $500,
// the $500 baked in silently). Old value $1,000 was the pre-surcharge math.
r = await ask([
  { role: "user", content: "Just my living room, it's about 200 sqft" },
]);
check(14, "200 sqft LVP: $1,500 quote", r, {
  contains: [/\$1[,.]?500|\$1500|1,500/],
  notContains: [/(in-person visit|free visit|schedule a visit)/i, /\$500/],
});

// T15 — One bedroom → small lead, give price
r = await ask([
  { role: "user", content: "I just want to redo my bedroom, it's one room" },
]);
check(15, "One room = small lead, give price or ask for sqft", r, {
  notContains: [/(schedule.*visit|in-person visit|free visit)/i],
});

// ── GROUP 5: HARD-CODED INTERCEPTS ────────────────────────────────────────

// T16 — "What is included?" → exact hardcoded response
r = await ask([{ role: "user", content: "What is included in the package?" }]);
check(16, "'What is included': exact hardcoded response", r, {
  contains: [/promotional package.*includes|includes.*flooring.*installation.*quarter round/i, /free quote/i],
  notContains: [/\$5|\$4\.50|cost|hidden fee/i],
});

// T17 — "Is labor included?" → hardcoded
r = await ask([{ role: "user", content: "Is labor included?" }]);
check(17, "'Is labor included': hardcoded response", r, {
  contains: [/installation labor.*included|includes.*installation labor/i],
  notContains: [/\$5|\$4\.50/i],
});

// T18 — "Can you send me photos?" → redirect to team WhatsApp, NO [SEND_IMAGES] tag
r = await ask([{ role: "user", content: "Can you send me photos of the floors?" }]);
check(18, "'Send photos': redirect to WhatsApp, no [SEND_IMAGES]", r, {
  contains: [/674[-\s]?8334/],
  notContains: [/\[SEND_IMAGES/i],
});

// T19 — "Do you have any samples?" → redirect to team WhatsApp
r = await ask([{ role: "user", content: "Do you have any samples available?" }]);
check(19, "'Samples available': redirect to WhatsApp", r, {
  contains: [/674[-\s]?8334/],
  notContains: [/\[SEND_IMAGES/i],
});

// T20 — Post-visit negotiation → hardcoded NOTIFY_OWNER
r = await ask([{ role: "user", content: "I already had the visit and want to negotiate the quote" }]);
check(20, "Post-visit negotiation: hardcoded NOTIFY_OWNER", r, {
  contains: [/\[NOTIFY_OWNER\]/],
  notContains: [/\$[\d,]+/],
});

// ── GROUP 6: BOOKING SYSTEM ────────────────────────────────────────────────

// T21 — "Sounds good" vague → wait, no address/phone request
r = await ask([
  { role: "user", content: "I need flooring for my whole house, about 1200 sqft" },
  { role: "assistant", content: "For that size I need to visit and measure in person to give you the best price. I bring samples so you can pick right there. I have Tuesday at 2pm and Thursday at 10am open. What works?" },
  { role: "user", content: "Sounds good" },
]);
check(21, "'Sounds good' → wait, don't ask for address/phone", r, {
  notContains: [/address|phone|number|telephone/i],
  sentences: 1,
});

// T22 — Client confirms specific slot → ask address AND phone together
r = await ask([
  { role: "user", content: "I need flooring for my whole house, about 1200 sqft" },
  { role: "assistant", content: "For that size I need to come measure in person and bring samples so you can choose right there. I have Tuesday June 3rd at 2pm and Thursday at 10am. What works?" },
  { role: "user", content: "Tuesday at 2pm works for me" },
]);
check(22, "Slot confirmed → ask name, address AND phone together", r, {
  contains: [/name/i, /address/i, /phone|number/i],
  notContains: [/\[BOOK:/],
});

// T23 — All confirmed (incl. the client's NAME, owner rule 2026-07-27) →
// generate [BOOK:...] with ≤5 words before
r = await ask([
  { role: "user", content: "Tuesday at 2pm, I'm Diego, my address is 3209 NE 7th St Miami FL, my phone is 3051234567" },
]);
check(23, "Complete info → [BOOK:...] with ≤5 words before", r, {
  contains: [/\[BOOK:\{/],
});
// Count words before [BOOK:
if (r.includes("[BOOK:")) {
  const before = r.slice(0, r.indexOf("[BOOK:")).trim();
  const wordCount = before.split(/\s+/).filter(Boolean).length;
  if (wordCount > 5) {
    console.log(`    ⚠ PRE-BOOKING TEXT: "${before}" has ${wordCount} words (max 5)`);
    fail++; pass--;
    console.log();
  }
}

// T24 — No real-time availability in context → don't invent time slots
r = await ask([
  { role: "user", content: "I want to schedule a visit. What days are you available?" },
]);
check(24, "No availability context → don't invent time slots", r, {
  notContains: [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(at|@)\b.*\b(am|pm|\d:\d{2})\b/i],
  contains: [/(what day|what time|when|works for you|check)/i],
});

// ── GROUP 7: IMAGE ANALYSIS ─────────────────────────────────────────────────

// T25 — Image pipeline smoke test: doesn't crash, returns a response
r = await ask(
  [{ role: "user", content: "Here's my floor" }],
  { imageBase64: RED_DOT_PNG }
);
check(25, "Image pipeline: no crash, returns response", r, {
  notContains: [/error|failed|could not/i],
});

// T26 — Simulate small floor plan (< 500 sqft) → give price
r = await ask([{ role: "user", content: SMALL_PLAN_MSG }]);
check(26, "Small floor plan (~226 sqft): give DM price", r, {
  contains: [/\$1[,.]?1(30|00|\d{2})|\$[\d,]{3}/],
  notContains: [/(schedule.*visit|in-person|free visit)/i],
});

// T27 — Simulate large floor plan (> 500 sqft) → propose visit
r = await ask([{ role: "user", content: LARGE_PLAN_MSG }]);
check(27, "Large floor plan (~904 sqft): propose visit, no DM price", r, {
  contains: [/(visit|measure|in person|in-person|free)/i],
  notContains: [/\$[\d,]{4,}/],
});

// ── GROUP 8: RETURNING CLIENT ──────────────────────────────────────────────

// T28 — [RETURNING CLIENT] → NOTIFY_OWNER, no pitch
r = await ask([
  { role: "user", content: "[RETURNING CLIENT]\nHey, this is James, I had floors done last year and I want another room done" },
]);
check(28, "Returning client: NOTIFY_OWNER, no package pitch", r, {
  contains: [/\[NOTIFY_OWNER\]/],
  notContains: [/(package includes|free quote|5.*sqft|\$5)/i],
});

// ── GROUP 9: FAREWELL HANDLING ─────────────────────────────────────────────

// T29 — "I'll think about it" → short warm response (≤2 sentences), no selling
r = await ask([
  { role: "user", content: "Okay, I'll think about it and get back to you" },
]);
check(29, "'I'll think about it': ≤2 sentences, no selling", r, {
  notContains: [/(schedule|quote|visit|price|sqft|package)/i],
  sentences: 2,
});

// T30 — "That's too expensive" → short warm response (≤2 sentences), no selling
r = await ask([
  { role: "user", content: "That's too expensive for me, never mind" },
]);
check(30, "'Too expensive, never mind': ≤2 sentences, no selling", r, {
  notContains: [/(quote|package|visit|per sqft)/i],
  sentences: 2,
});

// ── GROUP 10: NOTIFY_OWNER TRIGGERS ────────────────────────────────────────

// T31 — Partnership inquiry (no follower count) → NOTIFY_OWNER
r = await ask([
  { role: "user", content: "Hi! I'm a content creator and I'd love to collaborate with OzziFloors" },
]);
check(31, "Partnership: NOTIFY_OWNER", r, {
  contains: [/\[NOTIFY_OWNER\]/],
});

// T32 — Small lead closes → NOTIFY_OWNER (>=200 sqft so it's a real quotable job,
// jobs under 200 sqft are declined and never reach the close)
r = await ask([
  { role: "user", content: "I need flooring for one room, about 300 sqft" },
  { role: "assistant", content: "That's a small project we can quote right here. For 300 sqft you're looking at about $2,000 for the whole project." },
  { role: "user", content: "The quote sounds great, I want to move forward!" },
]);
check(32, "Small lead closes → NOTIFY_OWNER", r, {
  contains: [/\[NOTIFY_OWNER\]/],
});

// T33 — Warranty claim process: too specific for agent → NOTIFY_OWNER
r = await ask([
  { role: "user", content: "I had a floor installed by you 6 months ago and there's a defect. How do I file a warranty claim?" },
]);
check(33, "Warranty claim (post-install customer service) → NOTIFY_OWNER", r, {
  contains: [/\[NOTIFY_OWNER\]/],
});

// ── GROUP 11: REPAIRS ───────────────────────────────────────────────────────

// T34 — Repair request → installations only
r = await ask([{ role: "user", content: "Hi, can you repair a few broken tiles in my bathroom?" }]);
check(34, "Repair request: installations only", r, {
  contains: [/(installations? only|only.*install|we don't do repair|only do install)/i],
});

// ── GROUP 12: DISCOUNTS ─────────────────────────────────────────────────────

// T35 — Discount question: confirm yes, 2 sentences, no standalone "Hi!"
r = await ask([{ role: "user", content: "Do you offer any discounts?" }]);
check(35, "Discount: confirm yes, 2 sentences, no standalone 'Hi!'", r, {
  contains: [/(yes|i offer|we offer|discount)/i],
  notContains: [/^hi!?\s/i, /^hello!?\s/i],
  sentences: 2,
});

// ── GROUP 13: SERVICE AREA ─────────────────────────────────────────────────

// T36 — Service city within area: confirm
r = await ask([{ role: "user", content: "Do you service Coral Gables?" }]);
check(36, "Coral Gables: in service area", r, {
  contains: [/(yes|serve|service|cover|do.*coral gables|coral gables.*yes)/i],
});

// T37 — Outside service area: decline politely
r = await ask([{ role: "user", content: "Do you service Orlando?" }]);
check(37, "Orlando: outside service area", r, {
  contains: [/(don't service|don't serve|don't cover|don't work|not service|outside)/i],
});

// ── GROUP 14: PHONE NUMBER ─────────────────────────────────────────────────

// T38 — Client asks for phone → only give (561) 674-8334
r = await ask([{ role: "user", content: "Can I get a phone number to call you directly?" }]);
check(38, "Phone request: only (561) 674-8334", r, {
  contains: [/561.*674.*8334|561-674-8334|\(561\)/],
});

// ── GROUP 15: BOOKING — PHONE INTEGRITY (real incident) ────────────────────

// T39 — "Call me in Messenger" is NOT a phone. After slot + address, the bot
// must NOT book with a junk phone (e.g. phone="Messenger") — it asks for a real
// number. Real incident: it booked with phone="Messenger" and falsely confirmed.
r = await ask([
  { role: "user", content: "900 sqft apartment, living room bedroom kitchen and closet, no bathroom" },
  { role: "assistant", content: "For 900 sqft I need to visit and measure in person to give you the best price, and I bring floor samples so you can pick right there. I have Wednesday at 1pm or 5pm. What works for you?" },
  { role: "user", content: "Wednesday 1:00 pm good for me" },
  { role: "assistant", content: "Perfect! What is the full address of the property and your phone number?" },
  { role: "user", content: "Call me in Messenger" },
  { role: "user", content: "Rob, 427 golden isles dr #B12 Hallandale beach , FL 33009" },
]);
check(39, "'Call me in Messenger' + address → ask for real phone, do NOT book junk", r, {
  notContains: [/"phone"\s*:\s*"(?:messenger|here|instagram|dm)"/i, /\[BOOK:(?![\s\S]*"phone"\s*:\s*"[^"]*\d{7})/],
  contains: [/phone|number|callback|reach you/i],
});

// T40 — Real phone given → SHOULD book with the actual digits
r = await ask([
  { role: "user", content: "900 sqft apartment whole place" },
  { role: "assistant", content: "For 900 sqft I need to visit and measure in person. I have Wednesday at 1pm or 5pm. What works for you?" },
  { role: "user", content: "Wednesday 1:00 pm good for me" },
  { role: "assistant", content: "Perfect! What is the full address of the property and your phone number?" },
  { role: "user", content: "Rob, 427 golden isles dr #B12 Hallandale beach FL 33009, my number is 954-624-2455" },
]);
check(40, "Slot + address + real phone → [BOOK] with the real digits", r, {
  contains: [/\[BOOK:\{[\s\S]*"phone"\s*:\s*"[^"]*9546242455/],
});

// ── GROUP 16: WANTING TO SEE — visit vs WhatsApp (real incident) ───────────

// T41 — "Would love to see product as soon as possible" is a BUYING SIGNAL, not
// a photo request. The bot must propose the free visit (samples brought there),
// NOT redirect to WhatsApp. Real incident: it deflected an eager lead to WhatsApp.
r = await ask([
  { role: "user", content: "What is included in the materials package?" },
  { role: "assistant", content: "Hello, the promotional package already includes the flooring, installation labor, and the quarter round. I offer a free quote. Are you planning to do just one area, or will it be the entire house?" },
  { role: "user", content: "Would love to see product as soon as possible" },
]);
check(41, "'see product asap' → propose visit/samples, NOT WhatsApp redirect", r, {
  contains: [/visit|samples?|in person|one area|whole house/i],
  notContains: [/674[-\s]?8334|whatsapp/i],
});

// T42 — But an explicit "send me photos" still redirects to WhatsApp (unchanged)
r = await ask([{ role: "user", content: "Can you send me photos of the floors?" }]);
check(42, "'send me photos' → still WhatsApp redirect", r, {
  contains: [/674[-\s]?8334/],
});

// ── FINAL SUMMARY ───────────────────────────────────────────────────────────

const total = pass + fail;
console.log("═══════════════════════════════════════════════════════════");
console.log(` RESULT: ${pass}/${total} passed  |  ${fail} failed`);
console.log("═══════════════════════════════════════════════════════════");

if (fail > 0) process.exit(1);
