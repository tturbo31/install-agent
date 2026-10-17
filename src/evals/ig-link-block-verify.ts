// Verifies the Instagram link-block handling (Graph 508 "Invalid message id",
// 2026-10-14): the reply "We actually do have a website at
// https://ozzifloors.company, …" was refused by Instagram while 215 link-free
// replies delivered the same day and the token was valid. The siren told the
// owner to mint a new token; he did; nothing changed. Pins:
//   1. the text policy: links detected, neutralized per language, emails and
//      numbers untouched, our site → "link in our bio", other links → owner line
//   2. the send: 508 on a link → resend without it, mark the block, calm note;
//      since 2026-10-17 (owner rule, see ig-no-links-verify.ts) EVERY AI reply
//      goes out link-free on Instagram, the marker is only a record
//   3. every producer stores the DELIVERED text (sentText) — stored ≠ sent
//      turns the IG echo into "[Treino]" + mode=human
//   4. the siren no longer tells the owner to swap the token on a 508
// Run: npx tsx src/evals/ig-link-block-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { containsLink, neutralizeLinks, replyLang, isIgLinkBlockError, IG_LINK_BLOCK_CODE } from "../lib/ig-link-policy";

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.slice(0, 200)}»`); }
}
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");

function main() {
  console.log("\n===================== INSTAGRAM LINK BLOCK (508) VERIFICATION (no API) =====================");

  // ── 1. text policy ────────────────────────────────────────────────────────
  console.log("\n[1] link detection");
  ck("508 is the link-block code", isIgLinkBlockError(508) && IG_LINK_BLOCK_CODE === 508);
  ck("190 / 10 / 551 are not", !isIgLinkBlockError(190) && !isIgLinkBlockError(10) && !isIgLinkBlockError(551) && !isIgLinkBlockError(undefined));
  ck("https link detected", containsLink("See https://ozzifloors.company for colors"));
  ck("www link detected", containsLink("Our site is www.ozzifloors.com"));
  ck("bare domain detected (Instagram linkifies it)", containsLink("Check ozzifloors.company for colors"));
  ck("financing link detected", containsLink("Apply here: https://app.gethearth.com/partners/ozzifloors"));
  ck("email is NOT a link", !containsLink("Yes, ozzifloors@gmail.com, same one you already sent the plans to."));
  ck("prices / times / abbreviations are NOT links", !containsLink("The vinyl promo is $5 per sq ft, 2.20 for carpet labor. Visit Tuesday at 10 a.m.? Port St. Lucie is served."));
  ck("plain reply unchanged", neutralizeLinks("Hi, our vinyl promo includes the floor, the installation and the quarter round.") === "Hi, our vinyl promo includes the floor, the installation and the quarter round.");

  console.log("\n[1b] language of the reply");
  ck("EN", replyLang("Sure, you can see our floors at https://ozzifloors.company, and I bring all the samples to the free visit.") === "en");
  ck("ES", replyLang("Puedes ver nuestros pisos en https://ozzifloors.company, y Ozzi lleva todas las muestras cuando se reúne contigo.") === "es");
  ck("PT", replyLang("Claro, você pode ver nossos pisos em https://ozzifloors.company, e eu levo todas as amostras na visita grátis.") === "pt");

  console.log("\n[1c] our site → link in our bio (same sentence, same language)");
  const en1 = neutralizeLinks("Sure, you can see our floors at https://ozzifloors.company, and I bring all the samples to the free visit. Is it just one area or the whole house?");
  ck("EN 'at URL' → 'on our website (link in our bio)'", en1 === "Sure, you can see our floors on our website (link in our bio), and I bring all the samples to the free visit. Is it just one area or the whole house?", en1);
  const en2 = neutralizeLinks("We actually do have a website at https://ozzifloors.company, but thanks for reaching out.");
  ck("EN 'website at URL' → 'website (link in our bio)' (the 2026-10-14 reply)", en2 === "We actually do have a website (link in our bio), but thanks for reaching out.", en2);
  const en3 = neutralizeLinks("You can see all our colors here: https://ozzifloors.company/gallery");
  ck("EN 'here: URL/path' → 'on our website (link in our bio)'", en3 === "You can see all our colors on our website (link in our bio)", en3);
  const en4 = neutralizeLinks("Check out ozzifloors.company for all the colors, and text me at (561) 674-8334.");
  ck("EN bare domain", en4 === "Check out our website (link in our bio) for all the colors, and text me at (561) 674-8334.", en4);
  const es1 = neutralizeLinks("Puedes ver nuestros pisos en https://ozzifloors.company, y Ozzi lleva todas las muestras cuando se reúne contigo. Puedes contactarlo al (561) 674-8334.");
  ck("ES 'en URL' → 'en nuestra página web (el link está en nuestra bio)'", es1 === "Puedes ver nuestros pisos en nuestra página web (el link está en nuestra bio), y Ozzi lleva todas las muestras cuando se reúne contigo. Puedes contactarlo al (561) 674-8334.", es1);
  const es2 = neutralizeLinks("Nuestra página web es https://ozzifloors.company, ahí están todos los colores.");
  ck("ES 'página web es URL'", es2 === "Nuestra página web (el link está en nuestra bio), ahí están todos los colores.", es2);
  const pt1 = neutralizeLinks("Claro, você pode ver nossos pisos em https://ozzifloors.company, e eu levo todas as amostras na visita grátis. É só uma área ou a casa toda?");
  ck("PT 'em URL' → 'no nosso site (o link está na nossa bio)'", pt1 === "Claro, você pode ver nossos pisos no nosso site (o link está na nossa bio), e eu levo todas as amostras na visita grátis. É só uma área ou a casa toda?", pt1);
  ck("old www.ozzifloors.com is our site too", neutralizeLinks("Our website is www.ozzifloors.com and the samples come to the visit.") === "Our website (link in our bio) and the samples come to the visit.");
  ck("URL-only reply", neutralizeLinks("https://ozzifloors.company") === "our website (link in our bio)");
  for (const out of [en1, en2, en3, en4, es1, es2, pt1]) ck("result carries no link", !containsLink(out), out);
  ck("no inverted punctuation in the Spanish fallbacks", !/[¿¡]/.test(es1 + es2 + neutralizeLinks("Aplica aquí: https://app.gethearth.com/partners/ozzifloors")));

  console.log("\n[1d] other links → dropped + owner line");
  const fin = neutralizeLinks("You can apply for financing here: https://app.gethearth.com/partners/ozzifloors");
  ck("EN financing link → its sentence goes, Ozzi's number for the financing (owner rule 2026-10-17)", fin === "For financing, just call or text Ozzi at (561) 674-8334.", fin);
  const finEs = neutralizeLinks("Aquí puedes aplicar al financiamiento: https://app.gethearth.com/partners/ozzifloors y me avisas.");
  ck("ES financing link → Ozzi's number", /escríbele a Ozzi al \(561\) 674-8334/.test(finEs) && !containsLink(finEs), finEs);
  const contract = neutralizeLinks("Here is your contract to sign: https://ozzifloors.app/sign/3f43d3d2348e705ec21c77def0843c4d1f93ce77ee729a6b. Let me know once it's done.");
  ck("EN contract link → owner line, rest of the reply kept", contract === "Here is your contract to sign. Let me know once it's done. Text Ozzi at (561) 674-8334 and he'll send it to you.", contract);
  const withEmail = neutralizeLinks("Send the plans to ozzifloors@gmail.com and see the colors at https://ozzifloors.company");
  ck("email survives the rewrite", withEmail.includes("ozzifloors@gmail.com") && !containsLink(withEmail), withEmail);

  // ── 2. the send ───────────────────────────────────────────────────────────
  console.log("\n[2] sendInstagramMessage handles 508");
  const ig = read("src/lib/instagram.ts");
  ck("imports the policy", /from "@\/lib\/ig-link-policy"/.test(ig) && /containsLink|neutralizeLinks|isIgLinkBlockError/.test(ig));
  ck("508 on a link → resend without it (same call, extra attempts)", /isIgLinkBlockError\(body\.error\?\.code\) && containsLink\(outText\)/.test(ig) && /outText = neutralizeLinks\(outText\)/.test(ig) && /maxAttempts = attempt \+ 2/.test(ig));
  ck("508 marks the block + calm owner note (never the siren path first)", /await markIgLinkBlock\(\);\s*\n\s*await reportIgLinkBlock\(recipientIgsid, lastErr\);/.test(ig));
  ck("every AI link → link-free version goes first (no marker gate since 2026-10-17)", /if \(hasLink && !opts\.allowLinks\) \{\s*\n\s*outText = neutralizeLinks\(text\);/.test(ig) && !/igLinkBlockActive/.test(ig));
  ck("no 'delivered link clears the block' path left (nothing delivers a link but the panel)", !/clearIgLinkBlock/.test(ig));
  ck("result carries the delivered text when it differs", /sentText\?: string;/.test(ig) && /sentText: outText/.test(ig));
  ck("never 'sentText' on an unchanged send", /linkFree \? \{ ok: true, via: "instagram", sentText: outText \} : \{ ok: true, via: "instagram" \}/.test(ig));

  console.log("\n[2b] delivery.ts: marker + note");
  const del = read("src/lib/delivery.ts");
  ck("marker row iglinkblock|<ISO>, 2h TTL (24h kept links off for 17h after the block lifted, 2026-10-15), cached", /IG_LINK_BLOCK_PREFIX = "iglinkblock\|"/.test(del) && /IG_LINK_BLOCK_TTL_MS = 2 \* 60 \* 60 \* 1000/.test(del) && /IG_LINK_BLOCK_CACHE_MS/.test(del));
  ck("owner note says the AI sends no link on Instagram (owner rule 17/10), only the panel", /a IA nao manda link nenhum no Instagram por regra sua \(so o painel manda\)/.test(del) && !/a cada 2h e volta ao normal sozinho/.test(del));
  ck("igLinkBlockActive / markIgLinkBlock / clearIgLinkBlock exported", /export async function igLinkBlockActive/.test(del) && /export async function markIgLinkBlock/.test(del) && /export async function clearIgLinkBlock/.test(del));
  ck("clear is a no-op without a marker (no DB write per link send)", /if \(\(await igLinkBlockSince\(\)\) === null\) return;/.test(del));
  ck("owner note once a day, calm, names the two owner actions", /shouldAlert\("sendfail", "instagram-linkblock", IG_LINK_BLOCK_ALERT_EVERY_MS\)/.test(del) && /bloqueou o envio de LINKS/.test(del) && /Status da conta/.test(del) && /bio do @ozzi\.floors/.test(del) && /trocar o token nao resolve/.test(del));
  ck("siren on a 508 no longer says 'mint a new token'", /\/\^508:\/\.test\(errorMsg\)/.test(del) && /Erro 508 = o Instagram esta bloqueando LINKS/.test(del));
  ck("outbox retry stores the delivered text", /update\(\{ content: r\.sentText \?\? text \}\)/.test(del));

  // ── 3. producers store the delivered text ────────────────────────────────
  console.log("\n[3] every Instagram producer stores sentText");
  const wh = read("src/app/api/webhook/route.ts");
  for (const [sent, orig] of [
    ["handoffSent", "handoff"], ["addrSent", "reply"], ["detailsSent", "details"], ["outageSent", "fallback"], ["mainSent", "outboundResponse"],
  ] as const) {
    ck(`webhook: content: ${sent}.sentText ?? ${orig}`, new RegExp(`content: ${sent}\\.sentText \\?\\? ${orig},`).test(wh), sent);
  }
  ck("webhook: both ack sites", (wh.match(/content: ackSent\.sentText \?\? ack \}/g) ?? []).length === 2);
  ck("webhook: no-content path", /content: noContentSent\.ok \? \(noContentSent\.sentText \?\? finalResponse\) : finalResponse \+ SEND_FAILED_DB_SUFFIX/.test(wh));
  ck("webhook: re-tap nudge path", /content: nudgeSent\.ok \? \(nudgeSent\.sentText \?\? retapNudge\) : retapNudge \+ SEND_FAILED_DB_SUFFIX/.test(wh));
  ck("webhook: failed send still queues the ORIGINAL for the outbox", /content: outboundResponse \+ SEND_FAILED_DB_SUFFIX/.test(wh));
  ck("webhook: no IG producer still stores a raw original after an IG send", !/sendInstagramMessage\(senderIgsid, (\w+)\);\s*\n\s*if \(\w+\.ok\) \{\s*\n\s*await supabaseAdmin\.from\("instagram_messages"\)\.insert\(\{[^}]*content: \1[,} ]/.test(wh));
  ck("webhook: TTS reads the delivered text", /generateSpeech\(mainSent\.sentText \?\? outboundResponse\)/.test(wh));
  const fu = read("src/lib/followup.ts");
  ck("followup nudge stores sentText", /if \(r\.sentText\) text = r\.sentText;/.test(fu));
  const panel = read("src/app/api/conversations/[id]/send/route.ts");
  ck("panel send stores sentText", /let storedText = body\.text;/.test(panel) && /if \(igResult\.sentText\) storedText = igResult\.sentText;/.test(panel) && /content: stripInvertedPunctuation\(storedText\)/.test(panel));

  // ── 4. Dreaming never learns the fallback wording ─────────────────────────
  console.log("\n[4] Dreaming");
  const dr = read("src/lib/dreaming.ts");
  ck("rule 13: 'link in our bio' is the Instagram rule, the 2026-10-14 'blocking links' wording stays a non-pattern", /INSTAGRAM IS THE EXCEPTION \(owner rule 2026-10-17\)/.test(dr) && /Instagram is blocking links on my end[\s\S]{0,120}never record it as a pattern/.test(dr));

  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1); }
}

main();
