// 27/10/2026 — AD PRICE CONTEXT nos 3 webhooks: ad_id persistido em qualquer turno, criativo (corpo + saudação) lido
// com cache, tipo pelo texto do anúncio em qualquer turno, e a nota de contexto de preço quando o anúncio mostra os dois valores.
import { applyPatches } from "./tmp-patch-lib.mjs";

const FB = "src/app/api/fb-webhook/route.ts";
const IG = "src/app/api/webhook/route.ts";
const WA = "src/app/api/wa-webhook/route.ts";

const TIER_COMMENT = String.raw`        // AD PRICE CONTEXT (owner rule 2026-10-27, caso Jason): the ad's body or
        // greeting quotes "$2,350 ❌ materials / $5,100 ✅ with materials" (or the
        // client quotes those numbers) → the model and the canned "what's
        // included" lines state the contrast (the $2,350 is the installation
        // only, the $5 per sq ft promo includes the luxury vinyl floor, the
        // installation and the quarter round), never the bare vinyl-includes line.`;

applyPatches([
  // ───────────── Messenger ─────────────
  {
    file: FB,
    find: String.raw`detectLargeLeadSqft, `,
    replace: String.raw`detectLargeLeadSqft, detectAdPriceTier, adPriceTierNote, `,
  },
  {
    file: FB,
    find: String.raw`dadosDeAnuncioDaConversa, midiasDaMensagem } from "@/lib/funil";`,
    replace: String.raw`dadosDeAnuncioDaConversa, adIdPersistidoDaConversa, midiasDaMensagem } from "@/lib/funil";`,
  },
  {
    file: FB,
    find: String.raw`        const adId = (fbRef?.ad_id ?? convAny.ad_id) as string | undefined;`,
    replace: String.raw`        // ad_id: fresh from this event, else the one the funnel persisted on the
        // opening turn (the conversation table has no ad columns), so the ad's
        // own text can be re-read on ANY turn (27/10/2026, AD PRICE CONTEXT).
        const adId = ((fbRef?.ad_id ?? convAny.ad_id) as string | undefined) ?? (await adIdPersistidoDaConversa(conv.id)) ?? undefined;`,
  },
  {
    file: FB,
    find: String.raw`        let adType = detectAdFlooringType(...adSignals);
        // Still unknown? Actually SEE the ad: pull its creative (text + image)
        // from Meta by ad_id, then fall back to the creative thumbnail. Bounded to
        // the opening turn and persisted so the tile answer survives later turns.
        // Vision is conservative (only a clear 'tile' verdict is trusted); ad TEXT
        // is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adId) {
            const ad = await withTimeout(fetchAdCreative(adId), 6000);
            if (ad?.text) resolved = detectAdFlooringType(ad.text);
            if (!resolved && ad?.imageUrl) {
              resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
            }
          }`,
    replace: String.raw`        let adType = detectAdFlooringType(...adSignals);
        // The ad's own words (body + greeting, cached per ad id, ANY turn): they
        // settle the flooring type when the referral was silent AND the price
        // the client read ("$2,350 ❌ materials / $5,100 ✅ with materials").
        const adCreative = adId ? await withTimeout(fetchAdCreative(adId), 6000) : null;
        if (!adType && adCreative?.text) adType = detectAdFlooringType(adCreative.text);
        // Still unknown? Look at the creative image (vision), bounded to the
        // opening turn. Vision is conservative (only a clear 'tile' verdict is
        // trusted); ad TEXT is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adCreative?.imageUrl) {
            resolved = (await withTimeout(classifyAdCreativeType(adCreative.imageUrl), 6000)) === "tile" ? "tile" : null;
          }`,
  },
  {
    file: FB,
    find: String.raw`        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
      }
      if (!isBookingConfirmed) {`,
    replace: String.raw`        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
` + TIER_COMMENT + String.raw`
        const userBlobForTier = messagesForAI
          .filter((m) => m.role === "user")
          .map((m) => m.content.split(/\n\n?\[SYSTEM:/)[0])
          .join(" ");
        if (detectAdPriceTier(adCreative?.text, fbRef?.ads_context_data?.ad_title, convAny.ad_title as string | undefined, userBlobForTier)) {
          systemParts.push(adPriceTierNote());
        }
      }
      if (!isBookingConfirmed) {`,
  },

  // ───────────── Instagram ─────────────
  {
    file: IG,
    find: String.raw`  detectAdFlooringType,
  adFlooringTypeNote,`,
    replace: String.raw`  detectAdFlooringType,
  adFlooringTypeNote,
  detectAdPriceTier,
  adPriceTierNote,`,
  },
  {
    file: IG,
    find: String.raw`dadosDeAnuncioDaConversa, persistirAnuncioDaConversa, midiasDaMensagem } from "@/lib/funil";`,
    replace: String.raw`dadosDeAnuncioDaConversa, adIdPersistidoDaConversa, persistirAnuncioDaConversa, midiasDaMensagem } from "@/lib/funil";`,
  },
  {
    file: IG,
    find: String.raw`        const adId = (ref?.ad_id ?? convAny.ad_id) as string | undefined;`,
    replace: String.raw`        // ad_id: fresh from this event, else the one the funnel persisted on the
        // opening turn (the conversation table has no ad columns), so the ad's
        // own text can be re-read on ANY turn (27/10/2026, AD PRICE CONTEXT).
        const adId = ((ref?.ad_id ?? convAny.ad_id) as string | undefined) ?? (await adIdPersistidoDaConversa(conversation.id)) ?? undefined;`,
  },
  {
    file: IG,
    find: String.raw`        let adType = detectAdFlooringType(...adSignals);
        // Still unknown? Actually SEE the ad: pull its creative (text + image)
        // from Meta by ad_id, then fall back to the creative thumbnail we already
        // have. Bounded to the opening turn and persisted so it never re-runs and
        // the tile answer survives later turns. Vision is conservative (only a
        // clear 'tile' verdict is trusted, since this advertiser's vinyl mimics
        // wood/stone/marble); ad TEXT is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adId) {
            const ad = await withTimeout(fetchAdCreative(adId), 6000);
            if (ad?.text) resolved = detectAdFlooringType(ad.text);
            if (!resolved && ad?.imageUrl) {
              resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
            }
          }`,
    replace: String.raw`        let adType = detectAdFlooringType(...adSignals);
        // The ad's own words (body + greeting, cached per ad id, ANY turn): they
        // settle the flooring type when the referral was silent AND the price
        // the client read ("$2,350 ❌ materials / $5,100 ✅ with materials").
        const adCreative = adId ? await withTimeout(fetchAdCreative(adId), 6000) : null;
        if (!adType && adCreative?.text) adType = detectAdFlooringType(adCreative.text);
        // Still unknown? Look at the creative image (vision), bounded to the
        // opening turn. Vision is conservative (only a clear 'tile' verdict is
        // trusted, since this advertiser's vinyl mimics wood/stone/marble); ad
        // TEXT is trusted for all three types.
        if (!adType && isAdReply && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adCreative?.imageUrl) {
            resolved = (await withTimeout(classifyAdCreativeType(adCreative.imageUrl), 6000)) === "tile" ? "tile" : null;
          }`,
  },
  {
    file: IG,
    find: String.raw`        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
      }
      // Scan last 3 user messages for a large-lead sqft mention`,
    replace: String.raw`        if (adType) {
          systemParts.push(adFlooringTypeNote(adType));
        } else if (isAdReply) {
          // Ad lead, type still unknown → ask the type. The hardcoded "what's
          // included" intercept also reads this note and refuses to assume vinyl.
          systemParts.push(AD_REPLY_NOTE);
        }
` + TIER_COMMENT + String.raw`
        const userBlobForTier = messagesForAI
          .filter((m) => m.role === "user")
          .map((m) => m.content.split(/\n\n?\[SYSTEM:/)[0])
          .join(" ");
        if (detectAdPriceTier(adCreative?.text, ref?.ads_context_data?.ad_title, convAny.ad_title as string | undefined, userBlobForTier)) {
          systemParts.push(adPriceTierNote());
        }
      }
      // Scan last 3 user messages for a large-lead sqft mention`,
  },

  // ───────────── WhatsApp ─────────────
  {
    file: WA,
    find: String.raw`detectLargeLeadSqft, `,
    replace: String.raw`detectLargeLeadSqft, detectAdPriceTier, adPriceTierNote, `,
  },
  {
    file: WA,
    find: String.raw`persistirAnuncioDaConversa, dadosDeAnuncioDaConversa } from "@/lib/funil";`,
    replace: String.raw`persistirAnuncioDaConversa, dadosDeAnuncioDaConversa, adIdPersistidoDaConversa } from "@/lib/funil";`,
  },
  {
    file: WA,
    find: String.raw`        // Best-effort auto-detect from the ad creative (opening turn only, then
        // persisted so the tile answer survives later turns). Vision is trusted
        // only for a clear 'tile' verdict; ad TEXT is trusted for all three types.
        const adId = convAny.ad_id as string | undefined;
        if (!adType && adId && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          const ad = await withTimeout(fetchAdCreative(adId), 6000);
          if (ad?.text) resolved = detectAdFlooringType(ad.text);
          if (!resolved && ad?.imageUrl) {
            resolved = (await withTimeout(classifyAdCreativeType(ad.imageUrl), 6000)) === "tile" ? "tile" : null;
          }`,
    replace: String.raw`        // ad_id: captured on this turn, else the one the funnel persisted on the
        // opening turn (the conversation table has no ad columns), so the ad's
        // own text can be re-read on ANY turn (27/10/2026, AD PRICE CONTEXT).
        const adId = (convAny.ad_id as string | undefined) ?? (await adIdPersistidoDaConversa(conv.id)) ?? undefined;
        // The ad's own words (body + greeting, cached per ad id, ANY turn): they
        // settle the flooring type when the referral was silent AND the price
        // the client read ("$2,350 ❌ materials / $5,100 ✅ with materials").
        const adCreative = adId ? await withTimeout(fetchAdCreative(adId), 6000) : null;
        if (!adType && adCreative?.text) adType = detectAdFlooringType(adCreative.text);
        // Still unknown? Look at the creative image (vision), opening turn only.
        // Vision is trusted only for a clear 'tile' verdict.
        if (!adType && adId && !messagesForAI.some((m) => m.role === "assistant")) {
          let resolved: AdFlooringType | null = null;
          if (adCreative?.imageUrl) {
            resolved = (await withTimeout(classifyAdCreativeType(adCreative.imageUrl), 6000)) === "tile" ? "tile" : null;
          }`,
  },
  {
    file: WA,
    find: String.raw`          } else {
            systemParts.push(AD_REPLY_NOTE);
          }
        }
      }`,
    replace: String.raw`          } else {
            systemParts.push(AD_REPLY_NOTE);
          }
        }
` + TIER_COMMENT + String.raw`
        if (detectAdPriceTier(adCreative?.text, convAny.ad_title as string | undefined, userBlob)) {
          systemParts.push(adPriceTierNote());
        }
      }`,
  },
]);
