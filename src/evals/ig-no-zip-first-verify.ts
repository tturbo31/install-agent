/**
 * ATUALIZADO 02/11/2026 (tarde): a regra virou GLOBAL ("no direct, você não pode
 * pedir o zip code logo de cara"): Messenger e WhatsApp também não pedem mais o
 * ZIP de cara. Este eval guarda os casos do Instagram e confere que os outros
 * canais seguem o mesmo script; a prova completa está em
 * no-links-no-zip-first-verify.ts.
 *
 * INSTAGRAM NÃO PEDE O ZIP CODE DE CARA (regra do dono, 02/11/2026):
 * "para o Instagram, nas conversas do Instagram, você não fique pedindo o zip
 * code logo de cara. Retire esses dois scripts do Instagram. Apenas do Instagram,
 * nos outros você deixa igual. No Messenger e no WhatsApp você deixa o script
 * antigo."
 *
 * Messenger e WhatsApp seguem com o ZIP CODE FIRST de 29/09/2026 (a proposta da
 * visita termina com a pergunta do ZIP, os horários vêm na mensagem seguinte).
 * Só o Instagram muda, em quatro camadas:
 *  1. AGENDA: o webhook do IG chama getRealAvailabilityContext({ ..., zipFirst:
 *     false }) e a nota "ZIP CODE FIRST" não entra no bloco da agenda.
 *  2. PROMPT: IG_CHANNEL_NOTE ganhou "NO ZIP CODE UP FRONT ON INSTAGRAM": a
 *     proposta da visita já vem com os dois horários; o ZIP só vem com o
 *     endereço completo e o telefone, depois do horário escolhido.
 *  3. ENLATADA "qual piso é esse": no IG a forma completa termina com "uma área
 *     ou a casa toda?" em vez do ZIP, e uma pergunta de ZIP escrita pelo modelo
 *     é trocada pela mesma pergunta (fixWhichFloorReply, noZip).
 *  4. ENLATADA de Port St. Lucie (visita): no IG pergunta o dia, não o ZIP.
 *
 * Prova: [1] puro, [2] estático (webhooks, scheduler, ai.ts), [3] agenda real
 * SÓ LEITURA (SCHED=1 ou LIVE=1), [4] AO VIVO com o modelo real (LIVE=1): no
 * IG a proposta da visita traz horários e nenhum ZIP; o mesmo caso SEM a nota
 * do IG (Messenger/WhatsApp) continua pedindo o ZIP primeiro.
 * Run: npx tsx src/evals/ig-no-zip-first-verify.ts      (LIVE=1 para [3]+[4])
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
import { IG_CHANNEL_NOTE, IG_CHANNEL_TAG, isInstagramChannel, neutralizeLinks, mentionsBioLink, containsLink } from "../lib/ig-link-policy";
import { getAIResponse, fixWhichFloorReply, portStLucieReply, asksForZip, containsSchedulingOffer, type ChatMessage } from "../lib/ai";
import { zipFirstNote, ZIP_FIRST_NOTE_HEADER, getRealAvailabilityContext, getEasternDateContext, portStLucieVisitMessage } from "../lib/scheduler";

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
const IG_SYS = (extra = "") => `\n\n[SYSTEM: TODAY: Monday, November 2, 2026 [2026-11-02]. Current time: 10:00 AM Eastern.${extra}\n\n${IG_CHANNEL_NOTE}]`;

function done() {
  console.log(`\n===================== RESULT: ${pass} passed, ${fail} failed =====================`);
  if (fail) { console.log("FAILED:\n  - " + fails.join("\n  - ")); process.exit(1); }
}

async function main() {
  console.log("\n===================== INSTAGRAM: NO ZIP CODE UP FRONT (owner rule 2026-11-02) =====================");

  // ── 1. puro ───────────────────────────────────────────────────────────────
  console.log("\n[1a] the channel note");
  ck("note still starts with the tag and keeps the link + financing rules", IG_CHANNEL_NOTE.startsWith(IG_CHANNEL_TAG) && /NEVER write any link or URL/.test(IG_CHANNEL_NOTE) && /financing[\s\S]*\(561\) 674-8334/.test(IG_CHANNEL_NOTE));
  ck("note: NO ZIP CODE UP FRONT ON INSTAGRAM, ZIP CODE FIRST and AD FLOOR QUESTIONS zip ending do not apply", /NO ZIP CODE UP FRONT ON INSTAGRAM \(owner rule 2026-11-02\)/.test(IG_CHANNEL_NOTE) && /ZIP CODE FIRST rule does NOT apply/.test(IG_CHANNEL_NOTE) && /AD FLOOR QUESTIONS/.test(IG_CHANNEL_NOTE));
  ck("note: the visit proposal offers the two times right away; the zip comes only with the full address + phone", /offer the two real times from the schedule right away/.test(IG_CHANNEL_NOTE) && /collected ONLY together with the full address and the phone/.test(IG_CHANNEL_NOTE));
  ck("note carries no link and no inverted punctuation", !containsLink(IG_CHANNEL_NOTE) && !/[¿¡]/.test(IG_CHANNEL_NOTE));
  ck("isInstagramChannel still reads the note off a user turn", isInstagramChannel([U("hi" + IG_SYS())]) && !isInstagramChannel([U("hi\n\n[SYSTEM: TODAY x]")]));

  console.log("\n[1b] zipFirstNote itself is unchanged (Messenger / WhatsApp keep the old script)");
  const noLoc = [U("Hi, I want vinyl for my whole house, about 1500 sqft")];
  ck("history without a location → the ZIP CODE FIRST note", (zipFirstNote(noLoc) ?? "").startsWith(ZIP_FIRST_NOTE_HEADER) && /ask, in ONE short natural question/.test(zipFirstNote(noLoc) ?? ""));
  ck("zip already typed → no note", zipFirstNote([U("vinyl, 33176")]) === null);

  console.log("\n[1c] fixWhichFloorReply: Instagram shape has no zip; off Instagram unchanged");
  const guess = "That's our luxury vinyl with a stone finish! Want me to set up a visit?";
  for (const lang of ["en", "es", "pt"] as const) {
    const ig = fixWhichFloorReply(guess, lang, true, { noZip: true, ig: true });
    const other = fixWhichFloorReply(guess, lang, true);
    ck(`${lang} IG full shape: bio + samples + one-area-or-whole-house, no zip, no link`, mentionsBioLink(ig) && !containsLink(ig) && !ZIP_WORD.test(ig) && /(?:one area, or the entire house|una sola área o toda la casa|só uma área ou a casa toda)\?$/.test(ig), ig);
    ck(`${lang} Messenger/WhatsApp full shape: samples + Ozzi's number + the same question, no zip, no link (every channel since 2026-11-02)`, /674[\s.-]?8334/.test(other) && !containsLink(other) && !ZIP_WORD.test(other) && /\?$/.test(other), other);
    const neut = neutralizeLinks(ig, lang);
    ck(`${lang} IG full shape after the link neutralizer: unchanged (bio wording, no zip)`, neut === ig && mentionsBioLink(neut) && !containsLink(neut) && !ZIP_WORD.test(neut), neut);
  }
  const modelZip = "Our floors are on our website, the link is in our bio, that floor is there with all the details, and I bring samples to the free visit too. What's the zip code there?";
  const swapped = fixWhichFloorReply(modelZip, "en", true, { noZip: true, ig: true });
  ck("IG: a zip question the model wrote on its own is swapped for the area question", !ZIP_WORD.test(swapped) && /link is in our bio/.test(swapped) && /one area, or the entire house\?$/.test(swapped), swapped);
  ck("off IG: the zip question is swapped too (no zip up front anywhere since 2026-11-02)", !ZIP_WORD.test(fixWhichFloorReply(modelZip, "en", true)), fixWhichFloorReply(modelZip, "en", true));
  const withTag = fixWhichFloorReply(modelZip + "[NOTIFY_OWNER]", "en", true, { noZip: true, ig: true });
  ck("IG: trailing tag survives the swap", /\[NOTIFY_OWNER\]$/.test(withTag) && !ZIP_WORD.test(withTag), withTag);
  const esZip = "Nuestros pisos están en nuestra web, el link está en nuestra bio, y llevo las muestras a la visita gratis. Cuál es el código postal de la propiedad?";
  const esSwapped = fixWhichFloorReply(esZip, "es", true, { noZip: true, ig: true });
  ck("IG ES: 'código postal' question swapped, no ¿", !ZIP_WORD.test(esSwapped) && /toda la casa\?$/.test(esSwapped) && !/[¿¡]/.test(esSwapped), esSwapped);
  const noQ = "Check out our floors on our website, the link is in our bio, that floor is there with all the details. Is it one area or the whole house?";
  ck("IG: a reply without a zip question is untouched", fixWhichFloorReply(noQ, "en", true, { noZip: true, ig: true }) === noQ, fixWhichFloorReply(noQ, "en", true, { noZip: true, ig: true }));

  console.log("\n[1d] Port St. Lucie visit line: IG asks the day, other channels the zip");
  const pslIg = [U("1500 sqft in Port St Lucie" + IG_SYS())];
  const pslOther = [U("1500 sqft in Port St Lucie")];
  ck("IG: 'What day works best for you?', no zip", /What day works best/.test(portStLucieReply(pslIg, "en")) && !ZIP_WORD.test(portStLucieReply(pslIg, "en")), portStLucieReply(pslIg, "en"));
  ck("off IG: asks the day too (no zip up front anywhere since 2026-11-02)", /What day works best/.test(portStLucieReply(pslOther, "en")) && !ZIP_WORD.test(portStLucieReply(pslOther, "en")), portStLucieReply(pslOther, "en"));
  ck("portStLucieVisitMessage(zipKnown=true) has no zip in EN/ES/PT", (["en", "es", "pt"] as const).every((l) => !ZIP_WORD.test(portStLucieVisitMessage(l, true, true))));

  console.log("\n[1e] asksForZip still recognizes the old script (anti-pressure logic for the other channels)");
  ck("asksForZip('What's the zip code of the property?')", asksForZip("For that size I measure in person, it's free. What's the zip code of the property?"));

  // ── 2. estático ───────────────────────────────────────────────────────────
  console.log("\n[2a] scheduler: zipFirst flag");
  const sc = read("src/lib/scheduler.ts");
  ck("getRealAvailabilityContext accepts zipFirst?: boolean", /export async function getRealAvailabilityContext\(opts\?: \{ history\?: Array<\{ role: string; content: string \}>; portStLucie\?: boolean; zipFirst\?: boolean \}\)/.test(sc));
  ck("the note is off by default on every channel (only zipFirst: true produces it, 2026-11-02)", /const zipNote = opts\?\.zipFirst === true \? zipFirstNote\(opts\?\.history\) : null;/.test(sc));

  console.log("\n[2b] webhooks: only Instagram passes zipFirst: false");
  const ig = read("src/app/api/webhook/route.ts");
  const fb = read("src/app/api/fb-webhook/route.ts");
  const wa = read("src/app/api/wa-webhook/route.ts");
  ck("IG webhook: getRealAvailabilityContext({ history, portStLucie: ..., zipFirst: false })", ig.includes("await getRealAvailabilityContext({ history, portStLucie: portStLucieStanding(history), zipFirst: false })"));
  ck("IG webhook still pushes IG_CHANNEL_NOTE", /systemParts\.push\(IG_CHANNEL_NOTE\);/.test(ig));
  ck("Messenger webhook: old call, no zipFirst", fb.includes("await getRealAvailabilityContext({ history, portStLucie: portStLucieStanding(history) })") && !/zipFirst/.test(fb));
  ck("WhatsApp webhook: old call, no zipFirst", wa.includes("await getRealAvailabilityContext({ history, portStLucie: portStLucieStanding(history) })") && !/zipFirst/.test(wa));
  ck("Messenger / WhatsApp never see the IG note", !/IG_CHANNEL_NOTE/.test(fb) && !/IG_CHANNEL_NOTE/.test(wa));

  console.log("\n[2c] ai.ts: the canned lines read the channel");
  const ai = read("src/lib/ai.ts");
  ck("which-floor backstop: noZip always on, ig = isInstagramChannel(messages)", /const ig = isInstagramChannel\(messages\);\s*\n\s*const fixed = fixWhichFloorReply\(cleaned, usersLang\(\), full, \{ noZip: true, ig \}\);/.test(ai));
  ck("fixWhichFloorReply signature has opts?: { noZip?: boolean; ig?: boolean }", /export function fixWhichFloorReply\(text: string, lang: "en" \| "es" \| "pt" = "en", full = false, opts\?: \{ noZip\?: boolean; ig\?: boolean \}\)/.test(ai));
  ck("PSL visit line asks the day on every channel", /portStLucieVisitMessage\(lang, intro, true\)/.test(ai));
  ck("the shared SYSTEM_PROMPT no longer carries ZIP CODE FIRST (every channel since 2026-11-02)", !/ZIP CODE FIRST/.test(read("src/lib/system-prompt.ts")) && /NO ZIP CODE UP FRONT \(owner rule 2026-11-02, every channel/.test(read("src/lib/system-prompt.ts")));

  // ── 3. agenda real (SÓ LEITURA) ───────────────────────────────────────────
  const sched = process.env.SCHED === "1" || process.env.LIVE === "1";
  if (!sched) { console.log("\n[3] agenda real: pulada (SCHED=1 ou LIVE=1 para rodar, só leitura)"); }
  else {
    console.log("\n[3] agenda real (SÓ LEITURA): a nota sai com zipFirst: false e fica no padrão");
    try {
      const hist = [U("Hi, I want vinyl for my whole house, about 1500 sqft")];
      const igAvail = await getRealAvailabilityContext({ history: hist, zipFirst: false });
      const defAvail = await getRealAvailabilityContext({ history: hist });
      ck("zipFirst: false → schedule block without ZIP CODE FIRST", /REAL-TIME SCHEDULE|fully booked|\[\d{4}-\d{2}-\d{2}\]/.test(igAvail) && !igAvail.includes(ZIP_FIRST_NOTE_HEADER), igAvail.slice(-300));
      ck("default → no note either (every channel since 2026-11-02; only zipFirst: true produces it)", !defAvail.includes(ZIP_FIRST_NOTE_HEADER) && (await getRealAvailabilityContext({ history: hist, zipFirst: true })).includes(ZIP_FIRST_NOTE_HEADER), defAvail.slice(-300));
      ck("the schedule lines are identical in both", igAvail.split("\n").filter((l) => l.startsWith("•")).join("\n") === defAvail.split("\n").filter((l) => l.startsWith("•")).join("\n"));
    } catch (e) { ck("agenda real (só leitura)", false, String(e)); }
  }

  // ── 4. ao vivo ────────────────────────────────────────────────────────────
  const live = process.env.LIVE === "1" && process.env.ANTHROPIC_API_KEY !== "unused-pure-eval";
  if (!live) { console.log("\n[4] AO VIVO: pulado (LIVE=1 com ANTHROPIC_API_KEY para rodar)"); return done(); }
  console.log("\n[4] AO VIVO: modelo real, IG sem ZIP x Messenger/WhatsApp com o script antigo");
  const date = getEasternDateContext();
  const get = async (msgs: ChatMessage[]) => {
    const r = await getAIResponse(msgs, null, null, null, false);
    return (r as { text?: string }).text ?? String(r);
  };
  const withSys = (msgs: ChatMessage[], avail: string, igNote: boolean): ChatMessage[] => {
    const out = msgs.slice();
    const last = out[out.length - 1];
    out[out.length - 1] = { ...last, content: last.content + `\n\n[SYSTEM: ${date}\n\n${avail}${igNote ? "\n\n" + IG_CHANNEL_NOTE : ""}]` };
    return out;
  };
  const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
  const PROMO = "Our vinyl promo is $5 per sqft and it includes the floor, the installation and the quarter round. I offer a free quote, are you planning to do just one area, or the entire house?";
  const base: ChatMessage[] = [A(OPENER), U("Vinyl"), A(PROMO), U("The whole house, about 1500 sqft")];
  try {
    const igAvail = await getRealAvailabilityContext({ history: base, zipFirst: false });
    const otherAvail = await getRealAvailabilityContext({ history: base });

    const igReply = neutralizeLinks(await get(withSys(base, igAvail, true)), "en");
    console.log(`   IG 1500 sqft: ${igReply.replace(/\s+/g, " ")}`);
    const igHours = igReply.match(CLOCK) ?? [];
    ck("LIVE IG (1500 sqft): visit proposed WITH two times, NO zip question", igHours.length >= 1 && containsSchedulingOffer(igReply) && !ZIP_WORD.test(igReply) && !/\[BOOK:/.test(igReply), igReply);
    ck("LIVE IG (1500 sqft): no price total, no link", !/\$\s?\d{3,}/.test(igReply) && !containsLink(igReply), igReply);

    const otherReply = await get(withSys(base, otherAvail, false));
    console.log(`   Messenger/WA 1500 sqft: ${otherReply.replace(/\s+/g, " ")}`);
    ck("LIVE Messenger/WhatsApp (same case, no IG note): times offered, NO zip question (every channel since 2026-11-02)", !asksForZip(otherReply) && (otherReply.match(CLOCK) ?? []).length >= 1, otherReply);

    const which = neutralizeLinks(await get([U("What floor is that in your post?" + IG_SYS())]), "en");
    console.log(`   IG which-floor: ${which.replace(/\s+/g, " ")}`);
    ck("LIVE IG (what floor is that): website in bio + no zip + a forward step", mentionsBioLink(which) && !containsLink(which) && !ZIP_WORD.test(which) && /\?/.test(which) && !/stone finish|marble look|wood look|herringbone/i.test(which), which);

    const avail2: ChatMessage[] = [A(OPENER), U("vinyl, just the living room, 600 sqft"), A("For that size I measure in person and give you the best price, the visit is free and I bring the samples."), U("ok when can you come?")];
    const igAvail2 = await getRealAvailabilityContext({ history: avail2, zipFirst: false });
    const when = neutralizeLinks(await get(withSys(avail2, igAvail2, true)), "en");
    console.log(`   IG when can you come: ${when.replace(/\s+/g, " ")}`);
    ck("LIVE IG ('when can you come?'): two times, no zip question", (when.match(CLOCK) ?? []).length >= 1 && !ZIP_WORD.test(when), when);
  } catch (e) { ck("ao vivo", false, String(e)); }

  done();
}

main().catch((e) => { console.error(e); process.exit(1); });
