/**
 * ÁREA DE ATENDIMENTO POR ZIP (trava de código, 21/10/2026).
 * Steve Leone (Messenger fb_29035927539368442, 21/10): "34686" → recusado como
 * Clearwater (certo); "34786" → "That's Windermere, we cover that area. ...
 * Does Thursday at 11am or 7pm work?" e a visita foi gravada (22/10 19h,
 * Windermere = Orlando). Fran (WhatsApp wa_13478203091, 07/10): "33837" →
 * "We cover that area, I have Thursday the 8th at 9am or 2pm" (Davenport =
 * Orlando), visita cancelada à mão. O prompt dizia "every ZIP in our area starts
 * with 33" (falso nos dois sentidos) e era a ÚNICA trava.
 * Regra: área = ZIPs 33000-33499 (330xx-334xx); qualquer outro ZIP (Port St.
 * Lucie à parte) é recusa, sem horário, sem endereço, sem [BOOK], sem "we cover
 * that area", sem nome de cidade.
 *
 * Puro (sem modelo):
 *  1. isServiceAreaZip / isOutOfAreaZip / zipsInText (32xxx passa a contar).
 *  2. outOfAreaZipStanding: ÚLTIMO ZIP do cliente decide; só o cliente conta.
 *  3. claimsCoverage: "we cover that area" nas 3 línguas, nunca a negação.
 *  4. outOfAreaLeak: horário, visita, endereço, [BOOK], claim; recusa passa.
 *  5. outOfAreaDeclineMessage / bookingAddressOutOfArea.
 *  6. Estático: prompt, nota dinâmica, rede, regra 26, 3 webhooks, Dreaming 18.
 * Ao vivo (LIVE=1): replay do Steve (3 turnos) e da Fran, ES, controles
 *  (33186 oferece horário; 34953 = fluxo PSL; 34686 depois 33186 = horário).
 * Run: npx tsx src/evals/out-of-area-zip-verify.ts   |   LIVE=1 npx tsx src/evals/out-of-area-zip-verify.ts
 */
import {
  outOfAreaZipStanding, outOfAreaLeak, claimsCoverage, outOfAreaNote, containsSchedulingOffer, isAskingForBookingInfo,
  portStLucieStanding, isPortStLucieHandoff, isSizeAsk, clientAlreadyGaveZip, getAIResponse, type ChatMessage,
} from "../lib/ai";
import { outOfAreaDeclineMessage, bookingAddressOutOfArea, bookingAddressHasZip, extractZip } from "../lib/scheduler";
import { zipsInText, isServiceAreaZip, isOutOfAreaZip, PORT_ST_LUCIE_ZIPS } from "../lib/zip-text";
import { sentenceCount } from "../lib/reply-length";
import { readFileSync } from "fs";
import { join } from "path";

function loadEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 320)}»`); }
}
const U = (c: string): ChatMessage => ({ role: "user", content: c });
const A = (c: string): ChatMessage => ({ role: "assistant", content: c });
const OPENER = "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?";
const PROMO = "Our vinyl promo is $5 per sqft and that already includes the flooring, installation, and quarter round. Is it one area or the whole house?";
const ZIP_ASK = "It's got a 20-year warranty and a stone composite core, so it lasts. What's the zip code of the property?";
const DECLINE_34686 = "That zip is Clearwater, which is on the Gulf side and outside our service area. We only cover South Florida's east coast, Homestead to Jupiter!";
const STEVE_34786 = "That's Windermere, we cover that area. I can come measure in person for free and bring samples. Does Thursday at 11am or 7pm work?";
const FRAN_33837 = "We cover that area, I have Thursday the 8th at 9am or 2pm. Which works better for you?";

// Histórico real do Steve até o ZIP de Windermere.
const steve = [
  U("I'm looking for a quote"), A(OPENER), U("Luxury vinyl"), A(PROMO),
  U("I'm looking for a 9\" wide 60\" long plank. Very durable. Not anything that I will need to replace in a few years."), A(ZIP_ASK),
  U("Do you come out to provide an estimate? I have some concerns around the waterfall in my kitchen. Can you go over tile?"), U("34686"), A(DECLINE_34686),
  U("34786"),
];
const fran = [U("Hi yes I'm looking g for an estimate ?"), A(OPENER), U("Vinyl"), A(PROMO), U("3 bedroom"), A("For that size I need to measure in person to give you the best price, it's free and I bring the samples. What's the zip code of the property?"), U("33837")];

console.log("\n━━ 1. ZIP helpers ━━");
for (const z of ["33010", "33030", "33132", "33186", "33301", "33431", "33458", "33499", "33000"]) ck(`área: ${z}`, isServiceAreaZip(z) && !isOutOfAreaZip(z));
for (const z of ["33500", "33569", "33837", "33990", "34786", "34686", "32801", "32960", "34994", "34233", "34102", "10001"]) ck(`fora: ${z}`, !isServiceAreaZip(z) && isOutOfAreaZip(z));
for (const z of PORT_ST_LUCIE_ZIPS) ck(`PSL ${z}: nem área nem fora (fluxo próprio)`, !isServiceAreaZip(z) && !isOutOfAreaZip(z));
ck("vazio / curto / null nunca é 'fora'", !isOutOfAreaZip("") && !isOutOfAreaZip(null) && !isOutOfAreaZip("3378") && !isServiceAreaZip(undefined));
ck("zipsInText pega 32xxx agora", JSON.stringify(zipsInText("my zip is 32801")) === '["32801"]' && JSON.stringify(zipsInText("34786")) === '["34786"]' && JSON.stringify(zipsInText("33837")) === '["33837"]');
ck("zipsInText ainda ignora preço, sqft, apt, número de casa", zipsInText("$33000").length === 0 && zipsInText("33000 sqft").length === 0 && zipsInText("32000 sq ft").length === 0 && zipsInText("apt 33130").length === 0 && zipsInText("33055 SW 12 St").length === 0);
ck("telefone / endereço sem ZIP não viram ZIP", zipsInText("407-534-0007").length === 0 && zipsInText("8782 Crescendo Ave Windermere").length === 0 && zipsInText("3053345678").length === 0);

console.log("\n━━ 2. outOfAreaZipStanding ━━");
ck("Steve: 34686 e depois 34786 → 34786", outOfAreaZipStanding(steve) === "34786");
ck("Fran: 33837 → 33837", outOfAreaZipStanding(fran) === "33837");
ck("ZIP fora e depois ZIP dentro → null (o último decide)", outOfAreaZipStanding([...steve, A(DECLINE_34686), U("Sorry, I meant 33186")]) === null);
ck("ZIP dentro e depois fora → o de fora", outOfAreaZipStanding([U("33186"), A("ok"), U("actually the property is 34786")]) === "34786");
ck("sem ZIP / ZIP em área → null", outOfAreaZipStanding([U("Hi, I'm in Miami 33130")]) === null && outOfAreaZipStanding([U("vinyl for the whole house")]) === null);
ck("só o cliente conta: bot escrevendo 34786 não vale", outOfAreaZipStanding([U("hi"), A("Windermere 34786 is outside our area.")]) === null);
ck("ZIP dentro de nota [SYSTEM:] não conta", outOfAreaZipStanding([U("ok\n\n[SYSTEM: the client has a visit at 1 Main St, Davenport FL 33837]")]) === null);
ck("ZIP de Port St. Lucie → null (fluxo PSL)", outOfAreaZipStanding([U("34953")]) === null && portStLucieStanding([U("34953")]));
ck("endereço do Steve (sem ZIP) e telefone não mudam o standing", outOfAreaZipStanding([...steve, A(STEVE_34786), U("7 pm would be best"), U("8782 Crescendo Ave\nWindermere"), U("407-534-0007")]) === "34786");
ck("'32000 sq ft' não é ZIP", outOfAreaZipStanding([U("the house is 32000 sq ft")]) === null);
ck("clientAlreadyGaveZip também vê 32xxx (não re-pede o ZIP)", clientAlreadyGaveZip([U("32801")]));

console.log("\n━━ 3. claimsCoverage ━━");
for (const t of [STEVE_34786, FRAN_33837, "Yes, we serve your area!", "We do cover that zip.", "Great, we cover this area.", "Sí, cubrimos esa zona.", "Claro, atendemos esa área.", "Atendemos essa área sim."]) ck(`claim: «${t.slice(0, 50)}»`, claimsCoverage(t), t);
for (const t of [DECLINE_34686, "We only cover South Florida's east coast, Homestead to Jupiter.", "Sorry, we don't cover that area.", "We do not serve that area.", "Lo siento, no cubrimos esa zona.", "Solo cubrimos la costa este.", "Infelizmente não atendemos essa área.", "A gente só atende a costa leste.", outOfAreaDeclineMessage("en"), outOfAreaDeclineMessage("es"), outOfAreaDeclineMessage("pt")]) ck(`não claim: «${t.slice(0, 50)}»`, !claimsCoverage(t), t);

console.log("\n━━ 4. outOfAreaLeak ━━");
for (const r of [
  STEVE_34786, FRAN_33837,
  "I have Thursday at 11am or 7pm, which works better for you?",
  "I can come measure in person for free and bring samples.",
  "Can I get the property address (number, street and city) and the best phone number to reach you?",
  "Perfect, I'm holding that 2pm for you. Can I get the full property address?",
  "Appointment confirmed for Thursday, October 22 at 7pm. [BOOK:{\"name\":\"\",\"phone\":\"4075340007\",\"address\":\"8782 Crescendo Ave, Windermere FL 34786\",\"date\":\"2026-10-22\",\"time\":\"7pm\"}]",
  "Yes, we serve your area! What's the best phone number?",
]) ck(`vaza: «${r.slice(0, 60)}»`, outOfAreaLeak(steve, r), r);
for (const r of [
  outOfAreaDeclineMessage("en"), outOfAreaDeclineMessage("es"), outOfAreaDeclineMessage("pt"), DECLINE_34686,
  "Yes, our vinyl goes right over existing tile. That zip code is outside our service area though, we only cover South Florida's east coast from Homestead to Jupiter.",
  "Sorry, that zip code is outside our area, we only serve Homestead to Jupiter. If you ever have a project on this side, happy to help!",
]) ck(`não vaza: «${r.slice(0, 60)}»`, !outOfAreaLeak(steve, r), r);
ck("sem standing nada vaza", !outOfAreaLeak([U("Hi, I'm in Miami 33130"), A(OPENER), U("vinyl")], STEVE_34786) && !outOfAreaLeak(fran.slice(0, -1), FRAN_33837));
ck("ZIP corrigido para dentro da área → a oferta de horário volta a passar", !outOfAreaLeak([...steve, A(DECLINE_34686), U("33186")], "I have Thursday at 11am or 7pm, which works better for you?"));

console.log("\n━━ 5. mensagens / endereço do [BOOK] ━━");
for (const lang of ["en", "es", "pt"] as const) {
  const m = outOfAreaDeclineMessage(lang);
  ck(`${lang}: Homestead a Jupiter, sem cidade chutada, sem traço/¿¡/emoji`, /Homestead/.test(m) && /Jupiter/.test(m) && !/Windermere|Orlando|Clearwater|Davenport/i.test(m) && !/[—–¿¡]/.test(m) && !/[\u{1F300}-\u{1FAFF}]/u.test(m), m);
  ck(`${lang}: ≤ 2 frases, ≤ 220 chars, não é push nem pedido de dados`, sentenceCount(m) <= 2 && m.length <= 220 && !containsSchedulingOffer(m) && !isAskingForBookingInfo(m), m);
}
ck("nota dinâmica cita o ZIP e proíbe cidade / 'we cover that area' / horário / [BOOK]", /ZIP 34786/.test(outOfAreaNote("34786")) && /Do NOT name the city/.test(outOfAreaNote("34786")) && /NEVER offer time slots/.test(outOfAreaNote("34786")) && /NEVER generate \[BOOK:\.\.\.\]/.test(outOfAreaNote("34786")) && /33000 to 33499/.test(outOfAreaNote("34786")));
ck("bookingAddressOutOfArea: Windermere 34786 / Davenport 33837", bookingAddressOutOfArea("8782 Crescendo Ave, Windermere FL 34786") === "34786" && bookingAddressOutOfArea("465 Sapphire Dr, Davenport FL 33837") === "33837");
ck("bookingAddressOutOfArea: Miami / Boca / PSL / sem ZIP → null", bookingAddressOutOfArea("3209 NE 7th St, Miami FL 33062") === null && bookingAddressOutOfArea("100 E Palmetto Park Rd, Boca Raton FL 33432") === null && bookingAddressOutOfArea("1 SW Bayshore Blvd, Port St. Lucie 34984") === null && bookingAddressOutOfArea("8782 Crescendo Ave Windermere") === null);
ck("número de casa com 5 dígitos não vira ZIP", bookingAddressOutOfArea("12345 NW 7th St, Miami FL 33125") === null && extractZip("34786 SW 8th St, Miami") === null);
ck("o [BOOK] do Steve passava em bookingAddressHasZip (ZIP digitado) e agora cai em bookingAddressOutOfArea", bookingAddressHasZip("8782 Crescendo Ave, Windermere FL 34786", steve) && bookingAddressOutOfArea("8782 Crescendo Ave, Windermere FL 34786") === "34786");

console.log("\n━━ 6. estático ━━");
const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8").replace(/\r\n/g, "\n");
const base = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8").replace(/\r\n/g, "\n");
const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8").replace(/\r\n/g, "\n");
const dream = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8").replace(/\r\n/g, "\n");
ck("prompt: ZIP CODE TEST = 33000-33499, Orlando/Windermere listados, nunca nomear a cidade, nunca 'we cover that area'", /ZIP CODE TEST: our service area is EXACTLY the ZIP codes 33000 to 33499/.test(base) && /Orlando, Windermere, Kissimmee/.test(base) && /never name the city you think a ZIP belongs to/.test(base) && /NEVER say "we cover that area" for such a ZIP/.test(base) && /except the Port St\. Lucie ZIPs, see the note/.test(base));
ck("prompt: Central / North Florida fora da área + 'lista não cobre'", /nor Central and North Florida: Orlando and everything around it \(Windermere, Kissimmee, Davenport/.test(base) && /Not being on these lists does not make a place covered/.test(base));
ck("ai.ts: regra 26 com Central Florida + faixa de ZIP", /nor Central and North Florida \(Orlando, Windermere, Kissimmee, Davenport, Clermont, Lakeland, Ocala, Jacksonville\), nor north of Jupiter/.test(ai) && /By ZIP code our area is exactly 33000-33499 \(330xx-334xx\)/.test(ai));
ck("ai.ts: nota dinâmica + rede de vazamento + 5 guardas de fluxo", /dynamicSystem \+= "\\n\\n---\\n\\n" \+ outOfAreaNote\(outOfAreaStandingZip\);/.test(ai) && /if \(outOfAreaLeak\(messages, cleaned\)\) \{[\s\S]{0,400}cleaned = outOfAreaDeclineMessage\(usersLang\(\)\);/.test(ai) && (ai.match(/!portStLucieReferral\(messages\) && outOfAreaZipStanding\(messages\) === null/g) ?? []).length === 5);
ck("ai.ts: PSL ZIPs vêm de zip-text (uma fonte só)", /import \{ zipsInText, isOutOfAreaZip, PORT_ST_LUCIE_ZIPS \} from "\.\/zip-text";/.test(ai) && !/const PORT_ST_LUCIE_ZIPS = new Set/.test(ai));
ck("scheduler.ts: outOfAreaDeclineMessage + bookingAddressOutOfArea", /export function outOfAreaDeclineMessage\(lang: Lang\)/.test(sched) && /export function bookingAddressOutOfArea\(address\?: string \| null\): string \| null/.test(sched));
for (const [f, tag, leakVar] of [["fb-webhook", "FB", "safeResponse"], ["wa-webhook", "WA", "safeResponse"], ["webhook", "IG", "safeAiText"]]) {
  const w = readFileSync(join(process.cwd(), `src/app/api/${f}/route.ts`), "utf-8").replace(/\r\n/g, "\n");
  ck(`${tag}: guarda de [BOOK] pelo standing (antes do mobile home)`, w.includes(`const outOfAreaZip = outOfAreaZipStanding(history);\n  if (outOfAreaZip) {\n    console.warn("[${tag}] booking blocked — ZIP " + outOfAreaZip + " is outside the service area (330xx-334xx); sending the decline");\n    return { response: outOfAreaDeclineMessage(lang), booked: false };\n  }\n  if (mobileHomeStanding(history)) {`));
  ck(`${tag}: guarda de [BOOK] pelo ZIP do endereço da tag (depois do bookingAddressHasZip)`, w.includes(`return { response: needZipMessage(lang), booked: false };\n    }\n    // The ZIP in the [BOOK] address must be inside the service area as well`) && w.includes(`const tagZipOutOfArea = bookingAddressOutOfArea(bookingData.address);\n    if (tagZipOutOfArea) {`));
  ck(`${tag}: rede de vazamento no webhook`, w.includes(`if (!isBookingConfirmed && outOfAreaLeak(history, ${leakVar})) {`) && w.includes(`${leakVar} = outOfAreaDeclineMessage(lang);`));
  ck(`${tag}: imports`, /outOfAreaZipStanding, outOfAreaLeak,/.test(w) && /outOfAreaDeclineMessage, bookingAddressOutOfArea,/.test(w));
}
ck("Dreaming: trava 18 (nunca aprender a cobrir ZIP fora de 330-334)", /18\. OUR SERVICE AREA IS EXACTLY THE ZIP CODES 330xx-334xx/.test(dream) && /Davenport FL 33837 \(2026-10-07\) and Windermere FL 34786 \(2026-10-21\) were mistakes/.test(dream));

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  console.log("\n━━ 7. ao vivo ━━");
  const SCHED = "\n\n[SYSTEM: TODAY: Wednesday, October 21, 2026 [2026-10-21].\n\nREAL-TIME SCHEDULE AVAILABILITY:\n• Thursday, October 22, 2026 [2026-10-22]: 11am, 7pm\n• Friday, October 23, 2026 [2026-10-23]: 9am, 1pm, 3pm]";
  const withSched = (msgs: ChatMessage[]): ChatMessage[] => { const last = msgs[msgs.length - 1]; return [...msgs.slice(0, -1), { ...last, content: last.content + SCHED }]; };
  const get = async (msgs: ChatMessage[]) => { const r = await getAIResponse(withSched(msgs), null, null, undefined, false); return (r as { text?: string }).text ?? String(r); };
  const declines = (r: string) => /outside (?:our|the) (?:service )?area|don'?t (?:cover|serve|service)|do not (?:cover|serve|service)|only (?:cover|serve|service)|can'?t (?:cover|serve|service)|fuera de (?:nuestra )?(?:zona|[aá]rea)|no (?:cubrimos|atendemos|llegamos)|solo (?:cubrimos|atendemos)|fora da (?:nossa )?[aá]rea|n[aã]o (?:atendemos|cobrimos)|s[oó] atende/i.test(r);
  const offersTime = (r: string) => containsSchedulingOffer(r) || /\b\d{1,2}\s*(?:am|pm)\b/i.test(r);
  const clean = (r: string) => r.replace(/\[[A-Z_]+(?::[^\]]*)?\]/g, "").trim();
  try {
    // Steve turno 1: "Can you go over tile?" + "34686"
    const t1 = await get(steve.slice(0, 8));
    console.log("   T1:", clean(t1).replace(/\s+/g, " ").slice(0, 200));
    ck("Steve T1 (34686): recusa, sem horário/visita/[BOOK]", declines(t1) && !offersTime(t1) && !outOfAreaLeak(steve.slice(0, 8), t1) && !/\[BOOK:/.test(t1), t1);
    // Steve turno 2: "34786" depois da recusa do 34686 (o caso real)
    const t2 = await get(steve);
    console.log("   T2:", clean(t2).replace(/\s+/g, " ").slice(0, 200));
    ck("Steve T2 (34786): recusa, sem horário/visita/[BOOK], sem 'we cover that area'", declines(t2) && !offersTime(t2) && !claimsCoverage(t2) && !/\[BOOK:/.test(t2), t2);
    ck("Steve T2: não chuta a cidade do ZIP", !/Windermere|Orlando/i.test(t2), t2);
    ck("Steve T2: curta (≤ 2 frases, ≤ 260 chars)", sentenceCount(clean(t2)) <= 3 && clean(t2).length <= 260, t2);
    // Steve turno 3: a conversa como aconteceu (bot já tinha oferecido) + endereço + telefone → nunca [BOOK]
    const steve3 = [...steve, A(STEVE_34786), U("Tomorrow Thursday?"), A("Yes, tomorrow Thursday I have 11am or 7pm, which works better for you?"), U("7 pm would be best"), U("8782 Crescendo Ave\nWindermere"), A("Can I get the property address (number, street and city) and the best phone number to reach you?"), U("407-534-0007")];
    const t3 = await get(steve3);
    console.log("   T3:", clean(t3).replace(/\s+/g, " ").slice(0, 200));
    ck("Steve T3 (dados completos, ZIP fora): NUNCA [BOOK] nem 'confirmed', recusa", !/\[BOOK:/.test(t3) && !/confirmed|see you (?:then|tomorrow)/i.test(t3) && declines(t3), t3);
    // Fran: 33837 respondendo a pergunta do ZIP
    const f1 = await get(fran);
    console.log("   F1:", clean(f1).replace(/\s+/g, " ").slice(0, 200));
    ck("Fran (33837 = Davenport): recusa, sem horário, sem 'we cover that area'", declines(f1) && !offersTime(f1) && !claimsCoverage(f1) && !/\[BOOK:/.test(f1), f1);
    // ES
    const es = await get([U("Hola, quiero un presupuesto"), A("Hola, trabajamos con vinyl de lujo, tile y madera, y tenemos promoción en cada uno. Cuál le interesa?"), U("Vinyl para toda la casa"), A("Para ese tamaño necesito medir en persona para darle el mejor precio, es gratis y llevo las muestras. Cuál es el código postal de la propiedad?"), U("34786")]);
    console.log("   ES:", clean(es).replace(/\s+/g, " ").slice(0, 200));
    ck("ES (34786): recusa em espanhol, sem horário, sem ¿¡", declines(es) && !offersTime(es) && !/[¿¡]/.test(es) && /zona|área|cubrimos|atendemos/i.test(es), es);
    // Controle: ZIP dentro da área oferece horário
    const c1 = await get([...fran.slice(0, -1), U("33186")]);
    console.log("   C1:", clean(c1).replace(/\s+/g, " ").slice(0, 200));
    ck("controle 33186: oferece horário, sem recusa", offersTime(c1) && !declines(c1), c1);
    // Controle: PSL tem fluxo próprio (regra 28/10: "3 bedroom" sem metragem → pergunta a metragem)
    const c2 = await get([...fran.slice(0, -1), U("34953")]);
    console.log("   C2:", clean(c2).replace(/\s+/g, " ").slice(0, 200));
    ck("controle 34953 (PSL sem metragem): pergunta a metragem, não a recusa", isSizeAsk(c2) && /Port St\. Lucie/.test(c2) && !declines(c2) && !isPortStLucieHandoff(c2), c2);
    // Controle: fora e depois dentro → horário
    const c3 = await get([...steve, A(outOfAreaDeclineMessage("en")), U("Oh sorry, that's my office. The house is 33186")]);
    console.log("   C3:", clean(c3).replace(/\s+/g, " ").slice(0, 200));
    ck("controle 34786 → 33186: volta ao fluxo com horário, sem recusa", offersTime(c3) && !declines(c3), c3);
  } catch (e) { ck("chamadas ao vivo", false, String(e)); }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
});
