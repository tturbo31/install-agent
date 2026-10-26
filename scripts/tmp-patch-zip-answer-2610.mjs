// Patch CRLF-safe (26/10/2026): resposta ao pedido de ZIP com ENDEREÇO completo não é "pressão"
// (Dragos wa_17738995511) + "Let me offer you ..." não é monólogo. String.raw: nada de escape duplo.
import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  {
    file: "src/lib/ai.ts",
    find: String.raw`// Resposta curta de localização ("33024", "Homestead", "Coral Gables FL"):
// sem pergunta, até 4 palavras.
export function isLocationAnswer(userText: string): boolean {
  const t = (userText || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  return t.split(/\s+/).length <= 4 && !/\?/.test(t);
}`,
    replace: String.raw`// Resposta de localização ao nosso pedido de ZIP: "33024", "Homestead", "Coral
// Gables FL" (curta, sem pergunta) OU o ZIP / o ENDEREÇO em qualquer frase.
// Dragos (wa_17738995511, 26/10/2026 11:45) respondeu "50 Biscayne blvd, Miami
// 33132": cinco palavras, a regra das 4 palavras não reconheceu a resposta, o
// anti-pressão disparou (nossa proposta da visita conta como push) e comeu a
// oferta de horários; o cliente recebeu só "33132 is covered, we're in that
// area all the time." e nenhum horário (reproduzido ao vivo 2/2). Um ZIP ou um
// número + rua no texto É a resposta à nossa pergunta, com ou sem uma pergunta
// do cliente junto ("33132, is the quarter round included?"): o modelo responde
// e oferece os horários, que é o fluxo, não pressão.
const STREET_ADDRESS = /\b\d{1,6}[a-z]?\s+(?:(?:[nsew]{1,2}\.?|north|south|east|west|northwest|northeast|southwest|southeast)\s+)?(?:[a-z0-9'.-]+\s+){0,4}(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|(?<!\b(?:the|a|my|no|any|that|this|one|other|either|same|long|right|wrong|best|only)\s)way|ter|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|trl|trail|calle|avenida|rua)\b/i;
export function isLocationAnswer(userText: string): boolean {
  const t = (userText || "").split(/\n\n?\[SYSTEM:/)[0].trim();
  if (!t) return false;
  if (zipsInText(t).length > 0 || STREET_ADDRESS.test(t)) return true;
  return t.split(/\s+/).length <= 4 && !/\?/.test(t);
}

// Nossa mensagem pediu o ZIP, com ou sem a proposta da visita na mesma frase
// ("Yes, 100% waterproof. What's the zip code of the property?").
export function asksForZip(text: string): boolean {
  const t = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  return /\bzip\b|c[oó]digo\s+postal|\bcep\b/i.test(t) && /\?/.test(t);
}`,
  },
  {
    file: "src/lib/ai.ts",
    find: String.raw`  // oferecer os horários; isso é o fluxo, não pressão. Uma pergunta
  // informativa ("is it waterproof?") continua protegida.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastMsg?.role === "user" && lastAssistant && isVisitProposalWithZipAsk(lastAssistant.content) && isLocationAnswer(lastMsg.content)) {
    return false;
  }`,
    replace: String.raw`  // oferecer os horários; isso é o fluxo, não pressão. Uma pergunta
  // informativa SEM o ZIP ("is it waterproof?") continua protegida. O endereço
  // completo ("50 Biscayne blvd, Miami 33132", Dragos 26/10/2026) e o ZIP
  // dentro de uma frase contam como resposta (isLocationAnswer), e o pedido do
  // ZIP vale mesmo sem a palavra "visit" na frase (asksForZip).
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (lastMsg?.role === "user" && lastAssistant && (isVisitProposalWithZipAsk(lastAssistant.content) || asksForZip(lastAssistant.content)) && isLocationAnswer(lastMsg.content)) {
    return false;
  }`,
  },
  {
    file: "src/lib/reasoning-leak.ts",
    find: String.raw`    /\blet\s+me\s+offer\b/.source,`,
    replace: String.raw`    // "Let me offer Wednesday 7pm or Thursday 6pm. Then ask for the address."
    // (Julie) is the model planning; "Let me offer you Wednesday at 9am or
    // 6pm, which works?" is said TO the client and shipped as "33132 is
    // covered." alone when this signal ate it (Dragos check, 26/10/2026).
    /\blet\s+me\s+offer\b(?!\s+you\b)/.source,`,
  },
]);
