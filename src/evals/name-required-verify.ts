/**
 * Regra do dono (2026-07-27): a visita SÓ é confirmada quando o CLIENTE deu os
 * TRÊS dados na conversa: NOME, endereço e telefone. Nome de perfil (IG/FB
 * display name, pushname do WhatsApp) NÃO conta — o bot tem que perguntar.
 *
 * Camadas verificadas aqui:
 *  1. clientProvidedName (pura): nome do [BOOK] precisa ser real e ter sido
 *     digitado pelo cliente (token a token, sem acento/caixa).
 *  2. Os 3 webhooks bloqueiam o [BOOK] sem nome e re-perguntam (estático).
 *  3. O prompt instrui a pedir nome + endereço + telefone (estático).
 *  4. A resposta curta com o nome ("It's John, thanks!") nunca é silenciada
 *     como fechamento puro (isPureClosingBurst).
 *  5. AO VIVO: o modelo pede o nome ao confirmar slot; sem nome não sai [BOOK]
 *     aprovável; com nome digitado o [BOOK] passa na guarda.
 *
 * Rodar: npx tsx src/evals/name-required-verify.ts   (parte 5 usa a API)
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

import { clientProvidedName, needNameMessage } from "../lib/scheduler";
import { getAIResponse, isPureClosingBurst, isAskingForBookingInfo, type ChatMessage } from "../lib/ai";

let pass = 0, fail = 0;
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` | ${(detail || "").replace(/\s+/g, " ").slice(0, 160)}` : ""}`); }
}
const U = (content: string) => ({ role: "user" as const, content });
const A = (content: string) => ({ role: "assistant" as const, content });

async function main() {
  console.log("[1] clientProvidedName — nome tem que ter sido DIGITADO pelo cliente");
  ck("'Brian' digitado em '(Brian)' → true", clientProvidedName("Brian", [U("Cell is 305-338-4145 (Brian)")]));
  ck("nome de perfil nunca digitado → false", !clientProvidedName("Brian Guilford", [
    U("Let’s do 9:00–thank you"), U("10611 Sw 124 Road Miami FL 33186"),
  ]));
  ck("'Randy Santos' dentro da msg de endereço → true", clientProvidedName("Randy Santos", [
    U("Ok thank you. Randy Santos 11417 SW 251st St, Homestead FL 33032 786-368-1800"),
  ]));
  ck("placeholder 'Instagram Client' → false", !clientProvidedName("Instagram Client", [U("hi")]));
  ck("'Client' → false", !clientProvidedName("Client", [U("my name is Client ok")]));
  ck("vazio/null → false", !clientProvidedName("", [U("hi")]) && !clientProvidedName(null, [U("hi")]));
  ck("'José' casa 'jose' digitado (sem acento) → true", clientProvidedName("José", [U("soy jose, la direccion es 123 NW 5th St")]));
  ck("'Ana' NÃO casa dentro de 'banana' → false", !clientProvidedName("Ana", [U("I want banana wood floors")]));
  ck("'O’Brien' (apóstrofo curvo) casa 'obrien... brien' digitado", clientProvidedName("O’Brien", [U("It's O'Brien, 123 Main St")]));
  ck("nome só com emoji → false", !clientProvidedName("🏠🏠", [U("hi")]));

  console.log("\n[2] needNameMessage");
  ck("EN pede o nome", /name/i.test(needNameMessage("en")));
  ck("ES pede o nome", /nombre/i.test(needNameMessage("es")));
  ck("sem travessão e sem emoji (regras do dono)", !/[—–]/.test(needNameMessage("en") + needNameMessage("es")) && !/\p{Emoji_Presentation}/u.test(needNameMessage("en") + needNameMessage("es")));

  console.log("\n[3] Webhooks — os 3 bloqueiam [BOOK] sem nome do cliente");
  for (const [name, rel] of [
    ["Instagram", "src/app/api/webhook/route.ts"],
    ["WhatsApp", "src/app/api/wa-webhook/route.ts"],
    ["Facebook", "src/app/api/fb-webhook/route.ts"],
  ] as const) {
    const src = readFileSync(join(process.cwd(), rel), "utf-8");
    ck(`${name}: importa clientProvidedName + needNameMessage`, /clientProvidedName/.test(src) && /needNameMessage/.test(src), rel);
    ck(`${name}: bloqueia e re-pergunta o nome`, /!clientProvidedName\(bookingData\.name,\s*history\)\)\s*\{[\s\S]{0,220}needNameMessage\(lang\)/.test(src), rel);
    ck(`${name}: guarda do nome antes do createBooking`, src.indexOf("clientProvidedName(bookingData.name") < src.indexOf("createBooking("), rel);
    ck(`${name}: guarda do nome depois da guarda de slot`, src.indexOf("clientConfirmedSlot(history)") < src.indexOf("clientProvidedName(bookingData.name"), rel);
  }

  console.log("\n[4] Prompt — instruções pedem nome + endereço + telefone");
  const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("coleta lista o nome como (4) e exige ALL FOUR", /\(4\) the client'?s name/i.test(prompt) && /ALL FOUR/i.test(prompt));
  ck("regra NAME MUST COME FROM THE CLIENT presente", /NAME MUST COME FROM THE CLIENT/.test(prompt));
  ck("proíbe usar nome de perfil/username", /NEVER fill it from the Instagram\/Facebook profile/.test(prompt));
  // Redação tolerante: o ZIP CODE entrou no meio da frase em 2026-08-01
  // (zip-required-verify cobre o ZIP em si), o que importa aqui é que os TRÊS
  // dados continuam sendo pedidos juntos.
  ck("Step 3 pede nome, endereço e telefone juntos", /Ask for the client's name, [^.]*address[^.]*, and phone ONLY after/.test(prompt));
  ck("WHATSAPP EXCEPTION pede nome + endereço (sem telefone)", /ask ONLY for the client's name and the (?:full )?property address/.test(prompt));

  console.log("\n[5] Resposta com o nome nunca é silenciada como fechamento");
  const nameAsk = "Last thing! What name should I put the visit under?";
  ck("needNameMessage conta como pergunta de booking info", isAskingForBookingInfo(nameAsk));
  ck("pergunta natural do modelo (name+address+phone) também conta", isAskingForBookingInfo("Perfect! What's your name, the full property address, and the best phone number?"));
  ck("'It's John, thanks!' após pedirmos o nome NÃO é fechamento puro", !isPureClosingBurst([
    A("Perfect, I have Tuesday at 9am or 1pm, which works better for you?"),
    U("9am works"),
    A(nameAsk),
    U("It's John, thanks!"),
  ]));
  ck("'Thank you so much!' SEM pergunta pendente segue silenciado", isPureClosingBurst([
    A("You are all set for Tuesday at 9am, see you then!"),
    U("Thank you so much!"),
  ]));

  // ── [5-LIVE] modelo real ────────────────────────────────────────────────────
  console.log("\n[5-LIVE] Modelo real — pede o nome e não confirma sem ele");
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);

  // (a) Cliente escolheu o slot → a resposta deve pedir nome + endereço + telefone.
  const afterSlotPick = await ai([
    A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("Vinyl for my whole house, about 1400 sqft"),
    A("For that size the visit is the best next step, all free. I have Tuesday at 9am or 1pm, which works better for you?"),
    U("Tuesday 9am works"),
  ]);
  console.log("   →", afterSlotPick.slice(0, 220).replace(/\n/g, " "));
  ck("pede o NOME após a escolha do slot", /\bname\b|\bnombre\b/i.test(afterSlotPick), afterSlotPick);
  ck("pede endereço e telefone também", /address|direcci[oó]n/i.test(afterSlotPick) && /phone|number|tel[eé]fono|n[uú]mero/i.test(afterSlotPick), afterSlotPick);

  // (b) Cliente deu slot + endereço + telefone mas NUNCA o nome → ou o modelo
  //     pede o nome (sem [BOOK]), ou emite [BOOK] e a guarda bloqueia. Nos dois
  //     casos a mensagem que SAI pede o nome — a visita não é confirmada.
  const noNameHistory: ChatMessage[] = [
    A("Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?"),
    U("Vinyl for my whole house, about 1400 sqft"),
    A("For that size the visit is the best next step, all free. I have Tuesday at 9am or 1pm, which works better for you?"),
    U("Tuesday 9am works"),
    A("Perfect! Can I have your name, the full property address, and the best phone number to confirm the visit?"),
    U("123 NW 5th St, Miami FL 33125. Phone 3055550123"),
  ];
  const noNameReply = await ai(noNameHistory);
  console.log("   →", noNameReply.slice(0, 220).replace(/\n/g, " "));
  const bookMatch = noNameReply.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  if (bookMatch) {
    let bookedName: string | null = null;
    try { bookedName = JSON.parse(bookMatch[1]).name ?? null; } catch { /* json quebrado = guarda nem roda */ }
    ck("modelo emitiu [BOOK] sem nome do cliente → guarda BLOQUEIA", !clientProvidedName(bookedName, noNameHistory), `name=${JSON.stringify(bookedName)}`);
  } else {
    ck("modelo não emitiu [BOOK] e pede o nome", /\bname\b|\bnombre\b/i.test(noNameReply), noNameReply);
  }

  // (c) Cliente deu o nome junto → o [BOOK] tem que sair e passar na guarda.
  const withNameHistory: ChatMessage[] = [
    ...noNameHistory.slice(0, 5),
    U("Sure, it's Carlos. 123 NW 5th St, Miami FL 33125. Phone 3055550123"),
  ];
  const withNameReply = await ai(withNameHistory);
  console.log("   →", withNameReply.slice(0, 220).replace(/\n/g, " "));
  const okBook = withNameReply.match(/\[BOOK:(\{[\s\S]*?\})\]/);
  ck("com nome digitado o modelo emite [BOOK]", !!okBook, withNameReply);
  if (okBook) {
    let n: string | null = null;
    try { n = JSON.parse(okBook[1]).name ?? null; } catch { /* noop */ }
    ck("nome do [BOOK] passa na guarda (foi digitado pelo cliente)", clientProvidedName(n, withNameHistory), `name=${JSON.stringify(n)}`);
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
