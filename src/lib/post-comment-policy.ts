// ─── Chat que o Facebook cria a partir de um COMENTÁRIO: regras puras ────────
// 03/10/2026, Joshua Gray (print do dono): no inbox da página aparece um chat
// "Facebook created this chat because Joshua Gray commented on your post.
// Joshua Gray won't see this until you start a conversation. ... See comment(...)"
// com o comentário e o card do anúncio. Para o dono é um cliente mandando
// mensagem junto com o anúncio — e a IA não respondia.
//
// Por quê: a rede de mensagem perdida (recoverLostInbounds) lê esse chat da
// lista de conversas e reposta as bolhas ao webhook; o bot gerava a resposta e
// a Meta recusava o envio normal com (#551) "This person isn't available right
// now" (3 tentativas do outbox). Nesse chat a 1ª mensagem da página SÓ entra
// como resposta privada ao comentário (recipient.comment_id). Depois que a
// pessoa responde, é conversa normal do Messenger.
//
// O dono NÃO quer o bot saindo atrás de comentário de anúncio (03/10): só o chat
// que aparece no inbox é respondido, pelo fluxo normal, como qualquer cliente.

// O aviso entra no histórico como este marcador (família "[Client replied to
// our ad": o NON_CLIENT_TAGS do ai.ts o tira do texto do cliente e o FB webhook
// trata a conversa como lead de anúncio, com as notas de tipo de piso).
export const COMMENT_CHAT_MARKER = "[Client replied to our ad with a public comment]";

// A resposta privada vale até 7 dias depois do comentário; depois disso o
// vínculo chat → comentário não serve mais.
export const COMMENT_CHAT_TTL_MS = 7 * 24 * 3600_000;

// Bolhas reais vistas (03/10):
//   "Facebook created this chat because Joshua Gray commented on your post. Joshua
//    Gray won't see this until you start a conversation. You have 7 days before
//    this chat disappears. See comment(https://facebook.com/story.php?...&comment_id=1606996650894324)"
//   "David Ch replied to a post. See post(https://www.facebook.com/story.php?story_fbid=...)"
export function isCommentChatNotice(text: string): boolean {
  const t = (text ?? "").trim();
  return (
    /^Facebook created this chat because\b/i.test(t) ||
    (/^[^\n]{1,80}?\b(?:replied to|commented on)\s+(?:a|an|your)\s+(?:post|ad|reel|video|photo|comment)\b/i.test(t) &&
      /\bSee\s+(?:post|comment)\s*\(\s*https?:\/\/(?:www\.|m\.)?facebook\.com\//i.test(t))
  );
}

// Só o aviso de chat NOVO (criado pelo comentário) tem o comment_id e a regra
// da resposta privada; "X replied to a post" cai numa thread que já existe.
export function isCommentChatCreatedNotice(text: string): boolean {
  return /^\s*Facebook created this chat because\b/i.test(text ?? "");
}

// Id do comentário no link "See comment(...)": comment_id é a parte local (o id
// da Graph é "<objeto>_<local>"); comment_gqlid, quando vem, é base64 de
// "comment:<objeto>_<local>" — o id completo.
export function commentIdFromNotice(text: string): { localId: string | null; fullId: string | null } {
  const t = text ?? "";
  const localId = t.match(/[?&]comment_id=(\d{6,})/)?.[1] ?? null;
  let fullId: string | null = null;
  const gql = t.match(/[?&]comment_gqlid=([^&)\s]+)/)?.[1];
  if (gql) {
    try {
      const decoded = Buffer.from(decodeURIComponent(gql), "base64").toString("utf8");
      fullId = decoded.match(/^comment:(\d+_\d+)$/)?.[1] ?? null;
    } catch {
      fullId = null;
    }
  }
  if (fullId && localId && !fullId.endsWith(`_${localId}`)) fullId = null;
  return { localId, fullId };
}

// Thread que só existe por causa de um comentário e ainda não recebeu nada
// nosso entregue: a próxima mensagem do bot tem que sair como resposta privada.
export function commentChatAwaitingFirstReply(rows: Array<{ role: string; content: string }>): boolean {
  const createdByComment = rows.some((r) => r.role === "user" && (isCommentChatCreatedNotice(r.content) || r.content === COMMENT_CHAT_MARKER));
  if (!createdByComment) return false;
  return !rows.some((r) => r.role === "assistant" && !/\[SYSTEM: ?SEND_FAILED\]/.test(r.content ?? ""));
}
