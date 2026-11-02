/**
 * NENHUM LINK EM CANAL NENHUM + NENHUM ZIP DE CARA + AMOSTRA = NÚMERO DO OZZI
 * (regra do dono, 02/11/2026): "não pode mandar link nem no Instagram, nem no
 * Messenger, nem no WhatsApp. Nenhum link pode ser enviado no direct. [...] no
 * direct, você não pode pedir o zip code logo de cara. Você deve primeiro ter
 * uma conversa com o cliente. Depois você pede o endereço, com zip code e
 * telefone [...] Caso o cliente peça para ver o sample, peça para ele entrar em
 * contato diretamente com o número final 34."
 *
 * O que mudou (o Instagram já era assim desde 17/10 e 02/11 de manhã; agora
 * Messenger e WhatsApp seguem a mesma regra):
 *  1. LINKS: o SYSTEM_PROMPT não tem mais nenhuma URL (site, Hearth). A
 *     resposta para amostras/fotos/cores/"que piso é esse"/site é: amostras na
 *     visita grátis + "text Ozzi at (561) 674-8334" para ver antes (no
 *     Instagram continua "our website, the link is in our bio"). Financiamento
 *     = número do Ozzi em todo canal. neutralizeLinks(text, lang, { channel })
 *     é o backstop: fora do Instagram o link do site derruba a frase e entra a
 *     SAMPLES_HANDOFF_LINE antes da pergunta final; getAIResponse, os 3
 *     webhooks, o follow-up e o quote-reply aplicam.
 *  2. ZIP: a nota ZIP CODE FIRST da agenda está DESLIGADA por padrão
 *     (getRealAvailabilityContext só a gera com zipFirst: true); o prompt
 *     propõe a visita já com os dois horários; as enlatadas "que piso é esse"
 *     e Port St. Lucie não perguntam o ZIP em nenhum canal. O ZIP continua
 *     obrigatório no [BOOK] (booking-requires-zipcode), pedido junto do
 *     endereço completo + telefone depois do horário escolhido.
 *  3. AMOSTRAS: as enlatadas see_options (EN/PT) e a regra (2a) mandam para o
 *     (561) 674-8334.
 *
 * Prova: [1] puro, [2] estático, [3] agenda real SÓ LEITURA (SCHED=1 ou
 * LIVE=1), [4] AO VIVO com o modelo real + o mesmo pós-processo dos webhooks
 * (LIVE=1): Messenger/WhatsApp sem link, sem ZIP de cara, amostras = número;
 * Instagram igual ao de antes (bio, sem ZIP).
 * Run: npx tsx src/evals/no-links-no-zip-first-verify.ts   (LIVE=1 para [3]+[4])
 */
import { readFileSync } from "fs";
import { join } from "path";
function loadEnv() {
  try {
    const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of c.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* sem .env.local: só a parte pura roda */ }
}
loadEnv();
process.env.ANTHROPIC_API_KEY ||= "unused-pure-eval";
import {
  IG_CHANNEL_NOTE, IG_CHANNEL_TAG, SAMPLES_HANDOFF_LINE, IG_FINANCING_LINE, OZZI_NUMBER_RE, containsLink, neutralizeLinks,
  ensureFinancingHandoff, ensureIgFinancingHandoff, mentionsBioLink, dmChannelOf, isInstagramChannel,
} from "../lib/ig-link-policy";
import { getAIResponse, fixWhichFloorReply, withSiteForColor, portStLucieReply, stripForbiddenTags, smallJobPhotosMessage, containsSchedulingOffer, unansweredUserBurst, scrubLearnings, type ChatMessage } from "../lib/ai";
import { zipFirstNote, ZIP_FIRST_NOTE_HEADER, getRealAvailabilityContext, getEasternDateContext, portStLucieVisitMessage } from "../lib/scheduler";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 400)}»`); }
}
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const ZIP_WORD = /\bzip\b|c[oó]digo\s+postal|\bcep\b/i;
const CLOCK = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi;
const APP_DETAILS = /2\s*min|credit\s+score|online\s+(?:form|application)|fill\s+out|formulario|aplicaci[oó]n\s+en\s+l[ií]nea|no\s+afecta|does\s+not\s+affect/i;
const IG_SYS = `\n\n[SYSTEM: TODAY: Monday, November 2, 2026 [2026-11-02]. Current time: 10:00 AM Eastern.\n\n${IG_CHANNEL_NOTE}]`;
const OTHER_SYS = `\n\n[SYSTEM: TODAY: Monday, November 2, 2026 [2026-11-02]. Current time: 10:00 AM Eastern.]`;
const WA_NOTE = (phone = "19545550123") => `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
const WA_SYS = (phone = "19545550123") => `\n\n[SYSTEM: TODAY: Monday, November 2, 2026 [2026-11-02]. Current time: 10:00 AM Eastern.\n\n${WA_NOTE(phone)}]`;

function done() {
  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1); }
}

async function main() {
  console.log("\n===================== NO LINKS ON ANY CHANNEL + NO ZIP UP FRONT + SAMPLES → OZZI (owner rule 2026-11-02) =====================");

  // ── 1. puro ───────────────────────────────────────────────────────────────
  console.log("\n[1a] the samples line and the channel helper");
  for (const l of ["en", "es", "pt"] as const) ck(`${l} samples line: Ozzi's number, no link, no ¿`, OZZI_NUMBER_RE.test(SAMPLES_HANDOFF_LINE[l]) && !containsLink(SAMPLES_HANDOFF_LINE[l]) && !/[¿¡]/.test(SAMPLES_HANDOFF_LINE[l]) && /visit|visita/.test(SAMPLES_HANDOFF_LINE[l]), SAMPLES_HANDOFF_LINE[l]);
  ck("dmChannelOf: IG note → instagram, otherwise other", dmChannelOf([U("hi" + IG_SYS)]) === "instagram" && dmChannelOf([U("hi" + OTHER_SYS)]) === "other" && dmChannelOf([U("hi" + WA_SYS())]) === "other");
  ck("IG note unchanged: tag, no link, no zip up front, bio wording", IG_CHANNEL_NOTE.startsWith(IG_CHANNEL_TAG) && /NO ZIP CODE UP FRONT ON INSTAGRAM/.test(IG_CHANNEL_NOTE) && /link is in our bio/.test(IG_CHANNEL_NOTE) && !containsLink(IG_CHANNEL_NOTE));

  console.log("\n[1b] neutralizeLinks off Instagram (Messenger / WhatsApp wording)");
  const siteWa = neutralizeLinks("Sure, you can see our floors at https://ozzifloors.company, and I bring all the samples to the free visit. Is it just one area or the whole house?", "en", { channel: "whatsapp" });
  ck("WA site link → sentence gone, samples + Ozzi line, closing question kept", siteWa === `${SAMPLES_HANDOFF_LINE.en} Is it just one area or the whole house?`, siteWa);
  const siteFb = neutralizeLinks("You can see all our floor colors at https://ozzifloors.company. Is it one area or the whole house?", "en", { channel: "messenger" });
  ck("Messenger site link → same shape", siteFb === `${SAMPLES_HANDOFF_LINE.en} Is it one area or the whole house?`, siteFb);
  const siteEs = neutralizeLinks("Claro, puedes ver nuestros pisos en https://ozzifloors.company y llevo las muestras. Es una sola área o toda la casa?", "es", { channel: "whatsapp" });
  ck("ES: Spanish line, no ¿", siteEs === `${SAMPLES_HANDOFF_LINE.es} Es una sola área o toda la casa?` && !/[¿¡]/.test(siteEs), siteEs);
  const sitePt = neutralizeLinks("Você pode ver nossos pisos em https://ozzifloors.company. É só uma área ou a casa toda?", "pt", { channel: "whatsapp" });
  ck("PT: Portuguese line", sitePt === `${SAMPLES_HANDOFF_LINE.pt} É só uma área ou a casa toda?`, sitePt);
  const bare = neutralizeLinks("Check ozzifloors.company for the colors. One area or whole house?", "en", { channel: "other" });
  ck("bare domain counts as a link off Instagram too", !containsLink(bare) && OZZI_NUMBER_RE.test(bare) && /One area or whole house\?$/.test(bare), bare);
  const finWa = neutralizeLinks("Yes, we offer financing. You can apply here: https://app.gethearth.com/partners/ozzifloors, it takes 2 minutes. Is it one area or the whole house?", "en", { channel: "whatsapp" });
  ck("WA financing link → Ozzi's financing line (same as Instagram)", finWa === "Yes, we offer financing. For financing, just call or text Ozzi at (561) 674-8334. Is it one area or the whole house?", finWa);
  const otherWa = neutralizeLinks("Here is your contract: https://ozzifloors.app/sign/abc. Let me know.", "en", { channel: "whatsapp" });
  ck("WA other link → dropped + owner line", otherWa === "Here is your contract. Let me know. Text Ozzi at (561) 674-8334 and he'll send it to you.", otherWa);
  const both = neutralizeLinks("See our floors at https://ozzifloors.company. For financing apply at https://app.gethearth.com/partners/ozzifloors. One area or whole house?", "en", { channel: "whatsapp" });
  ck("site + financing off IG → one Ozzi number, no link, question kept", !containsLink(both) && (both.match(/8334/g) ?? []).length === 1 && /One area or whole house\?$/.test(both), both);
  const already = neutralizeLinks("You can see our floors at https://ozzifloors.company or text Ozzi at (561) 674-8334. One area or whole house?", "en", { channel: "whatsapp" });
  ck("number already in the reply → still exactly one number after the drop", !containsLink(already) && (already.match(/8334/g) ?? []).length === 1, already);
  ck("idempotent off IG", neutralizeLinks(siteWa, "en", { channel: "whatsapp" }) === siteWa);
  ck("plain reply untouched off IG", neutralizeLinks("Our vinyl promo is $5 per sqft. One area or whole house?", "en", { channel: "whatsapp" }) === "Our vinyl promo is $5 per sqft. One area or whole house?");
  ck("email untouched off IG", neutralizeLinks("Send the plans to ozzifloors@gmail.com please.", "en", { channel: "whatsapp" }) === "Send the plans to ozzifloors@gmail.com please.");
  const siteIg = neutralizeLinks("Sure, you can see our floors at https://ozzifloors.company, and I bring all the samples to the free visit. Is it just one area or the whole house?", "en", { channel: "instagram" });
  ck("Instagram wording unchanged (bio)", siteIg === "Sure, you can see our floors on our website (link in our bio), and I bring all the samples to the free visit. Is it just one area or the whole house?", siteIg);
  ck("default (no channel) = Instagram wording, as the IG send uses it", neutralizeLinks("See https://ozzifloors.company today.") === siteIgDefault("See https://ozzifloors.company today."));
  ck("ensureFinancingHandoff is the same backstop as the IG one", ensureFinancingHandoff("Yes, we offer financing. Is it one area or the whole house?", "Do you offer financing?", "en") === ensureIgFinancingHandoff("Yes, we offer financing. Is it one area or the whole house?", "Do you offer financing?", "en") && OZZI_NUMBER_RE.test(ensureFinancingHandoff("Yes, we offer financing. Is it one area or the whole house?", "Do you offer financing?", "en")));

  console.log("\n[1c] fixWhichFloorReply: no link, no zip, channel wording");
  const guess = "That's our luxury vinyl with a stone finish! Want me to set up a visit?";
  for (const lang of ["en", "es", "pt"] as const) {
    const ig = fixWhichFloorReply(guess, lang, true, { ig: true });
    const other = fixWhichFloorReply(guess, lang, true);
    ck(`${lang} IG full shape: bio + samples + area question, no link, no zip`, mentionsBioLink(ig) && !containsLink(ig) && !ZIP_WORD.test(ig) && /(?:one area, or the entire house|una sola área o toda la casa|só uma área ou a casa toda)\?$/.test(ig), ig);
    ck(`${lang} Messenger/WA full shape: samples + Ozzi's number + area question, no link, no zip, no bio`, OZZI_NUMBER_RE.test(other) && !containsLink(other) && !ZIP_WORD.test(other) && !mentionsBioLink(other) && /(?:one area, or the entire house|una sola área o toda la casa|só uma área ou a casa toda)\?$/.test(other), other);
    ck(`${lang} neither shape guesses the floor`, !/stone finish|marble|herringbone|wood look/i.test(ig + other));
  }
  const modelZipOther = "Check out our floors at https://ozzifloors.company, that floor is there with all the details, and I bring samples to the free visit too. What's the zip code there?";
  const swappedOther = fixWhichFloorReply(modelZipOther, "en", true);
  ck("Messenger/WA: the URL + zip shape the model may still write → canned Ozzi shape, no link, no zip", swappedOther === fixWhichFloorReply(guess, "en", true), swappedOther);
  const modelZipIg = "Our floors are on our website, the link is in our bio, that floor is there with all the details, and I bring samples to the free visit too. What's the zip code there?";
  const swappedIg = fixWhichFloorReply(modelZipIg, "en", true, { ig: true });
  ck("IG: a zip question is swapped for the area question, bio kept", !ZIP_WORD.test(swappedIg) && mentionsBioLink(swappedIg) && /one area, or the entire house\?$/.test(swappedIg), swappedIg);
  const partial = fixWhichFloorReply("Great choice! Is it one area or the whole house?", "en", false);
  ck("Messenger/WA partial shape: the Ozzi sentence goes in ahead of the closing question", OZZI_NUMBER_RE.test(partial) && /Is it one area or the whole house\?$/.test(partial) && !containsLink(partial), partial);
  const okOther = "I bring all the samples to the free visit, and to see the options before that just text Ozzi at (561) 674-8334. Is it one area or the whole house?";
  ck("Messenger/WA reply that already has the number is untouched", fixWhichFloorReply(okOther, "en", true) === okOther);
  const withTag = fixWhichFloorReply(modelZipIg + "[NOTIFY_OWNER]", "en", true, { ig: true });
  ck("trailing tag survives", /\[NOTIFY_OWNER\]$/.test(withTag) && !ZIP_WORD.test(withTag), withTag);

  console.log("\n[1d] withSiteForColor: bio on IG, samples + Ozzi off IG, never a URL");
  const colorIg = withSiteForColor("We have many colors. Is it one area or the whole house?", "en", { ig: true });
  ck("IG: bio sentence added, no URL", mentionsBioLink(colorIg) && !containsLink(colorIg) && /whole house\?$/.test(colorIg), colorIg);
  const colorWa = withSiteForColor("We have many colors. Is it one area or the whole house?", "en");
  ck("Messenger/WA: samples + Ozzi line added ahead of the question, no URL", colorWa === `We have many colors. ${SAMPLES_HANDOFF_LINE.en} Is it one area or the whole house?`, colorWa);
  const colorPhone = "For the colors, just text Ozzi at (561) 674-8334. One area or whole house?";
  ck("Messenger/WA: a color-to-phone reply is the right answer now, untouched", withSiteForColor(colorPhone, "en") === colorPhone);
  ck("IG: a color-to-phone reply still becomes the bio sentence", mentionsBioLink(withSiteForColor(colorPhone, "en", { ig: true })) && !OZZI_NUMBER_RE.test(withSiteForColor(colorPhone, "en", { ig: true })), withSiteForColor(colorPhone, "en", { ig: true }));
  ck("tag-only reply untouched", withSiteForColor("[REACT_ONLY]", "en") === "[REACT_ONLY]" && withSiteForColor("[REACT_ONLY]", "en", { ig: true }) === "[REACT_ONLY]");
  for (const l of ["en", "es", "pt"] as const) ck(`${l} smallJobPhotosMessage: Ozzi's number, no link`, OZZI_NUMBER_RE.test(smallJobPhotosMessage(l)) && !containsLink(smallJobPhotosMessage(l)), smallJobPhotosMessage(l));
  const sendImages = stripForbiddenTags("Here are some options [SEND_IMAGES: a,b]");
  ck("[SEND_IMAGES] fallback: samples + Ozzi line, no URL", OZZI_NUMBER_RE.test(sendImages) && !containsLink(sendImages), sendImages);

  console.log("\n[1e] Port St. Lucie visit line: the day, never the zip, on every channel");
  const pslOther = [U("1500 sqft in Port St Lucie")];
  const pslIg = [U("1500 sqft in Port St Lucie" + IG_SYS)];
  ck("Messenger/WA: 'What day works best for you?', no zip", /What day works best/.test(portStLucieReply(pslOther, "en")) && !ZIP_WORD.test(portStLucieReply(pslOther, "en")), portStLucieReply(pslOther, "en"));
  ck("IG: same", /What day works best/.test(portStLucieReply(pslIg, "en")) && !ZIP_WORD.test(portStLucieReply(pslIg, "en")));
  ck("portStLucieVisitMessage never asks the zip (EN/ES/PT, any flag)", (["en", "es", "pt"] as const).every((l) => !ZIP_WORD.test(portStLucieVisitMessage(l, true, false)) && !ZIP_WORD.test(portStLucieVisitMessage(l, false)) && !/[¿¡]/.test(portStLucieVisitMessage(l))));

  console.log("\n[1f] the canned samples / photos intercept (no model call)");
  try {
    const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
    const PROMO = "Our vinyl promo is $5 per sqft and it includes the floor, the installation and the quarter round. I offer a free quote, are you planning to do just one area, or the entire house?";
    const cannedWa = (await getAIResponse([A(OPENER), U("Vinyl"), A(PROMO), U("Can you send me some samples or photos?" + WA_SYS())], null, null, null, false)).text;
    ck("WA 'can you send me samples?' → canned: samples at the visit + Ozzi's number, no link, scope question", OZZI_NUMBER_RE.test(cannedWa) && !containsLink(cannedWa) && /one area or the whole house\?$/i.test(cannedWa), cannedWa);
    const cannedIg = (await getAIResponse([A(OPENER), U("Vinyl"), A(PROMO), U("Can you send me some samples or photos?" + IG_SYS)], null, null, null, false)).text;
    ck("IG same ask → same canned (owner: samples = Ozzi's number, every channel), no link", OZZI_NUMBER_RE.test(cannedIg) && !containsLink(cannedIg), cannedIg);
    const cannedPt = (await getAIResponse([A(OPENER), U("Vinil"), A(PROMO), U("Me manda fotos dos pisos?" + WA_SYS())], null, null, null, false)).text;
    ck("PT 'me manda fotos' → canned PT with Ozzi's number, no link", OZZI_NUMBER_RE.test(cannedPt) && !containsLink(cannedPt) && /casa toda\?$/.test(cannedPt), cannedPt);
  } catch (e) { ck("canned intercept reachable without the model", false, String(e)); }

  console.log("\n[1g] scrubLearnings: the Dreaming learnings never re-teach a link or the zip-first script");
  const learn = "1. **Zip-first, then two times.** Every booking followed the same flow.\n2. Short pivot on epoxy.\nCheck our floors at https://ozzifloors.company. What's the zip code?\n3. Owning a filled slot and offering the next.";
  const scrubbed = scrubLearnings(learn);
  ck("lines teaching zip-first or a link are dropped, the others stay", !/Zip-first/.test(scrubbed) && !containsLink(scrubbed) && /Short pivot on epoxy/.test(scrubbed) && /Owning a filled slot/.test(scrubbed), scrubbed);
  const cleanLearn = "1. Own the filled slot.\n2. Ask the address with the zip code and the phone together.";
  ck("a clean learnings file is untouched", scrubLearnings(cleanLearn) === cleanLearn);
  ck("getAIResponse injects the scrubbed learnings", /\$\{scrubLearnings\(systemMemory\)\}/.test(read("src/lib/ai.ts")));

  // ── 2. estático ───────────────────────────────────────────────────────────
  console.log("\n[2a] the shared prompt: no URL, no ZIP CODE FIRST, samples → Ozzi");
  ck("SYSTEM_PROMPT carries no link at all", !containsLink(SYSTEM_PROMPT) && !/gethearth|ozzifloors\.com/i.test(SYSTEM_PROMPT), (SYSTEM_PROMPT.match(/[^\n]*(?:https?:\/\/|ozzifloors\.com)[^\n]*/) ?? [""])[0]);
  ck("no 'ZIP CODE FIRST' and no visit proposal ending with the zip question", !/ZIP CODE FIRST/.test(SYSTEM_PROMPT) && !/What's the zip code of the property\?"/.test(SYSTEM_PROMPT), (SYSTEM_PROMPT.match(/[^\n]*zip code of the property[^\n]*/) ?? [""])[0]);
  ck("STEP 2B: NO ZIP CODE UP FRONT (owner rule 2026-11-02, every channel), two times in the same message", /NO ZIP CODE UP FRONT \(owner rule 2026-11-02, every channel: Instagram, Messenger and WhatsApp\)/.test(SYSTEM_PROMPT) && /collected ONLY together with the full address and the phone, after the client chose a time/.test(SYSTEM_PROMPT));
  ck("VISIT CONFIRMATION SEQUENCE step 1 offers the two times and never ends with a zip question", /Step 1: Propose the visit in ONE short sentence[^\n]*offer exactly TWO specific time slots[^\n]*NEVER end the proposal with a zip code question/.test(SYSTEM_PROMPT));
  ck("(2a) samples / photos / colors / website → samples at the visit + text Ozzi, never a link", /\(2a\) SEND \/ SHOW REMOTELY → the samples at the free visit \+ Ozzi's number, NEVER a link \(owner rule 2026-11-02\)/.test(SYSTEM_PROMPT) && /text Ozzi directly at \(561\) 674-8334\. NEVER write a website address or any URL/.test(SYSTEM_PROMPT));
  ck("(2d) colors: bio on Instagram, Ozzi's number on Messenger / WhatsApp, never a URL", /\(2d\) ANY QUESTION ABOUT THE COLOR OF THE FLOOR → A WAY TO SEE THE COLORS, ALWAYS, NEVER A LINK/.test(SYSTEM_PROMPT) && /on Messenger and WhatsApp say you bring all the physical samples to the free visit and that to see the colors before that they can text Ozzi at \(561\) 674-8334/.test(SYSTEM_PROMPT));
  ck("AD FLOOR QUESTIONS: no link, no zip, area question or two times", /Answer EXACTLY in this shape, with NO link \(owner rule 2026-11-02\)/.test(SYSTEM_PROMPT) && /move toward the visit WITHOUT asking the zip code/.test(SYSTEM_PROMPT));
  ck("NO LINKS ON ANY CHANNEL block, Instagram keeps the bio wording", /NO LINKS ON ANY CHANNEL \(owner rule 2026-10-17 for Instagram, extended to Messenger and WhatsApp on 2026-11-02\)/.test(SYSTEM_PROMPT) && /the link is in our bio/.test(SYSTEM_PROMPT) && /el link está en nuestra bio/.test(SYSTEM_PROMPT) && /o link está na nossa bio/.test(SYSTEM_PROMPT));
  ck("FINANCING: Ozzi's number on every channel, no link, no application details", /NEVER send a financing link or any link \(owner rule 2026-11-02: no link on any channel/.test(SYSTEM_PROMPT) && /EVERY CHANNEL, SAME ANSWER/.test(SYSTEM_PROMPT) && !/takes about 2 minutes/.test(SYSTEM_PROMPT));
  ck("ZIP ALREADY GIVEN / ADDRESS MUST BE COMPLETE still there (the zip is still required to book)", /ZIP ALREADY GIVEN:/.test(SYSTEM_PROMPT) && /ADDRESS MUST BE COMPLETE, WITH THE ZIP CODE/.test(SYSTEM_PROMPT) && /NEVER guess, infer, or fill the ZIP CODE yourself/.test(SYSTEM_PROMPT));
  ck("no inverted punctuation", !/[¿¡]/.test(SYSTEM_PROMPT));

  console.log("\n[2b] scheduler: the ZIP CODE FIRST note is off by default");
  const sc = read("src/lib/scheduler.ts");
  ck("getRealAvailabilityContext: zipFirst === true is the only way to get the note", /const zipNote = opts\?\.zipFirst === true \? zipFirstNote\(opts\?\.history\) : null;/.test(sc));
  ck("zipFirstNote itself still exists (documents the retired script)", (zipFirstNote([U("Hi, vinyl, 1500 sqft")]) ?? "").startsWith(ZIP_FIRST_NOTE_HEADER));
  const pslFn = (sc.match(/export function portStLucieVisitMessage[\s\S]*?\n\}/) ?? [""])[0];
  ck("portStLucieVisitMessage asks the day in all three languages (no zip branch left)", /What day works best for you\?/.test(pslFn) && /Qué día le queda mejor\?/.test(pslFn) && /Qual dia fica melhor para você\?/.test(pslFn) && !ZIP_WORD.test(pslFn.replace(/\/\/[^\n]*/g, "")), pslFn);

  console.log("\n[2c] the three webhooks: no link out, financing backstop, same schedule call");
  const ig = read("src/app/api/webhook/route.ts");
  const fb = read("src/app/api/fb-webhook/route.ts");
  const wa = read("src/app/api/wa-webhook/route.ts");
  ck("Messenger imports the policy and neutralizes the final reply with channel: messenger", /import \{ neutralizeLinks, ensureFinancingHandoff \} from "@\/lib\/ig-link-policy";/.test(fb) && /const finalResponse = ensureFinancingHandoff\(\s*\n\s*neutralizeLinks\(stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang, \{ channel: "messenger" \}\),\s*\n\s*unansweredUserBurst\(messagesForAI\),\s*\n\s*lang,\s*\n\s*\);/.test(fb));
  ck("WhatsApp imports the policy and neutralizes the final reply with channel: whatsapp", /import \{ neutralizeLinks, ensureFinancingHandoff \} from "@\/lib\/ig-link-policy";/.test(wa) && /const finalResponse = ensureFinancingHandoff\(\s*\n\s*neutralizeLinks\(stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang, \{ channel: "whatsapp" \}\),\s*\n\s*unansweredUserBurst\(messagesForAI\),\s*\n\s*lang,\s*\n\s*\);/.test(wa));
  ck("Instagram webhook unchanged (note + neutralize + financing backstop)", /systemParts\.push\(IG_CHANNEL_NOTE\);/.test(ig) && /const finalResponse = ensureIgFinancingHandoff\(\s*\n\s*neutralizeLinks\(stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang\),/.test(ig));
  ck("no webhook asks for zipFirst: true", !/zipFirst: true/.test(ig + fb + wa));
  ck("Messenger / WhatsApp never got the IG note (the bio wording stays Instagram-only)", !/IG_CHANNEL_NOTE/.test(fb) && !/IG_CHANNEL_NOTE/.test(wa));

  console.log("\n[2d] ai.ts: channel-aware backstops, canned replies link-free");
  const ai = read("src/lib/ai.ts");
  ck("hard-coded intercept neutralized on every channel", /return \{ text: neutralizeInstagramLinks\(hardcoded, usersLang\(\), \{ channel: dmChannelOf\(messages\) \}\), inputTokens: 0, outputTokens: 0 \};/.test(ai));
  ck("final post-processing neutralized on every channel, after stripInvertedPunctuation", /cleaned = stripInvertedPunctuation\(cleaned\);[\s\S]{0,900}cleaned = neutralizeInstagramLinks\(cleaned, usersLang\(\), \{ channel: dmChannelOf\(messages\) \}\);/.test(ai));
  ck("which-floor backstop: noZip always, ig flag", /const fixed = fixWhichFloorReply\(cleaned, usersLang\(\), full, \{ noZip: true, ig \}\);/.test(ai));
  ck("color backstop passes the channel", /withSiteForColor\(cleaned, usersLang\(\), \{ ig: isInstagramChannel\(messages\) \}\)/.test(ai));
  ck("PSL visit line never asks the zip", /if \(mode === "visit"\) return portStLucieVisitMessage\(lang, intro, true\);/.test(ai));
  const canned = ai.match(/response: "[^"]*"/g) ?? [];
  ck("no canned response in ai.ts carries a URL", canned.every((c) => !containsLink(c)), canned.filter((c) => containsLink(c)).join(" | "));
  ck("see_options canned replies (EN/PT) give Ozzi's number", /id: "see_options_en",[\s\S]{0,400}response: "Sure! I bring all the samples to the free visit, and if you want to see them before that, just text Ozzi at \(561\) 674-8334\./.test(ai) && /id: "see_options_pt",[\s\S]{0,400}response: "Claro! Eu levo todas as amostras na visita grátis, e se quiser ver antes, é só mandar mensagem pro Ozzi no \(561\) 674-8334\./.test(ai));

  console.log("\n[2e] other producers: follow-up, quote replies, Dreaming, training panel");
  const fu = read("src/lib/followup.ts");
  ck("follow-up nudge neutralized per channel before the send", /text = neutralizeLinks\(text, decision\.lang, \{ channel: channel === "whatsapp" \? "whatsapp" : channel === "facebook" \? "messenger" : "instagram" \}\);/.test(fu));
  const qr = read("src/lib/quote-reply.ts");
  ck("quote replies: no link rule, financing → Ozzi, colors → Ozzi, output neutralized", /6\. NEVER write a link or URL of any kind \(owner rule 2026-11-02/.test(qr) && /18\. COLORS AND SAMPLES, NEVER A LINK/.test(qr) && /const noLinks = neutralizeLinks\(text, lang, \{ channel: "whatsapp" \}\);/.test(qr) && !/https:\/\/ozzifloors\.company/.test(qr) && !/Financing application link: \$\{ctx\.url\}/.test(qr));
  const dr = read("src/lib/dreaming.ts");
  ck("Dreaming rule 7: the zip is never asked up front; rule 13: no link on any channel", /7\. THE ZIP CODE IS NEVER ASKED UP FRONT \(owner rule 2026-11-02, every channel/.test(dr) && /13\. THE AGENT NEVER SENDS A LINK, ON ANY CHANNEL/.test(dr) && !/where the website is sent as https:\/\/ozzifloors\.company/.test(dr));
  const tr = read("src/app/api/training/chat/route.ts");
  ck("training panel: no URL plug, output neutralized", /aiResponse = neutralizeLinks\(aiResponse, undefined, \{ channel: "other" \}\);/.test(tr) && !/SITE_URL/.test(tr));

  // ── 3. agenda real (SÓ LEITURA) ───────────────────────────────────────────
  const sched = process.env.SCHED === "1" || process.env.LIVE === "1";
  if (!sched) { console.log("\n[3] agenda real: pulada (SCHED=1 ou LIVE=1 para rodar, só leitura)"); }
  else {
    console.log("\n[3] agenda real (SÓ LEITURA): the schedule block carries no ZIP CODE FIRST note by default");
    try {
      const hist = [U("Hi, I want vinyl for my whole house, about 1500 sqft")];
      const def = await getRealAvailabilityContext({ history: hist });
      const forced = await getRealAvailabilityContext({ history: hist, zipFirst: true });
      ck("default (Messenger / WhatsApp / Instagram) → schedule block WITHOUT the note", /REAL-TIME SCHEDULE|fully booked|\[\d{4}-\d{2}-\d{2}\]/.test(def) && !def.includes(ZIP_FIRST_NOTE_HEADER), def.slice(-300));
      ck("zipFirst: true still produces the note (documented, unused by the webhooks)", forced.includes(ZIP_FIRST_NOTE_HEADER));
      ck("the schedule lines are identical", def.split("\n").filter((l) => l.startsWith("•")).join("\n") === forced.split("\n").filter((l) => l.startsWith("•")).join("\n"));
    } catch (e) { ck("agenda real (só leitura)", false, String(e)); }
  }

  // ── 4. ao vivo ────────────────────────────────────────────────────────────
  const live = process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY !== "unused-pure-eval";
  if (!live) { console.log("\n[4] AO VIVO: pulado (LIVE=1 com ANTHROPIC_API_KEY para rodar)"); return done(); }
  console.log("\n[4] AO VIVO: modelo real + o pós-processo de cada webhook");
  const date = getEasternDateContext();
  const pipeline = async (msgs: ChatMessage[], channel: "instagram" | "messenger" | "whatsapp", lang: "en" | "es" | "pt") => {
    const raw = (await getAIResponse(msgs, null, null, null, false)).text;
    const final = ensureFinancingHandoff(neutralizeLinks(raw, lang, { channel }), unansweredUserBurst(msgs), lang);
    return { raw, final };
  };
  const withSys = (msgs: ChatMessage[], avail: string, channel: "instagram" | "messenger" | "whatsapp"): ChatMessage[] => {
    const out = msgs.slice();
    const last = out[out.length - 1];
    const extra = channel === "instagram" ? "\n\n" + IG_CHANNEL_NOTE : channel === "whatsapp" ? "\n\n" + WA_NOTE() : "";
    out[out.length - 1] = { ...last, content: last.content + `\n\n[SYSTEM: ${date}\n\n${avail}${extra}]` };
    return out;
  };
  const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
  const PROMO = "Our vinyl promo is $5 per sqft and it includes the floor, the installation and the quarter round. I offer a free quote, are you planning to do just one area, or the entire house?";
  const base: ChatMessage[] = [A(OPENER), U("Vinyl"), A(PROMO), U("The whole house, about 1500 sqft")];
  try {
    const avail = await getRealAvailabilityContext({ history: base });

    for (const channel of ["messenger", "whatsapp", "instagram"] as const) {
      const r = await pipeline(withSys(base, avail, channel), channel, "en");
      console.log(`   ${channel} 1500 sqft: ${r.final.replace(/\s+/g, " ")}`);
      ck(`LIVE ${channel} (1500 sqft): visit proposed WITH times, NO zip question, no link, no total`, (r.final.match(CLOCK) ?? []).length >= 1 && containsSchedulingOffer(r.final) && !ZIP_WORD.test(r.final) && !containsLink(r.final) && !/\$\s?\d{3,}/.test(r.final) && !/\[BOOK:/.test(r.final), r.final);
    }

    const colorsFb = await pipeline([U("Hi, I'm interested in vinyl flooring"), A(PROMO), U("What colors do you have? Can you send me the link to see them?" + OTHER_SYS)], "messenger", "en");
    console.log(`   Messenger colors raw: ${colorsFb.raw.replace(/\s+/g, " ")}\n   Messenger colors final: ${colorsFb.final.replace(/\s+/g, " ")}`);
    ck("LIVE Messenger colors + link ask: the model wrote no URL", !containsLink(colorsFb.raw), colorsFb.raw);
    ck("LIVE Messenger colors: final has Ozzi's number, no link, no bio, no zip", OZZI_NUMBER_RE.test(colorsFb.final) && !containsLink(colorsFb.final) && !mentionsBioLink(colorsFb.final) && !ZIP_WORD.test(colorsFb.final), colorsFb.final);

    const samplesWa = await pipeline([A(OPENER), U("vinyl for the living room and the kitchen"), A(PROMO), U("Do you have samples I could see first?" + WA_SYS())], "whatsapp", "en");
    console.log(`   WhatsApp samples: ${samplesWa.final.replace(/\s+/g, " ")}`);
    ck("LIVE WhatsApp 'samples I could see first': Ozzi's number, no link", OZZI_NUMBER_RE.test(samplesWa.final) && !containsLink(samplesWa.final), samplesWa.final);

    const whichFb = await pipeline([U("What floor is that in your ad?" + OTHER_SYS)], "messenger", "en");
    console.log(`   Messenger which-floor raw: ${whichFb.raw.replace(/\s+/g, " ")}\n   Messenger which-floor final: ${whichFb.final.replace(/\s+/g, " ")}`);
    ck("LIVE Messenger 'what floor is that': no link, no guess, no zip, Ozzi's number, forward step", !containsLink(whichFb.final) && !/stone finish|marble look|wood look|herringbone/i.test(whichFb.final) && !ZIP_WORD.test(whichFb.final) && OZZI_NUMBER_RE.test(whichFb.final) && /\?/.test(whichFb.final), whichFb.final);

    const finWa = await pipeline([U("Hi, I'm interested in vinyl flooring for my house"), A(PROMO), U("Do you offer financing?" + WA_SYS())], "whatsapp", "en");
    console.log(`   WhatsApp financing raw: ${finWa.raw.replace(/\s+/g, " ")}\n   WhatsApp financing final: ${finWa.final.replace(/\s+/g, " ")}`);
    ck("LIVE WhatsApp financing: the model itself gave Ozzi's number, no link, no application details", OZZI_NUMBER_RE.test(finWa.raw) && !containsLink(finWa.raw) && !APP_DETAILS.test(finWa.raw), finWa.raw);
    ck("LIVE WhatsApp financing: never 'we don't offer financing'", !/(?:don't|do not|no)\s+(?:offer|have|do)\s+financing/i.test(finWa.final), finWa.final);

    const finEs = await pipeline([U("Hola, me interesa el piso de vinil"), A("Hola, nuestra promoción de vinil es $5 por pie cuadrado e incluye el piso, la instalación y el quarter round. Es una sola área o toda la casa?"), U("Tienen financiamiento?" + OTHER_SYS)], "messenger", "es");
    console.log(`   Messenger financiamiento: ${finEs.final.replace(/\s+/g, " ")}`);
    ck("LIVE Messenger financiamiento (ES): Ozzi's number, no link, no ¿", OZZI_NUMBER_RE.test(finEs.final) && !containsLink(finEs.final) && !/[¿¡]/.test(finEs.final), finEs.final);

    const colorsIg = await pipeline([U("Hi, I'm interested in vinyl flooring"), A(PROMO), U("What colors do you have?" + IG_SYS)], "instagram", "en");
    console.log(`   IG colors: ${colorsIg.final.replace(/\s+/g, " ")}`);
    ck("LIVE IG colors (regression): bio wording, no link", !containsLink(colorsIg.final) && mentionsBioLink(colorsIg.final), colorsIg.final);

    const when: ChatMessage[] = [A(OPENER), U("vinyl, just the living room, 600 sqft"), A("For that size I measure in person and give you the best price, the visit is free and I bring the samples."), U("ok when can you come?")];
    const availWhen = await getRealAvailabilityContext({ history: when });
    const whenFb = await pipeline(withSys(when, availWhen, "messenger"), "messenger", "en");
    console.log(`   Messenger when can you come: ${whenFb.final.replace(/\s+/g, " ")}`);
    ck("LIVE Messenger 'when can you come?': times, no zip question", (whenFb.final.match(CLOCK) ?? []).length >= 1 && !ZIP_WORD.test(whenFb.final), whenFb.final);

    // The offer comes from the REAL schedule (first day line, its first and last time), so the pick is still open.
    const line = avail.split("\n").find((l) => /^• .*\[\d{4}-\d{2}-\d{2}\]: .*(?:am|pm)/.test(l) && !/fully booked/.test(l)) ?? "";
    const weekday = (line.match(/^• (\w+)/) ?? [])[1];
    const times = (line.split("]: ")[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!weekday || times.length === 0) console.log("   (no open day line in the real schedule, the pick case is skipped)");
    else {
      const offer = `I can come ${weekday} at ${times[0]}${times.length > 1 ? ` or ${times[times.length - 1]}` : ""}, which works?`;
      const picked: ChatMessage[] = [A(OPENER), U("Vinyl"), A(PROMO), U("The whole house, about 1500 sqft"), A(`For that size I measure in person and give you the best price, it's free and I bring the samples. ${offer}`), U(`${weekday} at ${times[0]} works`)];
      const availPicked = await getRealAvailabilityContext({ history: picked });
      const pickedFb = await pipeline(withSys(picked, availPicked, "messenger"), "messenger", "en");
      console.log(`   Messenger after the pick (${weekday} ${times[0]}): ${pickedFb.final.replace(/\s+/g, " ")}`);
      ck("LIVE Messenger after the client picked a time: asks the address WITH the zip code and the phone (the zip is still required)", /address|direcci|endere/i.test(pickedFb.final) && ZIP_WORD.test(pickedFb.final) && /phone|number|tel/i.test(pickedFb.final), pickedFb.final);
    }
  } catch (e) { ck("ao vivo", false, String(e)); }

  done();
}

function siteIgDefault(t: string): string { return neutralizeLinks(t, undefined, { channel: "instagram" }); }

main().catch((e) => { console.error(e); process.exit(1); });
