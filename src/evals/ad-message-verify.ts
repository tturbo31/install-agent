// Verifies that ad-reply messages are answered. When a client clicks an Instagram
// ad, the reel arrives as a "share" attachment alongside the pre-filled question
// ("What is included in the materials package?"). The bug: the share title
// overwrote the real text, a failed image analysis sent a "Got your photo"
// fallback, and a missing message.mid silently crashed the handler — so the AI
// never answered. These checks confirm the fixes (source-level) and that the AI
// answers the question even with the share-context note appended.
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { AD_REPLY_NOTE } from "../lib/system-prompt";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, undefined, false).then(r => r.text);

// The exact note the webhook now appends for an ad reel share.
const SHARE_NOTE = "[Client shared a post/reel from our ad]";

async function main() {
  console.log("\n===================== AD-REPLY MESSAGE VERIFICATION =====================");

  // ── 1. Instagram webhook source carries the three fixes ──────────────────
  console.log("\n[1] Instagram webhook fixes are in place");
  const ig = readFileSync(join(process.cwd(), "src/app/api/webhook/route.ts"), "utf-8");
  ck("mid is defensive (no silent crash on missing message.mid)", /messaging\.message\?\.mid \?\? `syn_/.test(ig), "mid access not guarded");
  ck("share attachment KEEPS the real text (appends note, not overwrite)", /realText \? `\$\{realText\}\\n\$\{shareNote\}`/.test(ig), "share still overwrites text");
  ck("text-bearing messages always answered (clientHasText drives hasRealContent)", /const clientHasText = !!messaging\.message\?\.text\?\.trim\(\)/.test(ig) && /hasRealContent = clientHasText \|\|/.test(ig), "fallback can still swallow text");
  ck("share note no longer hard-overwrites enrichedText with title-only", !/enrichedText\s*=\s*isFloorPlan\s*\n?\s*\?\s*`\[Client shared a floor plan: "\$\{shareTitle\}"\]`/.test(ig), "old overwrite still present");

  // ── 2. Facebook webhook: text always wins too ────────────────────────────
  console.log("\n[2] Facebook webhook fix is in place");
  const fb = readFileSync(join(process.cwd(), "src/app/api/fb-webhook/route.ts"), "utf-8");
  ck("FB answers text even if an attached photo fails to analyze", /const clientHasText = !!\(msg\?\.text as string\)\?\.trim\(\)/.test(fb) && /hasRealContent = clientHasText \|\| mediaProcessed/.test(fb), "FB fallback can still swallow text");

  // ── 3. The AI answers an ad reply of UNKNOWN type by ASKING the type ──────
  // (It must NOT assume vinyl: the reel could be a tile ad, and tile is labor
  //  only — assuming the vinyl "material included" package is the screenshot bug.)
  console.log("\n[3] AI answers the ad reply by asking the type (never assumes vinyl)");
  const adQuestion = `What is included in the materials package?\n${SHARE_NOTE}`;
  const r1 = await ai([{ role: "user", content: adQuestion }]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 150));
  ck("answers (not silent)", r1.trim().length > 0, r1);
  ck("asks the flooring type (tile / vinyl / hardwood), never assumes vinyl", /tile/i.test(r1) && /vinyl/i.test(r1) && /hardwood/i.test(r1), r1);
  // The ask-type line states the inclusions PER TYPE (vinyl → material+labor+
  // quarter round; tile/hardwood → labor only) and still asks the type — it must
  // never present the vinyl package as THE package.
  ck("vinyl inclusions are scoped to vinyl, tile/hardwood labor only (never a blanket vinyl claim)", /\bvinyl\s+promo\b[^.]{0,80}\bquarter round\b/i.test(r1) && /\btile\s+and\s+hardwood\b[^.]{0,60}\blabor\s+only\b/i.test(r1) && !/\bthe\s+promotional\s+package\s+already\s+includes\b/i.test(r1), r1);
  ck("no prices ($5/$2/over 1,000 sqft)", !/\$\s*\d/.test(r1) && !/over\s+1,?000/i.test(r1), r1);
  ck("does not leak the share note back to the client", !/\[Client shared/i.test(r1), r1);

  // ── 4. A different ad question + share note is still answered ─────────────
  console.log("\n[4] A non-'included' ad question + share note is still answered");
  const r2 = await ai([{ role: "user", content: `Can this be installed over my existing tile?\n${SHARE_NOTE}` }]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 150));
  ck("answers the capability question (not silent, not 'Got your photo')", r2.trim().length > 0 && !/got your photo/i.test(r2), r2);
  ck("answers about installing over tile", /tile|over|yes|can/i.test(r2), r2);
  ck("does not leak the share note", !/\[Client shared/i.test(r2), r2);

  // ── 5. Ad reply with NO readable text (the reported case) is NOT dropped ──
  console.log("\n[5] Ad reply with an unrecognized reel attachment and NO text is not dropped");
  ck("IG: ad referral / attachment with no text is stored, not dropped", /if \(!rawText && \(isAdReferral \|\| hasAnyAttachment\)\) rawText = "\[Client replied to our ad\]"/.test(ig), "no-drop guard missing in IG");
  ck("IG: injects AD_REPLY_NOTE", /systemParts\.push\(AD_REPLY_NOTE\)/.test(ig), "AD_REPLY_NOTE not injected in IG");
  ck("IG: logs incoming attachment types for diagnosis", /msg from \$\{senderIgsid\}.*attachments:/.test(ig), "diagnostic log missing");
  ck("FB: ad referral / attachment with no text is stored, not dropped", /if \(!rawText && \(isAdReferral \|\| hasAnyAttachment\)\) rawText = "\[Client replied to our ad\]"/.test(fb), "no-drop guard missing in FB");
  ck("FB: injects AD_REPLY_NOTE", /systemParts\.push\(AD_REPLY_NOTE\)/.test(fb), "AD_REPLY_NOTE not injected in FB");
  ck("AD_REPLY_NOTE asks for the flooring type", /tile, vinyl, or hardwood/i.test(AD_REPLY_NOTE) && /\$4\.50/.test(AD_REPLY_NOTE) && /\$3\.20/.test(AD_REPLY_NOTE), "note missing type question or per-type prices");

  // ── 6. AI engages a text-less ad reply by ASKING the flooring type ──────────
  console.log("\n[6] AI engages a text-less ad reply by asking tile/vinyl/hardwood");
  const adCtx = "\n\n[SYSTEM: TODAY: Sunday, June 8, 2026 [2026-06-08].\n\n" + AD_REPLY_NOTE + "]";
  const r3 = await ai([{ role: "user", content: "[Client replied to our ad]" + adCtx }]);
  console.log("   AI:", r3.replace(/\s+/g, " ").slice(0, 150));
  ck("engages (not silent)", r3.replace(/\[[^\]]*\]/g, "").trim().length > 0, r3);
  ck("asks which flooring type (tile / vinyl / hardwood)", /tile/i.test(r3) && /vinyl/i.test(r3) && /hardwood/i.test(r3), r3);
  ck("does NOT quote a price yet", !/\$\s?\d/.test(r3), r3);
  ck("does not leak the internal placeholder", !/\[Client replied to our ad\]/i.test(r3), r3);

  // ── 7. After the client names the type, quote the RIGHT price for it ─────────
  console.log("\n[7] Per-type pricing after the client picks a flooring type");
  const askType = "What type of flooring are you looking for, tile, vinyl, or hardwood?";

  const rTile = await ai([
    { role: "user", content: "[Client replied to our ad]" + adCtx },
    { role: "assistant", content: askType },
    { role: "user", content: "Tile" },
  ]);
  console.log("   TILE:", rTile.replace(/\s+/g, " ").slice(0, 150));
  ck("tile → $4.50/sqft labor only", /4\.50/.test(rTile), rTile);
  ck("tile → does NOT quote the $5 package", !/\$\s?5\b/.test(rTile), rTile);

  const rVinyl = await ai([
    { role: "user", content: "[Client replied to our ad]" + adCtx },
    { role: "assistant", content: askType },
    { role: "user", content: "Vinyl" },
  ]);
  console.log("   VINYL:", rVinyl.replace(/\s+/g, " ").slice(0, 150));
  ck("vinyl → $5/sqft package (includes flooring + labor)", /\$\s?5\b/.test(rVinyl) && /(includ|flooring)/i.test(rVinyl), rVinyl);
  ck("vinyl → does NOT use the tile $4.50 rate", !/4\.50/.test(rVinyl), rVinyl);

  console.log(`\n============ AD-MESSAGE-VERIFY RESULT: ${pass} passed, ${fail} failed ============`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
