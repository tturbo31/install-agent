/**
 * ENVIO PELO PAINEL (02/11/2026) — puro, sem modelo nem rede.
 * Caso real: o dono abre uma conversa do Instagram parada há mais de 24h, digita,
 * e nada acontece — o Meta recusava com "10: outside of allowed window" e o
 * painel engolia o erro. Agora:
 *  1. classificação do erro de janela (IG e Messenger) e do canal pelo igsid;
 *  2. mensagem em português para o dono, com o erro bruto;
 *  3. a rota do painel usa panelSend e não grava nada quando o envio falha;
 *  4. o painel mostra o erro e devolve o texto para a caixa.
 * Run: npx tsx src/evals/panel-send-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { isMetaWindowError, channelOfIgsid, panelErrorMessage } from "../lib/panel-send";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}

console.log("\n━━ 1. classificação ━━");
ck("IG: '10: This message is sent outside of allowed window.'", isMetaWindowError("10: This message is sent outside of allowed window."));
ck("Messenger: '(#10) This message is sent outside of allowed window.'", isMetaWindowError("(#10) This message is sent outside of allowed window."));
ck("190 token expirado NÃO é janela", !isMetaWindowError("190: Error validating access token"));
ck("200 permissão NÃO é janela", !isMetaWindowError("200: The account owner has disabled access to Instagram Direct Messaging."));
ck("100 usuário inválido NÃO é janela", !isMetaWindowError("100: No matching user found"));
ck("vazio NÃO é janela", !isMetaWindowError("") && !isMetaWindowError(undefined));
ck("canal wa_", channelOfIgsid("wa_15616748334") === "whatsapp");
ck("canal fb_", channelOfIgsid("fb_28897924036481584") === "facebook");
ck("canal IG (sem prefixo)", channelOfIgsid("1707754480965043") === "instagram");

console.log("\n━━ 2. mensagem para o dono ━━");
const threeDays = new Date(Date.now() - 3 * 24 * 3600e3);
const mWin = panelErrorMessage("instagram", "10: This message is sent outside of allowed window. / HUMAN_AGENT: 100: Tag not allowed", threeDays);
ck("janela IG: explica as 24h", /Instagram só deixa a página responder pela API até 24h/.test(mWin), mWin);
ck("janela IG: diz há quantos dias o cliente escreveu", /há 3 dias/.test(mWin), mWin);
ck("janela IG: manda responder pelo app", /Responda pelo app do Instagram/.test(mWin), mWin);
ck("janela IG: traz o erro bruto", /Erro da Meta: 10:/.test(mWin), mWin);
const mFb = panelErrorMessage("facebook", "(#10) This message is sent outside of allowed window.", new Date(Date.now() - 30 * 3600e3));
ck("janela Messenger: rótulo Messenger + horas", /Messenger só deixa/.test(mFb) && /há 30h/.test(mFb), mFb);
const mTok = panelErrorMessage("instagram", "190: Error validating access token", new Date());
ck("outro erro: 'cliente NÃO recebeu' + erro bruto", /O cliente NÃO recebeu nada/.test(mTok) && /190:/.test(mTok), mTok);
const mWa = panelErrorMessage("whatsapp", "HTTP 503", null);
ck("WhatsApp: nunca fala em janela", /WhatsApp/.test(mWa) && !/24h/.test(mWa), mWa);

console.log("\n━━ 3. rota e painel ━━");
const route = readFileSync(join(process.cwd(), "src/app/api/conversations/[id]/send/route.ts"), "utf-8");
ck("rota usa panelSend", /panelSend\(\{ conversationId: id, igsid, text: body\.text \}\)/.test(route));
ck("rota devolve 500 com o erro em português antes de gravar", route.indexOf("status: 500") < route.indexOf('.from("instagram_messages")'));
ck("rota não importa mais os envios diretos", !/sendInstagramMessage|sendFacebookMessage|sendWhatsAppMessage/.test(route));
const lib = readFileSync(join(process.cwd(), "src/lib/panel-send.ts"), "utf-8");
ck("etiqueta HUMAN_AGENT com MESSAGE_TAG", /messaging_type: "MESSAGE_TAG"/.test(lib) && /tag: "HUMAN_AGENT"/.test(lib));
ck("janela fechada vai direto para a etiqueta (sem aviso de 'inalcançável')", /if \(windowOpen\) \{/.test(lib) && /sendWithHumanAgentTag\(channel, recipientId, text\)/.test(lib));
const dash = readFileSync(join(process.cwd(), "src/components/Dashboard.tsx"), "utf-8");
ck("Dashboard lê o status da resposta", /if \(res\.ok\) return \{ ok: true \}/.test(dash) && /data\.error \?\?/.test(dash));
ck("Dashboard solta isSending mesmo com exceção (finally)", /finally \{\s*setIsSending\(false\);/.test(dash));
const panel = readFileSync(join(process.cwd(), "src/components/ChatPanel.tsx"), "utf-8");
ck("ChatPanel devolve o texto à caixa quando falha", /setInput\(\(current\) => \(current\.trim\(\) \? current : text\)\)/.test(panel));
ck("ChatPanel mostra 'Mensagem NÃO enviada'", /Mensagem NÃO enviada/.test(panel) && /role="alert"/.test(panel));
ck("ChatPanel limpa o erro ao trocar de conversa", /setSendError\(null\);\s*\}, \[conversation\.id\]\)/.test(panel));

console.log(`\n${fail === 0 ? "✅" : "❌"} panel-send-verify: ${pass} passed, ${fail} failed${fail ? "\n  " + fails.join("\n  ") : ""}`);
process.exit(fail ? 1 : 0);
