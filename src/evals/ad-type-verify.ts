/**
 * Verifies per-ad-type answers (the "edge tile" screenshot bug): a client who
 * replied to a TILE ad asked "What is included in the material package?" and the
 * bot returned the VINYL answer ("the package includes the flooring, labor, and
 * quarter round"). For a tile ad the promotion is INSTALLATION LABOR ONLY and the
 * client buys their own tile material — nothing else is included.
 *
 * This eval proves:
 *  1. DETECTION: detectAdFlooringType reads tile / vinyl / hardwood from the ad
 *     signals (ad_title / creative_url / ad_id) and returns null when silent.
 *  2. INTERCEPT: the hardcoded "what's included" answer is now ad-type aware — a
 *     tile ad gets the labor-only answer (no flooring, no quarter round), a
 *     hardwood ad likewise, and with NO ad type it stays the vinyl answer
 *     (backward compatible).
 *  3. BRAIN: with the tile-ad note injected (as the webhook does), the bot quotes
 *     tile terms ($4.50 labor only, client buys material), never the $5 vinyl
 *     package, and does NOT ask a flooring type it already knows.
 *  4. WIRING: both ad-bearing webhooks detect the type and inject the note.
 *
 * Run: npx tsx src/evals/ad-type-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  getAIResponse,
  detectAdFlooringType,
  adFlooringTypeNote,
  type ChatMessage,
} from "../lib/ai";
import {
  WHAT_IS_INCLUDED_RESPONSE,
  WHAT_IS_INCLUDED_TILE_RESPONSE,
  WHAT_IS_INCLUDED_HARDWOOD_RESPONSE,
  WHAT_IS_INCLUDED_ASK_TYPE,
  AD_REPLY_NOTE,
} from "../lib/system-prompt";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

// Build the system note exactly the way the webhook does, with the ad-type note.
const noteFor = (type: "tile" | "vinyl" | "hardwood") =>
  `\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\n${adFlooringTypeNote(type)}]`;

const SAYS_LABOR_ONLY = (t: string) => /labor only/i.test(t) || /installation labor only/i.test(t);
const SAYS_INCLUDES_FLOORING = (t: string) => /includes the flooring|flooring, (?:the )?installation|quarter round/i.test(t);

async function main() {
  console.log("\n==================== AD FLOORING-TYPE VERIFICATION ====================");

  // ── 1. Detection unit checks ──────────────────────────────────────────────
  console.log("\n[1] detectAdFlooringType");
  ck("ad_title 'Edge Tile Promo' → tile", detectAdFlooringType("Edge Tile Promo") === "tile");
  ck("ad_title 'Porcelain Floors Miami' → tile", detectAdFlooringType("Porcelain Floors Miami") === "tile");
  ck("ad_title 'Luxury Vinyl Plank $5' → vinyl", detectAdFlooringType("Luxury Vinyl Plank $5") === "vinyl");
  ck("ad_title 'Laminate Sale' → vinyl", detectAdFlooringType("Laminate Sale") === "vinyl");
  ck("ad_title 'Hardwood Flooring Deal' → hardwood", detectAdFlooringType("Hardwood Flooring Deal") === "hardwood");
  ck("creative_url with /tile/ → tile", detectAdFlooringType(undefined, ".../ads/edge-tile/cover.jpg") === "tile");
  ck("color-only 'Forged Brown' → null (unknown)", detectAdFlooringType("Forged Brown") === null);
  ck("empty signals → null", detectAdFlooringType(undefined, null, "") === null);

  // ── 1b. FALSE-POSITIVE GUARDS — never mislabel a vinyl ad as labor-only ────
  // (review findings: 'real wood look LVP' → hardwood, 'tile-look vinyl' → tile)
  console.log("\n[1b] detector never breaks the working vinyl flow");
  ck("'Real Wood Look LVP' → vinyl (not hardwood)", detectAdFlooringType("Real Wood Look LVP") === "vinyl");
  ck("'Tile-Look Vinyl' → vinyl (not tile)", detectAdFlooringType("Tile-Look Vinyl") === "vinyl");
  ck("'Stone-Look Luxury Vinyl' → vinyl", detectAdFlooringType("Stone-Look Luxury Vinyl") === "vinyl");
  ck("'Tile-Look Flooring' (no vinyl word) → vinyl (look-alike)", detectAdFlooringType("Tile-Look Flooring") === "vinyl");
  ck("'Marble Look Floors' → vinyl (look-alike)", detectAdFlooringType("Marble Look Floors") === "vinyl");
  ck("'Wood Look Tile' → tile (genuine tile material)", detectAdFlooringType("Wood Look Tile") === "tile");
  ck("'Real Wood Plank $5' → NOT hardwood", detectAdFlooringType("Real Wood Plank $5") !== "hardwood");
  ck("'Hardwood Flooring' still → hardwood", detectAdFlooringType("Hardwood Flooring") === "hardwood");
  ck("'Engineered Wood' still → hardwood", detectAdFlooringType("Engineered Wood") === "hardwood");

  // ── 2. adFlooringTypeNote carries the marker + correct terms ───────────────
  console.log("\n[2] adFlooringTypeNote");
  ck("tile note carries [AD_FLOORING_TYPE: tile] marker", /\[AD_FLOORING_TYPE:\s*tile\]/.test(adFlooringTypeNote("tile")));
  ck("tile note says labor only + $4.50 + buys own material", /labor only/i.test(adFlooringTypeNote("tile")) && /4\.50/.test(adFlooringTypeNote("tile")));
  ck("tile note forbids the vinyl flooring/quarter-round claim", /NEVER tell them the package includes the flooring/i.test(adFlooringTypeNote("tile")));
  ck("hardwood note says labor only + $3.20", /labor only/i.test(adFlooringTypeNote("hardwood")) && /3\.20/.test(adFlooringTypeNote("hardwood")));
  ck("vinyl note keeps the $5 included package", /\$5/.test(adFlooringTypeNote("vinyl")) && /includes the flooring/i.test(adFlooringTypeNote("vinyl")));

  // ── 3. INTERCEPT: "what's included" is ad-type aware ──────────────────────
  console.log("\n[3] 'What is included?' intercept by ad type (the screenshot)");
  const qTile = await ai([{ role: "user", content: "What is included in the material package?" + noteFor("tile") }]);
  console.log("   TILE  →", qTile.replace(/\s+/g, " ").slice(0, 160));
  ck("tile: returns the TILE included response", qTile.includes(WHAT_IS_INCLUDED_TILE_RESPONSE), qTile);
  ck("tile: says labor only", SAYS_LABOR_ONLY(qTile), qTile);
  ck("tile: does NOT claim flooring/quarter round are included", !SAYS_INCLUDES_FLOORING(qTile), qTile);

  const qHard = await ai([{ role: "user", content: "What is included in the package?" + noteFor("hardwood") }]);
  console.log("   HARD  →", qHard.replace(/\s+/g, " ").slice(0, 160));
  ck("hardwood: returns the HARDWOOD included response", qHard.includes(WHAT_IS_INCLUDED_HARDWOOD_RESPONSE), qHard);

  const qVinyl = await ai([{ role: "user", content: "What is included in the material package?" + noteFor("vinyl") }]);
  console.log("   VINYL →", qVinyl.replace(/\s+/g, " ").slice(0, 160));
  ck("vinyl: returns the VINYL included response (flooring + labor + quarter round)", qVinyl.includes(WHAT_IS_INCLUDED_RESPONSE), qVinyl);

  // ── 4. TYPE FIRST: organic lead, type unknown → ask the type (not vinyl) ──
  console.log("\n[4] organic lead, type unknown → ask the type (never assume vinyl)");
  const qNone = await ai([{ role: "user", content: "What is included in the package?" }]);
  console.log("   ORG   →", qNone.replace(/\s+/g, " ").slice(0, 160));
  ck("organic, type unknown: asks the type, never assumes vinyl", qNone.includes(WHAT_IS_INCLUDED_ASK_TYPE), qNone);
  // But once the client has named vinyl earlier in the chat, it gives the vinyl answer.
  const qVinylKnown = await ai([
    { role: "user", content: "I'm interested in vinyl" },
    { role: "assistant", content: "Great! Our vinyl promo is $5 per sqft including the flooring and labor. One area or the whole house?" },
    { role: "user", content: "What is included in the package?" },
  ]);
  ck("vinyl established earlier → vinyl included answer (no re-ask)", qVinylKnown.includes(WHAT_IS_INCLUDED_RESPONSE), qVinylKnown);

  // ── 4c. SAFETY NET: ad lead, type UNKNOWN → ask the type, NEVER vinyl ──────
  console.log("\n[4c] ad lead, type unknown → ask the type (never the $5 vinyl answer)");
  const adUnknownNote = `\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\n${AD_REPLY_NOTE}]`;
  const qUnknown = await ai([{ role: "user", content: "What is included in the material package?" + adUnknownNote }]);
  console.log("   →", qUnknown.replace(/\s+/g, " ").slice(0, 160));
  ck("unknown ad type: returns the ASK_TYPE safety response", qUnknown.includes(WHAT_IS_INCLUDED_ASK_TYPE), qUnknown);
  ck("unknown ad type: asks tile/vinyl/hardwood", /tile/i.test(qUnknown) && /vinyl/i.test(qUnknown) && /hardwood/i.test(qUnknown), qUnknown);
  ck("unknown ad type: NEVER claims the vinyl quarter-round inclusions", !/quarter round/i.test(qUnknown), qUnknown);
  ck("unknown ad type: no price", !/\$\s*\d/.test(qUnknown), qUnknown);
  // The exact screenshot text with a share-reel ad context must also ask, not assume vinyl
  const qShare = await ai([{ role: "user", content: "What is included in the materials package?\n[Client shared a post/reel from our ad]" }]);
  ck("shared-reel ad lead: asks the type, does not assume vinyl", !/quarter round/i.test(qShare) && /tile/i.test(qShare) && /hardwood/i.test(qShare), qShare);

  // ── 4b. SECONDARY SIGNAL: no marker but the CLIENT names tile ─────────────
  console.log("\n[4b] no marker, client's own message names tile → tile answer");
  const qClientTile = await ai([{ role: "user", content: "For tile, what is included in the package?" }]);
  console.log("   →", qClientTile.replace(/\s+/g, " ").slice(0, 160));
  ck("client says tile: returns the TILE included response", qClientTile.includes(WHAT_IS_INCLUDED_TILE_RESPONSE), qClientTile);

  // ── 5. BRAIN: tile-ad pricing question quotes tile terms, never $5 ────────
  console.log("\n[5] BRAIN: tile-ad lead asks the price");
  const pTile = await ai([{ role: "user", content: "How much per square foot?" + noteFor("tile") }]);
  console.log("   →", pTile.replace(/\s+/g, " ").slice(0, 160));
  ck("tile: quotes $4.50 labor only", /4\.50/.test(pTile), pTile);
  ck("tile: does NOT quote the $5 vinyl package", !/\$\s?5\b/.test(pTile), pTile);
  ck("tile: does NOT ask which flooring type (already known)", !(/tile/i.test(pTile) && /vinyl/i.test(pTile) && /hardwood/i.test(pTile)), pTile);

  // ── 6. WIRING: both ad-bearing webhooks detect + inject ───────────────────
  console.log("\n[6] webhooks wire ad-type detection + note");
  for (const [ch, f] of Object.entries({ IG: "src/app/api/webhook/route.ts", FB: "src/app/api/fb-webhook/route.ts" })) {
    const src = readFileSync(join(process.cwd(), f), "utf-8");
    ck(`${ch}: detectAdFlooringType + adFlooringTypeNote injected`, src.includes("detectAdFlooringType(") && src.includes("adFlooringTypeNote(adType)"));
    ck(`${ch}: fetches the ad creative from Meta by ad_id (sees the ad)`, src.includes("fetchAdCreative(adId)"));
    ck(`${ch}: vision trusted only for 'tile' (conservative)`, src.includes("classifyAdCreativeType(") && /=== "tile" \? "tile" : null/.test(src));
    ck(`${ch}: resolved type persisted so follow-up turns keep it`, /\[\$\{resolved\}\] \$\{\(convAny\.ad_title/.test(src) && src.includes("ad_title: persisted"));
    ck(`${ch}: ad lead of unknown type → AD_REPLY_NOTE (ask the type)`, /else if \(isAdReply\)/.test(src) && src.includes("systemParts.push(AD_REPLY_NOTE)"));
  }

  console.log(`\n=========== AD-TYPE-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
