// ─── Última barreira antes de qualquer texto sair para uma pessoa ───────────
// Mensagens gravadas no banco carregam marcadores internos junto do texto:
// "\n\n[SYSTEM: FOLLOWUP_NUDGE]" (dedup da nudge do Direct, followup.ts) e
// "\n\n[SYSTEM: QUOTE_FOLLOWUP {...}]" (contexto do quote, quote-reply.ts).
// Eles existem SÓ para o banco — mas em 2026-07-22 o resgate de respostas
// fantasmas (/api/ig-diag?rescue=) reenviou o conteúdo cru e um cliente recebeu
// "[SYSTEM: FOLLOWUP_NUDGE]" no Instagram. Todo envio (IG/FB/WA) passa por esta
// função para que nenhum caminho — atual ou futuro — repita isso.
//
// Remove (não trunca): alertas ao dono citam transcrições que podem conter um
// marcador no MEIO do texto, e cortar dali em diante engoliria o resto do alerta.
export function stripInternalMarkers(text: string): string {
  return (text || "")
    .replace(/\n{0,2}\[SYSTEM: ?(?:FOLLOWUP_NUDGE|QUOTE_FOLLOWUP[^\]]*|SEND_FAILED)\]/g, "")
    .trim();
}

// Sufixo gravado quando o envio FALHOU em definitivo (incidente FB 2026-07-22
// 14:38 UTC: blip transitório do Graph sobreviveu às 2 tentativas e o cliente
// ficou mudo até resgate manual). A resposta fica no banco marcada como
// não-entregue e retryFailedSends (delivery.ts) reenvia sozinho por até 48h.
export const SEND_FAILED_DB_SUFFIX = "\n\n[SYSTEM: SEND_FAILED]";
