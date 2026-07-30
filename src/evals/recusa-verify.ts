// Regression guard for the quote-follow-up REFUSAL detector (2026-07-30).
// A refusal ("not interested", "stop texting me", "already hired someone
// else") makes the wa-webhook send followup_respondeu with recusou=true, and
// the platform then blocks that phone from EVERY future follow-up (automatic
// and the manual screen). A false positive silences a client forever, so the
// negative cases here matter as much as the positives: deferrals, financing
// questions, and "stop by" must NEVER read as refusals.
// Pure-function tests — deterministic, instant, ZERO API calls and ZERO sends.
// Run: npx tsx src/evals/recusa-verify.ts
import { isQuoteRefusal } from "@/lib/quote-reply";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}`); }
}

console.log("\n— RECUSAS explícitas (devem detectar) —");
const recusas = [
  "I'm not interested, thanks",
  "No longer interested",
  "We lost interest in the project",
  "Please stop texting me",
  "stop",
  "STOP.",
  "Please stop",
  "Stop messaging me please",
  "unsubscribe",
  "Don't text me again",
  "don't contact me",
  "Take me off your list",
  "Remove me from this list",
  "leave me alone",
  "You have the wrong number",
  "wrong person, sorry",
  "We already hired someone else",
  "We found someone else to do it",
  "we went with someone else",
  "We signed with another company",
  "we went another direction",
  "No me interesa, gracias",
  "no nos interesa",
  "No estoy interesada",
  "ya no me interesa",
  "ya no quiero",
  "no me escriban mas",
  "No me llamen más por favor",
  "deja de mandar mensajes",
  "Ya contratamos a otra empresa",
  "ya contraté otro",
  "lo hicimos con otra empresa",
  "numero equivocado",
  "quítame de la lista",
  "Não tenho interesse",
  "sem interesse, obrigado",
  "não quero mais",
  "Já fechamos com outra empresa",
  "para de me mandar mensagem",
  "número errado",
];
for (const t of recusas) check(`recusa: "${t}"`, isQuoteRefusal(t) === true);

console.log("\n— NÃO-recusas (nunca podem detectar) —");
const naoRecusas = [
  // interesse / dúvidas — o caminho feliz do follow-up
  "Yes, tell me about the financing",
  "How does the financing work?",
  "I pay full, no financing needed",
  "What was my quote total again?",
  "Can you resend the quote?",
  "quiero saber mas del financiamiento",
  "Sí, me interesa",           // "me interesa" positivo não pode casar com "no me interesa"
  "I'm interested in moving forward",
  "we are very interested",
  // adiamentos — encerram a cadência mas NÃO são recusa permanente
  "I'll let you know next month",
  "vou pensar e te aviso",
  "let me talk to my husband first",
  "lo voy a pensar",
  "not right now, maybe later this year",
  // frases com "stop" que não são opt-out
  "Can you stop by tomorrow to measure?",
  "we made a stop at the store to see samples",
  "the bus stop is next to my house",
  // conversa normal
  "Thanks!",
  "ok",
  "Who is this?",
  "How much was it for the whole house?",
  "ya firmamos el contrato con ustedes",  // fechou COM a Ozzi — não é recusa
  "we already signed your quote yesterday",
];
for (const t of naoRecusas) check(`não-recusa: "${t}"`, isQuoteRefusal(t) === false);

console.log("\n— marcador [SYSTEM:] nunca conta —");
check("texto limpo + sufixo SYSTEM não vira recusa", isQuoteRefusal("Yes, sounds good\n\n[SYSTEM: not interested]") === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
