/**
 * INSTAGRAM NUNCA MANDA LINK + FINANCIAMENTO = NÚMERO DO OZZI (regra do dono,
 * 17/10/2026): "Apenas no Instagram não é para a IA enviar nenhum link. Quando
 * o cliente perguntar dos pisos que temos, fala para ele acessar o site que
 * está no link da nossa bio; e caso ele queira falar de financiamento, ele deve
 * entrar em contato com o Ozzi no número (561) 674-8334."
 *
 * Messenger e WhatsApp seguem iguais (site https://ozzifloors.company, link do
 * financiamento pela plataforma). Só o Instagram muda, em três camadas:
 *  1. PROMPT: o webhook do IG põe [INSTAGRAM CHANNEL: ...] na nota [SYSTEM:] da
 *     última bolha; o prompt fixo tem a exceção do Instagram no STEP 2 ("our
 *     website, the link is in our bio") e no FINANCING (número do Ozzi).
 *  2. BACKSTOP no webhook: o finalResponse passa por neutralizeLinks (qualquer
 *     link vira "link na bio" / número do Ozzi / linha do Ozzi) e por
 *     ensureIgFinancingHandoff (cliente perguntou de financiamento e a resposta
 *     não tem o número → a linha do financiamento entra antes da pergunta final).
 *  3. ENVIO: sendInstagramMessage neutraliza TODO link de TODO produtor de IA
 *     (webhook, follow-up, outbox, recuperação) e devolve sentText para o banco
 *     guardar o que o cliente viu. Só o painel (dono digitando) manda link
 *     (allowLinks), com o fallback do 508 ainda atrás.
 *  + ai.ts: withSiteForColor / fixWhichFloorReply aceitam "link in our bio"
 *    como "já tem o site" (senão o IG ganhava site + bio duplicados).
 *  + Dreaming (regra 13): "link na bio" no IG é a regra, nunca erro nem padrão
 *    para os outros canais.
 *
 * Prova: [1] puro (política), [2] estático (webhook, envio, painel, prompt,
 * ai.ts, Dreaming), [3] AO VIVO com o modelo real + o mesmo pós-processo do
 * webhook (pula com DET_ONLY=1 ou sem ANTHROPIC_API_KEY): cores/link no IG →
 * sem URL, "link in our bio"; financiamento EN/ES no IG → número do Ozzi, sem
 * URL, sem detalhes da aplicação; "what floor is that" no IG → sem URL, bio.
 * Run: npx tsx src/evals/ig-no-links-verify.ts   (DET_ONLY=1 pula a parte 3)
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
  IG_CHANNEL_NOTE, IG_CHANNEL_TAG, IG_FINANCING_LINE, OZZI_NUMBER_RE, isInstagramChannel, containsLink, neutralizeLinks,
  asksAboutFinancing, ensureIgFinancingHandoff, mentionsBioLink,
} from "../lib/ig-link-policy";
import { getAIResponse, withSiteForColor, fixWhichFloorReply, unansweredUserBurst, type ChatMessage } from "../lib/ai";
import { SYSTEM_PROMPT } from "../lib/system-prompt";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");
const APP_DETAILS = /2\s*min|credit\s+score|online\s+(?:form|application)|fill\s+out|formulario|aplicaci[oó]n\s+en\s+l[ií]nea|no\s+afecta|does\s+not\s+affect/i;

function done() {
  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1); }
}

async function main() {
  console.log("\n===================== INSTAGRAM: NO LINKS + FINANCING → OZZI (owner rule 2026-10-17) =====================");

  // ── 1. política pura ──────────────────────────────────────────────────────
  console.log("\n[1a] the channel note");
  ck("note is tagged [INSTAGRAM CHANNEL and says: no link, website = link in our bio, financing = Ozzi's number", IG_CHANNEL_NOTE.startsWith(IG_CHANNEL_TAG) && /NEVER write any link or URL/.test(IG_CHANNEL_NOTE) && /link is in our bio/.test(IG_CHANNEL_NOTE) && /financing[\s\S]*\(561\) 674-8334/.test(IG_CHANNEL_NOTE));
  ck("note never names the URL", !containsLink(IG_CHANNEL_NOTE));
  ck("isInstagramChannel reads the note off a user turn", isInstagramChannel([{ role: "user", content: `hi\n\n[SYSTEM: TODAY x\n\n${IG_CHANNEL_NOTE}]` }]) && !isInstagramChannel([{ role: "user", content: "hi\n\n[SYSTEM: TODAY x]" }]));

  console.log("\n[1b] every link neutralized, per kind and language");
  const site = neutralizeLinks("Sure, you can see all our floors at https://ozzifloors.company, and I bring all the samples to the free visit. Is it just one area or the whole house?");
  ck("site → 'on our website (link in our bio)'", site === "Sure, you can see all our floors on our website (link in our bio), and I bring all the samples to the free visit. Is it just one area or the whole house?", site);
  const finMid = neutralizeLinks("Yes, we offer financing. You can apply here: https://app.gethearth.com/partners/ozzifloors, it takes 2 minutes. Is it one area or the whole house?");
  ck("financing link: its sentence goes, Ozzi's line goes in before the closing question", finMid === "Yes, we offer financing. For financing, just call or text Ozzi at (561) 674-8334. Is it one area or the whole house?", finMid);
  const finOnly = neutralizeLinks("https://app.gethearth.com/partners/ozzifloors");
  ck("financing link alone → the line alone", finOnly === IG_FINANCING_LINE.en, finOnly);
  const finEs = neutralizeLinks("Sí, tenemos financiamiento. Puedes aplicar aquí: https://app.gethearth.com/partners/ozzifloors y me avisas. Es una sola área o toda la casa?");
  ck("ES financing link → 'llama o escríbele a Ozzi al (561) 674-8334', no ¿", finEs === "Sí, tenemos financiamiento. Para el financiamiento, llama o escríbele a Ozzi al (561) 674-8334. Es una sola área o toda la casa?" && !/[¿¡]/.test(finEs), finEs);
  const finPt = neutralizeLinks("Sim, temos financiamento, você pode aplicar em https://app.gethearth.com/partners/ozzifloors. É só uma área ou a casa toda?");
  ck("PT financing link (one sentence with the link) → the sentence goes, PT line before the closing question", finPt === "Para o financiamento, é só ligar ou mandar mensagem pro Ozzi no (561) 674-8334. É só uma área ou a casa toda?", finPt);
  const misspelt = neutralizeLinks("Apply at https://app.gerhearth.com/partners/ozzifloors today.");
  ck("misspelt hearth link is still the financing link", misspelt === IG_FINANCING_LINE.en, misspelt);
  const both = neutralizeLinks("See our floors at https://ozzifloors.company. For financing apply at https://app.gethearth.com/partners/ozzifloors. One area or whole house?");
  ck("site + financing in one reply", both === "See our floors on our website (link in our bio). For financing, just call or text Ozzi at (561) 674-8334. One area or whole house?", both);
  const other = neutralizeLinks("Here is your contract to sign: https://ozzifloors.app/sign/3f43d3d2348e705ec21c77def0843c4d1f93ce77ee729a6b. Let me know once it's done.");
  ck("other link → dropped + 'Text Ozzi … he'll send it to you' (no 'Instagram is blocking' excuse)", other === "Here is your contract to sign. Let me know once it's done. Text Ozzi at (561) 674-8334 and he'll send it to you." && !/blocking/i.test(other), other);
  ck("financing line already present → not repeated", !/8334[\s\S]*8334/.test(neutralizeLinks("For financing text Ozzi at (561) 674-8334, or apply at https://app.gethearth.com/partners/ozzifloors.")));
  for (const out of [site, finMid, finOnly, finEs, finPt, misspelt, both, other]) ck("result carries no link", !containsLink(out), out);
  ck("plain reply untouched", neutralizeLinks("Our vinyl promo is $5 per sqft and the estimate is free. One area or the whole house?") === "Our vinyl promo is $5 per sqft and the estimate is free. One area or the whole house?");
  ck("email untouched", neutralizeLinks("Send the plans to ozzifloors@gmail.com please.") === "Send the plans to ozzifloors@gmail.com please.");

  console.log("\n[1c] asksAboutFinancing (client intent, EN/ES/PT)");
  for (const q of ["Do you offer financing?", "Can I pay monthly?", "do you have payment plans", "any installment options?", "I'd like to finance it", "Financiamiento?", "tienen crédito?", "se puede pagar a plazos?", "pagar en cuotas?", "Vocês parcelam?", "tem financiamento?", "Financing available?"]) ck(`asks: "${q}"`, asksAboutFinancing(q));
  for (const q of ["How much is it?", "do you take credit cards?", "aceptan tarjeta de crédito?", "what payment methods do you accept?", "can I pay by check?", "When is the payment due?", "cartão de crédito?", "9am works, 123 Main St Miami FL 33130, 3055550100"]) ck(`not financing: "${q}"`, !asksAboutFinancing(q));
  ck("the [SYSTEM:] note (which names financing) never counts as the client asking", !asksAboutFinancing(`hi\n\n[SYSTEM: TODAY x\n\n${IG_CHANNEL_NOTE}]`));
  ck("unansweredUserBurst strips the note too", !asksAboutFinancing(unansweredUserBurst([{ role: "assistant", content: "x" }, { role: "user", content: `what colors do you have?\n\n[SYSTEM: TODAY x\n\n${IG_CHANNEL_NOTE}]` }])));

  console.log("\n[1d] ensureIgFinancingHandoff (the webhook backstop)");
  const b1 = ensureIgFinancingHandoff("Yes, we offer financing through our partner. Is it one area or the whole house?", "Do you offer financing?", "en");
  ck("no number → line goes in ahead of the closing question", b1 === "Yes, we offer financing through our partner. For financing, just call or text Ozzi at (561) 674-8334. Is it one area or the whole house?", b1);
  const b2 = ensureIgFinancingHandoff("Yes, we offer financing through our partner, it takes about 2 minutes to apply", "Do you offer financing?", "en");
  ck("no closing question → line at the end, sentence closed", b2 === "Yes, we offer financing through our partner, it takes about 2 minutes to apply. For financing, just call or text Ozzi at (561) 674-8334.", b2);
  const b3 = ensureIgFinancingHandoff("Sí, tenemos financiamiento con nuestro socio. Es una sola área o toda la casa?", "tienen financiamiento?", "es");
  ck("ES line", b3 === "Sí, tenemos financiamiento con nuestro socio. Para el financiamiento, llama o escríbele a Ozzi al (561) 674-8334. Es una sola área o toda la casa?", b3);
  const b4 = ensureIgFinancingHandoff("Sim, temos financiamento. É só uma área ou a casa toda?", "vocês parcelam?", "pt");
  ck("PT line", b4 === "Sim, temos financiamento. Para o financiamento, é só ligar ou mandar mensagem pro Ozzi no (561) 674-8334. É só uma área ou a casa toda?", b4);
  ck("number already there → untouched", ensureIgFinancingHandoff("Yes, for financing just text Ozzi at (561) 674-8334. One area or whole house?", "Do you offer financing?", "en") === "Yes, for financing just text Ozzi at (561) 674-8334. One area or whole house?");
  ck("client did not ask → untouched", ensureIgFinancingHandoff("Our vinyl promo is $5 per sqft.", "how much?", "en") === "Our vinyl promo is $5 per sqft.");
  const b5 = ensureIgFinancingHandoff("Yes we offer financing. Which works better, 3pm or 5pm?[NOTIFY_OWNER]", "financing?", "en");
  ck("trailing tag stays last", /\[NOTIFY_OWNER\]$/.test(b5) && OZZI_NUMBER_RE.test(b5) && /8334\. Which works better, 3pm or 5pm\?/.test(b5), b5);
  ck("tag-only reply (deliberate silence) untouched", ensureIgFinancingHandoff("[REACT_ONLY]", "financing?", "en") === "[REACT_ONLY]");
  ck("empty reply untouched", ensureIgFinancingHandoff("", "financing?", "en") === "");

  console.log("\n[1e] mentionsBioLink + the ai.ts site backstops accept it");
  ck("EN/ES/PT bio wording detected", mentionsBioLink("the link is in our bio") && mentionsBioLink("el link está en nuestra bio") && mentionsBioLink("o link está na nossa bio") && mentionsBioLink("our website (link in our bio)"));
  ck("URL / 'biology' are not bio wording", !mentionsBioLink("see https://ozzifloors.company") && !mentionsBioLink("a link to biology"));
  const igColor = "You can see all our floor colors on our website, the link is in our bio, and I bring the samples to the free visit. Is it one area or the whole house?";
  ck("withSiteForColor leaves the Instagram reply alone (no URL sentence added next to the bio line)", withSiteForColor(igColor, "en") === igColor, withSiteForColor(igColor, "en"));
  const igWhich = "Check out our floors on our website, the link is in our bio, that floor is there with all the details, and I bring samples to the free visit too. What's the zip code there?";
  ck("fixWhichFloorReply leaves the Instagram reply alone", fixWhichFloorReply(igWhich, "en", true) === igWhich, fixWhichFloorReply(igWhich, "en", true));
  ck("withSiteForColor still adds the URL off Instagram", /ozzifloors\.company/.test(withSiteForColor("We have many colors. Is it one area or the whole house?", "en")));

  // ── 2. estático ───────────────────────────────────────────────────────────
  console.log("\n[2a] IG webhook: note in, neutralize + financing backstop out");
  const wh = read("src/app/api/webhook/route.ts");
  ck("imports the policy", /import \{ IG_CHANNEL_NOTE, neutralizeLinks, ensureIgFinancingHandoff \} from "@\/lib\/ig-link-policy";/.test(wh));
  ck("IG_CHANNEL_NOTE pushed into systemParts right after date + schedule", /const systemParts: string\[\] = availability \? \[dateContext, availability\] : \[dateContext\];[\s\S]{0,400}systemParts\.push\(IG_CHANNEL_NOTE\);/.test(wh));
  ck("finalResponse = ensureIgFinancingHandoff(neutralizeLinks(stripForbiddenTags(...), lang), unansweredUserBurst(messagesForAI), lang)", /const finalResponse = ensureIgFinancingHandoff\(\s*\n\s*neutralizeLinks\(stripForbiddenTags\(redirectOwnerPromiseToPhone\(afterNotify, lang\)\), lang\),\s*\n\s*unansweredUserBurst\(messagesForAI\),\s*\n\s*lang,\s*\n\s*\);/.test(wh));
  ck("Messenger and WhatsApp webhooks untouched (no IG note, no IG neutralizer)", !/IG_CHANNEL_NOTE|ig-link-policy/.test(read("src/app/api/fb-webhook/route.ts")) && !/IG_CHANNEL_NOTE|ig-link-policy/.test(read("src/app/api/wa-webhook/route.ts")));

  console.log("\n[2b] the send: every AI link neutralized, panel keeps links");
  const ig = read("src/lib/instagram.ts");
  ck("sendInstagramMessage(recipient, text, opts: IgSendOptions = {})", /export async function sendInstagramMessage\(\s*\n\s*recipientIgsid: string,\s*\n\s*text: string,\s*\n\s*opts: IgSendOptions = \{\}\s*\n\)/.test(ig));
  ck("hasLink && !opts.allowLinks → neutralizeLinks, no marker gate", /if \(hasLink && !opts\.allowLinks\) \{\s*\n\s*outText = neutralizeLinks\(text\);\s*\n\s*linkFree = true;/.test(ig) && !/igLinkBlockActive|clearIgLinkBlock/.test(ig));
  ck("sentText still returned when the text changed", /linkFree \? \{ ok: true, via: "instagram", sentText: outText \} : \{ ok: true, via: "instagram" \}/.test(ig));
  ck("508 fallback kept for the panel path", /isIgLinkBlockError\(body\.error\?\.code\) && containsLink\(outText\)/.test(ig) && /await markIgLinkBlock\(\);/.test(ig));
  const panel = read("src/app/api/conversations/[id]/send/route.ts");
  ck("panel passes allowLinks: true (the owner typing is not the AI)", /sendInstagramMessage\(igsid, body\.text, \{ allowLinks: true \}\)/.test(panel) && /if \(igResult\.sentText\) storedText = igResult\.sentText;/.test(panel));
  for (const [file, re] of [
    ["src/lib/followup.ts", /sendInstagramMessage\(conv\.igsid, text\)/],
    ["src/lib/delivery.ts", /sendInstagramMessage\(conv\.igsid, text\)/],
  ] as const) ck(`${file}: AI producer sends without allowLinks`, re.test(read(file)));
  ck("no AI producer passes allowLinks: true", !/allowLinks: true/.test(wh) && !/allowLinks: true/.test(read("src/lib/followup.ts")) && !/allowLinks: true/.test(read("src/lib/delivery.ts")));

  console.log("\n[2c] prompt: the Instagram exceptions");
  ck("STEP 2: INSTAGRAM, NO LINKS block keyed on [INSTAGRAM CHANNEL]", /INSTAGRAM, NO LINKS \(owner rule 2026-10-17\): when an \[INSTAGRAM CHANNEL\] note is present in context, NEVER write any link or URL/.test(SYSTEM_PROMPT));
  ck("…with the bio wording in EN/ES/PT", /the link is in our bio/.test(SYSTEM_PROMPT) && /el link está en nuestra bio/.test(SYSTEM_PROMPT) && /o link está na nossa bio/.test(SYSTEM_PROMPT));
  ck("…color question still gets the website (bio), never the phone", /a color question still gets the website \(link in our bio\), never Ozzi's phone/.test(SYSTEM_PROMPT));
  ck("FINANCING: INSTAGRAM EXCEPTION → Ozzi's number, no link, no application details", /INSTAGRAM EXCEPTION \(owner rule 2026-10-17\): when an \[INSTAGRAM CHANNEL\] note is present in context, NEVER send the financing link and NEVER explain the application[\s\S]{0,300}\(561\) 674-8334/.test(SYSTEM_PROMPT));
  ck("Instagram examples carry no URL", !containsLink((SYSTEM_PROMPT.match(/INSTAGRAM, NO LINKS[\s\S]*?Financing on Instagram follows/) ?? [""])[0]) && !containsLink((SYSTEM_PROMPT.match(/INSTAGRAM EXCEPTION \(owner rule 2026-10-17\)[\s\S]*?casa toda\?"/) ?? [""])[0]));
  ck("off Instagram the website rule is unchanged (2a still sends https://ozzifloors.company)", /\(2a\) SEND \/ SHOW REMOTELY → send our website[\s\S]{0,400}https:\/\/ozzifloors\.company/.test(SYSTEM_PROMPT));
  ck("no inverted punctuation in the new Spanish examples", !/[¿¡]/.test(SYSTEM_PROMPT));

  console.log("\n[2c2] getAIResponse itself leaves Instagram link-free (canned intercepts + post-model backstops)");
  const aiSrc = read("src/lib/ai.ts");
  ck("hard-coded intercept neutralized on Instagram", /return \{ text: isInstagramChannel\(messages\) \? neutralizeInstagramLinks\(hardcoded, usersLang\(\)\) : hardcoded, inputTokens: 0, outputTokens: 0 \};/.test(aiSrc));
  ck("final post-processing neutralized on Instagram, after stripInvertedPunctuation", /cleaned = stripInvertedPunctuation\(cleaned\);[\s\S]{0,700}if \(isInstagramChannel\(messages\)\) cleaned = neutralizeInstagramLinks\(cleaned, usersLang\(\)\);/.test(aiSrc));

  console.log("\n[2d] Dreaming never learns against the rule");
  const dr = read("src/lib/dreaming.ts");
  ck("rule 13: Instagram exception, link in bio + Ozzi's number are the rule, not an error", /INSTAGRAM IS THE EXCEPTION \(owner rule 2026-10-17\)[\s\S]{0,600}never write a learning that tells the agent to send a link on Instagram/.test(dr));

  // ── 3. ao vivo ────────────────────────────────────────────────────────────
  const live = process.env.DET_ONLY !== "1" && process.env.ANTHROPIC_API_KEY !== "unused-pure-eval";
  if (!live) { console.log("\n[3] AO VIVO: pulado (DET_ONLY=1 ou sem ANTHROPIC_API_KEY)"); return done(); }
  console.log("\n[3] AO VIVO: modelo real + o pós-processo do webhook do IG");
  const NOTE = `\n\n[SYSTEM: TODAY: Friday, October 17, 2026 [2026-10-17]. Current time: 10:00 AM Eastern.\n\n${IG_CHANNEL_NOTE}]`;
  const U = (c: string): ChatMessage => ({ role: "user", content: c });
  const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
  const pipeline = async (msgs: ChatMessage[], lang: "en" | "es" | "pt") => {
    const raw = (await getAIResponse(msgs, null, null, null, false)).text;
    const final = ensureIgFinancingHandoff(neutralizeLinks(raw, lang), unansweredUserBurst(msgs), lang);
    return { raw, final };
  };

  const colors = await pipeline([
    U("Hi, I'm interested in vinyl flooring"),
    A("Hi, our vinyl promo is $5 per sqft and it includes the floor, the installation and the quarter round. Is it just one area or the whole house?"),
    U("What colors do you have? Can you send me the link to see them?" + NOTE),
  ], "en");
  console.log(`   colors raw:   ${colors.raw.replace(/\s+/g, " ")}\n   colors final: ${colors.final.replace(/\s+/g, " ")}`);
  ck("LIVE colors (IG): the model itself wrote no URL", !containsLink(colors.raw), colors.raw);
  ck("LIVE colors (IG): final reply has no link and points to the bio", !containsLink(colors.final) && mentionsBioLink(colors.final), colors.final);
  ck("LIVE colors (IG): no 'reach Ozzi' instead of the website", !OZZI_NUMBER_RE.test(colors.final), colors.final);

  const fin = await pipeline([
    U("Hi, I'm interested in vinyl flooring for my house"),
    A("Hi, our vinyl promo is $5 per sqft and it includes the floor, the installation and the quarter round. Is it just one area or the whole house?"),
    U("Do you offer financing?" + NOTE),
  ], "en");
  console.log(`   financing raw:   ${fin.raw.replace(/\s+/g, " ")}\n   financing final: ${fin.final.replace(/\s+/g, " ")}`);
  ck("LIVE financing (IG): the model itself gave Ozzi's number and no link", OZZI_NUMBER_RE.test(fin.raw) && !containsLink(fin.raw), fin.raw);
  ck("LIVE financing (IG): final reply = Ozzi's number, no link, no application details", OZZI_NUMBER_RE.test(fin.final) && !containsLink(fin.final) && !APP_DETAILS.test(fin.final), fin.final);
  ck("LIVE financing (IG): never 'we don't offer financing'", !/(?:don't|do not|no)\s+(?:offer|have|do)\s+financing/i.test(fin.final), fin.final);

  const finEsLive = await pipeline([
    U("Hola, me interesa el piso de vinil"),
    A("Hola, nuestra promoción de vinil es $5 por pie cuadrado e incluye el piso, la instalación y el quarter round. Es una sola área o toda la casa?"),
    U("Tienen financiamiento?" + NOTE),
  ], "es");
  console.log(`   financiamiento raw:   ${finEsLive.raw.replace(/\s+/g, " ")}\n   financiamiento final: ${finEsLive.final.replace(/\s+/g, " ")}`);
  ck("LIVE financiamiento (IG, ES): Ozzi's number, no link, Spanish, no ¿", OZZI_NUMBER_RE.test(finEsLive.final) && !containsLink(finEsLive.final) && !/[¿¡]/.test(finEsLive.final) && /\b(?:financiamiento|Ozzi)\b/.test(finEsLive.final), finEsLive.final);

  const which = await pipeline([
    U("What floor is that in your post?" + NOTE),
  ], "en");
  console.log(`   which-floor raw:   ${which.raw.replace(/\s+/g, " ")}\n   which-floor final: ${which.final.replace(/\s+/g, " ")}`);
  ck("LIVE which floor (IG): no link, bio wording, no guessed floor, zip asked", !containsLink(which.final) && mentionsBioLink(which.final) && !/stone finish|marble look|wood look|herringbone/i.test(which.final) && /zip/i.test(which.final), which.final);

  done();
}

main().catch((e) => { console.error(e); process.exit(1); });
