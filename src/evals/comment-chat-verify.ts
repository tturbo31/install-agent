/**
 * Chat que o Facebook cria a partir de um COMENTÁRIO (Joshua Gray, 03/10/2026).
 * Print do dono: "Facebook created this chat because Joshua Gray commented on
 * your post..." com o comentário e o card do anúncio — a IA não respondia: a
 * rede de mensagem perdida trazia o chat, o bot gerava a resposta e a Meta
 * recusava o envio normal com (#551). Nesse chat a 1ª mensagem só entra como
 * resposta privada ao comentário. O dono NÃO quer o bot saindo atrás de
 * comentário de anúncio: só o chat que aparece no inbox é respondido, pelo
 * fluxo normal, como qualquer cliente. Pina:
 *   1. avisos reais (Joshua, Jeff, Hilda, David) e o id do comentário no link
 *   2. quando o chat ainda espera a 1ª resposta
 *   3. fiação: webhook grava o vínculo e troca o aviso pelo marcador; o envio
 *      usa a resposta privada uma vez; nenhuma varredura de comentários ligada
 *   4. ao vivo (LIVE=1): id completo achado na Graph (Joshua, Jeff) e a IA
 *      respondendo o comentário com o marcador no histórico (nada é enviado)
 * Run: npx tsx src/evals/comment-chat-verify.ts   |   LIVE=1 npx tsx src/evals/comment-chat-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  COMMENT_CHAT_MARKER,
  commentChatAwaitingFirstReply,
  commentIdFromNotice,
  isCommentChatCreatedNotice,
  isCommentChatNotice,
} from "../lib/post-comment-policy";

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
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf-8").replace(/\r\n/g, "\n");

// Avisos REAIS gravados em produção (01-03/10/2026).
const JOSHUA = "Facebook created this chat because Joshua Gray commented on your post. Joshua Gray won't see this until you start a conversation. You have 7 days before this chat disappears. See comment(https://facebook.com/story.php?story_fbid=pfbid028GddrTaCrcf4JewM4nWiM7gquwpCFGyWSjYsz9LRZ4M8Hx2Gg3VHXaaBhdVqVWG5l&id=100083174840587&post_id=100083174840587_pfbid028GddrTaCrcf4JewM4nWiM7gquwpCFGyWSjYsz9LRZ4M8Hx2Gg3VHXaaBhdVqVWG5l&comment_id=1606996650894324)";
const JEFF = "Facebook created this chat because Jeff Lucas commented on your post. Jeff Lucas won't see this until you start a conversation. You have 7 days before this chat disappears. See comment(https://facebook.com/story.php?story_fbid=pfbid022GFZGiL3X9jNYvSPENdZyrX81JGMQzesqNv5RwwbDh6a5Vwqzrx3R5wour1B4DYhl&id=100083174840587&post_id=100083174840587_pfbid022GFZGiL3X9jNYvSPENdZyrX81JGMQzesqNv5RwwbDh6a5Vwqzrx3R5wour1B4DYhl&comment_id=1566480701352593)";
const HILDA = "Facebook created this chat because Hilda Quiroz Chalela commented on your post. Hilda Quiroz Chalela won't see this until you start a conversation. You have 7 days before this chat disappears. See comment(https://facebook.com/story.php?story_fbid=pfbid02QrmpMxnfo35J4JhAiWJ3MroM1yWU8HPAe7ZvZpFRm7C7St9E3Ai4QtLGdn31e5RWl&id=100083174840587&comment_id=1609538247539467&comment_gqlid=Y29tbWVudDoxMDY2NjI4NzcyNzg2Mjc0XzE2MDk1MzgyNDc1Mzk0Njc%3D)";
const DAVID = "David Ch replied to a post. See post(https://www.facebook.com/story.php?story_fbid=pfbid07at17SUCgj9BY31wiQm61zgzqMJHyUbwcsaHCuSgxm34sp8rQMXYKHtpL5Wb7swGl&id=100083174840587)";
const JOSHUA_COMMENT = "Just my opinion but I would have at least did a skim coat over the tile to fill in the grout joints, and I say that because if two boards meet at a grout joint it's eventually going to break";

console.log("\n━━ 1. Avisos do chat de comentário (reais) ━━");
for (const [n, t] of [["Joshua", JOSHUA], ["Jeff", JEFF], ["Hilda", HILDA], ["David", DAVID]] as const) ck(`${n}: é aviso de chat de comentário`, isCommentChatNotice(t));
ck("chat NOVO criado pelo comentário: Joshua, Jeff, Hilda sim; David (thread que já existia) não", isCommentChatCreatedNotice(JOSHUA) && isCommentChatCreatedNotice(JEFF) && isCommentChatCreatedNotice(HILDA) && !isCommentChatCreatedNotice(DAVID));
for (const t of [JOSHUA_COMMENT, "I replied to your post yesterday, can you see it?", "Facebook said you have a promo", "See post(https://example.com/x)", "Hola\nQue material es ese porfavor ?"]) ck(`fala de cliente NÃO é aviso: "${t.slice(0, 40)}"`, !isCommentChatNotice(t));

console.log("\n━━ 2. Id do comentário no link do aviso ━━");
const j = commentIdFromNotice(JOSHUA), je = commentIdFromNotice(JEFF), h = commentIdFromNotice(HILDA), d = commentIdFromNotice(DAVID);
ck("Joshua: parte local 1606996650894324, sem id completo no link", j.localId === "1606996650894324" && j.fullId === null, JSON.stringify(j));
ck("Jeff: parte local 1566480701352593", je.localId === "1566480701352593" && je.fullId === null, JSON.stringify(je));
ck("Hilda: comment_gqlid decodificado = id completo 1066628772786274_1609538247539467", h.localId === "1609538247539467" && h.fullId === "1066628772786274_1609538247539467", JSON.stringify(h));
ck("David (\"replied to a post\"): sem id", d.localId === null && d.fullId === null);
ck("gqlid que não bate com o comment_id é descartado", commentIdFromNotice("x?comment_id=1609538247539467&comment_gqlid=Y29tbWVudDoxMV8yMg%3D%3D").fullId === null);

console.log("\n━━ 3. Chat esperando a 1ª resposta ━━");
const U = (c: string) => ({ role: "user", content: c });
const A = (c: string) => ({ role: "assistant", content: c });
ck("aviso (gravado como marcador) + comentário, nada nosso → espera", commentChatAwaitingFirstReply([U(JOSHUA_COMMENT), U(COMMENT_CHAT_MARKER)]));
ck("aviso cru (gravado antes desta versão) também conta", commentChatAwaitingFirstReply([U(JOSHUA_COMMENT), U(JOSHUA)]));
ck("tentativa que falhou (#551, SEND_FAILED) não conta como resposta", commentChatAwaitingFirstReply([A("Hi!\n\n[SYSTEM: SEND_FAILED]"), U(JOSHUA_COMMENT), U(COMMENT_CHAT_MARKER)]));
ck("depois da 1ª resposta entregue → conversa normal", !commentChatAwaitingFirstReply([A("Thanks for sharing!"), U(JOSHUA_COMMENT), U(COMMENT_CHAT_MARKER)]));
ck("conversa normal de Messenger nunca espera", !commentChatAwaitingFirstReply([U("hi"), U("how much?")]));

console.log("\n━━ 4. Fiação ━━");
const fb = read("src/app/api/fb-webhook/route.ts");
const fbs = read("src/lib/facebook.ts");
const pc = read("src/lib/post-comments.ts");
ck("webhook: aviso → resolve o comentário, grava o vínculo e vira o marcador ANTES de gravar a mensagem",
  /if \(isCommentChatNotice\(rawText\)\) \{\s*if \(isCommentChatCreatedNotice\(rawText\)\) \{\s*const commentId = await resolveCommentChatCommentId\(rawText\)[\s\S]{0,120}?if \(commentId\) \{\s*await registerCommentChat\(psid, commentId\);[\s\S]*?rawText = COMMENT_CHAT_MARKER;\s*\}/.test(fb) &&
  fb.indexOf("rawText = COMMENT_CHAT_MARKER;") < fb.indexOf("const storedText ="));
ck("webhook: a IA responde normalmente (nenhum return no aviso)", !/isCommentChatNotice\(rawText\)\) \{\s*console\.log\([^)]*\);\s*return;/.test(fb));
ck("webhook: chat de comentário SEM vínculo não gasta IA nem tenta envio (depois do debounce e do modo humano)",
  /if \(commentChatAwaitingFirstReply\(threadRows \?\? \[\]\) && !\(await pendingCommentChat\(psid\)\)\) \{[\s\S]{0,160}?return;/.test(fb) &&
  fb.indexOf("commentChatAwaitingFirstReply(threadRows") > fb.indexOf("Conversation paused during debounce"));
ck("envio: vínculo pendente → 1ª mensagem como resposta privada ao comentário",
  /const pending = await pendingCommentChat\(psid\)[\s\S]{0,60}?if \(pending\) \{\s*const pr = await sendFacebookPrivateReply\(pending\.commentId, text\);/.test(fbs));
ck("envio: vínculo some quando usado ou recusado de vez; falha passageira deixa para a próxima", /if \(pr\.ok \|\| !pr\.retryable\) await clearCommentChat\(pending\.key\);/.test(fbs));
ck("envio: resposta privada recusada cai no envio normal (com o alerta de sempre)", /trying the normal send`\);\s*\}\s*let lastErr = "not attempted";/.test(fbs));
ck("resposta privada pelo comment_id na página", /\$\{FB_API\}\/\$\{pageId\}\/messages/.test(fbs) && /recipient: \{ comment_id: commentId \}/.test(fbs));
ck("vínculo vence em 7 dias (janela da resposta privada)", /Date\.now\(\) - at > COMMENT_CHAT_TTL_MS/.test(pc) && /COMMENT_CHAT_TTL_MS = 7 \* 24 \* 3600_000/.test(read("src/lib/post-comment-policy.ts")));
for (const [label, rel] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]] as const) {
  ck(`${label}: nenhuma varredura de comentários de anúncio (pedido do dono)`, !/sweepPostComments|handleFeedWebhookComments/.test(read(rel)));
}
ck("post-comments.ts não envia nem varre nada por conta própria", !/from "@\/lib\/facebook"|sendFacebook\w*\(|export async function sweep|classifyPostComment/.test(pc));
ck("ai.ts sem classificador/resposta de comentário", !/classifyPostComment|composeCommentCritiqueReply/.test(read("src/lib/ai.ts")));

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  const { resolveCommentChatCommentId } = await import("../lib/post-comments");
  const { getAIResponse } = await import("../lib/ai");
  const { AD_REPLY_NOTE } = await import("../lib/system-prompt");
  const { getEasternDateContext } = await import("../lib/scheduler");

  console.log("\n━━ 5. AO VIVO: id completo do comentário (só leitura na Graph) ━━");
  const [jid, jeid, hid] = await Promise.all([resolveCommentChatCommentId(JOSHUA), resolveCommentChatCommentId(JEFF), resolveCommentChatCommentId(HILDA)]);
  ck(`Joshua → ${jid}`, jid === "1014660201316465_1606996650894324");
  ck(`Jeff → ${jeid}`, jeid === "1014660277983124_1566480701352593");
  ck(`Hilda (gqlid, sem Graph) → ${hid}`, hid === "1066628772786274_1609538247539467");

  console.log("\n━━ 6. AO VIVO: a IA responde o comentário (nada é enviado) ━━");
  const sys = `\n\n[SYSTEM: ${getEasternDateContext()}\n\n${AD_REPLY_NOTE}]`;
  for (const [label, msgs] of [
    ["Hilda (comentário → marcador)", [U("Hola\nQue material es ese porfavor ?"), U(COMMENT_CHAT_MARKER + sys)]],
    ["Hilda (marcador → comentário)", [U(COMMENT_CHAT_MARKER), U("Hola\nQue material es ese porfavor ?" + sys)]],
    ["Joshua (crítica)", [U(JOSHUA_COMMENT), U(COMMENT_CHAT_MARKER + sys)]],
  ] as const) {
    const r = await getAIResponse(msgs as never, null, null, null, false);
    console.log(`     [${label}] → ${r.text}`);
    ck(`${label}: responde (não fica em silêncio)`, !!r.text.trim() && !/\[REACT_ONLY\]/.test(r.text), r.text);
    ck(`${label}: não repete o marcador nem fala de "comentário público"`, !/\[Client replied|public comment/i.test(r.text), r.text);
  }
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
