/**
 * REVISÃO ADVERSARIAL 28/08/2026 — guardas das 7 correções.
 *
 * Origem: revisão multiagente (7 lentes) sobre as regras do dono de 28/08
 * (dia mais próximo primeiro, primeiros horários do dia, rota só escolhe o
 * vendedor, espanhol sem ¿¡). Cada bloco abaixo trava um defeito que foi
 * REPRODUZIDO antes da correção:
 *
 *  1. GRAVADO ≠ ENVIADO: o strip de ¿¡ acontece no envio; se o INSERT gravasse
 *     o texto original, o eco do Messenger/IG não bateria com a linha do banco
 *     → "[Treino] ..." + mode=human → lead mudo (incidente de 03/08).
 *  2. clientEngagedScheduling: 32 de 33 respostas reais ("I'm flexible",
 *     "either one", "you choose", "amanhã", "quanto antes") não engajavam e o
 *     guard anti-pressão apagava a frase COM o horário.
 *  3. Corte de hoje nas enlatadas era 30 min, mas createBooking exige 120 →
 *     o bot oferecia hoje às 18h e depois recusava o próprio agendamento.
 *  4. Scrubber não conhecia o vocabulário novo da nota ("no empty hours",
 *     "soonest day first", "owner's rule").
 *  5. recapForDuplicateReply decidia o idioma pelo "¿" — que não existe mais.
 *  6. Prompt se contradizia: "offer 2 specific available DAYS" e exemplo com
 *     TRÊS horários em DOIS dias logo abaixo do SOONEST DAY FIRST.
 *  7. SLOT_DAY_REF: o \b do JS é ASCII e nunca fechava depois de "amanhã",
 *     "sábado", "mañana", "miércoles" — cliente PT/ES confirmando o dia por
 *     extenso não era reconhecido.
 *
 * Run: npx tsx src/evals/review-fixes-2808-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { clientEngagedScheduling, stripReasoningLeak, recapForDuplicateReply } from "../lib/ai";
import { stripInvertedPunctuation, stripInternalMarkers } from "../lib/outbound-text";
import { detectLang, clientConfirmedSlot } from "../lib/scheduler";

let pass = 0;
const fails: string[] = [];
function ck(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 220)}»`);
  }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");

console.log("\n━━ 1. GRAVADO == ENVIADO (espanhol sem ¿¡ não pode virar eco órfão) ━━");
{
  ck("stripInvertedPunctuation apaga ¿ e ¡", stripInvertedPunctuation("¡Perfecto! ¿Cuál te queda mejor?") === "Perfecto! Cuál te queda mejor?");
  ck("o envio (stripInternalMarkers) aplica o mesmo strip", stripInternalMarkers("¿Te funciona?") === "Te funciona?");
  // Todo produtor que ENVIA e GRAVA tem que gravar o texto já limpo.
  const producers: Array<[string, string]> = [
    ["src/lib/followup.ts", "followup (nudge)"],
    ["src/app/api/enviar/route.ts", "/api/enviar (Ozzi Plataforma)"],
    ["src/app/api/confirmar-instalacao/route.ts", "confirmar-instalacao"],
    ["src/app/api/conversations/[id]/send/route.ts", "painel (envio manual)"],
  ];
  for (const [file, label] of producers) {
    const s = src(file);
    const insertsRaw = /content:\s*(?:text|body\.text)\s*[,+]/.test(s);
    ck(`${label}: grava o texto JÁ limpo (nunca o original)`, s.includes("stripInvertedPunctuation") && !insertsRaw, file);
  }
}

console.log("\n━━ 2. clientEngagedScheduling: 'você escolhe' / 'o mais cedo' é engajamento ━━");
{
  const engaja = [
    "I'm flexible", "flexible", "whatever works", "whatever works best", "as early as possible",
    "as early as you can", "either one", "either is fine", "either day", "whichever", "up to you",
    "you choose", "you pick", "doesn't matter", "no preference", "right away", "I'm free", "im free",
    "the sooner the better",
    "el más pronto posible", "cualquier horario", "cuando puedas", "estoy libre", "estoy disponible",
    "lo que sea mejor", "tú decides", "como prefieras",
    "amanhã", "amanhã pode ser", "o mais cedo possível", "quanto antes", "qualquer horário",
    "quando puder", "estou livre", "estou disponível", "você escolhe", "tanto faz",
  ];
  for (const t of engaja) ck(`engaja: ${JSON.stringify(t)}`, clientEngagedScheduling(t), t);
  // Não pode virar um "sempre true": pergunta informativa sem nada de agenda continua fora.
  const naoEngaja = ["Is the vinyl waterproof and how thick is it?", "what is the warranty?", "do you offer free samples?", "Qual a garantia do piso?"];
  for (const t of naoEngaja) ck(`NÃO engaja (informativa): ${JSON.stringify(t)}`, !clientEngagedScheduling(t), t);
  // O [SYSTEM:] com a agenda nunca pode contar como fala do cliente.
  ck("bloco [SYSTEM:] não conta como engajamento do cliente", !clientEngagedScheduling("How thick is it?\n\n[SYSTEM: REAL-TIME SCHEDULE: Monday 9am, 11am, tomorrow 1pm]"));
}

console.log("\n━━ 3. Corte de HOJE: enlatadas usam o MESMO limite do booking (120 min) ━━");
{
  const s = src("src/lib/scheduler.ts");
  ck("SAME_DAY_MIN_NOTICE_MIN = 120", /export const SAME_DAY_MIN_NOTICE_MIN = 120;/.test(s));
  ck("nenhuma enlatada usa mais o corte de 30 min", !/nowET\.hour \* 60 \+ nowET\.minute \+ 30\b/.test(s), (s.match(/.{0,60}minute \+ 30.{0,40}/) ?? [""])[0]);
  const cutoffs = s.match(/nowET\.hour \* 60 \+ nowET\.minute \+ SAME_DAY_MIN_NOTICE_MIN/g) ?? [];
  ck("needTimeChoiceMessage e slotConflictRecoveryMessage usam a constante (>= 2 usos)", cutoffs.length >= 2, `${cutoffs.length} usos`);
}

console.log("\n━━ 4. Scrubber conhece o vocabulário NOVO da nota ━━");
{
  const leaks = [
    "The soonest day first rule says Monday. I have Monday at 9am or 11am, which works better for you?",
    "The priority day is Monday and it is 50% booked. I have 9am or 11am, which works better?",
    "Per the owner's rule I fill from the first hour. I have Monday at 9am or 11am, does that work?",
    "The offer first times are 9am and 11am, and also open are 1pm and 3pm. Which works better for you?",
  ];
  for (const t of leaks) {
    const out = stripReasoningLeak(t);
    ck(`limpa: ${JSON.stringify(t.slice(0, 46))}`, !/soonest day first|owner'?s rule|offer first|also open|priority day|% booked|first hour/i.test(out), out);
  }
  // A resposta legítima tem que sobreviver inteira ("earliest" sozinho é do cliente).
  const legit = [
    "The earliest I have is Monday at 9am or 11am, which works better for you?",
    "I have today at 3pm or 5pm, which one works better?",
    "Lo más pronto que tengo es el lunes a las 9am o 11am, cuál te queda mejor?",
    "O mais cedo que tenho é segunda às 9am ou 11am, qual fica melhor para você?",
  ];
  for (const t of legit) ck(`intacta: ${JSON.stringify(t.slice(0, 46))}`, stripReasoningLeak(t).trim() === t.trim(), stripReasoningLeak(t));
}

console.log("\n━━ 5. recapForDuplicateReply: idioma por detectLang, não por '¿' ━━");
{
  ck("ai.ts usa detectLang no recap", /const lang: "en" \| "es" \| "pt" = detectLang\(reply\);/.test(src("src/lib/ai.ts")));
  const es = recapForDuplicateReply([], "Que dia te queda mejor para la visita?") ?? "";
  ck("recap de resposta ES (sem ¿) NÃO leva prefixo em inglês", !/^As I mentioned|^Like I said/i.test(es), es.slice(0, 80));
  const pt = recapForDuplicateReply([], "Qual dia fica melhor para você para a visita?") ?? "";
  ck("recap de resposta PT leva prefixo em português", /^como|^conforme/i.test(pt), pt.slice(0, 80));
}

console.log("\n━━ 6. Prompt sem contradição com DIA MAIS PRÓXIMO + PRIMEIROS HORÁRIOS ━━");
{
  const sp = src("src/lib/system-prompt.ts");
  ck("STEP 2B pede 2 HORÁRIOS do dia mais próximo (não '2 dias')", /exactly 2 specific available TIMES/.test(sp) && !/Always offer 2 specific available days/.test(sp));
  ck("exemplo do STEP 2B não oferece dois dias sem horário", !/I have \[day\] and \[day\] open/.test(sp));
  const sc = src("src/lib/scheduler.ts");
  ck("exemplo da agenda não mostra mais 3 horários em 2 dias", !/Wednesday at 3pm, or Thursday at 9am or 11am/.test(sc));
  ck("regra SOONEST DAY FIRST continua na agenda", /SOONEST DAY FIRST/.test(sc) && /EARLIEST two open times/.test(sc));
  ck("regra 33 do prompt pede os primeiros horários do dia mais próximo", /EARLIEST open times \(its first two listed, 9am before 11am before 1pm\)/.test(src("src/lib/ai.ts")));
}

console.log("\n━━ 7. Dia por extenso com acento (PT/ES) é reconhecido ━━");
{
  const A = (content: string) => ({ role: "assistant", content });
  const U = (content: string) => ({ role: "user", content });
  ck("SLOT_DAY_REF sem \\b final (acento fecha)", /amanh\[ãa\]\)\(\?!\[a-zà-ÿ\]\)/.test(src("src/lib/scheduler.ts")));
  // clientConfirmedSlot: o cliente escolhe o dia por extenso, com acento.
  const casos: Array<[string, string]> = [
    ["amanhã às 9am", "pt"],
    ["o sábado às 11am fica bom", "pt"],
    ["mañana a las 9am", "es"],
    ["el miércoles a las 11am", "es"],
  ];
  for (const [msg, lang] of casos) {
    const hist = [A("Tenho amanhã às 9am ou 11am, qual fica melhor?"), U(msg)];
    ck(`cliente ${lang} confirma "${msg}" → slot reconhecido`, clientConfirmedSlot(hist as never), msg);
  }
  ck("detectLang continua certo sem ¿¡", detectLang("Hola, cual es el precio de instalacion?") === "es");
}

console.log(`\n${fails.length === 0 ? "✅" : "❌"} review-fixes-2808-verify: ${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log("FAILED:\n - " + fails.join("\n - "));
  process.exit(1);
}
