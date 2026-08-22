/**
 * Verifies the first-contact OPENER (the WhatsApp "Ola"/"Hola" silence bug): a
 * brand-new lead who opens with just a greeting used to get a silent reaction or
 * empty reply and was never answered. Now a bare greeting deterministically gets
 * the opener (greet + promotion + ask tile/vinyl/hardwood), in the greeting's
 * language, so the client answers and the normal per-type flow continues.
 *
 * Run: npx tsx src/evals/opener-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, isBareGreeting, openerMessage, isHostileRejection, isFirstContactRejection, type ChatMessage } from "../lib/ai";
import { OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LOCATION_EN, OPENER_LOCATION_ES, OPENER_LOCATION_PT } from "../lib/system-prompt";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("="); if (i === -1) continue;
    const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !process.env[k]) process.env[k] = v;
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 160)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);
// The webhook appends a [SYSTEM: ...] note to the last user message — opener must
// survive that.
const NOTE = "\n\n[SYSTEM: TODAY: Monday, June 8, 2026 [2026-06-08].\n\n[WHATSAPP CHANNEL: phone known.]]";

async function main() {
  console.log("\n==================== FIRST-CONTACT OPENER VERIFICATION ====================");

  // ── 1. isBareGreeting detection ───────────────────────────────────────────
  console.log("\n[1] isBareGreeting");
  for (const g of ["Ola", "Olá", "Hola", "hi", "Hello", "Hey", "Good morning", "Buenas", "Oi", "bom dia", "  hello!! "])
    ck(`"${g}" → greeting`, isBareGreeting(g), g);
  for (const s of ["How much for vinyl?", "Hi, do you do tile?", "I need flooring for my kitchen", "hello test 123 main st", "Busco trabajo"])
    ck(`"${s}" → NOT a bare greeting`, !isBareGreeting(s), s);
  ck("greeting survives an appended [SYSTEM:] note", isBareGreeting("Hola" + NOTE));

  // ── 2. opener language picked from the greeting ───────────────────────────
  console.log("\n[2] openerMessage language");
  ck("'Hola' → Spanish opener", openerMessage("Hola") === OPENER_ES);
  ck("'Ola' (no H) → Spanish opener", openerMessage("Ola") === OPENER_ES);
  ck("'Olá' → Portuguese opener", openerMessage("Olá") === OPENER_PT);
  ck("'Oi' → Portuguese opener", openerMessage("Oi") === OPENER_PT);
  ck("'Hi' → English opener", openerMessage("Hi") === OPENER_EN);
  ck("'Good morning' → English opener", openerMessage("Good morning") === OPENER_EN);

  // ── 3. opener content: promotion + 3 types, no price ──────────────────────
  console.log("\n[3] opener content");
  for (const [name, o] of [["EN", OPENER_EN], ["ES", OPENER_ES], ["PT", OPENER_PT]] as const) {
    ck(`${name}: names tile, vinyl/vinílico, hardwood`, /tile/i.test(o) && /vin(yl|ílico)/i.test(o) && /hardwood/i.test(o), o);
    ck(`${name}: mentions a promotion`, /promotion|promoci[oó]n|promo[çc][aã]o/i.test(o), o);
    ck(`${name}: no price`, !/\$\s*\d/.test(o), o);
  }

  // ── 4. getAIResponse fires the opener on a first-contact greeting ─────────
  console.log("\n[4] first-contact greeting → opener (deterministic, no AI call)");
  ck("'Ola' first contact → Spanish opener", (await ai([{ role: "user", content: "Ola" + NOTE }])) === OPENER_ES);
  ck("'Hola' first contact → Spanish opener", (await ai([{ role: "user", content: "Hola" + NOTE }])) === OPENER_ES);
  ck("'Hi' first contact → English opener", (await ai([{ role: "user", content: "Hi" + NOTE }])) === OPENER_EN);

  // ── 5. does NOT fire when it should not ───────────────────────────────────
  console.log("\n[5] opener does NOT override real conversations");
  const afterReply = await ai([
    { role: "user", content: "Hi" },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: "Hello again" + NOTE },
  ]);
  ck("greeting AFTER a prior bot reply → NOT the canned opener (AI continues)", afterReply !== OPENER_EN && afterReply.trim().length > 0, afterReply);

  const substantive = await ai([{ role: "user", content: "How much per square foot for vinyl?" + NOTE }]);
  ck("substantive first message → NOT the opener (AI answers)", substantive !== OPENER_EN && substantive !== OPENER_ES, substantive);

  // ── 5b. first-contact LOCATION question → location opener, right language ──
  // Caso Ken 2026-08-21: "Dónde te encuentras" (tú form) matched neither the
  // location FAQ nor the Spanish language check and got the generic ENGLISH
  // opener — question ignored AND wrong language.
  console.log("\n[5b] location question on first contact → location opener in the client's language");
  const locCases: Array<[string, string]> = [
    ["Dónde te encuentras", OPENER_LOCATION_ES],
    ["Dónde se encuentran?", OPENER_LOCATION_ES],
    ["¿Dónde están ubicados?", OPENER_LOCATION_ES],
    ["Ubicación?", OPENER_LOCATION_ES],
    ["En qué zona trabajan", OPENER_LOCATION_ES],
    ["Where are you located?", OPENER_LOCATION_EN],
    ["What areas do you serve?", OPENER_LOCATION_EN],
    ["Onde fica?", OPENER_LOCATION_PT],
    ["Onde vocês atendem?", OPENER_LOCATION_PT],
  ];
  for (const [q, want] of locCases) {
    const got = await ai([{ role: "user", content: q + NOTE }]);
    ck(`"${q}" → location opener (${want === OPENER_LOCATION_ES ? "ES" : want === OPENER_LOCATION_PT ? "PT" : "EN"})`, got === want, got);
  }
  // The ad-reply note must not reroute a location question to the generic opener.
  const adLoc = await ai([{ role: "user", content: "Dónde te encuentras\n\n[Client replied to our ad]" + NOTE }]);
  ck("'Dónde te encuentras' + ad note → still the ES location opener", adLoc === OPENER_LOCATION_ES, adLoc);

  // ── 5c. question the opener does NOT answer → model, never the canned line ──
  // 2026-08-21 sweep: 25 first messages in 7 days carried a real question and
  // got the canned opener over it (licensed? smaller projects? free estimates?).
  console.log("\n[5c] first-message question beyond the opener → real answer (not canned)");
  const ALL_CANNED = [OPENER_EN, OPENER_ES, OPENER_PT, OPENER_LOCATION_EN, OPENER_LOCATION_ES, OPENER_LOCATION_PT];
  const beyondCases = [
    "Are you guys licensed? I’m looking to do some flooring",
    "Hello, do you do smaller projects? I need to replace a portion of my flooring but not the whole thing",
    "Que material están colocando??",
    "Do you remove any existing rugs???",
  ];
  for (const q of beyondCases) {
    const got = await ai([{ role: "user", content: q + "\n\n[Client replied to our ad]" + NOTE }]);
    ck(`"${q.slice(0, 50)}…" → NOT a canned opener`, !ALL_CANNED.includes(got) && got.trim().length > 0, got);
  }
  // …but price/how-much questions are the opener's home turf and stay canned.
  ck("'how much per sqft?' still gets the canned type-ask", (await ai([{ role: "user", content: "how much per sqft?" + NOTE }])) === OPENER_EN);
  ck("'Hola?' (greeting with ?) still gets the canned ES opener", (await ai([{ role: "user", content: "Hola?" + NOTE }])) === OPENER_ES);

  // ── 5d. rejection / hostility on first contact → TOTAL silence ─────────────
  // fb_27777958491826513 (2026-08-22): "No. Get away from me" as the first
  // message got the canned promo opener via the ad-context leg. Any rejection
  // must produce [REACT_ONLY] deterministically — no promo, no apology, and
  // NEVER a model call (inputTokens must be 0).
  console.log("\n[5d] first-contact rejection → [REACT_ONLY], zero tokens");
  const rejectionCases = [
    // the reported case + the 7-day sweep's real victims
    "No. Get away from me",
    "No. Get away from me\n\n[Client replied to our ad]",
    "Reporting you for spam",
    "stop messaging me",
    "Don’t message me",
    "Fuck off",
    "Leave me alone",
    "Not interested",
    "No thanks",
    "No.",
    "Nope",
    "STOP",
    "Seriously piss off",
    "no me interesa",
    "Déjenme en paz",
    "não tenho interesse",
    "para de me mandar mensagem",
    "wrong number",
    "unsubscribe",
    // false negatives from the 2026-08-22 adversarial sweep
    "please stop",
    "stop sending me messages",
    "stop hitting me up",
    "stop reaching out",
    "no more messages please",
    "this is harassment",
    "I'll report your page",
    "im blocking you",
    "reported as spam",
    "spam",
    "scam",
    "f off",
    "screw you",
    "lose my number",
    "no im good thanks",
    "we're all set thanks",
    "no molesten",
    "no escriban mas",
    "no quiero nada",
    "es una estafa",
    "váyanse",
    "não quero",
    "não me mande mais mensagem",
    "não enche",
    "para com isso",
    "é golpe",
    "vou te bloquear",
  ];
  for (const msg of rejectionCases) {
    const r = await getAIResponse([{ role: "user", content: msg + NOTE }], null, null, null, false);
    ck(`"${msg.split("\n")[0]}" → [REACT_ONLY] (silence)`, r.text === "[REACT_ONLY]" && r.inputTokens === 0, r.text);
  }
  // Follow-up abuse AFTER the (already sent) opener → still silence, not a model chat.
  const midAbuse = await getAIResponse([
    { role: "user", content: "No. Get away from me" },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: "Reporting you for spam" },
    { role: "user", content: "Not even good flooring work, you're trash" + NOTE },
  ], null, null, null, false);
  ck("post-opener abuse burst → [REACT_ONLY] (silence)", midAbuse.text === "[REACT_ONLY]" && midAbuse.inputTokens === 0, midAbuse.text);

  // ── 5e. rejection detector precision — real customers are NEVER silenced ───
  // Every case here came from the 2026-08-22 adversarial sweep: 20/33 EN and
  // 23/45 ES/PT realistic customer messages were being silenced by the naive
  // pattern list. The owner's hardest rule: never silence a real client.
  console.log("\n[5e] rejection detectors do NOT fire on real customers");
  const notRejections = [
    "Can you stop by tomorrow to measure?",
    "no rush, whenever works",
    "you never contacted me back",
    "no me mandaron el precio",
    "Is this a scam?",
    "can we stop the installation for now?",
    "I want to stop the vinyl order and do tile instead",
    // adversarial sweep — hostile-family false positives
    "Take me off the schedule for Friday, can we do Monday instead?",
    "If you get lost just call me when you get to the gate",
    "Can we get away with vinyl in the bathroom?",
    "We go away for the summer in June, can we schedule before that?",
    "My neighbor reported you guys did an amazing job on her floors",
    "Don't text me, call me instead",
    "Stop texting me here, message me on WhatsApp instead",
    "Please don't message me before 9am, I work nights. But yes I want a quote",
    "Please quit bothering my tenant, coordinate with me directly",
    "Tell your guys to stay away from the pool area when they come",
    "Unsubscribe me from the promo blasts but keep my appointment",
    "stop texting my old number this is my new account",
    "no me hablen en ingles porfavor, solo español",
    "no me contacten por messenger, uso mas whatsapp",
    "no me molesten antes de las 9 porfa, trabajo de noche",
    "esto es spam o es real? me interesa el piso",
    "no son una estafa verdad?",
    "hay muchos estafadores por aqui, ustedes tienen licencia?",
    "cuidado, hay estafadores usando el nombre de ustedes",
    "perdon, deje de mandar mensajes porque estaba de viaje, todavia me interesa",
    "vayase derecho por la calle 8 y mi casa queda a la derecha",
    "não me esquece não, ainda to esperando o orçamento",
    "esse valor sai fora do meu orçamento, tem opção mais barata?",
    "vou denunciar meu vizinho na prefeitura, voces tiram a licença da obra?",
  ];
  for (const msg of notRejections)
    ck(`"${msg.slice(0, 60)}" → NOT hostile`, !isHostileRejection(msg), msg);
  const notFirstContactRejections = [
    "Not interested in vinyl, do you do tile?",
    "No, I need hardwood actually",
    "Hola",
    "Hi",
    "How much per sqft?",
    "How do I know you're not scammers? Are you licensed?",
    "no me interesa madera, quiero piso vinilico",
    "não tenho interesse em madeira, quero piso vinílico",
    "Stop texting me here, whatsapp me at 5613334444",
    "Do you install tile?\nstop texting my old number this is my new account",
  ];
  for (const msg of notFirstContactRejections)
    ck(`"${msg.split("\n")[0].slice(0, 60)}" → NOT a first-contact rejection`, !isFirstContactRejection(msg), msg);
  // ...but rejection-flavored wording still suppresses the CANNED opener: the
  // model must read the words ("call me instead" gets a call answer, never
  // the promo line).
  const prefReply = await getAIResponse([{ role: "user", content: "Don't text me, call me instead\n\n[Client replied to our ad]" + NOTE }], null, null, null, false);
  ck("'Don't text me, call me instead' → NOT the canned opener, NOT silence (model reads it)",
    !ALL_CANNED.includes(prefReply.text) && prefReply.text !== "[REACT_ONLY]" && prefReply.text.trim().length > 0, prefReply.text);
  // Re-engagement after a silenced first-contact rejection: the old hostile
  // bubble is still in the un-answered burst, but the new interest must win.
  const reengaged = await getAIResponse([
    { role: "user", content: "No. Get away from me" },
    { role: "user", content: "Sorry about earlier. Do you install tile? How much per sqft?" + NOTE },
  ], null, null, null, false);
  ck("re-engagement after first-contact rejection → answered (never eternal silence)",
    reengaged.text !== "[REACT_ONLY]" && reengaged.text.trim().length > 0, reengaged.text);
  // Mid-conversation re-engagement: stale hostility must not silence a client
  // who changed their mind (only the NEWEST bubble is judged).
  const midReengaged = await getAIResponse([
    { role: "user", content: "Hi" },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: "stop messaging me" },
    { role: "user", content: "Actually I changed my mind, I would like the free estimate for vinyl please" + NOTE },
  ], null, null, null, false);
  ck("mid-convo re-engagement after 'stop messaging me' → answered",
    midReengaged.text !== "[REACT_ONLY]" && midReengaged.text.trim().length > 0, midReengaged.text);
  // Cancel and booking info always beat mid-conversation silence.
  const cancelNotSwallowed = await getAIResponse([
    { role: "user", content: "Hi" },
    { role: "assistant", content: OPENER_EN },
    { role: "user", content: "stop messaging me, I want to cancel my appointment" + NOTE },
  ], null, null, null, false);
  ck("'stop messaging me, I want to cancel my appointment' → NOT silenced (cancel flow wins)", cancelNotSwallowed.text !== "[REACT_ONLY]" && cancelNotSwallowed.text.trim().length > 0, cancelNotSwallowed.text);

  // ── 6. wiring: the opener helpers are reachable via the shared brain ───────
  console.log("\n[6] source wiring");
  const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
  ck("getAIResponse sends the opener on a first-contact greeting", /isBareGreeting\(lastMsg\.content\)/.test(aiSrc) && /openerMessage\(lastMsg\.content\)/.test(aiSrc));
  ck("getAIResponse consults the rejection guard before any canned opener", /isFirstContactRejection\(unansweredBurst\)/.test(aiSrc) && /isHostileRejection\(newestBubble\)/.test(aiSrc));
  ck("first-contact router suppresses canned openers on rejection-flavored bursts", /mentionsRejection\(burst\)/.test(aiSrc) && /!rejectionish/.test(aiSrc));

  console.log(`\n=========== OPENER-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
