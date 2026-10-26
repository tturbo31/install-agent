// Patch CRLF-safe #2 (26/10/2026): a exceção do anti-pressão dura enquanto nenhum horário foi
// ofertado desde a resposta de localização (o "ok" depois do turno sem horário ainda recebe a oferta).
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  {
    file: "src/lib/ai.ts",
    find: String.raw`  // Resposta ao pedido de ZIP (fluxo restaurado 29/09/2026): nossa última
  // mensagem pediu o ZIP na proposta da visita e o cliente respondeu com o
  // ZIP, a cidade ou uma resposta curta sem pergunta → o próximo turno DEVE
  // oferecer os horários; isso é o fluxo, não pressão. Uma pergunta
  // informativa SEM o ZIP ("is it waterproof?") continua protegida. O endereço
  // completo ("50 Biscayne blvd, Miami 33132", Dragos 26/10/2026) e o ZIP
  // dentro de uma frase contam como resposta (isLocationAnswer), e o pedido do
  // ZIP vale mesmo sem a palavra "visit" na frase (asksForZip).
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastMsg?.role === "user" && lastAssistant && (isVisitProposalWithZipAsk(lastAssistant.content) || asksForZip(lastAssistant.content)) && isLocationAnswer(lastMsg.content)) {
    return false;
  }`,
    replace: String.raw`  // Resposta ao pedido de ZIP (fluxo restaurado 29/09/2026): pedimos o ZIP na
  // proposta da visita e o cliente respondeu com o ZIP, a cidade ou uma
  // resposta curta sem pergunta → o próximo turno DEVE oferecer os horários;
  // isso é o fluxo, não pressão. Uma pergunta informativa SEM o ZIP ("is it
  // waterproof?") continua protegida.
  // Dragos (wa_17738995511, 26/10/2026): o endereço completo ("50 Biscayne
  // blvd, Miami 33132") e o ZIP dentro de uma frase contam como resposta
  // (isLocationAnswer); o pedido do ZIP vale sem a palavra "visit" na frase
  // (asksForZip); e a exceção dura enquanto NENHUM horário foi ofertado desde o
  // pedido: depois do turno que saiu sem horário ("33132 is covered, we're in
  // that area all the time."), um "ok" ou uma pergunta do cliente ainda recebe
  // a primeira oferta, que nunca é repetição. A rede volta a valer assim que
  // uma mensagem nossa pôs um horário na mesa.
  let lastZipAsk = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && (isVisitProposalWithZipAsk(messages[i].content) || asksForZip(messages[i].content))) { lastZipAsk = i; break; }
  }
  if (lastMsg?.role === "user" && lastZipAsk >= 0) {
    const since = messages.slice(lastZipAsk + 1);
    const answered = since.some((m) => m.role === "user" && isLocationAnswer(m.content));
    const offeredSince = since.some((m) => m.role === "assistant" && isSchedulingPush(m.content.split(/\n\n?\[SYSTEM:/)[0]));
    if (answered && !offeredSince) return false;
  }`,
  },
]);
