/**
 * REGRESSION GUARD for the 2026-07-15 four-day review (Jul 11–15, all 3 channels).
 * Every case below reproduces a REAL production failure found in that review:
 *
 *  A. Booked clients saying "cancel" / probing a different slot got TOTAL SILENCE
 *     (Priscilla IG, Bindu WA, 💋 IG) — isRescheduleRequest now engages them.
 *  B. The model's internal monologue shipped to clients ("Wait, let me handle
 *     this properly…", "Since the client accepted the quote, I'll escalate.") —
 *     stripReasoningLeak scrubs it.
 *  C. The canned type-ask opener steamrolled the tapped ad-FAQ question
 *     (~17 dead leads) and fired on 500+ sqft first messages (OPENER EXCEPTION).
 *  D. Job seeker in misspelled Spanish got the English sales opener.
 *  E. Photo/catalog request answered WITH "message us on WhatsApp" INSIDE WhatsApp.
 *
 * ZERO API CALLS: every path tested here is deterministic (intercepts + pure
 * helpers). Safe to run anywhere: npx tsx src/evals/review-fixes-verify.ts
 */
import { isRescheduleRequest, stripReasoningLeak, mentionsLargeSqft, isJobSeeker, openerLang, getAIResponse, type ChatMessage } from "../lib/ai";
import { OPENER_EN, OPENER_PROCESS_EN, OPENER_DISCOUNT_EN, WHAT_IS_INCLUDED_ASK_TYPE } from "../lib/system-prompt";

let passed = 0, failed = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 160)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });

async function main() {
  console.log("\n========== REVIEW-FIXES VERIFY (2026-07-15 four-day review) ==========");

  console.log("\n[A] Cancel / slot-probe from a booked client must ENGAGE (never silence)");
  const engagePositives = [
    "Sorry I need to cancel or we could do this friday 2pm",                       // Priscilla, IG
    "please cancel the appointment for tomorrow, will text you with new time",     // Bindu, WA
    "Hi Ozzi, do you still have the 1pm time slot available on Wednesday?",        // 💋, IG
    "I have to cancel our appointment",
    "necesito cancelar la cita",
    "preciso cancelar a visita",
    "I can't make it tomorrow",
    "no puedo ir mañana",
    "is there a slot available on Saturday?",
  ];
  for (const p of engagePositives) ck(`engages: "${p}"`, isRescheduleRequest(p) === true, "not detected");
  const engageNegatives = [
    "Ok thank you",
    "Thanks, see you then!",
    "What time will you arrive exactly?",
    "Obrigado!",
    "Sounds good",
    "How much is it per sqft?",
    "do you handle permits?",
    "Could you also bring light wood samples with you?",
  ];
  for (const n of engageNegatives) ck(`stays silent: "${n}"`, isRescheduleRequest(n) === false, "false-positive");

  console.log("\n[B] Reasoning-leak scrubber — the 3 real leaked replies");
  const leak1 = "Perfect, 16 steps it is. What's the full address so I can get you scheduled? Wait, let me handle this properly. 16 steps at $140 per step is $2,240 for the labor. Let me redo this: That comes out to $2,240 for the installation.";
  const clean1 = stripReasoningLeak(leak1);
  ck("leak 1: 'Wait, let me handle this properly' removed", !/wait,?\s+let me|let me redo/i.test(clean1), clean1);
  ck("leak 1: the real question survives", /full address/i.test(clean1), clean1);
  const leak2 = "This is a small tile job quoted by DM, not a visit, so I just need to notify Ozzi to follow up. Since the client accepted the quote, I'll escalate. Great, I'll have Ozzi reach out to you directly to get this scheduled![NOTIFY_OWNER]";
  const clean2 = stripReasoningLeak(leak2);
  ck("leak 2: third-person planning removed", !/the client accepted|i'?ll escalate|notify ozzi to/i.test(clean2), clean2);
  ck("leak 2: the client-facing handoff line survives", /i'?ll have ozzi reach out to you/i.test(clean2), clean2);
  ck("leak 2: [NOTIFY_OWNER] tag survives", clean2.includes("[NOTIFY_OWNER]"), clean2);
  const leak3 = "I have Saturday August 16 at... wait, let me check what I have open around that time.";
  const clean3 = stripReasoningLeak(leak3);
  ck("leak 3: 'wait, let me check' removed (or fails open, never worse)", !/wait,?\s+let me check/i.test(clean3) || clean3 === leak3, clean3);
  // Safety: legit client-facing lines must pass through UNTOUCHED.
  for (const legit of [
    "For that size I need to come measure in person to give you the best price, and I bring all the samples so you can pick right there.",
    "I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.",
    "I'll make sure our team reaches out to you directly to go over all the details from your visit.[NOTIFY_OWNER]",
    "Let me check what I have open. What day works best for you?",
    "Perfect, our tile promo is $4.50 per square foot for the installation labor.",
  ]) ck(`legit reply untouched: "${legit.slice(0, 50)}…"`, stripReasoningLeak(legit) === legit, stripReasoningLeak(legit));

  console.log("\n[C] Ad-FAQ aware openers + OPENER EXCEPTION (500+ sqft) — deterministic, zero tokens");
  const NOTE = "\n\n[SYSTEM: TODAY: Wednesday, July 15, 2026 [2026-07-15].]";
  const proc = await getAIResponse([U("What is the installation process?" + NOTE)], null, null, null, false);
  ck("FAQ 'installation process' (1st contact) → answers + asks type", proc.text === OPENER_PROCESS_EN && proc.inputTokens === 0, proc.text);
  const disc = await getAIResponse([U("Do you offer any discounts for larger spaces?" + NOTE)], null, null, null, false);
  ck("FAQ 'discounts for larger spaces' (1st contact) → answers + asks type", disc.text === OPENER_DISCOUNT_EN && disc.inputTokens === 0, disc.text);
  const labor = await getAIResponse([U("Is installation labor cost extra?" + NOTE)], null, null, null, false);
  ck("FAQ 'labor cost extra' (1st contact) → inclusions ask-type line", labor.text === WHAT_IS_INCLUDED_ASK_TYPE && labor.inputTokens === 0, labor.text);
  const labor45 = await getAIResponse([U("Is labor cost also $4,500?" + NOTE)], null, null, null, false);
  ck("FAQ 'Is labor cost also $4,500?' (1st contact) → inclusions ask-type line", labor45.text === WHAT_IS_INCLUDED_ASK_TYPE && labor45.inputTokens === 0, labor45.text);
  const hi = await getAIResponse([U("Hi" + NOTE)], null, null, null, false);
  ck("bare 'Hi' (1st contact) → generic opener UNCHANGED", hi.text === OPENER_EN && hi.inputTokens === 0, hi.text);
  // OPENER EXCEPTION: 500+ sqft in the very first message skips every canned opener.
  ck("mentionsLargeSqft: 'I have about 2500sf how much can ypu do it for'", mentionsLargeSqft("I have about 2500sf how much can ypu do it for and so you have different samples?"));
  ck("mentionsLargeSqft: '840 sf in downtown'", mentionsLargeSqft("I have 840 sf in downtown, how much?"));
  ck("mentionsLargeSqft: '1,200 sqft home'", mentionsLargeSqft("Price for a 1,200 sqft home?"));
  ck("mentionsLargeSqft: '820 pies'", mentionsLargeSqft("son 820 pies cuadrados"));
  ck("mentionsLargeSqft: NOT for '300 sqft'", !mentionsLargeSqft("about 300 sqft"));
  ck("mentionsLargeSqft: NOT for a price '$2,350'", !mentionsLargeSqft("your ad says $2,350 for the promo"));
  ck("mentionsLargeSqft: NOT for 'Ft Lauderdale' addresses", !mentionsLargeSqft("I'm at 1250 Ft Lauderdale ave"));

  console.log("\n[D] Job seeker in misspelled Spanish → silent [REACT_ONLY]");
  ck("isJobSeeker: 'Nesesitan Istalador es'", isJobSeeker("Nesesitan Istalador es"));
  ck("isJobSeeker: 'necesitan instaladores?'", isJobSeeker("necesitan instaladores?"));
  ck("isJobSeeker: NOT for a customer 'do you have installers?'", !isJobSeeker("do you have installers available this week?"));
  ck("isJobSeeker: NOT for 'necesito instalar pisos en mi casa'", !isJobSeeker("necesito instalar pisos en mi casa"));
  const jobseeker = await getAIResponse([U("Nesesitan Istalador es")], null, null, null, false);
  ck("job seeker 1st contact → [REACT_ONLY], zero tokens", jobseeker.text === "[REACT_ONLY]" && jobseeker.inputTokens === 0, jobseeker.text);
  ck("openerLang: 'Quw material de loza es ese' → es", openerLang("Quw material de loza es ese") === "es");

  console.log("\n[E] Photo/samples request → link do site (regra do dono 27/07), nunca redirect de WhatsApp");
  const waNote = "\n\n[SYSTEM: TODAY: Wednesday, July 15, 2026 [2026-07-15].\n\n[WHATSAPP CHANNEL: You already have the client's phone number (13055551234). Ask ONLY for the client's name and the property address. Generate [BOOK:...] using \"13055551234\" as the phone.]]";
  const waPhotos = await getAIResponse([U("Can you send me photos of your floors?" + waNote)], null, null, null, false);
  ck("WA photo request → link ozzifloors.com, sem redirect de WhatsApp", /ozzifloors\.com/i.test(waPhotos.text) && !/message our team directly on whatsapp/i.test(waPhotos.text), waPhotos.text);
  const igPhotos = await getAIResponse([U("Can you send me photos of your floors?" + NOTE)], null, null, null, false);
  ck("IG/FB photo request → link ozzifloors.com, sem redirect de WhatsApp", /ozzifloors\.com/i.test(igPhotos.text) && !/message our team directly on whatsapp/i.test(igPhotos.text), igPhotos.text);

  console.log(`\n========== REVIEW-FIXES-VERIFY: ${passed} passed, ${failed} failed ==========`);
  if (fails.length) for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("review-fixes-verify crashed:", e); process.exit(1); });
