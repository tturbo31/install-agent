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
    .replace(/\n{0,2}\[SYSTEM: ?(?:FOLLOWUP_NUDGE|QUOTE_FOLLOWUP[^\]]*)\]/g, "")
    .trim();
}
