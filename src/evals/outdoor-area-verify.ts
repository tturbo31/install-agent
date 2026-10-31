// Verifies the OUTDOOR AREAS rule (owner, 2026-10-31): "say yes, we also do
// floors for the outside area, as long as it is porcelain tile or vinyl; we
// don't work with epoxy, pavers, cement or brick".
//  1. DETERMINISTIC (no API): brick joins the floors we do not do (EN / ES /
//     PT, "brick look" tile and "Brickell" never count, a brick patio as the
//     EXISTING surface is a normal lead), an outdoor area by itself is never a
//     decline, the canned decline names brick in the three languages, and the
//     prompt / CRITICAL note / rule 40 / dreaming constraint carry the rule.
//  2. LIVE MODEL: "do you do outdoor floors / patio?" (EN / ES / PT) → yes with
//     porcelain tile or vinyl; brick / pavers / stamped concrete for a patio →
//     decline that material, offer tile or vinyl, no price, no visit; porcelain
//     tile for a lanai → normal lead.
// Set DET_ONLY=1 to run only the deterministic sections.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isUnsupportedFloorRequest, mentionsUnsupportedFloor, unsupportedFloorStanding, unsupportedFloorLeak, unsupportedFloorReply, UNSUPPORTED_FLOOR_NOTE, type ChatMessage } from "../lib/ai";
import { unsupportedFloorDeclineMessage } from "../lib/scheduler";

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
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const src0 = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");

const DECLINE = /\b(?:don'?t|do\s+not)\s+(?:do|work|install|offer)\b|not\s+something\s+we|isn'?t\s+something\s+we|only\s+(?:do|install|work)\s+(?:on\s+)?(?:indoor|inside|interior)|\bno\s+(?:hacemos|trabajamos|instalamos)\b|no\s+es\s+algo\s+que|n[aã]o\s+(?:fazemos|trabalhamos|instalamos)\b|can'?t\s+(?:do|take)/i;
const OUR_TWO = /porcelain|porcelanato|\btiles?\b|cer[aá]mic|v[iy]n[iy]l|vin[ií]lico/i;
const NO_PRICE_NO_VISIT = (r: string) => !/\$\s?\d/.test(r) && !/\[BOOK:/i.test(r) && !/free\s+(?:visit|estimate)|come\s+(?:by|out|measure)|in\s+person|visita|zip\s*code|c[oó]digo\s+postal/i.test(r);

async function main() {
  console.log("\n[1] DETERMINISTIC — brick joins the list, outdoor alone is never a decline, wiring");
  for (const s of [
    "I want brick for my patio", "Do you do brick floors?", "How much for brick pavers on the patio?",
    "quiero ladrillo para el patio", "vocês fazem piso de tijolo?", "Brick", "pavers for my patio",
    "Can you do stamped concrete on my pool deck?", "epoxy for the porch",
  ]) ck(`unsupported request: ${JSON.stringify(s)}`, isUnsupportedFloorRequest(s), s);
  for (const s of [
    "Do you guys do outdoor floors?", "I want to redo my patio, about 500 sqft", "porcelain tile for my lanai, 600 sqft",
    "quiero vinyl para el patio de afuera", "Vocês fazem piso na área externa?", "brick look porcelain tile for the porch",
    "I have a brick patio and want porcelain tile over it", "I live in Brickell, 1200 sqft vinyl", "red brick tile for the kitchen",
    "Hacen pisos para afuera? Es la terraza", "the patio is concrete right now, I want tile",
  ]) ck(`NOT an unsupported request: ${JSON.stringify(s)}`, !isUnsupportedFloorRequest(s), s);
  ck("Brickell is not even a mention", !mentionsUnsupportedFloor("I live in Brickell"));
  ck("standing: brick request, then 'ok porcelain tile then' clears it", unsupportedFloorStanding([U("I want brick for the patio"), { role: "assistant", content: unsupportedFloorDeclineMessage("en") }, U("ok porcelain tile then")]) === null);
  for (const lang of ["en", "es", "pt"] as const) {
    const line = unsupportedFloorDeclineMessage(lang);
    ck(`decline ${lang}: names brick`, /brick|ladrillo|tijolo/i.test(line), line);
    ck(`decline ${lang}: still names pavers and epoxy`, /pavers/i.test(line) && /ep[oó]x/i.test(line), line);
    ck(`decline ${lang}: no ¿ ¡ and no dash`, !/[¿¡—–]/.test(line), line);
  }
  for (const lang of ["en", "es", "pt"] as const) {
    const line = unsupportedFloorDeclineMessage(lang, true);
    const std = [U("I want brick pavers for my patio")];
    ck(`outdoor decline ${lang}: only porcelain tile or vinyl, never hardwood / carpet`, OUR_TWO.test(line) && !/hardwood|carpet|madera|alfombra|madeira|carpete/i.test(line), line);
    ck(`outdoor decline ${lang}: names brick and pavers`, /brick|ladrillo|tijolo/i.test(line) && /pavers/i.test(line), line);
    ck(`outdoor decline ${lang}: never flags itself as a leak`, !unsupportedFloorLeak(std, line), line);
    ck(`outdoor decline ${lang}: no ¿ ¡ and no dash`, !/[¿¡—–]/.test(line), line);
    ck(`regular decline ${lang}: never flags itself as a leak`, !unsupportedFloorLeak([U("I want epoxy in the kitchen")], unsupportedFloorDeclineMessage(lang)));
  }
  ck("reply: patio → outdoor decline", unsupportedFloorReply([U("I want brick pavers for my patio")], "en") === unsupportedFloorDeclineMessage("en", true));
  ck("reply: kitchen → regular decline", unsupportedFloorReply([U("I want epoxy in the kitchen")], "en") === unsupportedFloorDeclineMessage("en"));
  ck("reply: ES terraza → outdoor decline", unsupportedFloorReply([U("quiero ladrillo en la terraza")], "es") === unsupportedFloorDeclineMessage("es", true));
  ck("prompt / note examples never use 'work for you' (reads as a slot offer and gets swapped)", !/patio we can install porcelain tile or vinyl\. Would one of those work for you/.test(src0("src/lib/system-prompt.ts") + UNSUPPORTED_FLOOR_NOTE));
  ck("note: brick in the header and outdoor areas are not the problem", /PAVERS \/ BRICK/.test(UNSUPPORTED_FLOOR_NOTE) && /OUTDOOR AREAS ARE NOT THE PROBLEM/.test(UNSUPPORTED_FLOOR_NOTE) && /porcelain tile or vinyl/.test(UNSUPPORTED_FLOOR_NOTE));
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");
  const prompt = src("src/lib/system-prompt.ts");
  ck("prompt: OUTDOOR AREAS section says yes with porcelain tile or vinyl", /## OUTDOOR AREAS: YES, WITH PORCELAIN TILE OR VINYL/.test(prompt) && /NEVER say we only do indoor floors/.test(prompt));
  ck("prompt: brick in FLOORS WE DO NOT DO", /## FLOORS WE DO NOT DO \([^)]*BRICK/.test(prompt) && /brick or any paving/.test(prompt));
  ck("brain rule 40: outdoor areas are a yes", /40\. FLOORS WE DO NOT DO[\s\S]{0,700}OUTDOOR AREAS ARE A YES/.test(src("src/lib/ai.ts")));
  ck("dreaming: constraint 20", /20\. OUTDOOR AREAS YES, WITH PORCELAIN TILE OR VINYL/.test(src("src/lib/dreaming.ts")));

  if (process.env.DET_ONLY) { done(); return; }

  console.log("\n[2] LIVE MODEL — outdoor = yes with porcelain tile or vinyl; brick / pavers / cement = decline the material");
  {
    const r = await ai([U("Do you guys do outdoor floors? I want to redo my back patio")]);
    ck("EN 'outdoor floors / patio?': yes, porcelain tile or vinyl, no decline", !DECLINE.test(r) && OUR_TWO.test(r) && !/\[BOOK:/i.test(r), r);
  }
  {
    const r = await ai([U("Hacen pisos para afuera? Es el patio de atrás de la casa")]);
    ck("ES 'pisos para afuera?': sí, porcelanato o vinyl, sin ¿ ¡", !DECLINE.test(r) && OUR_TWO.test(r) && !/[¿¡]/.test(r), r);
  }
  {
    const r = await ai([U("Vocês fazem piso na área externa? É uma varanda")]);
    ck("PT 'área externa?': sim, porcelanato ou vinil", !DECLINE.test(r) && OUR_TWO.test(r), r);
  }
  {
    const r = await ai([U("I want brick pavers for my patio, how much?")]);
    ck("brick pavers for the patio: decline the material, offer tile / vinyl, no price, no visit", DECLINE.test(r) && OUR_TWO.test(r) && NO_PRICE_NO_VISIT(r), r);
  }
  {
    const r = await ai([U("Can you guys do brick on my front porch?")]);
    ck("brick for the porch: decline the material, offer tile / vinyl, no price, no visit", DECLINE.test(r) && OUR_TWO.test(r) && NO_PRICE_NO_VISIT(r), r);
  }
  {
    const r = await ai([U("Can you do stamped concrete on my pool deck?")]);
    ck("stamped concrete pool deck: decline, offer tile / vinyl, no price, no visit", DECLINE.test(r) && OUR_TWO.test(r) && NO_PRICE_NO_VISIT(r), r);
  }
  {
    const r = await ai([U("I want porcelain tile for my lanai, about 600 sqft, how much?")]);
    ck("porcelain tile for a lanai: normal lead, no decline", !DECLINE.test(r) && !/\[BOOK:/i.test(r), r);
  }
  done();
}

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
