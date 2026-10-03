/**
 * Comentário em post/anúncio do Facebook → resposta privada (Joshua Gray,
 * 03/10/2026). O "chat" que o Facebook abre no inbox para um comentário não é
 * mensagem: nunca chegava ao bot (zero eventos `changes` em 8 dias de caixa-
 * preta; o page token não pode assinar o campo feed). Pina:
 *   1. regras puras (post-comment-policy.ts): elegibilidade, evento feed do
 *      webhook, marcador gravado, classe → responde?, nome, nota do turno,
 *      resposta à crítica (fallback e validação)
 *   2. fiação: varredura nos 3 webhooks, feed no POST do FB, trava antes de
 *      classificar, resposta privada por comment_id, gravação depois do envio
 *   3. ao vivo (LIVE=1): classificador nos comentários REAIS dos anúncios
 *      (27/09 a 03/10) e as respostas geradas para crítica e lead (nada é
 *      enviado: composePostCommentReply só lê agenda/memória e chama o modelo)
 * Run: npx tsx src/evals/post-comment-verify.ts   |   LIVE=1 npx tsx src/evals/post-comment-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  AD_COMMENT_MARKER,
  COMMENT_MAX_AGE_MS,
  CRITIQUE_MAX_AGE_MS,
  POST_COMMENT_MARKER,
  commentChatAwaitingPrivateReply,
  commentEligibility,
  commentFromFeedChange,
  commentHasWords,
  commentLeadNote,
  commentLookupPrefix,
  commentTextMatches,
  commentThreadBlockReason,
  isCommentChatNotice,
  commentStoredText,
  commentsFromWebhookBody,
  critiqueFallbackReply,
  critiqueReplyIsSafe,
  firstNameOf,
  parseCommentClass,
  shouldReplyToClass,
  type CommentClass,
  type PostComment,
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

const PAGE = "109621555056803";
const NOW = Date.parse("2026-10-03T14:00:00Z");
const AD_TEXT = "✨ 1000 sq.ft. FOR JUST $2,350 ❌ materials ✨ 1000 sq.ft. ONLY $5,100 ✅ with materials";
const JOSHUA = "Just my opinion but I would have at least did a skim coat over the tile to fill in the grout joints, and I say that because if two boards meet at a grout joint it's eventually going to break";
const cm = (p: Partial<PostComment>): PostComment => ({
  id: "1014660201316465_1606996650894324",
  postId: "109621555056803_1810865860067614",
  message: JOSHUA,
  createdTime: "2026-10-03T04:40:38.000Z",
  source: "ad",
  canReplyPrivately: true,
  postText: AD_TEXT,
  ...p,
});

console.log("\n━━ 1. Elegibilidade ━━");
ck("Joshua (anúncio, 9h, can_reply_privately) é elegível", commentEligibility(cm({}), PAGE, NOW).ok);
const r = (p: Partial<PostComment>) => { const e = commentEligibility(cm(p), PAGE, NOW); return e.ok ? "ok" : e.reason; };
ck("comentário da própria página → from-page", r({ fromId: PAGE }) === "from-page");
ck("resposta a outro comentário → reply-to-comment", r({ parentId: "1014660201316465_999" }) === "reply-to-comment");
ck("parent igual ao post = 1º nível (formato do webhook)", r({ parentId: "109621555056803_1810865860067614" }) === "ok");
ck("can_reply_privately false (já respondido / fora da janela) → fora", r({ canReplyPrivately: false }) === "cannot-reply-privately");
ck("can_reply_privately desconhecido (webhook) → segue", r({ canReplyPrivately: null }) === "ok");
ck("mais de 7 dias → too-old", r({ createdTime: new Date(NOW - COMMENT_MAX_AGE_MS - 60_000).toISOString() }) === "too-old");
for (const t of ["😂", "🔥🔥🔥🔥", ".", "!!!", "  "]) ck(`sem palavra ("${t}") → no-words`, r({ message: t }) === "no-words");
ck("\"No\" tem palavra (o classificador decide)", commentHasWords("No") && r({ message: "No" }) === "ok");
ck("data inválida → no-time", r({ createdTime: "x" }) === "no-time");

console.log("\n━━ 2. Evento feed do webhook ━━");
const feedBody = {
  object: "page",
  entry: [{
    id: PAGE, time: 1790995238,
    changes: [
      { field: "feed", value: { from: { id: "26600000000000001", name: "Joshua Gray" }, post_id: "109621555056803_1810865860067614", comment_id: "1014660201316465_1606996650894324", parent_id: "109621555056803_1810865860067614", created_time: 1790995238, item: "comment", verb: "add", message: JOSHUA } },
      { field: "feed", value: { from: { id: PAGE, name: "Ozzi floors" }, post_id: "109621555056803_1810865860067614", comment_id: "1014660201316465_2", parent_id: "1014660201316465_1606996650894324", created_time: 1790995300, item: "comment", verb: "add", message: "Thanks!" } },
      { field: "feed", value: { from: { id: "1", name: "X" }, post_id: "109621555056803_1810865860067614", comment_id: "1014660201316465_3", created_time: 1790995300, item: "comment", verb: "edited", message: "edit" } },
      { field: "feed", value: { from: { id: "1", name: "X" }, post_id: "109621555056803_1810865860067614", item: "reaction", verb: "add", reaction_type: "like" } },
    ],
  }],
};
const parsed = commentsFromWebhookBody(feedBody, PAGE);
ck("só o comentário novo de terceiro vira PostComment (página, edição e reação fora)", parsed.length === 1 && parsed[0].id === "1014660201316465_1606996650894324", JSON.stringify(parsed));
ck("campos do evento: post, nome, parent, created_time em segundos → ISO", parsed[0]?.postId === "109621555056803_1810865860067614" && parsed[0]?.fromName === "Joshua Gray" && parsed[0]?.createdTime === new Date(1790995238 * 1000).toISOString() && parsed[0]?.canReplyPrivately === null);
ck("o comentário do evento é elegível (passados os 5 min de espera)", !!parsed[0] && commentEligibility(parsed[0], PAGE, 1790995238 * 1000 + 6 * 60_000).ok);
ck("body de mensagem (entry.messaging) não vira comentário", commentsFromWebhookBody({ object: "page", entry: [{ messaging: [{ sender: { id: "1" }, message: { mid: "m", text: "hi" } }] }] }, PAGE).length === 0);
ck("objeto instagram não vira comentário", commentsFromWebhookBody({ ...feedBody, object: "instagram" }, PAGE).length === 0);
ck("change de outro campo → null", commentFromFeedChange({ field: "mention", value: {} }, PAGE) === null);

console.log("\n━━ 3. Texto gravado + marcador ━━");
const storedAd = commentStoredText(cm({}));
ck("anúncio: comentário + marcador da família \"[Client replied to our ad\"", storedAd === `${JOSHUA}\n${AD_COMMENT_MARKER}` && /\[Client (?:replied to|shared a post\/reel from) our ad/i.test(storedAd));
ck("post orgânico: marcador próprio", commentStoredText(cm({ source: "post" })).endsWith(POST_COMMENT_MARKER));
const ai = read("src/lib/ai.ts");
const nonClient = ai.match(/const NON_CLIENT_TAGS = (\/.*\/gi);/)?.[1] ?? "";
// eslint-disable-next-line no-eval
const NON_CLIENT_RE = nonClient ? (0, eval)(nonClient) as RegExp : /$^/;
ck("NON_CLIENT_TAGS tira os dois marcadores (não contam como texto do cliente)", storedAd.replace(NON_CLIENT_RE, " ").trim() === JOSHUA && commentStoredText(cm({ source: "post" })).replace(NON_CLIENT_RE, " ").trim() === JOSHUA, nonClient);
ck("marcador não lido como placeholder de re-tap (o comentário vem antes)", !/^\[Client (?:replied to|shared a post\/reel from) our ad[^\]]*\]$/i.test(storedAd));

console.log("\n━━ 4. Classe → responde? ━━");
ck("parse LEAD/CRITIQUE/SKIP (caixa e ruído)", parseCommentClass("LEAD") === "lead" && parseCommentClass(" critique.") === "critique" && parseCommentClass("Skip") === "skip" && parseCommentClass("maybe") === null);
ck("lead de 2 dias responde", shouldReplyToClass("lead", cm({ createdTime: new Date(NOW - 50 * 3600_000).toISOString() }), NOW));
ck("crítica de 9h responde (Joshua)", shouldReplyToClass("critique", cm({}), NOW));
ck("crítica de mais de 24h não ganha \"obrigado\" atrasado", !shouldReplyToClass("critique", cm({ createdTime: new Date(NOW - CRITIQUE_MAX_AGE_MS - 60_000).toISOString() }), NOW));
ck("skip nunca responde", !shouldReplyToClass("skip", cm({}), NOW));

console.log("\n━━ 5. Nome, nota do turno ━━");
ck("firstNameOf", firstNameOf("Joshua Gray") === "Joshua" && firstNameOf("maria lopez") === "Maria" && firstNameOf(null) === null && firstNameOf("🔥🔥") === null && firstNameOf("Ozzi123") === null);
const noteFresh = commentLeadNote(cm({}), NOW);
ck("nota: comentário público, UMA resposta privada, termina com pergunta", /PUBLICLY on our Facebook ad/.test(noteFresh) && /ONE private reply/.test(noteFresh) && /end with one easy question/.test(noteFresh));
ck("nota traz o texto do anúncio", noteFresh.includes("1000 sq.ft. FOR JUST $2,350"));
ck("comentário de 9h: sem desculpa de atraso", !/apology for the late reply/.test(noteFresh));
const noteLate = commentLeadNote(cm({ createdTime: "2026-09-29T16:44:14.000Z" }), NOW);
ck("comentário de ~4 dias: abre com desculpa pela demora", /about 4 days ago: open with a short, natural apology/.test(noteLate), noteLate);
ck("nome entra na nota quando o webhook trouxe", /first name is Joshua/.test(commentLeadNote(cm({ fromName: "Joshua Gray" }), NOW)));

console.log("\n━━ 6. Resposta à crítica: fallback e validação ━━");
for (const lang of ["en", "es", "pt"] as const) {
  for (const name of [null, "Joshua"]) {
    const t = critiqueFallbackReply(lang, name);
    ck(`fallback ${lang}${name ? " com nome" : ""} passa na validação`, critiqueReplyIsSafe(t), t);
  }
}
ck("fallback es sem ¿ ¡ (regra do dono)", !/[¿¡]/.test(critiqueFallbackReply("es", "Joshua")));
ck("fallback en com nome abre com \"Hi Joshua,\"", critiqueFallbackReply("en", "Joshua").startsWith("Hi Joshua, thanks"));
for (const [bad, why] of [
  ["Thanks Joshua! We always level the floor before installing, so the grout lines are not an issue.", "afirmação técnica"],
  ["Thanks for the input! Want to see more of our work?", "pergunta"],
  ["Thanks! Our promo is $2,350 for 1000 sqft.", "preço"],
  ["Thanks for sharing — we appreciate it.", "travessão"],
  ["Thanks for sharing 🙏", "emoji"],
  ["Thanks! Check ozzifloors.company", "link"],
  ["Gracias! Siempre usamos barrera de humedad.", "afirmação técnica es"],
] as const) ck(`validação recusa: ${why}`, !critiqueReplyIsSafe(bad), bad);
ck("validação aceita agradecimento que só nomeia o ponto", critiqueReplyIsSafe("Hi Joshua, thanks for the tip about the skim coat over the grout lines, we appreciate you sharing it. If you ever need floors done, we'd be glad to help."));

console.log("\n━━ 6b. Chat do comentário no Messenger + quem já tem conversa ━━");
const JOSHUA_NOTICE = "Facebook created this chat because Joshua Gray commented on your post. Joshua Gray won't see this until you start a conversation. You have 7 days before this chat disappears. See comment(https://facebook.com/story.php?story_fbid=pfbid028GddrTaCrcf4JewM4nWiM7gquwpCFGyWSjYsz9LRZ4M8Hx2Gg3VHXaaBhdVqVWG&id=1)";
const DAVID_NOTICE = "David Ch replied to a post. See post(https://www.facebook.com/story.php?story_fbid=pfbid07at17SUCgj9BY31wiQm61zgzqMJHyUbwcsaHCuSgxm34sp8rQMXYKHtpL5Wb7swGl&id=100083174840587)";
ck("aviso real do Joshua é aviso de chat de comentário", isCommentChatNotice(JOSHUA_NOTICE));
ck("aviso real do David é aviso de chat de comentário", isCommentChatNotice(DAVID_NOTICE));
for (const t of ["I replied to your post yesterday, can you see it?", "Just my opinion but I would have at least did a skim coat over the tile", "Facebook said you have a promo", "See post(https://example.com/x)"]) ck(`fala de cliente NÃO é aviso: "${t.slice(0, 40)}"`, !isCommentChatNotice(t));
ck("thread criada pelo comentário e sem nada nosso → espera a resposta privada", commentChatAwaitingPrivateReply([{ role: "user", content: JOSHUA }, { role: "user", content: JOSHUA_NOTICE }]));
ck("... a tentativa que falhou (SEND_FAILED) não conta como resposta", commentChatAwaitingPrivateReply([{ role: "assistant", content: "Hi!\n\n[SYSTEM: SEND_FAILED]" }, { role: "user", content: JOSHUA }, { role: "user", content: JOSHUA_NOTICE }]));
ck("... depois da resposta privada gravada, o fluxo normal volta", !commentChatAwaitingPrivateReply([{ role: "assistant", content: "Thanks for sharing your thoughts." }, { role: "user", content: JOSHUA_NOTICE }]));
ck("thread normal (sem o aviso de criação) nunca espera", !commentChatAwaitingPrivateReply([{ role: "user", content: DAVID_NOTICE }, { role: "user", content: "hi" }]));
const DAVID_API = "Can somebody contact me? I would like to do it in my apartment David ************.";
const DAVID_THREAD = "Can somebody contact me? I would like to do it in my apartment David 305-761-1633.";
ck("mesma frase com telefone mascarado (API) e com dígitos (thread) casa", commentTextMatches(DAVID_THREAD, DAVID_API));
ck("bolha gravada por nós (com marcador) casa com o comentário", commentTextMatches(`${JOSHUA}\n${AD_COMMENT_MARKER}`, JOSHUA));
ck("frases diferentes não casam", !commentTextMatches("Where are you?", "Where are you? I have a job for you.") && !commentTextMatches("Price?", "Price?"));
ck("prefixo de busca para no trecho mascarado e exige 8 letras", commentLookupPrefix(DAVID_API) === "Can somebody contact me?" && commentLookupPrefix("Price?") === null && commentLookupPrefix("************ call me") === null);
const at = Date.parse("2026-10-01T12:30:38Z");
const nowD = Date.parse("2026-10-03T14:00:00Z");
const davidRows = [
  { role: "assistant", content: "[Treino] Yes, I’ll call you within the next hour", created_at: "2026-10-01T12:42:08Z" },
  { role: "user", content: DAVID_THREAD, created_at: "2026-10-01T12:30:54Z" },
];
ck("David (modo humano) → não responde", commentThreadBlockReason({ mode: "human" }, davidRows, at, nowD) === "human");
ck("dono escreveu na thread nos últimos 14 dias → não responde", commentThreadBlockReason({ mode: "agent" }, davidRows, at, nowD) === "owner");
ck("visita marcada → não responde", commentThreadBlockReason({ mode: "agent", booking_confirmed: true }, [], at, nowD) === "booked");
ck("bot já respondeu depois do comentário → não responde", commentThreadBlockReason({ mode: "agent" }, [{ role: "assistant", content: "We cover all of South Florida!", created_at: "2026-10-01T12:31:30Z" }], at, nowD) === "answered");
ck("resposta que falhou (#551) não conta → responde em privado", commentThreadBlockReason({ mode: "agent" }, [{ role: "assistant", content: "Hi!\n\n[SYSTEM: SEND_FAILED]", created_at: "2026-10-01T12:31:30Z" }], at, nowD) === null);
ck("conversa antiga do bot, de antes do comentário → responde", commentThreadBlockReason({ mode: "agent" }, [{ role: "assistant", content: "Which type?", created_at: "2026-09-20T10:00:00Z" }], at, nowD) === null);
ck("comentário com menos de 5 min espera a próxima varredura (a bolha da thread chega antes)", r({ createdTime: new Date(NOW - 2 * 60_000).toISOString() }) === "too-new");

console.log("\n━━ 7. Fiação ━━");
const fb = read("src/app/api/fb-webhook/route.ts");
const pc = read("src/lib/post-comments.ts");
const fbs = read("src/lib/facebook.ts");
for (const [label, rel] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]] as const) {
  const src = read(rel);
  ck(`${label}: waitUntil(sweepPostComments()) logo depois de recoverLostInbounds`, /waitUntil\(recoverLostInbounds\(\)\);[\s\S]{0,300}?waitUntil\(sweepPostComments\(\)\);/.test(src));
}
ck("FB POST: entry.changes → handleFeedWebhookComments (antes do handler de mensagem)", /e\.changes\.length > 0\)\) \{\s*waitUntil\(handleFeedWebhookComments\(body\)\);\s*\}\s*waitUntil\(handleFbMessage\(body, \{ replay \}\)\);/.test(fb));
ck("varredura autolimitada pela trava de janela (1 / 3 min)", /shouldAlert\("fbcomments", "sweep", COMMENT_SWEEP_GAP_MS\)/.test(pc) && /COMMENT_SWEEP_GAP_MS = 3 \* 60_000/.test(read("src/lib/post-comment-policy.ts")));
ck("Facebook pausado: nem varre nem responde (checado de novo antes do envio)", (pc.match(/await facebookPaused\(\)/g) ?? []).length >= 3);
ck("trava ANTES de classificar; falha do classificador devolve a trava", /if \(!\(await claimComment\(c\.id\)\)\) return "already-claimed";[\s\S]*?classifyPostComment[\s\S]*?catch \(err\) \{[\s\S]{0,200}?await releaseComment\(c\.id\);\s*return "classify-failed";/.test(pc));
ck("leitura de travas que falha = varredura pulada (nunca \"ninguém travou\")", /if \(error\) \{[\s\S]{0,120}?return null;/.test(pc) && /if \(!claimed\) return;/.test(pc));
ck("envio por resposta privada (recipient.comment_id) na página", /\$\{FB_API\}\/\$\{pageId\}\/messages/.test(fbs) && /recipient: \{ comment_id: commentId \}/.test(fbs) && /sendFacebookPrivateReply\(c\.id, composed\.text\)/.test(pc));
ck("conversa gravada com o PSID devolvido (fb_<PSID>) DEPOIS do envio", /sentOk = true;[\s\S]*?persistThread\(sent\.recipientId, c, stored, composed\.text\)/.test(pc) && /const igsid = `fb_\$\{psid\}`;/.test(pc));
ck("mensagem do cliente gravada com id fbcmt_<comment_id> (dedupe)", /instagram_msg_id: `fbcmt_\$\{c\.id\}`/.test(pc));
ck("erro depois do envio NÃO devolve a trava (nunca responder 2x)", /if \(!sentOk\) await releaseComment\(c\.id\);/.test(pc));
ck("lead que não deu para responder avisa o dono (1 aviso a cada 6h, não 1 por comentário)", /cls === "lead" && giveUp && \(await shouldAlert\("fbcmt-alert", "lead", 6 \* 3600_000\)\)/.test(pc));
ck("erro de permissão/token = canal bloqueado: devolve o comentário, recua 1h, 1 aviso/6h", /CHANNEL_BLOCK_CODES = new Set\(\[3, 10, 190, 200\]\)/.test(pc) && /CHANNEL_BLOCK_CODES\.has\(sent\.code\) && failures < MAX_SEND_FAILURES\) \{\s*await releaseComment\(c\.id\);/.test(pc) && /shouldAlert\("fbcmt-alert", "blocked", 6 \* 3600_000\)/.test(pc) && /if \(await channelBlockedRecently\(\)\) return;/.test(pc) && /BLOCK_BACKOFF_MS = 60 \* 60_000/.test(pc));
ck("varredura para no 1º bloqueio e o teto conta respostas, não classificações", /if \(out === "send-blocked"\) break;/.test(pc) && /if \(replies >= COMMENT_MAX_PER_SWEEP\) break;/.test(pc) && /\.slice\(0, COMMENT_MAX_CLASSIFIED_PER_SWEEP\)/.test(pc));
ck("lead passa pelos backstops do Messenger (reparo, piso que não fazemos, trailer, PSL, <400, banheiro)", ["repairVisitOfferLeak", "unsupportedFloorLeak", "mobileHomeLeak", "portStLucieLeak", "smallJobLeak", "bathroomLeak"].every((f) => pc.includes(`if (${f}(history, text))`)));
ck("lead: [BOOK] sai (sem endereço/telefone num comentário)", /\.replace\(\/\\\[BOOK:\[\\s\\S\]\*\?\\\]\/g, ""\)/.test(pc));
ck("lead: promessa de contato vira o número do Ozzi + stripForbiddenTags", /stripForbiddenTags\(psl \? text : redirectOwnerPromiseToPhone\(text, lang\)\)/.test(pc));
ck("lead entra no funil (lead_criado) — crítica não", /if \(saved && cls === "lead"\) \{\s*await funilOnInboundMessage\(/.test(pc));
ck("FB webhook: aviso de chat de comentário e thread só-do-comentário não recebem envio normal (antes do debounce)", /if \(isCommentChatNotice\(rawText\)\) \{[\s\S]{0,200}?return;\s*\}[\s\S]{0,500}?if \(commentChatAwaitingPrivateReply\(threadRows \?\? \[\]\)\) \{[\s\S]{0,200}?return;\s*\}\s*\}\s*\/\/ Debounce/.test(fb));
ck("FB webhook: o filtro fica DEPOIS do modo humano (o aviso entra no histórico e o dono é avisado como sempre)", fb.indexOf("isCommentChatNotice(rawText)") > fb.indexOf('if (conv.mode === "human") {'));
ck("resposta privada: guarda da thread existente ANTES de classificar, busca que falha devolve a trava", /thread = await findThreadWithComment\(c\);\s*\} catch \(err\) \{[\s\S]{0,200}?await releaseComment\(c\.id\);\s*return "lookup-failed";[\s\S]*?commentThreadBlockReason\(thread\.conv, thread\.rows[\s\S]*?classifyPostComment/.test(pc));
ck("busca da bolha ignora as linhas gravadas pela própria resposta privada", /startsWith\("fbcmt_"\)/.test(pc) && /commentTextMatches\(h\.content, c\.message\)/.test(pc));
ck("leitura de anúncios pelo page token derivado do token de anúncios", /getAdsToken\(\)/.test(pc) && /me\/accounts\?fields=id,access_token/.test(pc) && /ads_posts\?fields=id,updated_time,message/.test(pc));

async function live() {
  if (process.env.LIVE !== "1") { console.log("\n(ao vivo pulado; LIVE=1 para rodar)"); return; }
  const { classifyPostComment, composeCommentCritiqueReply, promisesOwnerContact, containsSchedulingOffer } = await import("../lib/ai");
  const { composePostCommentReply } = await import("../lib/post-comments");

  console.log("\n━━ 8. AO VIVO: classificador nos comentários reais (27/09 a 03/10) ━━");
  const cases: Array<[string, CommentClass[]]> = [
    // leads
    ["Where are you? I have a job for you.", ["lead"]],
    ["Can somebody contact me? I would like to do it in my apartment David ************.", ["lead"]],
    ["Hola\nQue material es ese porfavor ?", ["lead"]],
    ["Cual es el precio? Del material e instalacion?", ["lead"]],
    ["Eso es vinyl o ceramica lo que va instalar?", ["lead"]],
    ["Se puede instalar sin quitar el Tile??", ["lead"]],
    ["Can this be put over floors that have soft spots", ["lead"]],
    ["Would this work for a mobile home with soft spots", ["lead"]],
    ["Will water get through that when you’re mopping the floors or if you spill something won’t go through the cracks ?", ["lead"]],
    ["What was the cost of this?", ["lead"]],
    ["Do you guys do those shelves in the stairs too?", ["lead"]],
    // críticas
    [JOSHUA, ["critique"]],
    ["No underlayment on that rough floor is wild.", ["critique"]],
    ["Hey question why are you installing that vinyl tile without any moisture barrier since you're going over that tile you're going to have an issue down the road", ["critique"]],
    ["Definitely should have used some underlayment and a taping block", ["critique"]],
    ["Where's the vapor barrier?", ["critique", "lead"]],
    // pular
    ["No glue, nothing, shit work, shit products", ["skip"]],
    ["The installer/ helpers pay must be abysmal. What a terrible pest of a company lowering the pay for eveyone around them", ["skip"]],
    ["Necesito trabajo de pintura", ["skip"]],
    ["There’s no traffic in Miami it’s just bumper cars.", ["skip"]],
    ["This guy need to start his own company! Ya kick ass bro! Start your own company", ["skip"]],
    ["Stop showing these videos you guys are not putting down a moisture barrier and that'll all Buckle in a month because of the grout lines you fucking morons stop putting up dumb videos", ["skip"]],
    ["Hola amigo no le hace farta un ayudante", ["skip"]],
    ["Yo se instalar ese piso", ["skip"]],
    ["Sharron B. Mattox", ["skip"]],
    ["Awesome work", ["skip"]],
    ["I am not interested in this. Thank you 💕", ["skip"]],
    ["Dicen un precio y despues hacen un quote con el doble, no pasen el tiempo con esta compañia...!!!!!", ["skip"]],
    // limítrofes: crítica ou pular, nunca lead
    ["Tap tap tap waking in plastic.", ["skip", "critique"]],
    ["You guys are killing the vinyl floor industry by not putting down moisture barrier this is why people are stop buying it because their floors are going the shit and buckling", ["critique", "skip"]],
    ["Yeah, let’s take out Nails and do floor prep when you’re starting to lay that’s not how it works", ["critique", "skip"]],
    ["Why are you beating on the flooring,are you trying to practice drumming !!!", ["critique", "skip"]],
  ];
  const results = await Promise.all(cases.map(([t]) => classifyPostComment(t, AD_TEXT).catch((e) => `ERR ${String(e).slice(0, 60)}` as unknown as CommentClass)));
  cases.forEach(([t, ok], i) => ck(`"${t.replace(/\s+/g, " ").slice(0, 60)}" → ${results[i]}`, ok.includes(results[i]), `esperado ${ok.join("|")}`));

  console.log("\n━━ 9. AO VIVO: resposta à crítica (Joshua) ━━");
  const crit = await composeCommentCritiqueReply(JOSHUA, null, "en");
  console.log(`     → ${crit}`);
  ck("modelo devolveu resposta válida (senão cai no fallback)", !!crit && critiqueReplyIsSafe(crit));
  ck("curta (≤ 220) e sem venda", !!crit && crit.length <= 220 && !/\$|promo|sq\.?\s*ft|visit|estimate/i.test(crit), crit ?? "");
  const critComposed = await composePostCommentReply("critique", cm({ fromName: "Joshua Gray" }));
  console.log(`     → (com nome) ${critComposed?.text}`);
  ck("com nome do webhook abre com \"Hi Joshua,\"", !!critComposed && /^Hi Joshua,/.test(critComposed.text), critComposed?.text ?? "");
  const critEs = await composePostCommentReply("critique", cm({ message: "que mal que instalan eso se rompe es muy debil se usa una goma para golpear", createdTime: new Date(NOW - 3600_000).toISOString() }));
  console.log(`     → (es) ${critEs?.text}`);
  ck("crítica em espanhol responde em espanhol, sem ¿ ¡", !!critEs && /\b(gracias|comentario|opini[oó]n)\b/i.test(critEs.text) && !/[¿¡]/.test(critEs.text), critEs?.text ?? "");

  console.log("\n━━ 10. AO VIVO: resposta a lead (cérebro do Messenger) ━━");
  const lead = async (message: string, hoursAgo = 2) => {
    const out = await composePostCommentReply("lead", cm({ message, createdTime: new Date(Date.now() - hoursAgo * 3600_000).toISOString() }));
    console.log(`     [${message.slice(0, 50)}] → ${out?.text}`);
    return out?.text ?? "";
  };
  const common = (t: string, label: string) => {
    ck(`${label}: resposta não vazia, sem tag e sem traço`, !!t && !/\[[A-Z_]+/.test(t) && !/[–—]|\s-\s/.test(t), t);
  };
  const where = await lead("Where are you? I have a job for you.");
  common(where, "\"Where are you?\"");
  ck("\"Where are you?\": diz a área atendida", /florida|miami|broward|palm beach|county|fort lauderdale/i.test(where), where);
  ck("\"Where are you?\": não promete que o Ozzi liga", !promisesOwnerContact(where), where);
  const price = await lead("Cual es el precio? Del material e instalacion?", 96);
  common(price, "\"Cual es el precio?\"");
  ck("\"Cual es el precio?\": responde em espanhol, sem ¿ ¡", /\b(hola|el|la|de|para|piso|precio)\b/i.test(price) && !/[¿¡]/.test(price), price);
  ck("\"Cual es el precio?\" (4 dias): pede desculpa pela demora", /(disculp|perd[oó]n|lament|demora|tard)/i.test(price), price);
  const mobile = await lead("Would this work for a mobile home with soft spots", 80);
  common(mobile, "mobile home");
  ck("mobile home: recusa, sem visita nem horário", /mobile home|manufactured|trailer|casa m[oó]vil/i.test(mobile) && !containsSchedulingOffer(mobile), mobile);
  const contact = await lead("Can somebody contact me? I would like to do it in my apartment David ************.", 50);
  common(contact, "\"Can somebody contact me?\"");
  ck("\"Can somebody contact me?\": não promete retorno do Ozzi", !promisesOwnerContact(contact), contact);
}

live().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fails.length) { console.log("FALHAS:\n - " + fails.join("\n - ")); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
