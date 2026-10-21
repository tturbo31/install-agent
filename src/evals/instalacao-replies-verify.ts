// Etapa de INSTALAÇÃO (regra do dono 2026-08-25, caso Sarah McKnight):
//   • o aviso de véspera saiu "confirmed for Wednesday, August 26 at 5am" para
//     uma instalação às 10am — o texto vem pronto do app Lovable. Horário fora
//     de 7h–19h é REMOVIDO da mensagem (vai só a data) e o dono é avisado;
//     `data_instalacao_iso` (ISO com fuso) é formatado por nós na Flórida.
//   • depois do aviso, o bot NÃO conversa: agradecimento/ack → só 👍;
//     qualquer outra coisa → uma frase "vou repassar ao Ozzi" + aviso ao dono.
//     Determinístico no wa-webhook (sem modelo); o prompt segue a mesma regra
//     como rede de segurança.
// Run: npx tsx src/evals/instalacao-replies-verify.ts
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, scrubForeignPhones, installConfirmationPhones, hasInstallationConfirmation, type ChatMessage } from "../lib/ai";
import {
  sanitizeInstallDate,
  stripInstallTime,
  formatInstallDateTime,
  INSTALL_CONFIRMATION_RE,
  isInstallAck,
  installHandoffMessage,
  findRecentInstallationConfirmation,
  isDuplicateInstallNotice,
} from "../lib/instalacao";
import { encodeInstalacaoLogKey, decodeInstalacaoLogKey, instalacaoLogSlot, type InstalacaoLogRecord } from "../lib/instalacao-log";

function loadEnv() {
  const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

let pass = 0, fail = 0;
const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${detail.replace(/\s+/g, " ").slice(0, 200)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then(r => r.text);

// Exatamente o que composeConfirmation() em /api/confirmar-instalacao produz.
const CONFIRMATION =
  "Hi Sarah McKnight! This is Ozzi Floors 😊\n\n" +
  "Just a quick reminder — your flooring installation starts tomorrow, Wednesday, August 26. Our installation team will arrive between 10am and 11am with the materials.\n\n" +
  "Our installation team will be taking care of the job. If you have any questions, you can reach out directly to Alexandre, the sales rep who put together your estimate, at (561) 609-9025.\n\n" +
  "See you soon! 🏠";

const SELLER_PHONE = /561[)\s.-]*609[\s.-]*9025/;
const OWNER_PHONE = /561[)\s.-]*674[\s.-]*8334/;
const TYPE_ASK = /tile,? vinyl,? (or |o )?hardwood\?/i;
const OZZI_HANDOFF = /ozzi/i;
const ANY_TIME = /\b\d{1,2}\s?(am|pm|:\d{2})\b/i;

async function main() {
  // ── 1. UNIT: guarda de horário implausível ────────────────────────────────
  console.log("\n[1] sanitizeInstallDate: horário fora de 7h–19h sai da mensagem");
  const s1 = sanitizeInstallDate("Wednesday, August 26 at 5am");
  ck("'at 5am' é removido", s1.text === "Wednesday, August 26", s1.text);
  ck("marca o horário suspeito", s1.horarioSuspeito === "5am", String(s1.horarioSuspeito));
  const s2 = sanitizeInstallDate("Tuesday, August 25 at 9am");
  ck("'at 9am' fica intacto", s2.text === "Tuesday, August 25 at 9am" && s2.horarioSuspeito === null, s2.text);
  const s3 = sanitizeInstallDate("Friday, August 28 at 10:30am");
  ck("'at 10:30am' fica intacto", s3.text === "Friday, August 28 at 10:30am" && s3.horarioSuspeito === null, s3.text);
  const s4 = sanitizeInstallDate("Friday, August 28 at 8pm");
  ck("'at 8pm' é removido", s4.text === "Friday, August 28" && s4.horarioSuspeito === "8pm", s4.text);
  const s5 = sanitizeInstallDate("Monday, Aug 17");
  ck("sem horário → intacto", s5.text === "Monday, Aug 17" && s5.horarioSuspeito === null, s5.text);
  const s6 = sanitizeInstallDate("Thursday, August 27 at 5 a.m.");
  ck("'at 5 a.m.' é removido", s6.text === "Thursday, August 27" && !!s6.horarioSuspeito, s6.text);
  const s7 = sanitizeInstallDate("Thursday, August 27 at 17:00");
  ck("'at 17:00' (5pm) fica intacto", s7.text === "Thursday, August 27 at 17:00" && s7.horarioSuspeito === null, s7.text);
  const s8 = sanitizeInstallDate("Thursday, August 27 at 7am");
  ck("'at 7am' (limite inferior) fica", s8.horarioSuspeito === null, s8.text);
  const s9 = sanitizeInstallDate("Thursday, August 27 at 12pm");
  ck("'at 12pm' (meio-dia) fica", s9.horarioSuspeito === null, s9.text);
  const s10 = sanitizeInstallDate("Thursday, August 27 at 12am");
  ck("'at 12am' (meia-noite) sai", s10.horarioSuspeito === "12am", s10.text);

  console.log("\n[1b] formatInstallDateTime: ISO com fuso → texto na Flórida");
  ck("14:00Z em agosto (EDT) = 10am", formatInstallDateTime("2026-08-26T14:00:00.000Z") === "Wednesday, August 26 at 10am", String(formatInstallDateTime("2026-08-26T14:00:00.000Z")));
  ck("offset explícito -04:00 é respeitado", formatInstallDateTime("2026-08-26T10:00:00-04:00") === "Wednesday, August 26 at 10am", String(formatInstallDateTime("2026-08-26T10:00:00-04:00")));
  ck("minutos aparecem quando não são :00", formatInstallDateTime("2026-08-26T13:30:00.000Z") === "Wednesday, August 26 at 9:30am", String(formatInstallDateTime("2026-08-26T13:30:00.000Z")));
  ck("ISO inválido → null (cai no texto livre)", formatInstallDateTime("amanhã cedo") === null);
  ck("vazio → null", formatInstallDateTime("") === null);

  // ── 1c. UNIT: trava de duplicidade do aviso (21/10/2026) ─────────────────
  console.log("\n[1c] isDuplicateInstallNotice: 2ª chamada para o mesmo telefone em <20h não reenvia");
  const agora = new Date("2026-10-21T13:00:10Z");
  const avisoHa = (h: number, content = CONFIRMATION, role = "assistant") => ({ role, content, created_at: new Date(agora.getTime() - h * 3600_000).toISOString() });
  ck("aviso há 1h → duplicado", isDuplicateInstallNotice([avisoHa(1)], agora) === true);
  ck("aviso há 19h → duplicado", isDuplicateInstallNotice([avisoHa(19)], agora) === true);
  ck("aviso há 24h (rodada de ontem) → NÃO é duplicado", isDuplicateInstallNotice([avisoHa(24)], agora) === false);
  ck("aviso há 13 dias (job remarcado) → não é duplicado", isDuplicateInstallNotice([avisoHa(13 * 24)], agora) === false);
  ck("sem aviso no histórico → não é duplicado", isDuplicateInstallNotice([avisoHa(1, "Hi! How can I help you today?")], agora) === false);
  ck("cliente citando o aviso não conta (role user)", isDuplicateInstallNotice([avisoHa(1, CONFIRMATION, "user")], agora) === false);
  ck("versão antiga 'is confirmed for' também conta", isDuplicateInstallNotice([avisoHa(2, "Hi! your flooring installation is confirmed for Monday, August 17.")], agora) === true);
  ck("aviso há 1h seguido de conversa normal continua duplicado", isDuplicateInstallNotice([avisoHa(1), avisoHa(0.5, "For anything about your installation, the best is to reach Ozzi directly at (561) 674-8334.")], agora) === true);
  ck("linha sem created_at não prova duplicidade", isDuplicateInstallNotice([{ role: "assistant", content: CONFIRMATION }], agora) === false);
  ck("histórico vazio → não é duplicado", isDuplicateInstallNotice([], agora) === false);

  console.log("\n[1d] registro da chamada: chave ↔ JSON ida e volta, cabe no índice");
  const rec: InstalacaoLogRecord = { t: agora.toISOString(), st: "400", tel: null, nome: "Sarah McKnight", data: null, rec: "Wednesday, August 26 at 5am", vend: "Alexandre", tv: "(561) 609-9025", hs: null, iso: false, err: "campos obrigatorios ausentes ou invalidos: telefone_cliente (telefone_cliente=null)" };
  const key = encodeInstalacaoLogKey(rec, agora.getTime(), "ab12");
  const back = decodeInstalacaoLogKey(key);
  ck("chave começa com instalacao_log_<epoch13>_<rand>::", /^instalacao_log_\d{13}_ab12::/.test(key), key.slice(0, 40));
  ck("decodifica igual ao original", JSON.stringify(back?.rec) === JSON.stringify(rec), JSON.stringify(back));
  ck("epoch volta inteiro", back?.epoch === agora.getTime(), String(back?.epoch));
  ck("chave curta (<1500)", key.length < 1500, String(key.length));
  const longo = encodeInstalacaoLogKey({ ...rec, err: "x".repeat(5000), nome: "y".repeat(500), rec: "z".repeat(900) }, agora.getTime(), "ab12");
  const backLongo = decodeInstalacaoLogKey(longo);
  ck("campos longos são cortados e a chave fica <1500", longo.length < 1500, String(longo.length));
  ck("chave cortada ainda decodifica", backLongo?.rec.st === "400" && (backLongo?.rec.nome?.length ?? 0) === 60, JSON.stringify(backLongo?.rec).slice(0, 120));
  ck("ordem lexicográfica = ordem no tempo", encodeInstalacaoLogKey(rec, agora.getTime() + 1, "aaaa") > key);
  ck("chave de outro prefixo → null", decodeInstalacaoLogKey("funil_raw_wa_1792587393605_ab12_1of1::abc") === null);
  ck("chave corrompida → null", decodeInstalacaoLogKey("instalacao_log_1792587393605_ab12::%E0%A4%A") === null);

  console.log("\n[1e] 401 em janela de 1h: duas chamadas na mesma hora → UMA chave (anti-inundação)");
  const rec401: InstalacaoLogRecord = { t: "", st: "401", tel: null, nome: null, data: null, rec: null, vend: null, tv: null, hs: null, iso: false, err: "token ausente ou incorreto" };
  const j1 = instalacaoLogSlot(agora.getTime(), 3600_000);
  const j2 = instalacaoLogSlot(agora.getTime() + 5 * 60_000 + 731, 3600_000); // 5 min e 731 ms depois, mesma hora
  const k1 = encodeInstalacaoLogKey({ ...rec401, t: j1.t }, j1.epoch, j1.rand);
  const k2 = encodeInstalacaoLogKey({ ...rec401, t: j2.t }, j2.epoch, j2.rand);
  ck("mesma hora → mesma chave", k1 === k2, `${k1.slice(0, 60)} ≠ ${k2.slice(0, 60)}`);
  ck("epoch é o início da hora (13:00:00Z)", j1.t === "2026-10-21T13:00:00.000Z" && j1.epoch % 3600_000 === 0, j1.t);
  const j3 = instalacaoLogSlot(agora.getTime() + 3600_000, 3600_000);
  ck("hora seguinte → chave diferente", encodeInstalacaoLogKey({ ...rec401, t: j3.t }, j3.epoch, j3.rand) !== k1);
  const n1 = instalacaoLogSlot(agora.getTime()), n2 = instalacaoLogSlot(agora.getTime());
  ck("sem janela: carimbo exato e rand aleatório (chaves distintas)", n1.t === agora.toISOString() && n1.epoch === agora.getTime() && n1.rand !== n2.rand, `${n1.rand} ${n2.rand}`);

  // ── 2. UNIT: ack × dúvida ─────────────────────────────────────────────────
  console.log("\n[2] isInstallAck: agradecimento/ack → 👍; dúvida → handoff");
  for (const t of ["Thank you!", "That sounds better! Ha! See you tomorrow", "👍", "Ok", "Perfect, thanks", "See you then", "Sounds good!", "Gracias!", "Obrigada", "Yes", "Got it, thank you", "🙏",
    // Casos reais de 45 dias (verificação de 19/10/2026): acks que viravam handoff
    "Ok,,,i be there", "Buenos días ahí los esperamos, por mi parte todo bien 👍", "Hi thank you, we will be here..!!!!!!",
    "Perfect we are ready", "Perfeito obrigado", "Ok thanks", "Perfecto gracias", "Good morning, we'll be waiting for you", "Ok. Thank you", "Perfect, thank you see you tomorrow"]) {
    ck(`ack: ${JSON.stringify(t)}`, isInstallAck(t) === true);
  }
  for (const t of ["5am???", "What time will you arrive?", "Can we move it to Friday?", "Do I need to move my furniture?", "How long does it take?", "Thanks, but is 5am right?", "5am? That's too early", "I need to cancel", "A qué hora llegan?", "Que horas voces chegam?", "Please call me",
    // Casos reais de 45 dias: dúvidas/pedidos que têm que ir ao Ozzi
    "Me mandas al mismo muchacho?", "i need to cancel till next friday", "Is Leon coming again? I'll give him the check", "Gm. I'm paying with a card not cash",
    "Can you please send the link as promised", "Good morning! Yes I do have questions I will reach to Alex", "Hello", "Hi"]) {
    ck(`dúvida: ${JSON.stringify(t)}`, isInstallAck(t) === false);
  }

  console.log("\n[2b] installHandoffMessage: uma frase, Ozzi, sem telefone, sem horário");
  for (const lang of ["en", "es", "pt"] as const) {
    const m = installHandoffMessage(lang);
    ck(`${lang}: menciona Ozzi`, /ozzi/i.test(m), m);
    // Regra do dono 14/09/2026 (aplicada aqui em 27/09): nunca prometer retorno, dar o número do Ozzi.
    ck(`${lang}: dá o número do Ozzi e não promete retorno`, /674[\s.-]?8334/.test(m) && !/get in touch|se comunicar|entrar[áa] em contato|shortly|en breve/i.test(m), m);
    ck(`${lang}: uma frase só`, (m.match(/[.!?]/g) ?? []).length === 1, m);
  }

  console.log("\n[2c] findRecentInstallationConfirmation: só confirmação NOSSA e recente");
  const now = new Date("2026-08-25T13:05:00Z");
  const recent = [{ role: "assistant", content: CONFIRMATION, created_at: "2026-08-25T13:00:12Z" }, { role: "user", content: "5am???", created_at: "2026-08-25T13:02:52Z" }];
  ck("confirmação de hoje conta", !!findRecentInstallationConfirmation(recent, now));
  const old = [{ role: "assistant", content: CONFIRMATION, created_at: "2026-07-20T13:00:12Z" }, { role: "user", content: "hi, I need another floor", created_at: "2026-08-25T13:02:52Z" }];
  ck("confirmação de 36 dias atrás NÃO conta (cliente volta ao fluxo normal)", findRecentInstallationConfirmation(old, now) === null);
  ck("confirmação vinda do CLIENTE não conta", findRecentInstallationConfirmation([{ role: "user", content: "your flooring installation is confirmed for Tuesday", created_at: "2026-08-25T13:00:00Z" }], now) === null);
  ck("sem created_at (histórico antigo) conta como recente", !!findRecentInstallationConfirmation([{ role: "assistant", content: CONFIRMATION }], now));

  // ── 3. STATIC: endpoint, webhook e prompt carregam a regra ───────────────
  console.log("\n[3] Static: endpoint + webhook + prompt");
  const rotaSrc = readFileSync(join(process.cwd(), "src/app/api/confirmar-instalacao/route.ts"), "utf-8");
  ck("endpoint passa o texto pela guarda de horário", /sanitizeInstallDate\(/.test(rotaSrc));
  ck("endpoint aceita data_instalacao_iso", /data_instalacao_iso/.test(rotaSrc) && /formatInstallDateTime\(/.test(rotaSrc));
  ck("guarda de horário vale TAMBÉM para o caminho ISO (placeholder 09:00Z do all_day)", /sanitizeInstallDate\(viaIso \?\? dataInstalacao!\)/.test(rotaSrc));
  const placeholder = sanitizeInstallDate(formatInstallDateTime("2026-08-26T09:00:00Z") ?? "");
  ck("09:00Z (all_day do Lovable) formatado vira 5am e é cortado", placeholder.text === "Wednesday, August 26" && placeholder.horarioSuspeito === "5am", JSON.stringify(placeholder));
  ck("endpoint avisa o dono quando remove o horário", /notifyOwners\(/.test(rotaSrc) && /installTimeAlert\(/.test(rotaSrc));
  ck("template nomeia a equipe de instalação como executora", /Our installation team will arrive/.test(rotaSrc));

  // ── 3b. Regra do dono 27/08: SEM horário do job; "starts tomorrow" + chegada 10–11am
  console.log("\n[3b] Aviso de véspera sem horário do job (regra 27/08/2026)");
  ck("endpoint tira o horário do texto final", /stripInstallTime\(guarda\.text\)/.test(rotaSrc));
  ck("template diz 'starts tomorrow'", /installation starts tomorrow, \$\{dataInstalacao\}/.test(rotaSrc));
  ck("template usa a janela de chegada 10am–11am com materiais", /INSTALL_ARRIVAL_WINDOW\} with the materials/.test(rotaSrc));
  ck("template NÃO tem mais 'confirmed for'", !/is confirmed for \$\{/.test(rotaSrc));
  ck("'at 10am' (plausível) também sai", stripInstallTime("Wednesday, August 26 at 10am") === "Wednesday, August 26");
  ck("'at 10:30am' sai", stripInstallTime("Friday, August 28 at 10:30am") === "Friday, August 28");
  ck("'at 5am' sai", stripInstallTime("Wednesday, August 26 at 5am") === "Wednesday, August 26");
  ck("ISO 14:00Z → só a data", stripInstallTime(formatInstallDateTime("2026-08-26T14:00:00.000Z") ?? "") === "Wednesday, August 26");
  ck("sem horário → intacto", stripInstallTime("Monday, Aug 17") === "Monday, Aug 17");
  ck("regex reconhece o aviso NOVO", INSTALL_CONFIRMATION_RE.test(CONFIRMATION));
  ck("regex ainda reconhece o aviso ANTIGO (histórico)", INSTALL_CONFIRMATION_RE.test("Great news — your flooring installation is confirmed for Wednesday, August 26 at 10am."));
  ck("aviso novo NÃO contém horário do job", !/\bat \d{1,2}(?::\d{2})?\s*[ap]m/i.test(CONFIRMATION.split("\n")[0]) && /starts tomorrow/.test(CONFIRMATION));
  const waSrc = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  ck("webhook: branch determinística da etapa de instalação", /findRecentInstallationConfirmation\(instRows\)/.test(waSrc));
  ck("webhook: ack → reação 👍", /isInstallAck\(instBurst\)[\s\S]{0,200}sendWhatsAppReaction\(phone, messageId, "👍"\)/.test(waSrc));
  ck("webhook: dúvida → installHandoffMessage + notifyOwners", /installHandoffMessage\(detectLang\(instBurst\)\)/.test(waSrc) && /INSTALL_STAGE_ALERT/.test(waSrc));
  ck("webhook: branch vem ANTES do cérebro de follow-up de orçamento", waSrc.indexOf("findRecentInstallationConfirmation(instRows)") < waSrc.indexOf("// ── Cliente de FOLLOW-UP DE ORÇAMENTO respondeu"));
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("prompt: seção presente", /## INSTALLATION CONFIRMED/.test(promptSrc));
  ck("prompt: ack → [REACT_ONLY]", /output EXACTLY \[REACT_ONLY\] and nothing else\. The system reacts with a thumbs up/.test(promptSrc));
  ck("prompt: dúvida → número do Ozzi + [NOTIFY_OWNER] (regra 14/09)", /reach Ozzi directly at \(561\) 674-8334 for that, and add \[NOTIFY_OWNER\]/.test(promptSrc));
  ck("prompt: proíbe repetir/corrigir o horário", /NEVER repeat, confirm, correct, or recalculate the installation date or time/.test(promptSrc));
  ck("prompt: proíbe a piada ('that does sound early')", /that does sound early!" is forbidden/.test(promptSrc));
  ck("prompt: não manda mais o cliente ao vendedor nomeado", !/HAND TO THE NAMED CONTACT/.test(promptSrc));
  for (const [name, file] of [["wa-webhook", "src/app/api/wa-webhook/route.ts"], ["fb-webhook", "src/app/api/fb-webhook/route.ts"], ["ig webhook", "src/app/api/webhook/route.ts"]] as const) {
    const src = readFileSync(join(process.cwd(), file), "utf-8");
    ck(`${name}: guarda visita-afirmada condicionada a !hasInstallationConfirmation`, /!hasInstallationConfirmation\(staleRows\) && assertsExistingAppointment\(/.test(src));
  }

  // ── 3b. UNIT: scrubber de telefone continua íntegro ───────────────────────
  console.log("\n[3b] scrubForeignPhones × confirmação");
  const history: ChatMessage[] = [{ role: "assistant", content: CONFIRMATION }];
  ck("hasInstallationConfirmation detecta a confirmação", hasInstallationConfirmation(history) === true);
  const allowed = installConfirmationPhones(history);
  ck("extrai o número do vendedor da confirmação", allowed.includes("5616099025"), JSON.stringify(allowed));
  ck("número do cliente segue sendo limpo", !/3057668885/.test(scrubForeignPhones("I'll have Ozzi reach out to you at 3057668885 shortly!", allowed)));

  // ── 4. LIVE (rede de segurança do prompt, caso o branch não pegue) ───────
  console.log("\n[4] LIVE: 'Thank you!' → [REACT_ONLY]");
  const r1 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Thank you!" },
  ]);
  console.log("   AI:", r1.replace(/\s+/g, " ").slice(0, 220));
  ck("só [REACT_ONLY]", /^\s*\[REACT_ONLY\]\s*$/i.test(r1), r1);

  console.log("\n[5] LIVE: '5am???' → repassa ao Ozzi, sem horário, sem piada, [NOTIFY_OWNER]");
  const r2 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "5am???" },
  ]);
  console.log("   AI:", r2.replace(/\s+/g, " ").slice(0, 220));
  ck("menciona Ozzi", OZZI_HANDOFF.test(r2), r2);
  ck("adiciona [NOTIFY_OWNER]", /\[NOTIFY_OWNER\]/.test(r2), r2);
  ck("não repete nem corrige horário", !ANY_TIME.test(r2.replace(/\[NOTIFY_OWNER\]/g, "")), r2);
  ck("sem piada sobre 'early'", !/early/i.test(r2), r2);
  ck("sem telefone do vendedor (o do Ozzi é permitido desde 14/09)", !SELLER_PHONE.test(r2) && OWNER_PHONE.test(r2) !== undefined, r2);
  ck("não fica em silêncio", !/\[REACT_ONLY\]/.test(r2), r2);

  console.log("\n[6] LIVE: 'can we move it to Friday?' → repassa ao Ozzi, sem prometer, sem vendedor");
  const r3 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Hey, something came up, can we move the installation to Friday?" },
  ]);
  console.log("   AI:", r3.replace(/\s+/g, " ").slice(0, 220));
  ck("menciona Ozzi + [NOTIFY_OWNER]", OZZI_HANDOFF.test(r3) && /\[NOTIFY_OWNER\]/.test(r3), r3);
  ck("não promete que moveu", !/(moved|rescheduled) (it|your|the)|all set|done!|i('ve| have) (moved|rescheduled)/i.test(r3), r3);
  ck("sem telefone do vendedor (o do Ozzi é permitido desde 14/09)", !SELLER_PHONE.test(r3), r3);
  ck("não reinicia a venda", !TYPE_ASK.test(r3) && !/\$\s?\d/.test(r3), r3);

  console.log("\n[7] LIVE: 'do I need to move my furniture?' → NÃO responde, repassa ao Ozzi");
  const r4 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Do I need to move my furniture before you come?" },
  ]);
  console.log("   AI:", r4.replace(/\s+/g, " ").slice(0, 220));
  ck("menciona Ozzi + [NOTIFY_OWNER]", OZZI_HANDOFF.test(r4) && /\[NOTIFY_OWNER\]/.test(r4), r4);
  ck("não responde a dúvida sozinho", !/we ('ll |will )?(move|take care of|handle)/i.test(r4), r4);

  console.log(`\n${"─".repeat(50)}\n${pass} passed, ${fail} failed${fail ? `: ${fails.join(", ")}` : ""}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
