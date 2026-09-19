/**
 * EDITED WhatsApp bubble (Alejandro Trigoso, WA 17864439815, 2026-09-18):
 * asked for the address with the zip, he sent "17474 sw 272 st" and 8s later
 * EDITED it to "17474 sw 272 st\nHomestead, fl 33031". Z-API sends the edit
 * with isEdit:true, the ORIGINAL messageId and phone = chat LID; the webhook
 * deduped it as a repeat, the bot asked "What's the zip code for that
 * address?" and the Sunday 3pm visit was lost.
 *
 * Layers checked:
 *  1. Pure policy (wa-edit-policy.ts): same text → ignore; not answered yet →
 *     answer; answered + new info (number, zip, day, hour, email, negation,
 *     floor type, 3+ new words) → answer; answered + cosmetic (typo, one extra
 *     word) → update-original. Real cases: Alejandro, Francis Celis, Elisabet.
 *  2. Real captured payloads (caixa-preta 18-19/09): edit id, LID phone,
 *     phone from the stored conversation.
 *  3. Webhook wiring: edit branch BEFORE the dedupe, original looked up by
 *     messageId, number from the conversation, edit stored under
 *     editMessageId, 👍 reactions point at the original bubble, the pre-send
 *     stale-context guard is still there.
 *  4. LIVE (skipped with DET_ONLY=1): with the edit stored as a new bubble, the
 *     model books ([BOOK] with the 33031 address at 15:00) in the original
 *     burst and in the rescue shape (after our "what's the zip?").
 *
 * Run: npx tsx src/evals/wa-edit-verify.ts   (DET_ONLY=1 skips part 4)
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

import {
  isWaEditCallback, waEditStoreId, isRealWaPhone, phoneFromWaIgsid, editAddsInfo, waEditAction,
} from "../lib/wa-edit-policy";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { getEasternDateContext } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` | ${(detail || "").replace(/\s+/g, " ").slice(0, 260)}` : ""}`); }
}
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");

// Payloads as captured (caixa-preta funil_raw_wa_*), photo fields dropped.
const ALEJANDRO_ORIGINAL = {
  isStatusReply: false, chatLid: "111952684707921@lid", connectedPhone: "15614724610", waitingMessage: false, isEdit: false,
  isGroup: false, isNewsletter: false, instanceId: "3F3C3CD945DCB216168FFADA20428719", messageId: "3EB072AE7E6C405C6FFB44",
  phone: "17864439815", fromMe: false, momment: 1789767316000, status: "RECEIVED", chatName: "Mk Music And Events",
  senderName: "Mk Music And Events", type: "ReceivedCallback", fromApi: false, text: { message: "17474 sw 272 st" },
};
const ALEJANDRO_EDIT = {
  isStatusReply: false, chatLid: "111952684707921@lid", connectedPhone: "15614724610", waitingMessage: false, isEdit: true,
  isGroup: false, isNewsletter: false, instanceId: "3F3C3CD945DCB216168FFADA20428719", messageId: "3EB072AE7E6C405C6FFB44",
  editMessageId: "3EB0654D4C00E0946123", phone: "111952684707921@lid", fromMe: false, momment: 1789767326000,
  status: "RECEIVED", chatName: "", senderName: "Mk Music And Events", type: "ReceivedCallback", fromApi: false,
  text: { message: "17474 sw 272 st\nHomestead, fl 33031" },
};

async function main() {
  console.log("[1] política pura");
  const A = "17474 sw 272 st", AE = "17474 sw 272 st\nHomestead, fl 33031";
  ck("Alejandro: edição antes da nossa resposta → answer", waEditAction(A, AE, false) === "answer");
  ck("Alejandro: edição DEPOIS do nosso \"qual o zip?\" → answer (ZIP novo)", waEditAction(A, AE, true) === "answer");
  ck("Francis: \"usually the APR?\" → \"percentage usually the APR?\" depois da resposta → update-original",
    waEditAction("What is usually the APR?", "What is percentage usually the APR?", true) === "update-original");
  ck("Francis: mesma edição antes da resposta → answer", waEditAction("What is usually the APR?", "What is percentage usually the APR?", false) === "answer");
  ck("Elisabet: \"Thank yoi\" → \"Thank you\" depois da resposta → update-original", waEditAction("Wonderful Thank yoi", "Wonderful Thank you", true) === "update-original");
  ck("texto igual (caixa/espaço) → ignore", waEditAction("3 pm", "3  PM", true) === "ignore" && waEditAction("3 pm", "3 pm", false) === "ignore");
  ck("edição vazia → ignore", waEditAction("3 pm", "   ", false) === "ignore");
  ck("hora trocada 3pm → 4pm → info", editAddsInfo("3pm works", "4pm works"));
  ck("dia trocado Monday → Sunday → info (sem tolerância de typo p/ dia)", editAddsInfo("Monday is good", "Sunday is good"));
  ck("dia em ES/PT sem acento (sábado) → info", editAddsInfo("el lunes", "el sábado") && editAddsInfo("pode ser segunda", "pode ser sábado"));
  ck("negação \"can\" → \"can't\" → info", editAddsInfo("I can do Sunday", "I can't do Sunday") && editAddsInfo("I want it", "I do not want it"));
  ck("e-mail acrescentado → info", editAddsInfo("ok", "ok my email is joe@gmail.com"));
  ck("telefone acrescentado → info", editAddsInfo("call me", "call me 305 555 0142"));
  ck("tipo de piso trocado (tile → vinyl) → info", editAddsInfo("I want tile", "I want vinyl"));
  ck("3+ palavras novas → info", editAddsInfo("I want a quote", "I want a quote for the kitchen and hallway too"));
  ck("typo simples não é info (houze → house)", !editAddsInfo("for my houze", "for my house"));
  ck("1 palavra a mais sem peso não é info", !editAddsInfo("What is usually the APR?", "What is percentage usually the APR?"));
  ck("pontuação só não é info", !editAddsInfo("3 pm", "3 pm!!") && !editAddsInfo("ok", "ok."));
  ck("ZIP diferente (typo de dígito) → info (número nunca tem tolerância)", editAddsInfo("33031", "33013"));

  console.log("\n[2] payloads reais da caixa-preta");
  ck("original não é edição", !isWaEditCallback(ALEJANDRO_ORIGINAL));
  ck("edição detectada (isEdit:true)", isWaEditCallback(ALEJANDRO_EDIT));
  ck("edição traz o MESMO messageId da original (por isso a dedupe comia)", ALEJANDRO_EDIT.messageId === ALEJANDRO_ORIGINAL.messageId);
  ck("id gravado da edição = editMessageId", waEditStoreId(ALEJANDRO_EDIT) === "3EB0654D4C00E0946123");
  ck("sem editMessageId → id derivado estável, diferente do original",
    waEditStoreId({ ...ALEJANDRO_EDIT, editMessageId: undefined }) === "3EB072AE7E6C405C6FFB44_edit_1789767326000");
  ck("phone da edição é LID, não número", !isRealWaPhone(ALEJANDRO_EDIT.phone) && isRealWaPhone(ALEJANDRO_ORIGINAL.phone));
  ck("número vem da conversa gravada (wa_17864439815)", phoneFromWaIgsid("wa_17864439815") === "17864439815");
  ck("igsid não-WA ou LID → null", phoneFromWaIgsid("fb_28467730842862629") === null && phoneFromWaIgsid("wa_111952684707921@lid") === null && phoneFromWaIgsid(undefined) === null);

  console.log("\n[3] fiação no webhook do WhatsApp");
  const wa = src("src/app/api/wa-webhook/route.ts");
  const iEdit = wa.indexOf("if (isWaEditCallback(body))");
  const iDedupe = wa.indexOf("// Deduplicate");
  const iFromMe = wa.indexOf("if (body.fromMe === true)");
  ck("importa a política", /from "@\/lib\/wa-edit-policy"/.test(wa));
  ck("ramo da edição depois do fromMe e ANTES da dedupe", iFromMe > 0 && iEdit > iFromMe && iDedupe > iEdit, `${iFromMe}/${iEdit}/${iDedupe}`);
  const branch = wa.slice(iEdit, iDedupe);
  ck("acha a bolha original pelo messageId (role user)", /\.eq\("instagram_msg_id", messageId\)\s*\.eq\("role", "user"\)/.test(branch));
  ck("número vem da conversa da original", /phoneFromWaIgsid\(origConv\?\.igsid\)/.test(branch) && /phone = origPhone;/.test(branch));
  ck("\"respondido desde a original\" compara datas, não strings", /Date\.parse\(lastAsst\.created_at\) > Date\.parse\(orig\.created_at\)/.test(branch));
  ck("update-original só corrige a bolha gravada e sai", /action === "update-original"[\s\S]{0,200}\.update\(\{ content: editedText \}\)\.eq\("id", orig\.id\)[\s\S]{0,40}return;/.test(branch));
  ck("sem original e sem número (LID) → descarta com log", /!isRealWaPhone\(phone\)[\s\S]{0,300}return;/.test(branch));
  ck("edição gravada com id próprio (editMessageId)", /storeMsgId = waEditStoreId\(body\);/.test(branch));
  ck("dedupe e insert usam storeMsgId (id da edição)", /\.eq\("instagram_msg_id", storeMsgId\)\s*\.maybeSingle\(\);\s*if \(already\) return;/.test(wa) && /instagram_msg_id: storeMsgId,/.test(wa.slice(iDedupe)));
  ck("enriquecimento atualiza a bolha gravada (storeMsgId)", /update\(\{ content: enrichedText \}\)\.eq\("instagram_msg_id", storeMsgId\)/.test(wa));
  ck("👍 aponta para a bolha real: messageId é const e nunca vira o id da edição", /const messageId = body\.messageId as string;/.test(wa) && !/\n\s*messageId = /.test(wa) && (wa.match(/sendWhatsAppReaction\(phone, messageId, "👍"\)/g) ?? []).length >= 4);
  ck("guarda pré-envio de contexto velho continua (descarta resposta montada no texto antigo)", /Newer client message arrived during generation — discarding stale reply/.test(wa));
  ck("janela de graça do re-pedido de dados continua", /Booking-info follow-up arrived during grace window/.test(wa));
  for (const rel of ["src/app/api/webhook/route.ts", "src/app/api/fb-webhook/route.ts"]) {
    ck(`${rel.split("/")[3]}: Meta não manda edição (nada a fazer lá; ramo só no WA)`, !/isWaEditCallback/.test(src(rel)));
  }

  if (process.env.DET_ONLY === "1") { console.log("\n[4] AO VIVO pulado (DET_ONLY=1)"); return done(); }

  console.log("\n[4] AO VIVO: com a edição como bolha nova, o modelo marca a visita");
  const phone = "17864439815";
  const sysNote = () => `\n\n[SYSTEM: ${getEasternDateContext()}\n\nREAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):\n• ${SLOT_DAY} [${SLOT_DATE}]: 09:00, 15:00\n\n[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (${phone}). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "${phone}" as the phone, with the name only if the client stated it and "name":"" otherwise.]]`;
  const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
  const head: ChatMessage[] = [
    { role: "user", content: "Hello" },
    { role: "user", content: "How much is the floor installation for 4’ x 4’ tiles" },
    { role: "assistant", content: "Tile installation is $4.50 per square foot for the labor, and you supply the tile material. What's the approximate square footage of the area?" },
    { role: "user", content: "3200" },
    { role: "assistant", content: `For 3,200 sqft I need to come measure in person to give you the best price. The visit is free and I bring everything needed to go over the details with you on the spot. I have ${SLOT_DAY} at 9am or 3pm, which works better?` },
    { role: "user", content: "3 pm" },
    { role: "assistant", content: "Perfect, I'm holding that 3pm for you! Can I get the full property address with the zip code?" },
  ];
  const parseBook = (t: string) => {
    const tag = /\[BOOK:(\{[\s\S]*?\})\]/.exec(t)?.[1];
    try { return tag ? JSON.parse(tag) as { name?: string; address?: string; date?: string; time?: string; phone?: string } : null; } catch { return null; }
  };
  // 4a: rajada original com a edição gravada como bolha nova (entre o endereço e o nome).
  for (let i = 1; i <= 2; i++) {
    const t = await ai([...head, { role: "user", content: A }, { role: "user", content: AE }, { role: "user", content: `Alejandro Trigoso${sysNote()}` }]);
    console.log(`   4a#${i} →`, t.replace(/\s+/g, " ").slice(0, 320));
    const b = parseBook(t);
    ck(`4a#${i}: [BOOK] sai na hora`, !!b, t);
    ck(`4a#${i}: endereço com Homestead 33031, ${SLOT_DATE} 15:00`, !!b && /33031/.test(b.address ?? "") && /homestead/i.test(b.address ?? "") && b.date === SLOT_DATE && b.time === "15:00", JSON.stringify(b));
    ck(`4a#${i}: não pede o ZIP de novo`, !/zip/i.test(t.replace(/\[BOOK:[\s\S]*?\]/g, "")), t);
  }
  // 4b: forma do resgate: já tínhamos perguntado o ZIP, a edição chega depois.
  for (let i = 1; i <= 2; i++) {
    const t = await ai([...head, { role: "user", content: A }, { role: "user", content: "Alejandro Trigoso" },
      { role: "assistant", content: "Almost set! What's the zip code for that address?" },
      { role: "user", content: `${AE}${sysNote()}` }]);
    console.log(`   4b#${i} →`, t.replace(/\s+/g, " ").slice(0, 320));
    const b = parseBook(t);
    ck(`4b#${i}: [BOOK] com o 33031, ${SLOT_DATE} 15:00`, !!b && /33031/.test(b.address ?? "") && b.date === SLOT_DATE && b.time === "15:00", JSON.stringify(b) + " | " + t);
  }
  done();
}
// Um dia fixo no futuro próximo com vaga fictícia (a parte 4 não toca a agenda real).
const nextDay = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); return d; })();
const SLOT_DATE = nextDay.toISOString().slice(0, 10);
const SLOT_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][nextDay.getUTCDay()];

function done() {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) console.log("FAILS:\n - " + fails.join("\n - "));
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
