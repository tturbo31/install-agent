// ─── Comentário em post/anúncio do Facebook: regras puras (sem I/O) ──────────
// 03/10/2026, Joshua Gray: comentou num anúncio "Just my opinion but I would
// have at least did a skim coat over the tile to fill in the grout joints..." e
// o Facebook abriu um "chat" no inbox da página ("Facebook created this chat
// because Joshua Gray commented on your post. Joshua Gray won't see this until
// you start a conversation"). Para o dono parecia um cliente no Messenger, mas é
// COMENTÁRIO: não chega como mensagem (entry.messaging), a página não assina o
// campo feed (caixa-preta: 2.481 POSTs do FB em 8 dias, zero `changes`) e o page
// token não tem pages_manage_metadata para assinar. Nenhum comentário de
// anúncio chegava ao bot (313 em 240 posts de anúncio): leads ("Where are you?
// I have a job for you.", "Can somebody contact me? I would like to do it in my
// apartment") no meio de críticas de instaladores e trolls.
//
// A resposta sai como RESPOSTA PRIVADA (recipient.comment_id): UMA mensagem por
// comentário, até 7 dias depois dele. Quem decide a quem responder:
//   lead     → o cérebro do Messenger responde, como 1º contato de anúncio
//   critique → agradecimento curto, sem discutir e sem afirmação técnica
//   skip     → insulto, deboche, piada, elogio solto, emoji, marcação de amigo,
//              conversa com outro comentarista, vaga de emprego, outro ofício
// I/O em post-comments.ts; aqui só o que o eval (post-comment-verify) pina.

// Janela da Meta para a resposta privada.
export const COMMENT_MAX_AGE_MS = 7 * 24 * 3600_000;
// Crítica com mais de um dia não ganha "obrigado pela opinião": chega fora de
// hora. Lead responde até o fim da janela (um "tem trabalho pra vocês" de 2 dias
// atrás ainda é venda).
export const CRITIQUE_MAX_AGE_MS = 24 * 3600_000;
// Varredura: no máximo 1 a cada 3 min (tráfego dos 3 webhooks), poucas
// respostas por vez (cada uma custa geração + envio dentro do waitUntil); a
// classificação sozinha é barata, então cabem mais comentários lidos por vez.
export const COMMENT_SWEEP_GAP_MS = 3 * 60_000;
export const COMMENT_MAX_PER_SWEEP = 4;
export const COMMENT_MAX_CLASSIFIED_PER_SWEEP = 15;
// Posts cujo updated_time (sobe a cada comentário novo) está nessa janela têm
// os comentários lidos.
export const COMMENT_POST_LOOKBACK_MS = COMMENT_MAX_AGE_MS;

export const AD_COMMENT_MARKER = "[Client replied to our ad with a public comment]";
export const POST_COMMENT_MARKER = "[Client replied to our post with a public comment]";

export type CommentSource = "ad" | "post";
export type CommentClass = "lead" | "critique" | "skip";
export type CommentLang = "en" | "es" | "pt";

export type PostComment = {
  id: string;
  postId: string;
  message: string;
  createdTime: string; // ISO
  source: CommentSource;
  fromId?: string | null;
  fromName?: string | null;
  // Ausente (ou igual ao postId) = comentário de 1º nível.
  parentId?: string | null;
  // null = desconhecido (webhook não traz; a varredura lê can_reply_privately).
  canReplyPrivately?: boolean | null;
  postText?: string | null;
};

export type Eligibility = { ok: true } | { ok: false; reason: string };

// Sem uma letra ou um número não há o que responder (emoji, figurinha, "!!!").
export function commentHasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text ?? "");
}

export function commentEligibility(c: PostComment, pageId: string, nowMs: number): Eligibility {
  if (!c.id || !c.postId) return { ok: false, reason: "no-id" };
  if (pageId && c.fromId && c.fromId === pageId) return { ok: false, reason: "from-page" };
  // Resposta a OUTRO comentário é conversa entre comentaristas ("Tommy G Russo
  // not true...", "Joey Sawyer cause that's why").
  if (c.parentId && c.parentId !== c.postId) return { ok: false, reason: "reply-to-comment" };
  // false = já respondido em privado (pelo dono ou por nós) ou fora da janela.
  if (c.canReplyPrivately === false) return { ok: false, reason: "cannot-reply-privately" };
  const t = Date.parse(c.createdTime);
  if (!Number.isFinite(t)) return { ok: false, reason: "no-time" };
  if (nowMs - t > COMMENT_MAX_AGE_MS) return { ok: false, reason: "too-old" };
  if (!commentHasWords(c.message)) return { ok: false, reason: "no-words" };
  return { ok: true };
}

// Evento do campo `feed` do webhook da página (quando a assinatura existir):
// entry[].changes[] = { field: "feed", value: { item: "comment", verb: "add",
// comment_id, post_id, parent_id, from: { id, name }, message, created_time } }.
export function commentFromFeedChange(change: unknown, pageId: string): PostComment | null {
  const ch = (change ?? {}) as { field?: unknown; value?: Record<string, unknown> };
  if (ch.field !== "feed") return null;
  const v = ch.value ?? {};
  if (v.item !== "comment" || v.verb !== "add") return null;
  const id = typeof v.comment_id === "string" ? v.comment_id : "";
  const postId = typeof v.post_id === "string" ? v.post_id : "";
  if (!id || !postId) return null;
  const from = (v.from ?? {}) as { id?: unknown; name?: unknown };
  const fromId = typeof from.id === "string" ? from.id : null;
  if (pageId && fromId === pageId) return null;
  const ct = v.created_time;
  const createdTime =
    typeof ct === "number"
      ? new Date(ct < 1e12 ? ct * 1000 : ct).toISOString()
      : typeof ct === "string" && Number.isFinite(Date.parse(ct))
        ? new Date(Date.parse(ct)).toISOString()
        : new Date().toISOString();
  return {
    id,
    postId,
    message: typeof v.message === "string" ? v.message : "",
    createdTime,
    source: "post", // o webhook não diz se é anúncio; o I/O confere no post
    fromId,
    fromName: typeof from.name === "string" ? from.name : null,
    parentId: typeof v.parent_id === "string" ? v.parent_id : null,
    canReplyPrivately: null,
  };
}

export function commentsFromWebhookBody(body: unknown, pageId: string): PostComment[] {
  const b = (body ?? {}) as { object?: unknown; entry?: Array<{ changes?: unknown[] }> };
  if (b.object !== "page" || !Array.isArray(b.entry)) return [];
  const out: PostComment[] = [];
  for (const e of b.entry) {
    for (const ch of Array.isArray(e?.changes) ? e.changes : []) {
      const c = commentFromFeedChange(ch, pageId);
      if (c) out.push(c);
    }
  }
  return out;
}

// O que entra no histórico (e o cérebro lê): o comentário + o marcador. O
// marcador do anúncio é da família "[Client replied to our ad" — o NON_CLIENT_TAGS
// do ai.ts o remove antes de julgar o texto do cliente, e o FB webhook segue
// tratando a conversa como lead de anúncio nos turnos seguintes.
export function commentStoredText(c: PostComment): string {
  return `${c.message.trim()}\n${c.source === "ad" ? AD_COMMENT_MARKER : POST_COMMENT_MARKER}`;
}

export function parseCommentClass(raw: string): CommentClass | null {
  const m = (raw ?? "").toUpperCase().match(/\b(LEAD|CRITIQUE|SKIP)\b/);
  return m ? (m[1].toLowerCase() as CommentClass) : null;
}

export function shouldReplyToClass(cls: CommentClass, c: PostComment, nowMs: number): boolean {
  if (cls === "lead") return true;
  if (cls === "critique") return nowMs - Date.parse(c.createdTime) <= CRITIQUE_MAX_AGE_MS;
  return false;
}

// Primeiro nome só quando parece nome de gente (o webhook traz from.name; a
// varredura não — a Meta oculta o autor).
export function firstNameOf(fullName: string | null | undefined): string | null {
  const first = (fullName ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^\p{L}[\p{L}'’.]{1,19}$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function trimPostText(text: string | null | undefined, max = 280): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// Comentário deixado há 12h ou mais: a resposta abre pedindo desculpa pela
// demora (a 1ª varredura pega leads de até 7 dias atrás).
export const LATE_REPLY_AFTER_MS = 12 * 3600_000;

function ageLabel(ms: number): string {
  const h = Math.round(ms / 3600_000);
  if (h < 36) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

// Nota do turno para o cérebro (lead). Vai só no [SYSTEM:] do turno, nunca no
// histórico gravado.
export function commentLeadNote(c: PostComment, nowMs: number): string {
  const where = c.source === "ad" ? "ad" : "post";
  const post = trimPostText(c.postText);
  const name = firstNameOf(c.fromName);
  const age = nowMs - Date.parse(c.createdTime);
  return (
    `[FACEBOOK COMMENT: This person did NOT message us. They left the comment above PUBLICLY on our Facebook ${where}, ` +
    `and your reply goes to their Messenger as our ONE private reply to that comment: nothing else can be sent until they answer. ` +
    `Answer what the comment asks or wants, briefly and warmly, the way you answer the first message of an ad lead, ` +
    `and end with one easy question that makes them want to reply. You may open with a short thanks for the comment.` +
    (Number.isFinite(age) && age >= LATE_REPLY_AFTER_MS
      ? ` The comment was left about ${ageLabel(age)} ago: open with a short, natural apology for the late reply.`
      : "") +
    (name ? ` Their first name is ${name}.` : "") +
    (post ? ` The ${where} they commented on says: "${post}".` : "") +
    `]`
  );
}

// Resposta à crítica quando o modelo falha ou escreve algo fora da linha.
export function critiqueFallbackReply(lang: CommentLang, firstName?: string | null): string {
  const n = firstName ? firstName : "";
  if (lang === "es") {
    return `${n ? `Hola ${n}, g` : "G"}racias por tomarte el tiempo de compartir tu opinión, de verdad apreciamos el comentario. Si algún día necesitas pisos, con gusto te ayudamos.`;
  }
  if (lang === "pt") {
    return `${n ? `Oi ${n}, o` : "O"}brigado por compartilhar sua opinião, a gente agradece de verdade. Se um dia precisar de piso, vamos ter o maior prazer em ajudar.`;
  }
  return `${n ? `Hi ${n}, t` : "T"}hanks for taking the time to share your opinion, we really appreciate the feedback. If you ever need floors done, we'd be glad to help.`;
}

// A resposta à crítica é curta, sem pergunta (convida discussão), sem número
// ou preço, sem link, sem traço (ZERO DASHES), sem emoji, sem tag e sem
// afirmação de como instalamos ("we always use a moisture barrier" pode ser
// falso e vira briga pública).
export function critiqueReplyIsSafe(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || t.length > 280) return false;
  if (/[?¿]/.test(t)) return false;
  if (/[\d$]/.test(t)) return false;
  if (/https?:|www\.|\.com\b|\.company\b/i.test(t)) return false;
  if (/[-‐-―]/.test(t)) return false;
  if (/\p{Extended_Pictographic}/u.test(t)) return false;
  if (/[[\]]/.test(t)) return false;
  if (/\b(?:we|our\s+(?:team|installers?|crew))\s+(?:always|never|use|used|did|do|does|install(?:ed)?|put|apply|applied|level(?:ed)?|prep(?:ped)?)\b/i.test(t)) return false;
  if (/\b(?:siempre|nunca)\s+(?:usamos|ponemos|instalamos|aplicamos|nivelamos)\b|\b(?:sempre|nunca)\s+(?:usamos|colocamos|instalamos|aplicamos|nivelamos)\b/i.test(t)) return false;
  return true;
}
