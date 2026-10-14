// Reel/post forwarded from someone else's feed with no words = silence
// (14/10/2026, owner: "não é para ela responder a essas pessoas"). Stephen Bell
// (IG) forwarded 17 random reels and got 13 "tile, vinyl, or hardwood?" nudges;
// 106 IG threads in 30 days had zero client words. Meta's real shapes from the
// 7-day raw capture are reproduced here verbatim (types, payload keys, captions).
// [1] feedShareOf: what is a feed share, what is not (ad card, story, ephemeral).
// [2] judgeFeedShare: the decision matrix (ours / flooring / unrelated / none).
// [3] classifyFeedShare: platform lookup only when the caption did not settle it.
// [4] followup: a placeholder-only thread is never "engaged" (Stephen's nudge).
// Pure functions only: zero API, zero send. Run: npx tsx src/evals/shared-media-verify.ts
import {
  feedShareOf,
  judgeFeedShare,
  classifyFeedShare,
  flooringShareNote,
  isFlooringShareNote,
  OUR_AD_CAPTION_RE,
  type FeedShare,
} from "@/lib/shared-media-policy";
import { decideFollowup, isFaqGhost, isNonClientPlaceholder, type FollowupMsg } from "@/lib/followup";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 300)}»`); }
}

// ── Real Meta payloads (7-day raw capture, 07–14/10/2026) ──────────────────
const IG_REEL_FOREIGN = { mid: "m1", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18123142853490027", title: "🚨🔮 ¡HOY MARTES 13! PROTEGE TU ENERGÍA Y LIBÉRATE DE LO NEGATIVO. Según antigua tradición…", url: "https://www.instagram.com/reel/DeMBYvHgH4a/" } }] };
const IG_REEL_STEPHEN = { mid: "m2", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18220584850337841", title: "\"Before these planes go into action, they will come over America dropping leaflets in English and in Arabic\" — The Honorable Minister Louis Farrakhan", url: "https://www.instagram.com/reel/Dd7pH_Qse5F/" } }] };
const IG_REEL_NO_TITLE = { mid: "m3", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18106391363263517", url: "https://www.instagram.com/reel/DeXsxiGjJDA/" } }] };
const IG_POST_OURS = { mid: "m4", attachments: [{ type: "ig_post", payload: { ig_post_media_id: "18111909323027651", title: "✨ 1000 sq.ft. FOR JUST $2,350 ❌ materials ✨ 1000 sq.ft. ONLY $5,100 ✅ with materials included", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18111909323027651&signature=Ab0" } }] };
const IG_POST_OURS_HERRINGBONE = { mid: "m5", attachments: [{ type: "ig_post", payload: { ig_post_media_id: "17991939687103279", title: "✨ 1000 sq.ft. FOR JUST $4000 ❌ materials ✨ 1000 sq.ft. ONLY $7600 ✅ with materials", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17991939687103279" } }] };
const IG_POST_EMPTY_TITLE = { mid: "m6", attachments: [{ type: "ig_post", payload: { ig_post_media_id: "17936329794381861", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17936329794381861&signature=x" } }] };
const IG_POST_FOREIGN = { mid: "m7", attachments: [{ type: "ig_post", payload: { ig_post_media_id: "17961000000000001", title: "BE HONEST! James Talarico’s reported comments reject the clear teaching…", url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17961000000000001" } }] };
const IG_REEL_FLOORING_3P = { mid: "m8", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18099429920248698", title: "Herringbone LVP install, before and after 😍 #flooring #vinyl", url: "https://www.instagram.com/reel/Dx/" } }] };
const IG_REEL_SENATE_FLOOR = { mid: "m9", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18148461274563400", title: "Senator Marco Rubio issued a stern warning from the U.S. Senate floor in Washington", url: "https://www.instagram.com/reel/Dy/" } }] };
const IG_TEMPLATE_AD_CARD = { mid: "m10", attachments: [{ type: "template", payload: { generic: { elements: [] } } }] };
const IG_STORY = { mid: "m11", attachments: [{ type: "ig_story", payload: { story_media_id: "18210748978363422", story_media_url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18210748978363422" } }] };
const IG_EPHEMERAL = { mid: "m12", attachments: [{ type: "ephemeral" }] };
const IG_IMAGE = { mid: "m13", attachments: [{ type: "image", payload: { url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=17468" } }] };
const IG_TEXT_PLUS_REEL = { mid: "m14", text: "What is included in the materials package?", attachments: [{ type: "ig_reel", payload: { reel_video_id: "18111909323027651", title: "✨ 1000 sq.ft. FOR JUST $2,350 ❌ materials", url: "https://www.instagram.com/reel/Dz/" } }] };
const FB_REEL_WITH_STALE_REF = { mid: "fb1", attachments: [{ type: "reel", payload: { url: "https://www.facebook.com/reel/1092031603528915?fs=e&s=m", title: "America I want you to keep this in mind when you go out and vote", reel_video_id: "1092031603528915" } }] };
const FB_FALLBACK_YOUTUBE = { mid: "fb2", attachments: [{ type: "fallback", payload: { url: "https://l.facebook.com/l.php?u=https%3A%2F%2Fyoutube.com%2Flive%2FsjxNu", title: "PRIÈRE DU SOIR | PSAUMES 113| SEIGNEUR LÈVE-TOI POUR ME SECOURIR" } }] };
const FB_FALLBACK_OURS = { mid: "fb3", attachments: [{ type: "fallback", payload: { url: "https://www.facebook.com/photo.php?fbid=1102791425", title: "Ozzi floors added a new photo." } }] };
const FB_FALLBACK_LINK_WITH_REF = { mid: "fb4", attachments: [{ type: "fallback", payload: { url: "https://l.facebook.com/l.php?u=https%3A%2F%2Fjimmyjohns-gift.com", title: "jimmyjohns-gift.com" } }] };

const NO_TEXT = { hasText: false, hasPostback: false, hasReferral: false };
const notOurs = { ok: true, ours: false };
const isOurs = { ok: true, ours: true };
const couldNotAsk = { ok: false, ours: false };

function section1() {
  console.log("\n[1] feedShareOf — what counts as a feed share");
  const s = feedShareOf(IG_REEL_FOREIGN)!;
  ck("ig_reel is a feed share with id + title", !!s && s.type === "ig_reel" && s.mediaIds.includes("18123142853490027") && s.title.startsWith("🚨🔮"), JSON.stringify(s));
  const p = feedShareOf(IG_POST_OURS)!;
  ck("ig_post exposes ig_post_media_id (also from asset_id)", !!p && p.mediaIds.length === 1 && p.mediaIds[0] === "18111909323027651", JSON.stringify(p));
  ck("ig_reel without title → empty title, id kept", feedShareOf(IG_REEL_NO_TITLE)?.title === "" && feedShareOf(IG_REEL_NO_TITLE)?.mediaIds[0] === "18106391363263517");
  const fb = feedShareOf(FB_REEL_WITH_STALE_REF)!;
  ck("Messenger reel: reel_video_id (also from the facebook.com/reel URL)", !!fb && fb.mediaIds.length === 1 && fb.mediaIds[0] === "1092031603528915", JSON.stringify(fb));
  ck("Messenger fallback link: feed share with no media id", feedShareOf(FB_FALLBACK_YOUTUBE)?.mediaIds.length === 0 && feedShareOf(FB_FALLBACK_YOUTUBE)?.type === "fallback");
  ck("template ad card is NOT a feed share", feedShareOf(IG_TEMPLATE_AD_CARD) === null);
  ck("ig_story is NOT a feed share", feedShareOf(IG_STORY) === null);
  ck("ephemeral is NOT a feed share", feedShareOf(IG_EPHEMERAL) === null);
  ck("image is NOT a feed share", feedShareOf(IG_IMAGE) === null);
  ck("no attachments → null", feedShareOf({ mid: "x", text: "hi" }) === null && feedShareOf(undefined) === null);
}

function section2() {
  console.log("\n[2] judgeFeedShare — decision matrix");
  const j = (msg: unknown, ctx: Partial<typeof NO_TEXT> & { lookup: { ok: boolean; ours: boolean } | null }) =>
    judgeFeedShare(feedShareOf(msg), { ...NO_TEXT, ...ctx });
  ck("random IG reel, no words, platform says not ours → unrelated (silence)", j(IG_REEL_FOREIGN, { lookup: notOurs }).kind === "unrelated");
  ck("Stephen Bell's Farrakhan reel → unrelated", j(IG_REEL_STEPHEN, { lookup: notOurs }).kind === "unrelated");
  ck("random reel, platform could not be asked, no referral → unrelated", j(IG_REEL_FOREIGN, { lookup: couldNotAsk }).kind === "unrelated");
  ck("random reel, platform could not be asked, no media id → unrelated", j(IG_REEL_FOREIGN, { lookup: null }).kind === "unrelated");
  ck("reel without any title, not ours → unrelated", j(IG_REEL_NO_TITLE, { lookup: notOurs }).kind === "unrelated");
  ck("random IG post (Talarico) → unrelated", j(IG_POST_FOREIGN, { lookup: notOurs }).kind === "unrelated");
  ck("empty-caption post the platform does not know → unrelated", j(IG_POST_EMPTY_TITLE, { lookup: notOurs }).kind === "unrelated");
  const ours = j(IG_POST_OURS, { lookup: null });
  ck("our vinyl ad post ($2,350 ❌ materials) → ours by caption, no lookup needed", ours.kind === "ours" && ours.via === "caption", JSON.stringify(ours));
  const herr = j(IG_POST_OURS_HERRINGBONE, { lookup: null });
  ck("our herringbone ad post ($4000/$7600) → ours by caption", herr.kind === "ours" && herr.via === "caption");
  const viaPlat = j(IG_POST_EMPTY_TITLE, { lookup: isOurs });
  ck("empty-caption post the platform maps to an ad → ours via platform", viaPlat.kind === "ours" && viaPlat.via === "platform");
  const adClick = j(IG_REEL_NO_TITLE, { hasReferral: true, lookup: couldNotAsk });
  ck("referral + media we could NOT check → ours (benefit of the doubt, old behavior)", adClick.kind === "ours" && adClick.via === "unverifiable-ad-click");
  ck("referral + no media id to check → ours (old behavior)", j(FB_FALLBACK_LINK_WITH_REF, { hasReferral: true, lookup: null }).kind === "ours");
  ck("Messenger meme WITH the thread's stale ad referral, platform says not ours → unrelated", j(FB_REEL_WITH_STALE_REF, { hasReferral: true, lookup: notOurs }).kind === "unrelated");
  ck("Messenger YouTube prayer link, no referral → unrelated", j(FB_FALLBACK_YOUTUBE, { lookup: null }).kind === "unrelated");
  ck("Messenger 'Ozzi floors added a new photo.' → ours by caption", j(FB_FALLBACK_OURS, { lookup: null }).kind === "ours");
  const fl = j(IG_REEL_FLOORING_3P, { lookup: notOurs });
  ck("third-party flooring reel (herringbone LVP) → flooring note for the model", fl.kind === "flooring" && fl.note.startsWith("[Client shared a post/reel about flooring: \"Herringbone LVP"), JSON.stringify(fl));
  ck("'Senate floor' is not flooring → unrelated", j(IG_REEL_SENATE_FLOOR, { lookup: notOurs }).kind === "unrelated");
  ck("client typed text + reel attached → none (the words decide, unchanged flow)", j(IG_TEXT_PLUS_REEL, { hasText: true, lookup: null }).kind === "none");
  ck("icebreaker postback + feed share → none", j(IG_REEL_FOREIGN, { hasPostback: true, lookup: null }).kind === "none");
  ck("ad card / story / ephemeral / image → none", ["none", "none", "none", "none"].join() === [IG_TEMPLATE_AD_CARD, IG_STORY, IG_EPHEMERAL, IG_IMAGE].map((m) => j(m, { lookup: null }).kind).join());
  ck("OUR_AD_CAPTION_RE does not fire on 'materials' alone or on another shop's 'only $5'", !OUR_AD_CAPTION_RE.test("Best materials for a DIY deck build") && !OUR_AD_CAPTION_RE.test("Only $5 coffee today ☕") && !OUR_AD_CAPTION_RE.test("Ozzy Osbourne tribute") && OUR_AD_CAPTION_RE.test("1000 sq ft only $5,100") && OUR_AD_CAPTION_RE.test("Ozzi floors added a new photo."));
  const note = flooringShareNote({ type: "ig_reel", title: "Wood look [tile] \"review\"", url: "", mediaIds: [] } as FeedShare);
  ck("flooring note strips brackets/quotes from the caption and is recognizable", note === "[Client shared a post/reel about flooring: \"Wood look tile review\"]" && isFlooringShareNote(note) && !isFlooringShareNote("[Client replied to our ad]"), note);
}

async function section3() {
  console.log("\n[3] classifyFeedShare — platform asked only when needed, never throws");
  let calls: string[][] = [];
  const platformKnows = (ours: string[]) => async (ids: string[]) => { calls.push(ids); return { ok: true, resolvidas: Object.fromEntries(ids.filter((i) => ours.includes(i)).map((i) => [i, { ad_id: "1", ad_name: "x" }])) }; };
  const v1 = await classifyFeedShare(IG_REEL_FOREIGN, NO_TEXT, platformKnows([]));
  ck("foreign reel: platform asked once with the reel id → unrelated", v1.kind === "unrelated" && calls.length === 1 && calls[0][0] === "18123142853490027", JSON.stringify(calls));
  calls = [];
  const v2 = await classifyFeedShare(IG_POST_OURS, NO_TEXT, platformKnows([]));
  ck("our-caption post: platform NOT asked → ours", v2.kind === "ours" && calls.length === 0);
  calls = [];
  const v3 = await classifyFeedShare(IG_POST_EMPTY_TITLE, NO_TEXT, platformKnows(["17936329794381861"]));
  ck("empty-caption post the platform knows → ours via platform", v3.kind === "ours" && v3.via === "platform" && calls.length === 1);
  const v4 = await classifyFeedShare(IG_REEL_FOREIGN, NO_TEXT, async () => { throw new Error("boom"); });
  ck("platform throws → treated as 'could not ask' → unrelated without referral", v4.kind === "unrelated");
  const v5 = await classifyFeedShare(IG_REEL_FOREIGN, { ...NO_TEXT, hasReferral: true }, async () => { throw new Error("boom"); });
  ck("platform throws + referral → ours (old behavior kept for a real ad click)", v5.kind === "ours" && v5.via === "unverifiable-ad-click");
  calls = [];
  const v6 = await classifyFeedShare(IG_TEXT_PLUS_REEL, { ...NO_TEXT, hasText: true }, platformKnows([]));
  ck("typed text: platform not asked, none", v6.kind === "none" && calls.length === 0);
  const v7 = await classifyFeedShare(IG_TEMPLATE_AD_CARD, NO_TEXT, platformKnows([]));
  ck("ad card: none (keeps the ad-reply path)", v7.kind === "none");
}

function section4() {
  console.log("\n[4] followup — placeholder-only thread is never engaged (Stephen Bell, 03/10)");
  const T = (iso: string) => new Date(iso + ":00-04:00").toISOString();
  const m = (role: "user" | "assistant", content: string, at: string): FollowupMsg => ({ role, content, created_at: T(at) });
  const IG = "1151232057233674";
  const stephen: FollowupMsg[] = [
    m("user", "[Client replied to our ad]", "2026-10-03T07:34"),
    m("assistant", "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?", "2026-10-03T07:35"),
    m("user", "[Client replied to our ad]", "2026-10-03T12:14"),
    m("assistant", "Hi again, which floor are you looking at, tile, vinyl, or hardwood? I'll send you the promo for it.", "2026-10-03T12:15"),
  ];
  const d = decideFollowup(IG, stephen, Date.parse(T("2026-10-03T15:30")));
  ck("Stephen's thread (2 forwarded reels, zero words) gets NO follow-up", !d.eligible, JSON.stringify(d));
  ck("…and it is classified as a ghost (no client words at all)", isFaqGhost(stephen));
  ck("isNonClientPlaceholder: ad placeholder, FAQ button, empty, SYSTEM-suffixed", isNonClientPlaceholder("[Client replied to our ad]") && isNonClientPlaceholder("[Client shared a post/reel from our ad: \"x\"]") && isNonClientPlaceholder("What is included in the materials package?") && isNonClientPlaceholder("  ") && isNonClientPlaceholder("[Client replied to our ad]\n\n[SYSTEM: note]"));
  ck("…but real words are not placeholders", !isNonClientPlaceholder("vinyl") && !isNonClientPlaceholder("Hola, cuánto cuesta?"));
  // Regression: a lead who typed real words after our first reply is still engaged.
  const WA = "wa_15551234567";
  const engaged: FollowupMsg[] = [
    m("user", "[Client replied to our ad]", "2026-10-03T07:34"),
    m("assistant", "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?", "2026-10-03T07:35"),
    m("user", "vinyl, around 900 sqft", "2026-10-03T07:40"),
    m("assistant", "I have Thursday at 9am or 1pm for a free in-home visit, which one works for you?", "2026-10-03T07:41"),
  ];
  const e = decideFollowup(WA, engaged, Date.parse(T("2026-10-03T12:00")));
  ck("regression: client who typed real words after the opener is still follow-up eligible", e.eligible && e.kind === "engaged", JSON.stringify(e));
  const faqGhost: FollowupMsg[] = [
    m("user", "What is included in the materials package?", "2026-10-01T07:34"),
    m("assistant", "Hi! Which floor are you looking at, tile, vinyl, or hardwood?", "2026-10-01T07:35"),
  ];
  const g = decideFollowup(WA, faqGhost, Date.parse(T("2026-10-03T12:00")));
  ck("regression: FAQ-button ghost on WhatsApp still gets the 48h ghost nudge", g.eligible && g.kind === "faq_ghost", JSON.stringify(g));
}

async function main() {
  section1();
  section2();
  await section3();
  section4();
  console.log(`\n${pass} passed, ${fail} failed${fail ? ": " + fails.join(" | ") : ""}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
