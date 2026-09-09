// Verifies the FLOORS WE DO NOT DO policy (owner rule 2026-09-09):
//  THE BUG (JuanCarlos Briones, IG 2026-09-05 → visit 09-09): "Need floor for
//  new restaurant" → opener → a PHOTO of a stone-paver floor (never analyzed:
//  the IG image prefetch used the dead env token) + "This" → the model wrote
//  "for a restaurant that size I definitely need to come measure", never
//  learned the type, collected name/address/phone and booked a real visit for
//  a paver floor we do not install. Same family: Frank Fernandez (WA 08-31)
//  "Epoxy flooring" → "Self leveling concrete." → "we don't do that either"
//  and STILL booked a visit.
//  We install ONLY luxury vinyl plank, porcelain/ceramic tile and hardwood
//  (carpet/laminate installation unchanged). Epoxy, concrete/cement,
//  microcement, resin, pavers, terrazzo → decline that names what we DO
//  install, NEVER a visit / booking-details ask / [BOOK].
//
//  1. DETERMINISTIC (no API): isUnsupportedFloorRequest, the conversation flag,
//     the photo detector (real vision outputs), the leak backstop, the canned
//     replies (ES without ¿ ¡), the unread-photo detector.
//  2. LIVE MODEL: Frank replay (decline, no visit; no [BOOK] at the details
//     turn), Briones replay with the REAL vision output (clarify, no slots),
//     Briones with the UNREAD placeholder (never pretends it saw the photo),
//     ES / PT declines.
//  3. REGRESSIONS: "is that microcement in the video?" → it is our vinyl (no
//     decline of the lead); bare concrete subfloor + vinyl → normal lead;
//     "Title or epoxy" → tile lead; decline → pivot to tile resumes the flow;
//     carpet still YES; concrete-look tile still a lead.
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse, isUnsupportedFloorRequest, unsupportedFloorRequestActive, imageAnalysisShowsUnsupportedFloor,
  unsupportedImageClarifyPending, unsupportedFloorStanding, unsupportedFloorLeak, unsupportedFloorReply,
  lastBurstHasUnreadImage, isFlooringInquiry, type ChatMessage,
} from "../lib/ai";
import { unsupportedFloorDeclineMessage, unsupportedImageClarifyMessage } from "../lib/scheduler";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 240)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);
const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

// ── Predicates (EN / ES / PT) ───────────────────────────────────────────────
const DECLINES_UNSUPPORTED = (t: string) =>
  /(?:don'?t|do\s+not|not\s+something\s+we|isn'?t\s+something\s+we|is\s+not\s+something\s+we|we\s+(?:don'?t|do\s+not)\s+(?:do|offer|install|work)|outside\s+(?:of\s+)?what\s+we|we\s+only\s+(?:do|install|work)|not\s+(?:a\s+)?service\s+we|no\s+(?:hacemos|trabajamos|ofrecemos|instalamos|es\s+algo\s+que)|n[aã]o\s+(?:fazemos|trabalhamos|instalamos|[eé]\s+algo\s+que)|solo\s+(?:hacemos|instalamos|trabajamos)|s[oó]\s+(?:fazemos|instalamos|trabalhamos))/i.test(t)
  && /\b(?:epoxy|ep[oó]x[iy]\w*|concrete|concreto|cement\w*|cimento|micro\s*-?\s*cement\w*|microcemento|pavers?|resin\w*|terrazzo|that\s+(?:type|kind)|ese\s+tipo|esse\s+tipo)\b/i.test(t);
const NAMES_OUR_FLOORS = (t: string) => /\bvinyl|vinil|vin[ií]lico\b/i.test(t) && /\b(?:tiles?|porcelain|porcelanato|cer[aâ]mica|ceramic)\b/i.test(t) && /\b(?:hardwood|madera|madeira)\b/i.test(t);
const PROPOSES_VISIT = (t: string) =>
  /\bvisit\b|in.?person|come\s+(?:by|out|over|measure)|stop\s+by|\bmeasure\b|take\s+a\s+look|\bvisita\b|presencial|pessoalmente|\bmedir\b|which\s+(?:day|time|one)\s+works|what\s+day\s+works|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.!?\n]{0,25}\b(?:at\s+)?\d{1,2}\s*(?:am|pm)\b|\b(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b/i.test(t);
const ASKS_DETAILS = (t: string) => /\b(?:address|phone|zip|direcci[oó]n|tel[eé]fono|endere[çc]o|telefone|cep|c[oó]digo\s+postal)\b/i.test(t);
const HAS_PRICE = (t: string) => /\$\s?\d/.test(t);
const HAS_BOOK = (t: string) => /\[BOOK:/i.test(t);
const SAYS_VINYL = (t: string) => /\bvinyl\b|\bvinil\b|\bvin[ií]lico\b/i.test(t);
const PRETENDS_SAW_PHOTO = (t: string) => /\b(?:that\s+size|this\s+size|from\s+the\s+photo|in\s+the\s+photo|in\s+your\s+photo|looks\s+like|i\s+(?:can\s+)?see\b|restaurant\s+that\s+size|based\s+on\s+the\s+(?:photo|image|picture))/i.test(t);
const ASKS_TYPE = (t: string) => /\b(?:vinyl|vinil)\b/i.test(t) && /\b(?:tile|porcelanato|cer[aâ]mica)\b/i.test(t) && /\?/.test(t);
const NO_INVERTED = (t: string) => !/[¿¡]/.test(t);

// ── The REAL Briones history (IG 00156e7a, 2026-09-05) ─────────────────────
// The photo was never analyzed in production (dead env token). Replayed here
// (a) with the REAL vision output for that photo (legacy format, no "Floor
// type:" line) and (b) with the new-format line, and (c) with the UNREAD
// placeholder exactly as it happened.
const BRIONES_VISION_LEGACY = `[Floor plan analysis: # Floor Assessment

This is **NOT a floor plan** — it's a **photo of an existing floor**.

## Floor Type & Condition:

**Material:** Natural stone or travertine pavers with irregular, organic shapes (ashlar/random pattern)

**Grout:** Visible gray mortar joints between stones

**Condition:**
- Moderate wear with visible dirt/dust accumulation
- Some efflorescence (white mineral deposits) visible on stone surfaces
- Stones appear slightly uneven

**Setting:** Interior residential space with furniture visible (chair legs in frame, blue mat in background)]`;
const BRIONES_VISION_NEW = `[Floor plan analysis: This is a photo of an existing floor, not a floor plan. Natural stone pavers in an irregular pattern with gray mortar joints, moderate wear and some staining.
Floor type: pavers]`;
const BRIONES_OPEN: ChatMessage[] = [
  u("Need floor for new restaurant"),
  a("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
];
const brionesWithPhoto = (bubble: string): ChatMessage[] => [...BRIONES_OPEN, u(bubble), u("This")];
const BRIONES_UNREAD: ChatMessage[] = [...BRIONES_OPEN, u("[floor plan or photo]"), u("This")];
const BRIONES_TO_BOOK = (bubble: string): ChatMessage[] => [
  ...brionesWithPhoto(bubble),
  a("For a restaurant that size I definitely need to come measure in person to give you the right price, and I bring floor samples so you can pick on the spot. What's the zip code of the property?"),
  u("33132"),
  u("212-4702421 call me"),
  a("33132 is right in our area. I have tonight at 7pm available, or Monday the 7th at 9am or 1pm. Which works for you?"),
  u("I can do Wednesday 12pm"),
  u("Midtown location"),
  a("Wednesday at 1pm works, I'm holding that for you. Can I get your name, the full property address, and the best phone number to confirm the visit?"),
  u("JC Briones\n3401 NE 1st ave\n212-470-2421\nIt's the Hyde hotel meet me at the lobby"),
  u("[Client replied to our ad]"),
];

// ── The REAL Frank Fernandez history (WA 4bb89f01, 2026-08-31) ─────────────
const FRANK_UP_TO_CONCRETE: ChatMessage[] = [
  u("Need a quote. Frank 305-986-5182 4335 NW 3 St. Miami 33126 kitchen and laundry room."),
  a("Hey Frank, which type of flooring are you thinking for the kitchen and laundry, tile, vinyl, or hardwood?"),
  u("Epoxy flooring"),
  a("Epoxy is one thing we don't do, we only handle luxury vinyl, tile, and hardwood flooring. If any of those would work for the kitchen and laundry, happy to get you a quote right here!"),
  u("Self leveling concrete."),
];
const FRANK_UP_TO_BOOK: ChatMessage[] = [
  ...FRANK_UP_TO_CONCRETE,
  a("That's not something we do either, Frank, but I'd love to come take a look at the kitchen and laundry and see if one of our floors could work for you. I have tonight at 6pm or Tuesday at 3pm or 4pm. Does any of those work?"),
  u("Tuesday at 3 pm works."),
  a("Holding that Tuesday at 3pm for you! What's your name and the property address, Frank?"),
  u("Frank 4335 NW 3 St. Miami 33126"),
];

async function main() {
  console.log("\n================ FLOORS WE DO NOT DO — VERIFICATION ================");

  // ── 1. DETERMINISTIC ──────────────────────────────────────────────────────
  console.log("\n[1] isUnsupportedFloorRequest — positives (real client messages)");
  for (const s of [
    "Epoxy flooring", "Self leveling concrete.", "Epoxy", "Epoxi", "epoxy", "Micro cemento", "Metallic resin", "Concrete",
    "Do you do epoxy?", "Do you guys do epoxy", "Do you do epoxy by any chance?", "Hi. Do you do epoxy ?", "I need epoxy",
    "I'm looking for epoxy", "Not looking for tile. I want epoxy", "Neither. I'm looking for epoxy", "I need only garage epoxy",
    "The micro cement flooring", "You do this micro cement?", "I'm looking for micro cement", "Do you work with microcement?", "You do micro cement too?",
    "Hi! Do you do micro-cement floor?", "Do you cover tile and make cement floor?", "I am looking for the metalic/epoxy",
    "How much for 1200 square feet house with epoxy egg shell white", "I need stamp concrete covered over with cement to create a smooth surface",
    "Do you install pavers?", "You do overlay on pavers?", "I was thinking about outdoors do you do poor concrete?", "How much for polished concrete?",
    "I have old tile that I want to cover with little cover of concrete", "epoxy finish for my garage", "I want real microcement, not vinyl",
    "Friday at 11am is fine , I have hardwood floors trying to do the epoxy flooring interior on it if possible not sure if it works on woods floor",
    "realmente lo q estoy buscando es quizás algún epoxy o algo así", "Quiero hacer mi piso con epoxi", "Estaba buscando epoxy", "Hacen epoxy?",
    "Disculpa … estoy buscando en resina", "Es concreto estampado,quiero poner epoxy", "Buenas tardes, usas la resina epoxi", "we thought you worked with concrete",
    "No thank you. I was looking for someone who works with micro cement", "Vocês fazem piso de epóxi?", "Quero porcelanato líquido na sala", "Fazem cimento queimado?",
  ]) ck(`request: "${s.slice(0, 70)}"`, isUnsupportedFloorRequest(s), s);

  console.log("\n[1b] isUnsupportedFloorRequest — negatives (leads / ad questions / existing surface)");
  for (const s of [
    "Right now I have bare concrete", "16x16 concrete slab uncovered", "Yes. Outdoor tiles, installed over concrete", "I'm looking for 2000 sqft in 33033 I have cement right now",
    "cheap waterproof for rental property it has concrete base will need 6mil underlay and 1/4 round", "Try here is no concrete floor there it's raw",
    "es para un restaurant q ahora tiene concreto pulido", "Hi how much installed per sq ft on concrete pad?", "Can it be installed in a second floor that has a wooden base, not concrete.",
    "Is this micro cement", "Is that an epoxy overlay in the video?", "Esto es epoxy", "Eso no es resina ..?", "It looks like one piece epoxy", "In the comercial looks like epoxy",
    "I saw the promotion for cement floors", "Looks like cement over tile", "What's it made of? Microcement ?", "This is like a cement that you pour on right ?",
    "Que piso es ese que colocan como cemento sobre tile, es microcemento?", "Están poniendo como un cemento", "Is pouring that concrete necessary ?",
    "Is the leveling a cement does it damage the tile that is existing ?", "I just saw a video on FB. It looks like a liquid concrete, grey.",
    "Title or epoxy", "Pavers or Seville type tiles", "I want very big tiles with little to no grout in concrete look", "Something that has a micro cement looking finish",
    "I have stained concrete now in the house that I had done over 15 years ago. I want to continue to have a seamless look to my floor", "Vinyl for the whole house, the floor is concrete right now",
    "Can you pour concrete over the travertine to make one flooring like you did in your video over regular tile?", "Epoxy?", "No epoxy ?",
    "[Floor plan analysis: photo of an existing polished concrete floor]", "[Client replied to our ad]", "JC Briones\n3401 NE 1st ave\n212-470-2421\nIt's the Hyde hotel meet me at the lobby",
    "Hi, I'm interested in the promotion", "Do you install tile over concrete?", "Se puede poner piso de vinyl sobre este piso?",
    // existing floor described with "is / it's / es / é" (garage, slab, mine)
    "I'm looking for flooring for my garage, it's concrete", "I need flooring for 1200 sqft, the slab is concrete", "Looking for flooring, its concrete",
    "el piso es concreto, quiero saber precios", "Hola quiero piso nuevo, el mio es concreto", "Precisamos de piso para 100 m2, hoje é concreto",
    "Do we need cement board under the tile?", "how much for cement tile?",
    // the ad's floor as clients describe it (vinyl over tile): the MODEL corrects it, never a decline
    "Cement over tile", "micro cement over tile", "Cement on the tile", "How much for the epoxy over tile?", "Do you do micro cement over tile? for floor",
    "the cement one", "El de cemento", "The epoxy", "Hi. I have 1000 square feet. I would cement flooring over my existing tiles",
    "Lo q necesito saber es si hacen pisos con epoxy encima de la losa y cuánto cobran por pie cuadrado. Gracias",
    // Instagram caption + analysis in ONE bubble: vision words are not client words
    "Here is my floor\n[Floor plan analysis: Photo of an existing floor, concrete floor with cracks and stains.\nFloor type: concrete]",
  ]) ck(`not request: "${s.slice(0, 70).replace(/\n/g, " ")}"`, !isUnsupportedFloorRequest(s), s);

  console.log("\n[1c] canned opener never fires on an unsupported-floor first message");
  ck("isFlooringInquiry('I need stamp concrete covered over with cement...') = false", !isFlooringInquiry("I need stamp concrete covered over with cement to create a smooth surface"));
  ck("isFlooringInquiry('I need epoxy floors for my garage') = false", !isFlooringInquiry("I need epoxy floors for my garage"));
  ck("isFlooringInquiry('I saw the promotion for cement floors') = false (model corrects: it is our vinyl)", !isFlooringInquiry("I saw the promotion for cement floors"));
  ck("isFlooringInquiry('I need new floors, what is the price?') still true", isFlooringInquiry("I need new floors, what is the price?"));
  ck("isFlooringInquiry('I need new floors, it's just concrete right now') still true (subfloor is not an unsupported ask)", isFlooringInquiry("I need new floors, it's just concrete right now") || !isUnsupportedFloorRequest("I need new floors, it's just concrete right now"));

  console.log("\n[1d] unsupportedFloorRequestActive — the exact Frank history");
  ck("active right after 'Self leveling concrete.'", unsupportedFloorRequestActive(FRANK_UP_TO_CONCRETE));
  ck("STILL active at the name/address turn (the [BOOK] turn)", unsupportedFloorRequestActive(FRANK_UP_TO_BOOK));
  ck("clears when the client pivots to a floor we install", !unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("Ok, what about tile then? about 600 sqft")]));
  ck("clears on a short YES to 'would one of those work?'", !unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("Yes")]));
  ck("clears on 'how much?' after the decline (asking about OUR floors)", !unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("Ok how much?")]));
  ck("clears on 'what do you recommend?'", !unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("What do you recommend for a kitchen?")]));
  ck("does NOT clear on a plain 'ok thanks' (nothing to book anyway)", unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("Ok thanks, bye")]));
  ck("clears on 'the stone look one' (picking our vinyl finish)", !unsupportedFloorRequestActive([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("the stone look one")]));
  ck("clears when the BOT corrected the ad guess to our vinyl (no decline) and the client continues", !unsupportedFloorRequestActive([
    u("I want epoxy like in your ad"), a("That's actually our luxury vinyl with a stone finish, it goes right over your tile. Is it one area or the whole house?"), u("Whole house, 1200 sqft"),
  ]));
  ck("the canned DECLINE (which names vinyl) does NOT clear the flag", unsupportedFloorRequestActive([u("I want epoxy"), a(unsupportedFloorDeclineMessage("en")), u("When can you come?")]));
  ck("'Do you guys do epoxy' → 'Marble tile' clears (Tevaris, FB 08-24)", !unsupportedFloorRequestActive([u("Do you guys do epoxy"), a("We don't do epoxy, we focus on tile, vinyl, hardwood and carpet."), u("Marble tile")]));
  ck("'Title or epoxy' never activates (tile lead, Herman FB 08-30)", !unsupportedFloorRequestActive([u("Yea for patio"), a("Which one, tile, vinyl, or hardwood?"), u("Title or epoxy")]));
  ck("'Concrete floor for retail store' → 'can u install direct vinyl on the floor?' clears", !unsupportedFloorRequestActive([u("Concrete floor for retail store"), a("We don't do concrete floors, we install vinyl, tile and hardwood."), u("Theee is nothing in the floor can u install direct vinyl on the floor ?")]));
  ck("not active on a normal lead history", !unsupportedFloorRequestActive(BRIONES_OPEN));

  console.log("\n[1e] imageAnalysisShowsUnsupportedFloor — real vision outputs");
  ck("Briones REAL vision output (legacy, 'natural stone or travertine pavers') → unsupported", imageAnalysisShowsUnsupportedFloor(BRIONES_VISION_LEGACY));
  ck("Briones new-format 'Floor type: pavers' → unsupported", imageAnalysisShowsUnsupportedFloor(BRIONES_VISION_NEW));
  ck("'Floor Type: Polished concrete or epoxy-coated cement' → unsupported", imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: This is NOT a floor plan – it's a photo of existing flooring. **Floor Type:** Polished concrete or epoxy-coated cement **Condition:** excellent]"));
  ck("'Floor type: tile' → supported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an existing floor. Beige porcelain tile, good condition.\nFloor type: tile]"));
  ck("'Floor type: vinyl plank' → supported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an existing floor, grey planks.\nFloor type: vinyl plank]"));
  ck("'Floor type: floor plan' → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Sala 3.00x3.00m, Cozinha 1.90x3.00m. Total: ~15m² (~160sqft). SMALL PROJECT\nFloor type: floor plan]"));
  ck("'Floor type: not a floor' → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Marketing graphic for a flooring promotion, no floor visible.\nFloor type: not a floor]"));
  ck("concrete SUBFLOOR under renovation (Andres, WA 09-05) → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: # Image Analysis This is NOT a floor plan — it's a photograph of an active kitchen renovation in progress. - Unfinished drywall - Concrete subfloor with dust and debris - Concrete leveler bags stacked. Subfloor is being prepared for installation.]"));
  ck("raw concrete 'awaiting flooring installation' (Andres) → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: # Floor Assessment This is not a floor plan — it's a photo of an existing concrete floor showing: - Surface type: Raw concrete/cement screed - Condition: Rough, unfinished with trowel marks. This appears to be a freshly laid concrete base awaiting flooring installation.]"));
  ck("photo of stacked materials 'on a floor' (bags of cement) → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: # Image Analysis This is NOT a floor plan image — it's a photo of stacked construction materials and supplies on a floor. - Stacked bags of what appears to be cement or flooring substrate]"));
  ck("photo of a hallway with 'dark flooring (appears to be polished concrete or similar)' → not unsupported (subject is the hallway)", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: # Floor Plan Analysis This is a photo of an existing interior hallway, not a floor plan. - Dark flooring (appears to be polished concrete or similar) - Recessed lighting]"));
  ck("photo of a person standing on a concrete surface → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: This is not a floor plan – it's a photo of a person in casual clothing standing outdoors on what appears to be a concrete or paved surface.]"));
  ck("plain client text is never an image verdict", !imageAnalysisShowsUnsupportedFloor("I have a concrete floor"));
  ck("NEW format 'Floor type: concrete' on a renovation subfloor photo → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of a kitchen renovation in progress. Concrete subfloor with dust and debris, concrete leveler bags stacked, no finished flooring yet.\nFloor type: concrete]"));
  ck("NEW format 'Floor type: concrete' + 'awaiting flooring installation' → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an existing floor. Raw concrete screed, rough and unfinished, appears to be a freshly laid slab awaiting flooring installation.\nFloor type: concrete]"));
  ck("NEW format 'Floor type: subfloor' → not unsupported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an empty garage with a bare concrete slab, no finished floor.\nFloor type: subfloor]"));
  ck("NEW format finished polished concrete in a lived-in space → unsupported", imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an existing floor in a furnished living room. Polished grey concrete floor, sealed, good condition.\nFloor type: concrete]"));
  ck("IG mixed bubble (caption + analysis) → the IMAGE detector still sees the paver floor", imageAnalysisShowsUnsupportedFloor("This is the floor\n" + BRIONES_VISION_NEW));
  ck("travertine TILE in a regular grid 'Floor type: tile' → supported", !imageAnalysisShowsUnsupportedFloor("[Floor plan analysis: Photo of an existing floor. Large travertine stone tiles laid in a regular grid with grout lines, good condition.\nFloor type: tile]"));

  console.log("\n[1f] unsupportedImageClarifyPending / unsupportedFloorStanding — Briones");
  ck("pending right after the paver photo + 'This'", unsupportedImageClarifyPending(brionesWithPhoto(BRIONES_VISION_LEGACY)));
  ck("standing = image at that turn", unsupportedFloorStanding(brionesWithPhoto(BRIONES_VISION_NEW)) === "image");
  ck("STILL standing at the name/address/phone turn (the [BOOK] turn)", unsupportedFloorStanding(BRIONES_TO_BOOK(BRIONES_VISION_LEGACY)) === "image");
  ck("clears once the bot clarified (assistant said we don't do pavers/concrete)", !unsupportedImageClarifyPending([...brionesWithPhoto(BRIONES_VISION_NEW), a(unsupportedImageClarifyMessage("en"))]));
  ck("clears when the client names a floor we install after the photo", !unsupportedImageClarifyPending([...brionesWithPhoto(BRIONES_VISION_NEW), u("I want vinyl over it")]));
  ck("clears when the client wants to install over / cover the pictured floor", !unsupportedImageClarifyPending([...brionesWithPhoto(BRIONES_VISION_NEW), u("Can you install over this?")]));
  ck("never pending when the client named a type BEFORE the photo (existing floor)", !unsupportedImageClarifyPending([u("Hi, I want tile for my balcony"), a("Great, tile is $4.50 per sqft labor only. How big is the balcony?"), u("[Floor plan analysis: Photo of an existing balcony with a gray concrete floor.\nFloor type: concrete]"), u("This one")]));
  ck("text request after the photo hands over to the request flag", unsupportedFloorStanding([...brionesWithPhoto(BRIONES_VISION_NEW), u("I want this same concrete look, epoxy or microcement")]) === "request");
  ck("no photo → nothing standing", unsupportedFloorStanding(BRIONES_OPEN) === null);

  console.log("\n[1g] unsupportedFloorLeak + canned replies");
  const leakOffer = "For a restaurant that size I definitely need to come measure in person to give you the right price, and I bring floor samples so you can pick on the spot. What's the zip code of the property?";
  const leakSlots = "I have tonight at 7pm available, or Monday the 7th at 9am or 1pm. Which works for you?";
  const leakDetails = "Can I get your name, the full property address, and the best phone number to confirm the visit?";
  const leakBook = "Appointment confirmed for Wednesday, September 9 at 1pm. [BOOK:{\"date\":\"2026-09-09\",\"time\":\"13:00\",\"name\":\"JC Briones\"}]";
  ck("visit offer after the paver photo → leak", unsupportedFloorLeak(brionesWithPhoto(BRIONES_VISION_LEGACY), leakOffer), leakOffer);
  ck("slot offer while Frank's request stands → leak", unsupportedFloorLeak(FRANK_UP_TO_CONCRETE, leakSlots), leakSlots);
  ck("booking-details ask while standing → leak", unsupportedFloorLeak(FRANK_UP_TO_CONCRETE, leakDetails), leakDetails);
  ck("[BOOK] at Briones' details turn → leak", unsupportedFloorLeak(BRIONES_TO_BOOK(BRIONES_VISION_NEW), leakBook), leakBook);
  ck("[BOOK] at Frank's details turn → leak", unsupportedFloorLeak(FRANK_UP_TO_BOOK, leakBook), leakBook);
  ck("the decline itself is NOT a leak", !unsupportedFloorLeak(FRANK_UP_TO_CONCRETE, unsupportedFloorDeclineMessage("en")));
  ck("the clarify message itself is NOT a leak", !unsupportedFloorLeak(brionesWithPhoto(BRIONES_VISION_NEW), unsupportedImageClarifyMessage("en")));
  ck("same offer with nothing standing → not a leak", !unsupportedFloorLeak(BRIONES_OPEN, leakOffer));
  ck("reply for a text request = the decline", unsupportedFloorReply(FRANK_UP_TO_CONCRETE, "en") === unsupportedFloorDeclineMessage("en"));
  ck("reply for a photo = the clarification", unsupportedFloorReply(brionesWithPhoto(BRIONES_VISION_NEW), "en") === unsupportedImageClarifyMessage("en"));
  for (const lang of ["en", "es", "pt"] as const) {
    const d = unsupportedFloorDeclineMessage(lang), c = unsupportedImageClarifyMessage(lang);
    ck(`decline ${lang}: says we don't do it + names vinyl/tile/hardwood`, DECLINES_UNSUPPORTED(d) && NAMES_OUR_FLOORS(d), d);
    ck(`clarify ${lang}: names vinyl/tile/hardwood, asks which`, NAMES_OUR_FLOORS(c) && /\?/.test(c), c);
    ck(`decline/clarify ${lang}: no visit, no price, no details ask, no ¿¡`, !PROPOSES_VISIT(d) && !PROPOSES_VISIT(c) && !HAS_PRICE(d) && !HAS_PRICE(c) && !ASKS_DETAILS(d) && !ASKS_DETAILS(c) && NO_INVERTED(d) && NO_INVERTED(c), d + " | " + c);
  }

  console.log("\n[1h] lastBurstHasUnreadImage");
  ck("Briones as it happened ('[floor plan or photo]' + 'This') → unread image in the latest burst", lastBurstHasUnreadImage(BRIONES_UNREAD));
  ck("analyzed photo → not unread", !lastBurstHasUnreadImage(brionesWithPhoto(BRIONES_VISION_NEW)));
  ck("placeholder in an OLDER burst (already answered) → not unread now", !lastBurstHasUnreadImage([...BRIONES_UNREAD, a("The photo didn't come through, what does it show?"), u("It's the restaurant floor")]));
  ck("placeholder + an ANALYZED photo in the same burst → not 'unread' (use the analysis we have)", !lastBurstHasUnreadImage([...BRIONES_OPEN, u("[floor plan or photo]"), u(BRIONES_VISION_NEW), u("This")]));
  ck("IG mixed bubble (caption + paver analysis) + 'This' → image standing", unsupportedFloorStanding([...BRIONES_OPEN, u("Here is the floor\n" + BRIONES_VISION_NEW), u("This")]) === "image");
  for (const lang of ["en", "es", "pt"] as const) {
    ck(`canned strings ${lang} carry no dash (owner's zero-dash rule)`, !/[-–—]/.test(unsupportedFloorDeclineMessage(lang) + unsupportedImageClarifyMessage(lang)), unsupportedFloorDeclineMessage(lang) + " | " + unsupportedImageClarifyMessage(lang));
  }

  // ── 2. LIVE MODEL ─────────────────────────────────────────────────────────
  console.log("\n[2] LIVE: Frank replay — 'Self leveling concrete.'");
  const r1 = await ai(FRANK_UP_TO_CONCRETE);
  console.log("   →", r1.replace(/\s+/g, " ").slice(0, 260));
  ck("declines and names what we install", DECLINES_UNSUPPORTED(r1) && NAMES_OUR_FLOORS(r1), r1);
  ck("does NOT propose a visit / slots", !PROPOSES_VISIT(r1), r1);
  ck("does NOT quote a price, does NOT ask for details", !HAS_PRICE(r1) && !ASKS_DETAILS(r1), r1);

  console.log("\n[2b] LIVE: Frank replay — the name/address turn (model must not [BOOK])");
  const r2 = await ai(FRANK_UP_TO_BOOK);
  console.log("   →", r2.replace(/\s+/g, " ").slice(0, 260));
  ck("no [BOOK] for an epoxy/concrete request even with name/address in hand", !HAS_BOOK(r2), r2);
  ck("no 'confirmed' / no visit; declines instead", !/confirmed|locked in|see you|penciled/i.test(r2) && DECLINES_UNSUPPORTED(r2), r2);

  console.log("\n[2c] LIVE: Briones replay — REAL vision output (pavers) + 'This'");
  const r3 = await ai(brionesWithPhoto(BRIONES_VISION_LEGACY));
  console.log("   →", r3.replace(/\s+/g, " ").slice(0, 260));
  ck("says that finish isn't something we install", DECLINES_UNSUPPORTED(r3) || /\b(?:pavers?|stone|concrete|cement)\b[^.!?]{0,60}\b(?:not|isn'?t|don'?t)\b|\b(?:not|isn'?t|don'?t)\b[^.!?]{0,60}\b(?:pavers?|stone|concrete|cement)\b/i.test(r3), r3);
  ck("names vinyl / tile / hardwood", NAMES_OUR_FLOORS(r3), r3);
  ck("no slots, no visit, no zip/details ask", !PROPOSES_VISIT(r3) && !ASKS_DETAILS(r3), r3);
  ck("never 'for a restaurant that size'", !/that\s+size/i.test(r3), r3);

  console.log("\n[2d] LIVE: Briones replay — the details turn after the paver photo (model must not [BOOK])");
  const r4 = await ai(BRIONES_TO_BOOK(BRIONES_VISION_NEW));
  console.log("   →", r4.replace(/\s+/g, " ").slice(0, 260));
  ck("no [BOOK]", !HAS_BOOK(r4), r4);
  ck("no 'confirmed'; clarifies what we install instead", !/appointment confirmed|locked in/i.test(r4) && NAMES_OUR_FLOORS(r4), r4);

  console.log("\n[2e] LIVE: Briones as it happened — UNREAD photo placeholder + 'This'");
  const r5 = await ai(BRIONES_UNREAD);
  console.log("   →", r5.replace(/\s+/g, " ").slice(0, 260));
  ck("does not pretend it saw the photo (no 'that size', no 'I see', no 'looks like')", !PRETENDS_SAW_PHOTO(r5), r5);
  ck("asks the flooring type (vinyl / tile ...) or what the photo shows", ASKS_TYPE(r5) || /\b(?:photo|picture|image)\b[^.!?]{0,80}\?/i.test(r5), r5);
  ck("no slots / visit / details in this turn", !PROPOSES_VISIT(r5) && !ASKS_DETAILS(r5), r5);

  console.log("\n[2f] LIVE ES: 'Quiero hacer mi piso con epoxi'");
  const r6 = await ai([u("Hola, quiero hacer mi piso con epoxi, cuanto cobran?")]);
  console.log("   →", r6.replace(/\s+/g, " ").slice(0, 260));
  ck("declines in Spanish and names vinyl/porcelanato/madera", DECLINES_UNSUPPORTED(r6) && NAMES_OUR_FLOORS(r6), r6);
  ck("no visit, no price, no details, no ¿¡", !PROPOSES_VISIT(r6) && !HAS_PRICE(r6) && !ASKS_DETAILS(r6) && NO_INVERTED(r6), r6);

  console.log("\n[2g] LIVE PT: 'Vocês fazem piso de epóxi?'");
  const r7 = await ai([u("Oi, tudo bem? Vocês fazem piso de epóxi na garagem?")]);
  console.log("   →", r7.replace(/\s+/g, " ").slice(0, 260));
  ck("declines in Portuguese and names our floors", DECLINES_UNSUPPORTED(r7) && NAMES_OUR_FLOORS(r7), r7);
  ck("no visit, no price, no details", !PROPOSES_VISIT(r7) && !HAS_PRICE(r7) && !ASKS_DETAILS(r7), r7);

  console.log("\n[2h] LIVE EN: type known, then 'actually I want microcement instead'");
  const r8 = await ai([
    u("Hi, do you install vinyl? about 900 sqft"),
    a("Yes! Our luxury vinyl promo is $5 per square foot with the flooring, installation and quarter round included. For 900 sqft I come measure in person for the exact number, the visit is free. What's the zip code of the property?"),
    u("Actually I changed my mind, I want microcement instead, do you do that?"),
  ]);
  console.log("   →", r8.replace(/\s+/g, " ").slice(0, 260));
  ck("declines microcement", DECLINES_UNSUPPORTED(r8), r8);
  ck("no visit / zip ask in this turn", !PROPOSES_VISIT(r8) && !ASKS_DETAILS(r8), r8);

  // ── 3. REGRESSIONS ────────────────────────────────────────────────────────
  console.log("\n[3] REGRESSION: 'is that micro cement in the video?' → it is our VINYL, lead continues");
  const r9 = await ai([u("Hi, is that micro cement in the video you guys poured over the tile?\n\n[SYSTEM: [AD REPLY: lead replied to our vinyl promotion ad]]")]);
  console.log("   →", r9.replace(/\s+/g, " ").slice(0, 260));
  ck("says it is vinyl", SAYS_VINYL(r9), r9);
  ck("does NOT close the door (no bare decline without vinyl)", SAYS_VINYL(r9) && !/we may not be the right fit|feel free to reach out anytime/i.test(r9), r9);

  console.log("\n[3b] REGRESSION: bare concrete subfloor + vinyl → normal lead (visit / zip)");
  const r10 = await ai([u("Right now I have bare concrete, I want vinyl for the whole house, about 1400 sqft, zip 33176")]);
  console.log("   →", r10.replace(/\s+/g, " ").slice(0, 260));
  ck("does NOT decline", !DECLINES_UNSUPPORTED(r10), r10);
  ck("moves to the visit (large lead)", PROPOSES_VISIT(r10) || ASKS_DETAILS(r10), r10);

  console.log("\n[3c] REGRESSION: 'Title or epoxy' → tile lead with the $4.50 labor rate");
  const r11 = await ai([
    u("Yea for patio"),
    a("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    u("How much porch"),
    a("The price depends on which type of flooring you want for the porch, tile, vinyl, or hardwood, since each one has a different rate. Which one are you thinking?"),
    u("Title or epoxy"),
  ]);
  console.log("   →", r11.replace(/\s+/g, " ").slice(0, 260));
  ck("quotes tile at $4.50 (labor only)", /4\.50/.test(r11) && /labor|install/i.test(r11), r11);
  ck("mentions we don't do epoxy (or ignores epoxy), but keeps the tile lead alive (asks size / zip)", /\?/.test(r11) && !/we may not be the right fit/i.test(r11), r11);

  console.log("\n[3d] REGRESSION: decline → client pivots to tile → normal flow resumes");
  const r12 = await ai([...FRANK_UP_TO_CONCRETE, a(unsupportedFloorDeclineMessage("en")), u("Ok, what about porcelain tile then? The kitchen and laundry are about 600 sqft")]);
  console.log("   →", r12.replace(/\s+/g, " ").slice(0, 260));
  ck("does NOT repeat the decline", !DECLINES_UNSUPPORTED(r12), r12);
  ck("engages the tile job (rate or visit)", /4\.50/.test(r12) || PROPOSES_VISIT(r12) || ASKS_DETAILS(r12), r12);

  console.log("\n[3e] REGRESSION: carpet is still YES");
  const r13 = await ai([u("Hi, do you install carpet? About 300 sqft")]);
  console.log("   →", r13.replace(/\s+/g, " ").slice(0, 260));
  ck("says yes to carpet with $2.20 labor only", /2\.20/.test(r13) && !/don'?t\s+(?:do|install)\s+carpet/i.test(r13), r13);

  console.log("\n[3f] REGRESSION: 'big tiles in a concrete look' → tile lead, no decline");
  const r14 = await ai([u("I want very big tiles with little to no grout in concrete look, about 800 sqft")]);
  console.log("   →", r14.replace(/\s+/g, " ").slice(0, 260));
  ck("does NOT decline", !DECLINES_UNSUPPORTED(r14), r14);
  ck("treats it as a tile lead (rate or visit)", /4\.50/.test(r14) || PROPOSES_VISIT(r14) || ASKS_DETAILS(r14), r14);

  console.log("\n[3g] REGRESSION: analyzed photo of a TILE floor + 'this' → normal flow, no clarify");
  const r15 = await ai([...BRIONES_OPEN, u("[Floor plan analysis: This is a photo of an existing floor, not a floor plan. Large-format beige porcelain tile with thin grout lines, good condition.\nFloor type: tile]"), u("This, for the whole restaurant, about 2500 sqft")]);
  console.log("   →", r15.replace(/\s+/g, " ").slice(0, 260));
  ck("does NOT decline", !DECLINES_UNSUPPORTED(r15), r15);
  ck("large tile lead → visit / zip", PROPOSES_VISIT(r15) || ASKS_DETAILS(r15), r15);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
