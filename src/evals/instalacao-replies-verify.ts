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
  formatInstallDateTime,
  isInstallAck,
  installHandoffMessage,
  findRecentInstallationConfirmation,
} from "../lib/instalacao";

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
  "Great news — your flooring installation is confirmed for Wednesday, August 26 at 5am.\n\n" +
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

  // ── 2. UNIT: ack × dúvida ─────────────────────────────────────────────────
  console.log("\n[2] isInstallAck: agradecimento/ack → 👍; dúvida → handoff");
  for (const t of ["Thank you!", "That sounds better! Ha! See you tomorrow", "👍", "Ok", "Perfect, thanks", "See you then", "Sounds good!", "Gracias!", "Obrigada", "Yes", "Got it, thank you", "🙏"]) {
    ck(`ack: ${JSON.stringify(t)}`, isInstallAck(t) === true);
  }
  for (const t of ["5am???", "What time will you arrive?", "Can we move it to Friday?", "Do I need to move my furniture?", "How long does it take?", "Thanks, but is 5am right?", "5am? That's too early", "I need to cancel", "A qué hora llegan?", "Que horas voces chegam?", "Please call me"]) {
    ck(`dúvida: ${JSON.stringify(t)}`, isInstallAck(t) === false);
  }

  console.log("\n[2b] installHandoffMessage: uma frase, Ozzi, sem telefone, sem horário");
  for (const lang of ["en", "es", "pt"] as const) {
    const m = installHandoffMessage(lang);
    ck(`${lang}: menciona Ozzi`, /ozzi/i.test(m), m);
    ck(`${lang}: sem número de telefone`, !/\d{3}[\s.-]?\d{4}/.test(m), m);
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
  ck("endpoint avisa o dono quando remove o horário", /notifyOwners\(/.test(rotaSrc) && /installTimeAlert\(/.test(rotaSrc));
  ck("template nomeia a equipe de instalação como executora", /Our installation team will be taking care of the job/.test(rotaSrc));
  const waSrc = readFileSync(join(process.cwd(), "src/app/api/wa-webhook/route.ts"), "utf-8");
  ck("webhook: branch determinística da etapa de instalação", /findRecentInstallationConfirmation\(instRows\)/.test(waSrc));
  ck("webhook: ack → reação 👍", /isInstallAck\(instBurst\)[\s\S]{0,200}sendWhatsAppReaction\(phone, messageId, "👍"\)/.test(waSrc));
  ck("webhook: dúvida → installHandoffMessage + notifyOwners", /installHandoffMessage\(detectLang\(instBurst\)\)/.test(waSrc) && /INSTALL_STAGE_ALERT/.test(waSrc));
  ck("webhook: branch vem ANTES do cérebro de follow-up de orçamento", waSrc.indexOf("findRecentInstallationConfirmation(instRows)") < waSrc.indexOf("// ── Cliente de FOLLOW-UP DE ORÇAMENTO respondeu"));
  const promptSrc = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
  ck("prompt: seção presente", /## INSTALLATION CONFIRMED/.test(promptSrc));
  ck("prompt: ack → [REACT_ONLY]", /output EXACTLY \[REACT_ONLY\] and nothing else\. The system reacts with a thumbs up/.test(promptSrc));
  ck("prompt: dúvida → repassa ao Ozzi + [NOTIFY_OWNER]", /pass it along to Ozzi, who will get in touch with them shortly, and add \[NOTIFY_OWNER\]/.test(promptSrc));
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
  ck("sem telefone do vendedor nem do dono", !SELLER_PHONE.test(r2) && !OWNER_PHONE.test(r2), r2);
  ck("não fica em silêncio", !/\[REACT_ONLY\]/.test(r2), r2);

  console.log("\n[6] LIVE: 'can we move it to Friday?' → repassa ao Ozzi, sem prometer, sem vendedor");
  const r3 = await ai([
    { role: "assistant", content: CONFIRMATION },
    { role: "user", content: "Hey, something came up, can we move the installation to Friday?" },
  ]);
  console.log("   AI:", r3.replace(/\s+/g, " ").slice(0, 220));
  ck("menciona Ozzi + [NOTIFY_OWNER]", OZZI_HANDOFF.test(r3) && /\[NOTIFY_OWNER\]/.test(r3), r3);
  ck("não promete que moveu", !/(moved|rescheduled) (it|your|the)|all set|done!|i('ve| have) (moved|rescheduled)/i.test(r3), r3);
  ck("sem telefone", !SELLER_PHONE.test(r3) && !OWNER_PHONE.test(r3), r3);
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
