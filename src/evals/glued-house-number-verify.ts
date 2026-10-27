/**
 * NÚMERO DA CASA COLADO À RUA + ZIP EM BOLHA SEPARADA (cliente WA, 25/10/2026 21:32 ET).
 *
 * O que aconteceu: "33404" respondeu a pergunta do ZIP; "Yes 9am works" escolheu o horário;
 * "105harbor street riviera beaches" respondeu o pedido do endereço. O modelo pediu
 * "the full address ... with the zip code" (não juntou o ZIP da bolha anterior com a rua),
 * o backstop stripZipReask apagou só o "with the zip code" e sobrou "Almost set! What's the
 * full address for 105 Harbor Street, Riviera Beach?". Nenhum detector de endereço via
 * "105harbor street" (todos exigiam espaço entre número e rua), então bookingDataLooksComplete
 * era false, o retry forçado do [BOOK] não disparava e a pergunta sem sentido saiu, duas vezes
 * (reproduzido ao vivo 3/3 e 2/2 com o histórico real).
 *
 * Puro (sem modelo):
 *  1. Detectores aceitam número colado à rua ("105harbor street", "106harbor street"):
 *     isLocationAnswer, containsBookingInfo, carriesBookingFact, clientLocationKnown,
 *     bookingItemsGiven(address), addressHasStreetNumber.
 *  2. Sem falso positivo: "251st St" sem número, "5pm", "100sqft", "2nd floor", "Miami FL 33125",
 *     ZIP sozinho; endereços com espaço (Dragos, Randy) continuam iguais.
 *  3. Histórico real da cliente: bookingDataLooksComplete = true e forcedBookRetryReason = "reask"
 *     nos dois turnos em que o bot repetiu o pedido (antes do fix: null nos dois).
 *  4. addressAlreadyTypedNote: cita a ÚLTIMA bolha com rua e o ZIP; null sem ZIP ou sem rua;
 *     telefone digitado junto não vai na citação.
 *  5. Prompt e os 3 webhooks carregam a regra / a nota.
 * Ao vivo (LIVE=1, N amostras por turno): replay dos dois turnos da cliente com as notas do webhook
 * do WhatsApp; o rascunho (ou, se faltar, o retry forçado) tem que trazer [BOOK] de 2026-12-18 09:00
 * com o endereço da Harbor Street e o ZIP 33404 que a cliente digitou. Nada é enviado.
 * Run: npx tsx src/evals/glued-house-number-verify.ts   |   LIVE=1 N=2 npx tsx src/evals/glued-house-number-verify.ts
 */
import {
  isLocationAnswer, containsBookingInfo, bookingItemsGiven, bookingDataLooksComplete, forcedBookRetryReason,
  addressAlreadyTypedNote, clientAlreadyGaveZip, getAIResponse, adFlooringTypeNote, retryForBookTag, type ChatMessage,
} from "../lib/ai";
import { addressHasStreetNumber, clientLocationKnown, bookingAddressHasZip, isRealAddress, clientConfirmedSlot, bookingEpisodeHistory, getRealAvailabilityContext, getEasternDateContext } from "../lib/scheduler";
import { carriesBookingFact } from "../lib/booking-facts";
import { SYSTEM_PROMPT } from "../lib/system-prompt";
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

// Histórico real (dump-conv-5610000000-2610.json), até o turno do endereço.
const HIST: ChatMessage[] = [
  U("What is the installation process?"),
  A("We come in, lay everything out, move the furniture, install the tile, and leave the space clean and ready to use, usually done in 2 to 3 days. Are you thinking of one area or the whole house?"),
  U("Yes"),
  A("Which type of flooring are you looking at, tile, vinyl, or hardwood?"),
  U("Tile \nDownstairs living and kitchen"),
  U("With bathroom"),
  A("Tile for the living room, kitchen and bathroom is a solid combo. For that size I need to measure in person to give you the best price, it's a free visit and I bring the samples. What's the zip code of the property?"),
  U("33404"),
  A("33404 is covered! I have Tuesday the 27th at 2pm or 4pm, which works better for you?"),
  U("I’m just shopping around not quite ready but looking to start early January will do a date in Decemberany date after the 18th"),
  A("No problem, I've got you for any date after December 18th. Does Friday the 18th work, at 9am or 8pm?"),
  U("I’m just shopping around not quite ready but looking to start early January will do a date in December any date after the 18th"),
  A("Got it, no rush at all. I've got Wednesday December 18th at 9am or 8pm, which works better for you?"),
  U("Yes 9am works"),
  A("Perfect, I'm holding that Wednesday December 18th at 9am for you! Can I get the full property address to lock it in?"),
  U("December 18th a Friday"),
  U("106harbor street"),
  A("You're right, December 18th is a Friday! I'm holding that 9am for you. Can I get the full property address to lock it in?"),
  U("105harbor street riviera beaches"),
];
const REPLY_T1 = "Almost set! What's the full address for 105 Harbor Street, Riviera Beach?";
const HIST_T2: ChatMessage[] = [...HIST, A(REPLY_T1), U("That’s the full address"), U("33404")];
const REPLY_T2 = "Almost set! What's the full street address for Riviera Beach?";

console.log("\n━━ 1. número colado à rua conta como endereço ━━");
for (const s of ["105harbor street riviera beaches", "106harbor street", "105harbor street riviera beach 33404"]) {
  ck(`isLocationAnswer("${s}")`, isLocationAnswer(s));
  ck(`containsBookingInfo("${s}")`, containsBookingInfo(s));
  ck(`carriesBookingFact("${s}")`, carriesBookingFact(s));
  ck(`clientLocationKnown("${s}")`, clientLocationKnown([U(s)]));
  ck(`bookingItemsGiven("${s}") tem address`, bookingItemsGiven([U(s)], true).has("address"));
  ck(`addressHasStreetNumber("${s}")`, addressHasStreetNumber(s));
}
ck("addressHasStreetNumber(tag normalizada)", addressHasStreetNumber("105 Harbor Street, Riviera Beach, FL 33404"));
ck("bookingAddressHasZip(tag normalizada, ZIP da cliente)", bookingAddressHasZip("105 Harbor Street, Riviera Beach, FL 33404", HIST));
ck("bookingAddressHasZip(tag sem ZIP) = false", !bookingAddressHasZip("105 Harbor Street, Riviera Beach", HIST));

console.log("\n━━ 2. sem falso positivo / endereços com espaço inalterados ━━");
for (const s of ["I live on 251st St", "5pm works for me", "100sqft of tile", "2nd floor", "3rd ave is far", "33404", "Miami FL 33125", "9am"]) {
  ck(`"${s}" não é endereço (bookingItemsGiven)`, !bookingItemsGiven([U(s)], true).has("address"));
  ck(`"${s}" não é endereço (containsBookingInfo só por rua)`, !containsBookingInfo(s) || /\b\d{5}\b/.test(s));
}
ck("addressHasStreetNumber('Miami FL 33125') = false", !addressHasStreetNumber("Miami FL 33125"));
ck("addressHasStreetNumber('33404') = false", !addressHasStreetNumber("33404"));
ck("addressHasStreetNumber('251st St') = false", !addressHasStreetNumber("251st St"));
for (const s of ["50 Biscayne blvd, Miami 33132", "11417 SW 251st St, Homestead FL 33032", "15269 Sw 35th terrace Miami, Fl 33185"]) {
  ck(`"${s}" continua endereço`, isLocationAnswer(s) && containsBookingInfo(s) && carriesBookingFact(s) && clientLocationKnown([U(s)]) && bookingItemsGiven([U(s)], true).has("address") && addressHasStreetNumber(s));
}

console.log("\n━━ 3. histórico real: o retry forçado do [BOOK] agora dispara ━━");
ck("T1: clientAlreadyGaveZip", clientAlreadyGaveZip(HIST));
ck("T1: clientConfirmedSlot(episódio)", clientConfirmedSlot(bookingEpisodeHistory(HIST)));
ck("T1: bookingDataLooksComplete (WhatsApp)", bookingDataLooksComplete(HIST, true));
ck("T1: forcedBookRetryReason = reask", forcedBookRetryReason(REPLY_T1, HIST, true) === "reask", String(forcedBookRetryReason(REPLY_T1, HIST, true)));
ck("T2: bookingDataLooksComplete (WhatsApp)", bookingDataLooksComplete(HIST_T2, true));
ck("T2: forcedBookRetryReason = reask", forcedBookRetryReason(REPLY_T2, HIST_T2, true) === "reask", String(forcedBookRetryReason(REPLY_T2, HIST_T2, true)));
ck("só a rua, sem ZIP: dados incompletos (sem retry)", !bookingDataLooksComplete([A("What's the zip code?"), U("Tuesday 9am"), A("I'm holding Tuesday 9am. Address?"), U("105harbor street riviera beaches")], true));

console.log("\n━━ 4. nota ADDRESS ALREADY TYPED ━━");
const note = addressAlreadyTypedNote(HIST) ?? "";
ck("T1: nota existe", note.length > 0);
ck("T1: cita a última bolha com rua", note.includes('"105harbor street riviera beaches"'), note);
ck("T1: não cita a bolha anterior (106)", !note.includes("106harbor"), note);
ck("T1: cita o ZIP 33404", /zip code 33404\b/.test(note), note);
ck("T1: manda escrever o [BOOK] com rua + ZIP quando o horário estiver confirmado", /\[BOOK:/.test(note) && /confirmed a specific day and time/.test(note), note);
ck("T2: nota existe", (addressAlreadyTypedNote(HIST_T2) ?? "").includes("33404"));
ck("sem ZIP → null", addressAlreadyTypedNote([U("105harbor street riviera beaches")]) === null);
ck("sem rua → null", addressAlreadyTypedNote([U("33404"), U("Riviera Beach")]) === null);
ck("ZIP só no [SYSTEM:] → null", addressAlreadyTypedNote([U("105harbor street riviera beaches\n\n[SYSTEM: zip 33404]")]) === null);
const withPhone = addressAlreadyTypedNote([U("Yami Fonseca 786-457-3511 15269 SW 35th terrace Miami Fl 33185")]) ?? "";
ck("telefone digitado junto não vai na citação", withPhone.length > 0 && !withPhone.includes("786") && withPhone.includes("15269 SW 35th terrace"), withPhone);
ck("bolha nossa com endereço não conta", addressAlreadyTypedNote([A("Is it 105 Harbor Street, Riviera Beach 33404?"), U("yes")]) === null);

console.log("\n━━ 5. prompt + webhooks ━━");
ck("prompt: número colado à rua", /house number may be written together with the street name/.test(SYSTEM_PROMPT));
ck("prompt: peças em mensagens separadas", /may arrive in SEPARATE messages/.test(SYSTEM_PROMPT));
ck("prompt: caso cliente WA na regra ADDRESS ALREADY GIVEN", /WhatsApp 2026-10-25/.test(SYSTEM_PROMPT));
ck("prompt: regras antigas intactas", /ADDRESS ALREADY GIVEN/.test(SYSTEM_PROMPT) && /Read the WHOLE conversation before asking/.test(SYSTEM_PROMPT) && /ZIP ALREADY GIVEN/.test(SYSTEM_PROMPT));
for (const f of ["src/app/api/wa-webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/webhook/route.ts"]) {
  const src = readFileSync(join(process.cwd(), f), "utf-8");
  ck(`${f}: nota ligada ao histórico (sem visita confirmada, sem remarcação)`, /const typedAddressNote = !isBookingConfirmed && !isRescheduling \? addressAlreadyTypedNote\(history\) : null;\s*\r?\n\s*if \(typedAddressNote\) systemParts\.push\(typedAddressNote\);/.test(src));
}

async function main() {
  if (process.env.LIVE === "1") {
    const N = Number(process.env.N ?? 2);
    console.log(`\n━━ LIVE: replay dos dois turnos da cliente pelo cérebro (notas do webhook WA), ${N} amostra(s) cada ━━`);
    const phone = "15610000000";
    const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
    const dateContext = getEasternDateContext();
    for (const [label, hist] of [["T1 (105harbor street riviera beaches)", HIST], ["T2 (That's the full address + 33404)", HIST_T2]] as Array<[string, ChatMessage[]]>) {
      const window = hist.slice(-15);
      const availability = await getRealAvailabilityContext({ history: window });
      ck(`${label}: agenda lista 2026-12-18`, /\[2026-12-18\]/.test(availability), availability.slice(0, 200));
      const typedNote = addressAlreadyTypedNote(window);
      const parts = [dateContext, availability, ...(typedNote ? [typedNote] : []), waNote, adFlooringTypeNote("tile")];
      const messages = window.map((m) => ({ ...m }));
      messages[messages.length - 1] = { ...messages[messages.length - 1], content: `${messages[messages.length - 1].content}\n\n[SYSTEM: ${parts.join("\n\n")}]` };
      for (let i = 0; i < N; i++) {
        let text = "";
        try { text = (await getAIResponse(messages, null, null, null, false)).text; } catch (e) { ck(`${label} #${i + 1}: chamada ao modelo`, false, String(e)); continue; }
        let source = "rascunho";
        if (!/\[BOOK:/i.test(text)) {
          const reason = forcedBookRetryReason(text, window, true);
          ck(`${label} #${i + 1}: rascunho sem tag é re-pedido reconhecido (retry forçado)`, reason === "reask" || reason === "claim", text);
          if (reason) { const rt = await retryForBookTag(messages, null, null, null, reason); if (rt) { text = rt; source = "retry"; } }
        }
        const tag = text.match(/\[BOOK:(\{[\s\S]*?\})\]/);
        let d: { date?: string; time?: string; address?: string } | null = null;
        try { d = tag ? JSON.parse(tag[1]) : null; } catch { d = null; }
        ck(`${label} #${i + 1}: [BOOK] presente (${source})`, !!d, text);
        if (!d) continue;
        ck(`${label} #${i + 1}: data 2026-12-18 09:00`, d.date === "2026-12-18" && d.time === "09:00", `${d.date} ${d.time}`);
        ck(`${label} #${i + 1}: endereço com número, Harbor e o ZIP da cliente`, isRealAddress(d.address) && addressHasStreetNumber(d.address) && /harbor/i.test(d.address ?? "") && bookingAddressHasZip(d.address, window), String(d.address));
        ck(`${label} #${i + 1}: não pede endereço/ZIP de novo`, !/\b(?:full|street)\s+address\b|\bzip\b/i.test(text.replace(/\[BOOK:[\s\S]*?\]/, "")), text);
      }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed${fails.length ? "\n  - " + fails.join("\n  - ") : ""}`);
  process.exit(fail ? 1 : 0);
}
void main();
