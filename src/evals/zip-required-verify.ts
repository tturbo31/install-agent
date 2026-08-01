/**
 * Regra do dono (2026-08-01): na confirmação da visita a IA tem que pedir o
 * ENDEREÇO COMPLETO — número da casa, rua, cidade e ZIP CODE — além do nome e
 * do telefone. Endereço sem ZIP não fecha visita.
 *
 * Camadas verificadas aqui:
 *  1. extractZip / addressHasStreetNumber / bookingAddressHasZip (puras): acham
 *     o ZIP de verdade, nunca confundem número da casa com ZIP, e exigem que o
 *     ZIP tenha sido DIGITADO pelo cliente (nada de ZIP inventado pela cidade).
 *  2. Os 3 webhooks bloqueiam o [BOOK] sem ZIP e re-perguntam (estático).
 *  3. O prompt manda pedir endereço completo com ZIP CODE (estático).
 *  4. O pedido de ZIP nunca é engolido pelos guards (anti-pressão / silêncio) e
 *     a resposta "33125" nunca é tratada como fechamento puro.
 *  5. AO VIVO: o modelo pede o ZIP; sem ZIP não sai [BOOK] aprovável; com ZIP
 *     digitado o [BOOK] passa na guarda.
 *
 * Rodar: npx tsx src/evals/zip-required-verify.ts   (parte 5 usa a API)
 */
import { readFileSync } from "fs";
import { join } from "path";
function loadEnv() {
  const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const l of c.split("\n")) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv();

import {
  extractZip,
  addressHasStreetNumber,
  bookingAddressHasZip,
  needZipMessage,
  needAddressMessage,
  isRealAddress,
} from "../lib/scheduler";
import {
  getAIResponse,
  isPureClosingBurst,
  isAskingForBookingInfo,
  containsBookingInfo,
  stripSchedulingPush,
  type ChatMessage,
} from "../lib/ai";

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` | ${(detail || "").replace(/\s+/g, " ").slice(0, 160)}` : ""}`); }
}
const U = (content: string) => ({ role: "user" as const, content });
const A = (content: string) => ({ role: "assistant" as const, content });

async function main() {
  console.log("[1] extractZip — acha o ZIP e nunca confunde com o número da casa");
  ck("'11417 SW 251st St, Homestead FL 33032' → 33032", extractZip("11417 SW 251st St, Homestead FL 33032") === "33032");
  ck("'3209 NE 7th St, Miami FL 33062' → 33062", extractZip("3209 NE 7th St, Miami FL 33062") === "33062");
  ck("'10611 Sw 124 Road Miami FL 33186' → 33186", extractZip("10611 Sw 124 Road Miami FL 33186") === "33186");
  ck("ZIP+4 '123 Main St, Miami FL 33125-1234' → 33125", extractZip("123 Main St, Miami FL 33125-1234") === "33125");
  ck("sem ZIP: '123 NW 5th St, Miami FL' → null", extractZip("123 NW 5th St, Miami FL") === null);
  ck("número da casa de 5 dígitos NÃO é ZIP: '12345 Main St, Miami FL' → null", extractZip("12345 Main St, Miami FL") === null);
  ck("casa de 5 dígitos no meio: 'Apt 2, 12345 NW 7th St, Miami FL 33125' → 33125", extractZip("Apt 2, 12345 NW 7th St, Miami FL 33125") === "33125");
  ck("vazio/null → null", extractZip("") === null && extractZip(null) === null && extractZip(undefined) === null);

  console.log("\n[2] addressHasStreetNumber — endereço COMPLETO, não só cidade");
  ck("'3209 NE 7th St, Miami FL 33062' → true", addressHasStreetNumber("3209 NE 7th St, Miami FL 33062"));
  ck("'110 NW 77 Avenue' → true", addressHasStreetNumber("110 NW 77 Avenue"));
  ck("'12A Main St, Miami FL 33125' → true", addressHasStreetNumber("12A Main St, Miami FL 33125"));
  ck("só cidade + ZIP 'Miami FL 33125' → false", !addressHasStreetNumber("Miami FL 33125"));
  ck("rua sem número 'SW 251st St, Homestead FL 33032' → false", !addressHasStreetNumber("SW 251st St, Homestead FL 33032"));

  console.log("\n[3] bookingAddressHasZip — ZIP tem que ter sido DIGITADO pelo cliente");
  const histComZip = [U("123 NW 5th St, Miami FL 33125. Phone 3055550123")];
  ck("ZIP digitado pelo cliente → true", bookingAddressHasZip("123 NW 5th St, Miami FL 33125", histComZip));
  ck("ZIP inventado (cliente nunca digitou) → false", !bookingAddressHasZip("123 NW 5th St, Miami FL 33125", [U("123 NW 5th St, Miami")]));
  ck("endereço sem ZIP → false", !bookingAddressHasZip("123 NW 5th St, Miami FL", histComZip));
  ck("ZIP em bolha anterior do cliente ainda vale", bookingAddressHasZip("123 NW 5th St, Miami FL 33125", [
    U("123 NW 5th St, Miami"), A("What's the zip code?"), U("33125"),
  ]));
  ck("ZIP só na fala do BOT não conta", !bookingAddressHasZip("123 NW 5th St, Miami FL 33125", [
    U("123 NW 5th St, Miami"), A("Is that 33125?"),
  ]));
  ck("dígitos dentro do telefone não viram ZIP", !bookingAddressHasZip("123 NW 5th St, Miami FL 33125", [U("my phone is 3053312500")]));
  ck("sufixo [SYSTEM:] não conta como fala do cliente", !bookingAddressHasZip("123 NW 5th St, Miami FL 33125", [
    U("123 NW 5th St, Miami\n\n[SYSTEM: zip 33125 from profile]"),
  ]));
  ck("sem histórico só exige o ZIP no endereço", bookingAddressHasZip("123 NW 5th St, Miami FL 33125"));
  ck("endereço completo continua passando no isRealAddress", isRealAddress("123 NW 5th St, Miami FL 33125"));

  console.log("\n[4] Mensagens");
  ck("needZipMessage EN pede o zip", /zip/i.test(needZipMessage("en")));
  ck("needZipMessage ES pede o código postal", /c[oó]digo postal/i.test(needZipMessage("es")));
  ck("needAddressMessage EN já pede o zip junto", /zip/i.test(needAddressMessage("en")));
  ck("needAddressMessage ES já pede o código postal junto", /c[oó]digo postal/i.test(needAddressMessage("es")));
  const todas = needZipMessage("en") + needZipMessage("es") + needAddressMessage("en") + needAddressMessage("es");
  ck("sem travessão e sem emoji (regras do dono)", !/[—–]/.test(todas) && !/\p{Emoji_Presentation}/u.test(todas));

  console.log("\n[5] Webhooks — os 3 bloqueiam [BOOK] sem ZIP");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: importa bookingAddressHasZip + needZipMessage`, /bookingAddressHasZip/.test(src) && /needZipMessage/.test(src), rel);
    ck(`${name}: bloqueia e re-pergunta o ZIP`, /!bookingAddressHasZip\(bookingData\.address,\s*history\)\)\s*\{[\s\S]{0,260}needZipMessage\(lang\)/.test(src), rel);
    ck(`${name}: exige número da casa no endereço`, /!addressHasStreetNumber\(bookingData\.address\)/.test(src), rel);
    ck(`${name}: guarda do ZIP antes do createBooking`, src.indexOf("bookingAddressHasZip(bookingData.address") < src.indexOf("createBooking("), rel);
    ck(`${name}: guarda do ZIP depois da guarda de endereço`, src.indexOf("isRealAddress(bookingData.address)") < src.indexOf("bookingAddressHasZip(bookingData.address"), rel);
    ck(`${name}: guarda do nome continua no lugar (sem regressão)`, /!clientProvidedName\(bookingData\.name,\s*history\)/.test(src), rel);
  }

  console.log("\n[6] Prompt — pede endereço completo com ZIP CODE");
  const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("coleta cita street number + ZIP CODE", /INCLUDING the street number and the ZIP CODE/i.test(prompt));
  ck("regra ADDRESS MUST BE COMPLETE, WITH THE ZIP CODE presente", /ADDRESS MUST BE COMPLETE, WITH THE ZIP CODE/.test(prompt));
  ck("proíbe adivinhar o ZIP pela cidade", /NEVER guess, infer, or fill the ZIP CODE yourself/.test(prompt));
  ck("Step 3 pede nome + endereço com ZIP + telefone", /Ask for the client's name, full address with the ZIP CODE, and phone ONLY after/.test(prompt));
  ck("pedido único junta nome + endereço com ZIP + telefone", /the FULL address WITH THE ZIP CODE, AND the phone together in ONE message/.test(prompt));
  ck("WHATSAPP EXCEPTION pede endereço com ZIP (sem telefone)", /ask ONLY for the client's name and the full property address with the ZIP CODE/.test(prompt));
  ck("exemplo completo do [BOOK] tem ZIP no endereço", /"address":"3209 NE 7th St, Miami FL 33062"/.test(prompt));

  console.log("\n[7] O pedido de ZIP nunca é engolido pelos guards");
  const zipAsk = needZipMessage("en");
  ck("needZipMessage conta como pergunta de booking info", isAskingForBookingInfo(zipAsk));
  ck("pergunta natural do modelo (name+address+zip+phone) conta", isAskingForBookingInfo("Perfect! What's your name, the full address with the zip code, and the best phone number?"));
  ck("anti-pressão NÃO apaga o pedido de ZIP", stripSchedulingPush(zipAsk).includes("zip"));
  ck("anti-pressão NÃO apaga o pedido de endereço com ZIP", stripSchedulingPush(needAddressMessage("en")).toLowerCase().includes("zip"));
  ck("'33125' sozinho é booking info", containsBookingInfo("33125"));
  ck("'33125, thanks!' após pedirmos o ZIP NÃO é fechamento puro", !isPureClosingBurst([
    A("Perfect, I have Tuesday at 9am or 1pm, which works better for you?"),
    U("9am works"),
    A(zipAsk),
    U("33125, thanks!"),
  ]));
  ck("'Thank you so much!' sem pergunta pendente segue silenciado", isPureClosingBurst([
    A("You are all set for Tuesday at 9am, see you then!"),
    U("Thank you so much!"),
  ]));

  // ── [8-LIVE] modelo real ────────────────────────────────────────────────────
  console.log("\n[8-LIVE] Modelo real — pede o ZIP e não confirma sem ele");
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);

  const base: ChatMessage[] = [
    A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("Vinyl for my whole house, about 1400 sqft"),
    A("For that size the visit is the best next step, all free. I have Tuesday at 9am or 1pm, which works better for you?"),
    U("Tuesday 9am works"),
  ];

  // (a) Slot escolhido → o pedido tem que incluir o ZIP junto com nome/endereço/telefone.
  const afterSlotPick = await ai(base);
  console.log("   →", afterSlotPick.slice(0, 240).replace(/\n/g, " "));
  ck("pede o ZIP CODE ao pedir os dados", /zip|postal/i.test(afterSlotPick), afterSlotPick);
  ck("continua pedindo nome, endereço e telefone", /\bname\b|\bnombre\b/i.test(afterSlotPick) && /address|direcci[oó]n/i.test(afterSlotPick) && /phone|number|tel[eé]fono/i.test(afterSlotPick), afterSlotPick);

  // (b) Nome + endereço + telefone SEM ZIP → ou o modelo pede o ZIP (sem [BOOK]),
  //     ou emite [BOOK] e a guarda bloqueia. Nos dois casos a visita NÃO fecha.
  const noZipHistory: ChatMessage[] = [
    ...base,
    A("Perfect! Can I have your name, the full property address with the zip code, and the best phone number for the visit?"),
    U("Carlos, 123 NW 5th St, Miami. Phone 3055550123"),
  ];
  const noZipReply = await ai(noZipHistory);
  console.log("   →", noZipReply.slice(0, 240).replace(/\n/g, " "));
  const bookMatch = noZipReply.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (bookMatch) {
    let addr: string | null = null;
    try { addr = JSON.parse(bookMatch[1]).address ?? null; } catch { /* json quebrado = guarda nem roda */ }
    ck("modelo emitiu [BOOK] sem ZIP do cliente → guarda BLOQUEIA", !bookingAddressHasZip(addr, noZipHistory), `address=${JSON.stringify(addr)}`);
  } else {
    ck("modelo não emitiu [BOOK] e pede o ZIP", /zip|postal/i.test(noZipReply), noZipReply);
  }

  // (c) Com o ZIP digitado o [BOOK] sai e passa na guarda.
  const withZipHistory: ChatMessage[] = [
    ...noZipHistory,
    A("Almost set! What's the zip code for that address?"),
    U("33125"),
  ];
  const withZipReply = await ai(withZipHistory);
  console.log("   →", withZipReply.slice(0, 240).replace(/\n/g, " "));
  const okBook = withZipReply.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  ck("com ZIP digitado o modelo emite [BOOK]", !!okBook, withZipReply);
  if (okBook) {
    let a: string | null = null;
    try { a = JSON.parse(okBook[1]).address ?? null; } catch { /* noop */ }
    ck("endereço do [BOOK] passa na guarda de ZIP", bookingAddressHasZip(a, withZipHistory), `address=${JSON.stringify(a)}`);
    ck("endereço do [BOOK] tem número da casa", addressHasStreetNumber(a), `address=${JSON.stringify(a)}`);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
