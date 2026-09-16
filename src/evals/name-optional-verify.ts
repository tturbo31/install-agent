/**
 * Regra do dono (2026-09-16): o NOME NÃO é requisito para marcar visita e NUNCA
 * é pedido. Endereço completo com ZIP + telefone (no WhatsApp o número do chat)
 * = [BOOK]. Se o cliente digitou o nome, a visita fica nesse nome; senão o
 * sistema busca na plataforma (última visita pelo telefone) / perfil salvo.
 * Substitui name-required-verify (regra de 27/07, revogada).
 *
 * Camadas verificadas aqui:
 *  1. Estático: os 3 webhooks NÃO bloqueiam o [BOOK] sem nome, não existe mais
 *     needNameMessage, e o nome sem digitação vem de lookupClientNameByPhone
 *     (plataforma) antes do perfil; a nota do canal WhatsApp não pede o nome.
 *  2. Estático: prompt (BOOKING SYSTEM, sequência, WhatsApp, lembretes finais,
 *     BOOK_NOW_NOTE, caudas enlatadas) sem "name" como requisito / pedido; trava
 *     8 no prompt de análise do Dreaming.
 *  3. Puro: rewriteBookingDataAsk tira o nome de qualquer pedido de dados
 *     (nome sempre "dado"); pedido só de nome com endereço faltando vira pedido
 *     do endereço; clientProvidedName segue como ranqueador (nome digitado vence).
 *  4. Puro: resolveClientName ranqueia digitado → plataforma → perfil → handle.
 *  5. AO VIVO (pula com DET_ONLY=1): o modelo, ao confirmar o slot, pede
 *     endereço + telefone SEM o nome; com endereço + telefone e sem nome, sai
 *     [BOOK]; no WhatsApp, endereço só (sem nome) → [BOOK]; e a resposta
 *     continua humana (sem "Great question"/"assistant"/travessão).
 *
 * Rodar: npx tsx src/evals/name-optional-verify.ts   (DET_ONLY=1 pula a parte 5)
 */
import { readFileSync } from "fs";
import { join } from "path";
function loadEnv() {
  try {
    const c = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

import { clientProvidedName, resolveClientName, getEasternDateContext } from "../lib/scheduler";
import {
  getAIResponse, rewriteBookingDataAsk, bookingItemsGiven, forcedBookRetryReason, keepBookingThreadAfterPhone,
  BOOK_NOW_NOTE, type ChatMessage,
} from "../lib/ai";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` | ${(detail || "").replace(/\s+/g, " ").slice(0, 260)}` : ""}`); }
}
const U = (content: string) => ({ role: "user" as const, content });
const A = (content: string) => ({ role: "assistant" as const, content });
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");
const NAME_ASK = /\b(?:your|full|first|last)\s+name\b|\bname\s+(?:for|to|under|should|do)\b|what name|\btu nombre\b|\bsu nombre\b|a nombre de|\bseu nome\b|em nome de/i;
const ROBOTIC = /great question|good question|as an ai|assistant|\bbot\b|[—–]|feel free|do not hesitate|at your earliest convenience/i;

async function main() {
  console.log("[1] webhooks: sem guarda de nome, nome vem da plataforma");
  for (const rel of ["src/app/api/webhook/route.ts", "src/app/api/fb-webhook/route.ts", "src/app/api/wa-webhook/route.ts"]) {
    const s = src(rel);
    const tag = rel.split("/")[3];
    ck(`${tag}: NÃO bloqueia o [BOOK] sem nome`, !/if\s*\(!clientProvidedName\(bookingData\.name,\s*history\)\)/.test(s), rel);
    ck(`${tag}: needNameMessage não existe mais`, !/needNameMessage/.test(s), rel);
    ck(`${tag}: nome digitado vence (clientProvidedName ranqueia)`, /const typedName = clientProvidedName\(bookingData\.name, history\) \? bookingData\.name : null;/.test(s), rel);
    ck(`${tag}: sem nome digitado → busca na plataforma pelo telefone`, /const platformName = typedName \? null : await lookupClientNameByPhone\(/.test(s), rel);
    ck(`${tag}: ordem digitado → plataforma → perfil → handle → campo do modelo`, /resolveClientName\(\s*\[typedName, platformName, conv\w*\?\.name, conv\w*\?\.username, bookingData\.name\]/.test(s), rel);
    ck(`${tag}: guardas de endereço/ZIP/telefone continuam antes do createBooking`, s.indexOf("bookingAddressHasZip(bookingData.address") < s.indexOf("createBooking(") && /isRealAddress\(bookingData\.address\)/.test(s), rel);
  }
  const wa = src("src/app/api/wa-webhook/route.ts");
  ck("WA: nota do canal pede SÓ o endereço com o ZIP (nunca o nome)", /ask ONLY for the full property address with the zip code\. NEVER ask the client for their phone number, and NEVER ask for their name/.test(wa), "nota [WHATSAPP CHANNEL]");
  const sch = src("src/lib/scheduler.ts");
  ck("scheduler: lookupClientNameByPhone existe, é só leitura (select), ignora placeholders", /export async function lookupClientNameByPhone/.test(sch) && /\.from\("bookings"\)\s*\.select\("name, phone, booking_date"\)/.test(sch) && !/lookupClientNameByPhone[\s\S]{0,1500}\.(insert|update|delete)\(/.test(sch) && /GENERIC_NAMES\.has\(n\.toLowerCase\(\)\)/.test(sch));
  ck("scheduler: needNameMessage removida", !/export function needNameMessage/.test(sch));
  ck("scheduler: nota da agenda não fala em coletar o nome", !/collect their name, address and phone/.test(sch) && /collect their address and phone/.test(sch));

  console.log("\n[2] prompt e lembretes: nome nunca é requisito nem pedido");
  const sp = src("src/lib/system-prompt.ts");
  ck("BOOKING SYSTEM: 3 itens (slot, endereço com ZIP, telefone) e nome NUNCA pedido", /\(3\) phone number\. The client's NAME is NOT a requirement and is NEVER asked/.test(sp) && /ALL THREE confirmed/.test(sp) && !/ALL FOUR/.test(sp));
  ck("regra antiga NAME MUST COME FROM THE CLIENT removida", !/NAME MUST COME FROM THE CLIENT/.test(sp) && !/Without the client's name there is no booking/.test(sp));
  ck("regra nova NAME IS NEVER ASKED presente com \"name\":\"\" quando não dito", /NAME IS NEVER ASKED \(owner rule 2026-09-16\)/.test(sp) && /"name":""/.test(sp));
  ck("Step 3 pede endereço + telefone, nunca o nome", /Step 3: Ask for the full address with the ZIP CODE and the phone \(never the name\)/.test(sp));
  ck("pedido em UMA mensagem: endereço com ZIP + telefone, exemplo sem nome", /Can I have the full property address with the zip code and the best phone number for the visit\?/.test(sp) && !/Can I have your name, the full property address/.test(sp));
  ck("ZIP já dado: exemplo sem nome", /Can I get the property address and the best phone number for the visit\?/.test(sp));
  ck("WhatsApp: só o endereço com ZIP, nunca nome nem telefone", /ask ONLY for the full property address with the ZIP CODE and NEVER ask for the phone \(and never the name\)/.test(sp));
  ck("tom humano: exemplos de variação sem 'your name'", !/"shoot me your name/.test(sp) && /always address and phone together, never the name/.test(sp));
  ck("prompt não tem mais nenhum exemplo pedindo o nome", !/Can I get your name/.test(sp) && !/What name should I put the visit under\?"\)\. Without/.test(sp));
  const aiSrc = src("src/lib/ai.ts");
  ck("FINAL REMINDERS 7: endereço + telefone (never the name)", /n7\. SLOT CONFIRMATION RULE: Ask for the client's address and phone \(never the name\) ONLY after/.test(aiSrc));
  ck("FINAL REMINDERS 8b (WhatsApp): só o endereço com ZIP, never the name", /Ask ONLY for the property address with the zip code instead \(never the name\)/.test(aiSrc));
  ck("FINAL REMINDERS 15b: NAME IS NEVER ASKED", /15b\. NAME IS NEVER ASKED \(owner rule 2026-09-16\)/.test(aiSrc));
  ck("caudas enlatadas pós-telefone sem 'your name' / 'tu nombre' / 'seu nome'", !/can I get your name, the full address/.test(aiSrc) && !/me pasas tu nombre, la dirección/.test(aiSrc) && !/me passa seu nome, o endereço/.test(aiSrc));
  ck("BOOK_NOW_NOTE: nome não obrigatório, nunca pedir", /name is NOT required/i.test(BOOK_NOW_NOTE) && !/ask for the name alone/i.test(BOOK_NOW_NOTE) && /"name":""/.test(BOOK_NOW_NOTE));
  const dream = src("src/lib/dreaming.ts");
  ck("Dreaming: trava 8 THE CLIENT'S NAME IS NEVER ASKED", /8\. THE CLIENT'S NAME IS NEVER ASKED \(owner rule 2026-09-16\)/.test(dream));

  console.log("\n[3] reescritor de pedido de dados: o nome sai de qualquer pedido");
  const yami = [
    A("The visit is free and I bring all the samples. What's the zip code of the property?"),
    U("15269 Sw 35th terrace Miami, Fl 33185"),
    A("33185 is covered. I have today at 3pm or 4pm, which works better?"),
    U("3 pm"),
  ];
  ck("nome conta como dado mesmo sem o cliente digitar", bookingItemsGiven([U("hi")], false).has("name"));
  const r1 = rewriteBookingDataAsk("Perfect, I'm holding that 3pm for you! Can I get your name, the property address, and the best phone number?", yami, false, "en");
  ck("EN: 'your name' e o endereço já dado saem, fica só o telefone", r1 === "Perfect, I'm holding that 3pm for you! Can I get the best phone number to reach you?" && !NAME_ASK.test(r1), r1);
  const r2 = rewriteBookingDataAsk("Perfect! Can I get your name and the property address with the zip code?", [A("I have 9am or 11am"), U("9am")], false, "en");
  ck("EN: nome + endereço (endereço não dado) → só endereço com ZIP", !NAME_ASK.test(r2) && /property address/.test(r2) && /zip code/.test(r2), r2);
  const r3 = rewriteBookingDataAsk("Perfect, I'm holding 9am! What name should I put the visit under?", [A("I have 9am or 11am"), U("9am")], false, "en");
  ck("EN: pedido SÓ de nome com endereço/telefone faltando → vira pedido de endereço + ZIP + telefone", !NAME_ASK.test(r3) && /property address/.test(r3) && /zip code/.test(r3) && /phone number/.test(r3), r3);
  const r3wa = rewriteBookingDataAsk("Perfect, I'm holding 9am! What name should I put the visit under?", [A("I have 9am or 11am"), U("9am")], true, "en");
  ck("WA: pedido SÓ de nome → vira pedido de endereço + ZIP (sem telefone)", !NAME_ASK.test(r3wa) && /property address/.test(r3wa) && !/phone/.test(r3wa), r3wa);
  const r4 = rewriteBookingDataAsk("Perfecto, te aparto las 3pm! Me das tu nombre, la dirección de la propiedad y el mejor número de teléfono?", [
    A("Cual es el código postal de la propiedad?"), U("15269 Sw 35th terrace Miami, Fl 33185"), A("Tengo hoy a las 3pm o 4pm, cual te queda mejor?"), U("3 pm"),
  ], false, "es");
  ck("ES: sem 'tu nombre', sem ¿", r4 === "Perfecto, te aparto las 3pm! Me pasas el mejor número de teléfono para contactarte?" && !/[¿¡]/.test(r4), r4);
  const r5 = rewriteBookingDataAsk("Perfeito, te aparto as 3pm! Me passa seu nome, o endereço da propriedade e o melhor telefone?", [
    A("Qual o zip code?"), U("15269 Sw 35th terrace Miami, Fl 33185"), A("Tenho hoje 3pm ou 4pm"), U("3 pm"),
  ], false, "pt");
  ck("PT: sem 'seu nome'", !NAME_ASK.test(r5) && /telefone/.test(r5), r5);
  const complete = [...yami, U("786-457-3511")];
  ck("tudo dado + pedido só de nome → retry forçado (reask), nada de pedir o nome", forcedBookRetryReason("Last thing! What name should I put the visit under?", complete, false) === "reask");
  const tail = keepBookingThreadAfterPhone([U("1500 sqft vinyl"), A("Perfect, I'm holding that 11am for you! Can I get your name, the property address, and the best phone number?"), U("What's your number?")], "You can reach Ozzi at (561) 674-8334.", "en");
  ck("cauda pós-telefone pede endereço + telefone, sem nome", /full address with the zip code and the best phone number/.test(tail) && !NAME_ASK.test(tail), tail);

  console.log("\n[4] ranqueamento do nome: digitado → plataforma → perfil → handle");
  ck("clientProvidedName: 'Randy Santos' digitado → true", clientProvidedName("Randy Santos", [U("Ok thank you. Randy Santos 11417 SW 251st St, Homestead FL 33032 786-368-1800")]));
  ck("clientProvidedName: nome de perfil não digitado → false (não bloqueia, só perde a preferência)", !clientProvidedName("Brian Guilford", [U("10611 Sw 124 Road Miami FL 33186"), U("305-338-4145")]));
  ck("resolveClientName: digitado vence a plataforma", resolveClientName(["Randy Santos", "Randy S.", "randy_ig"], "Instagram Client") === "Randy Santos");
  ck("resolveClientName: sem digitado → nome da plataforma (última visita pelo telefone)", resolveClientName([null, "Brian Guilford", "Brian 🏠", "brian_g"], "Instagram Client") === "Brian Guilford");
  ck("resolveClientName: sem digitado nem plataforma → perfil (emoji limpo)", resolveClientName([null, null, "Линда ♎️", "linda_ig"], "Instagram Client") === "Линда");
  ck("resolveClientName: placeholder do modelo nunca vence", resolveClientName([null, null, null, null, "Client"], "Instagram Client") === "Instagram Client");
  ck("resolveClientName: campo do modelo com nome real (não digitado) é o último recurso antes do fallback", resolveClientName([null, null, null, null, "Maria"], "Instagram Client") === "Maria");

  if (process.env.DET_ONLY === "1") { done(); return; }

  console.log("\n[5] AO VIVO: o modelo não pede o nome e agenda sem ele");
  const sysNote = (extra = "") => `\n\n[SYSTEM: ${getEasternDateContext()}\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• ${SLOT_DAY} [${SLOT_DATE}]: 09:00, 11:00, 13:00, 15:00${extra ? "\n\n" + extra : ""}]`;
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const head: ChatMessage[] = [
    { role: "user", content: "Hi, I want luxury vinyl for my whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size I do a free in-person visit to measure and bring the samples, and you get the exact price on the spot. Any day this week works?" },
    { role: "user", content: "Anyday, sooner the better" },
    { role: "assistant", content: `I have ${SLOT_DAY} at 9am or 11am, which one works?` },
  ];
  // 5a: cliente escolhe o horário → pede endereço + telefone, SEM nome, tom humano.
  const t1 = await ai([...head, { role: "user", content: `11am works${sysNote()}` }]);
  console.log("   5a →", t1.replace(/\s+/g, " ").slice(0, 300));
  ck("5a: NÃO pede o nome", !NAME_ASK.test(t1), t1);
  ck("5a: pede o endereço com o ZIP", /address/i.test(t1) && /zip/i.test(t1), t1);
  ck("5a: pede o telefone", /phone|number/i.test(t1), t1);
  ck("5a: sem [BOOK] ainda", !/\[BOOK:/.test(t1), t1);
  ck("5a: tom humano (sem 'Great question', travessão, 'assistant')", !ROBOTIC.test(t1), t1);
  // 5b: endereço + telefone, sem nome → [BOOK] na hora.
  const t2 = await ai([...head, { role: "user", content: "11am works" },
    { role: "assistant", content: "Perfect, I'm holding 11am for you. What's the full address with the zip code and the best number to reach you?" },
    { role: "user", content: `2350 NE 4th St, Boynton Beach FL 33435, 561-555-0142${sysNote()}` }]);
  console.log("   5b →", t2.replace(/\s+/g, " ").slice(0, 300));
  ck("5b: [BOOK] sai SEM o nome", /\[BOOK:/.test(t2), t2);
  ck("5b: não pede o nome", !NAME_ASK.test(t2.replace(/\[BOOK:[\s\S]*?\]/g, "")), t2);
  const tag = /\[BOOK:(\{[\s\S]*?\})\]/.exec(t2)?.[1];
  let parsed: { name?: string; phone?: string; address?: string; date?: string; time?: string } | null = null;
  try { parsed = tag ? JSON.parse(tag) : null; } catch {}
  ck("5b: tag válida com telefone, endereço com ZIP, data e hora", !!parsed && /5615550142|561-555-0142|\(561\) 555-0142/.test(parsed.phone ?? "") && /33435/.test(parsed.address ?? "") && parsed.date === SLOT_DATE && parsed.time === "11:00", tag ?? "");
  ck("5b: nome vazio ou não inventado (sem nome digitado)", !!parsed && (!parsed.name || /^(client|instagram client|customer)$/i.test(parsed.name) || parsed.name.trim() === ""), `name=${JSON.stringify(parsed?.name)}`);
  // 5c: nome digitado junto → vai na tag.
  const t3 = await ai([...head, { role: "user", content: "11am works" },
    { role: "assistant", content: "Perfect, I'm holding 11am for you. What's the full address with the zip code and the best number to reach you?" },
    { role: "user", content: `Maria Lopez, 2350 NE 4th St, Boynton Beach FL 33435, 561-555-0142${sysNote()}` }]);
  const tag3 = /\[BOOK:(\{[\s\S]*?\})\]/.exec(t3)?.[1];
  let p3: { name?: string } | null = null; try { p3 = tag3 ? JSON.parse(tag3) : null; } catch {}
  console.log("   5c →", t3.replace(/\s+/g, " ").slice(0, 200));
  ck("5c: nome digitado vai na tag", !!p3 && /maria/i.test(p3.name ?? ""), tag3 ?? t3);
  // 5d: WhatsApp — só o endereço com ZIP, sem nome → [BOOK].
  const WA_NOTE = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (13055551234). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "13055551234" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
  const t4 = await ai([...head, { role: "user", content: `11am works${sysNote(WA_NOTE)}` }]);
  console.log("   5d →", t4.replace(/\s+/g, " ").slice(0, 300));
  ck("5d (WA): pede só o endereço com o ZIP, sem nome e sem telefone", !NAME_ASK.test(t4) && /address/i.test(t4) && /zip/i.test(t4) && !/\bphone\b|best number/i.test(t4), t4);
  const t5 = await ai([...head, { role: "user", content: "11am works" },
    { role: "assistant", content: "Perfect, I'm holding 11am for you. What's the full property address with the zip code?" },
    { role: "user", content: `113 NW 11th St Ft Lauderdale FL 33311${sysNote(WA_NOTE)}` }]);
  console.log("   5e →", t5.replace(/\s+/g, " ").slice(0, 300));
  ck("5e (WA): endereço só, sem nome → [BOOK]", /\[BOOK:/.test(t5) && !NAME_ASK.test(t5.replace(/\[BOOK:[\s\S]*?\]/g, "")), t5);
  // 5f: espanhol — mesmo comportamento, sem ¿ e sem nome.
  const t6 = await ai([
    { role: "user", content: "Hola, quiero vinyl para toda la casa, unos 1200 pies cuadrados." },
    { role: "assistant", content: "Para ese tamaño hago una visita gratis para medir y llevo las muestras, y ahí mismo te doy el precio exacto. Te sirve esta semana?" },
    { role: "user", content: "Si, lo antes posible" },
    { role: "assistant", content: `Tengo ${SLOT_DAY} a las 9am o 11am, cuál te queda mejor?` },
    { role: "user", content: `11am${sysNote()}` }]);
  console.log("   5f →", t6.replace(/\s+/g, " ").slice(0, 300));
  ck("5f (ES): pide dirección con código postal + teléfono, sin nombre, sin ¿", !NAME_ASK.test(t6) && /direcci[oó]n/i.test(t6) && /c[oó]digo postal|zip/i.test(t6) && /tel[eé]fono|n[uú]mero/i.test(t6) && !/[¿¡]/.test(t6), t6);
  done();
}
// Um dia fixo no futuro próximo com vaga fictícia (a parte 5 não toca a agenda real).
const nextDay = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); return d; })();
const SLOT_DATE = nextDay.toISOString().slice(0, 10);
const SLOT_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][nextDay.getUTCDay()];

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILS:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
