// Verificação dos achados da revisão adversarial (28/08/2026). READ-ONLY.
import { clientEngagedScheduling, stripReasoningLeak, stripSchedulingPush, recapForDuplicateReply } from "../src/lib/ai";
import { detectLang } from "../src/lib/scheduler";

let bad = 0;
const line = (ok: boolean, label: string, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "BUG "} ${label}${extra ? "  « " + extra + " »" : ""}`);
};

console.log("\n=== 1. clientEngagedScheduling: FALSOS NEGATIVOS (guard apaga o horário) ===");
const shouldEngage = [
  "I'm flexible", "flexible", "whatever works", "whatever works best", "as early as possible",
  "as early as you can", "either one", "either is fine", "either day", "whichever", "up to you",
  "doesn't matter", "right away", "I'm free", "im free", "you choose", "you pick", "yes please",
  "amanhã", "amanhã pode ser", "o mais cedo possível", "quanto antes", "qualquer horário",
  "quando puder", "estou livre", "estou disponível", "el más pronto posible", "cualquier horario",
  "cuando puedas", "estoy libre", "estoy disponible", "lo que sea mejor", "el que sea",
];
for (const t of shouldEngage) line(clientEngagedScheduling(t), `engaja: ${JSON.stringify(t)}`);

console.log("\n=== 1b. FALSOS POSITIVOS (guard desligado à toa — brando) ===");
const shouldNotEngage = [
  "is the estimate free?", "do you offer free samples?", "I saw your ad today",
  "how thick is the vinyl?", "what is the warranty?", "hoje vi o anúncio de vocês",
];
for (const t of shouldNotEngage) line(!clientEngagedScheduling(t), `NÃO engaja: ${JSON.stringify(t)}`);

console.log("\n=== 2. \\b com acento (amanhã / sábado) ===");
line(/\b(amanh[ãa])\b/i.test("amanhã"), "regex \\b(amanhã)\\b casa 'amanhã'");
line(/\b(amanh[ãa])\b/i.test("amanha"), "regex \\b(amanhã)\\b casa 'amanha' (sem acento)");

console.log("\n=== 3. stripReasoningLeak: vocabulário NOVO da nota vaza? ===");
const leaks = [
  "The soonest day first rule says I should offer Monday. I have Monday at 9am or 11am, which works better for you?",
  "There are no empty hours to fill, so I have Monday at 9am or 11am, which works better?",
  "The priority day is Monday and it is 50% booked. I have 9am or 11am, which works better?",
  "Per the owner's rule I fill from the first hour. I have Monday at 9am or 11am, does that work?",
  "The offer first times are 9am and 11am, and also open are 1pm and 3pm. Which works better for you?",
];
for (const t of leaks) {
  const out = stripReasoningLeak(t);
  const clean = !/soonest day first|no empty hours|owner'?s rule|offer first|also open|priority day|% booked|fill from the first hour/i.test(out);
  line(clean, `scrubber limpa: ${JSON.stringify(t.slice(0, 55))}`, clean ? "" : out.slice(0, 110));
}

console.log("\n=== 4. stripReasoningLeak NÃO pode comer resposta legítima ===");
const legit = [
  "The earliest I have is Monday at 9am or 11am, which works better for you?",
  "I have today at 3pm or 5pm, which one works better?",
  "Lo más pronto que tengo es el lunes a las 9am o 11am, cuál te queda mejor?",
  "O mais cedo que tenho é segunda às 9am ou 11am, qual fica melhor para você?",
];
for (const t of legit) line(stripReasoningLeak(t).trim() === t.trim(), `intacta: ${JSON.stringify(t.slice(0, 55))}`, stripReasoningLeak(t));

console.log("\n=== 5. stripSchedulingPush não pode mutilar a oferta legítima ===");
for (const t of legit) {
  const out = stripSchedulingPush(t);
  line(/\d\s*(am|pm)/i.test(out), `mantém horário: ${JSON.stringify(t.slice(0, 45))}`, out);
}

console.log("\n=== 6. detectLang / recap: espanhol SEM ¿¡ ainda é 'es'? ===");
const esNoMarks = [
  "Hola, cual es el precio de instalacion?",
  "Perfecto! Para ese dia tengo disponible 9am o 11am, a que hora te queda mejor?",
  "Que dia te queda mejor para la visita?",
  "Buenas, quiero cambiar el piso de la sala. Cuanto cuesta?",
];
for (const t of esNoMarks) line(detectLang(t) === "es", `detectLang=es: ${JSON.stringify(t.slice(0, 50))}`, detectLang(t));

console.log("\n--- recapForDuplicateReply (prefixo tem que ser ES) ---");
for (const t of ["Que dia te queda mejor para la visita?", "Tengo el lunes a las 9am o 11am, cual prefieres?"]) {
  const out = recapForDuplicateReply([], t) ?? "";
  line(!/^As I mentioned|^Like I said/i.test(out), `prefixo ES: ${JSON.stringify(t.slice(0, 45))}`, out.slice(0, 70));
}

console.log(`\n${bad === 0 ? "TUDO OK" : `${bad} PROBLEMA(S) CONFIRMADO(S)`}`);
