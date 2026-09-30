/**
 * Horário ACEITO que já encheu + [BOOK] no dia errado — caso wa_17329668249
 * (WhatsApp, 30/09/2026).
 *
 *  8:41  bot: "Today I have 6pm or 8pm, which works better for you?"
 *  8:42  bot: "Today I only have 6pm or 8pm, but Sunday I have 9am or 1pm..."
 * 10:33  (outro cliente ocupa o 6pm de hoje: era o único 18:00 do dia)
 * 12:53  cliente: "Ok 6 will work"  → bot: "Perfect, I'm holding that 6pm for you!"
 * 12:56  cliente: endereço           → bot: "That exact time isn't open on my end,
 *                                       but that same day I can do 9am, 11am or 1pm."
 *
 * Duas falhas: (1) nada conferia o horário ACEITO contra a agenda, o modelo
 * "segurou" um 6pm que já não existia; (2) o [BOOK] de hoje 18:00 foi jogado
 * para DOMINGO por reconcileBookingWeekday (a última fala do bot com dia da
 * semana era a do domingo e o cliente nunca digitou "today"), domingo não tem
 * 18:00, e a recuperação ofereceu as manhãs de domingo.
 *
 *  A. DETERMINÍSTICO: acceptedOfferSlot resolve o par (dia, hora) aceito;
 *     reconcileBookingWeekday com a hora do [BOOK] mantém hoje / devolve o
 *     domingo para hoje; acceptedSlotGone gera nota + enlatada; backstop
 *     replyIgnoresGoneSlot; as enlatadas EN/ES/PT são lidas por
 *     parseSlotGoneApology (a nota "já pedi desculpa" do turno seguinte).
 *  B. ESTÁTICO: os 3 webhooks injetam a nota, aplicam o backstop e passam a
 *     hora do [BOOK] para a guarda de weekday.
 *  C. AO VIVO (DB, só leitura): slotConflictRecoveryMessage assume o horário
 *     aceito em vez de "That exact time isn't open on my end".
 *  D. AO VIVO (modelo): turno "Ok 6 will work" com o 6pm fora da linha de hoje
 *     → resposta assume e oferece o horário real; turno do endereço → o [BOOK]
 *     sai para HOJE depois da guarda. Nada é gravado.
 * DET_ONLY=1 pula C e D.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, parseSlotGoneApology, forcedBookRetryReason, retryForBookTag, isAskingForBookingInfo, type ChatMessage } from "../lib/ai";
import { tightenedIsSafe } from "../lib/reply-length";
import {
  acceptedOfferSlot, acceptedSlotGone, acceptedSlotGoneReply, replyIgnoresGoneSlot, reconcileBookingWeekday, bookingEpisodeHistory,
  clientConfirmedSlot, dayOnlyPickNeedsTime, bookedTimeSeenInConversation, bookedSlotMismatchesPromise, slotConflictRecoveryMessage,
  easternTodayStr, getEasternDateContext, getRealAvailabilityContext,
} from "../lib/scheduler";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); process.env[m[1]] = v; }
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 360)}»`); }
}
const U = (content: string): ChatMessage => ({ role: "user", content });
const A = (content: string): ChatMessage => ({ role: "assistant", content });
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wdOf = (s: string) => new Date(s + "T12:00:00Z").getUTCDay();
const display = (s: string) => { const d = new Date(s + "T12:00:00Z"); return `${DAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };

const today = easternTodayStr();
const tomorrow = addDays(today, 1);
// O "domingo" da conversa real vira um dia da semana que NÃO é hoje (o eval roda em qualquer dia).
const other = addDays(today, 4);
const OTHER = DAY_NAMES[wdOf(other)];

// A conversa real (sem timestamps: "today" resolve para o dia em que o eval roda).
const REAL: ChatMessage[] = [
  U("What is the installation process?"),
  A("We move all the furniture, install the tile, and leave the space clean and ready, usually done in 2 to 3 days. Is it just one area or the whole house?"),
  A("Hi, want me to check a time this week for your free estimate visit? I bring all the samples and you get the exact price on the spot.\n\n[SYSTEM: FOLLOWUP_NUDGE]"),
  U("Ok what about tomorrow?"),
  U("North Miami"),
  A("Tomorrow works! I have Thursday at 3pm or 8pm, which one is better for you?"),
  U("Can you come today?"),
  A("Today I have 6pm or 8pm, which works better for you?"),
  U("You can do before noon ?"),
  A(`Today I only have 6pm or 8pm, but ${OTHER} I have 9am or 1pm if mornings work better for you.`),
  U("The house it’s in north Miami"),
  A("North Miami is covered, no problem. Today I have 6pm or 8pm, which works for you?"),
  U("Ok I will let you know later"),
  U("Ok 6 will work"),
];
const HOLD = A("Perfect, I'm holding that 6pm for you! What's the full property address with the zip code?");
const ADDRESS = U("835 ne 171 st 33162");
const REAL_BOOK_TURN: ChatMessage[] = [...REAL, HOLD, ADDRESS];

function schedule(lines: Array<[string, string]>): string {
  return ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):", ...lines.map(([d, t]) => `• ${display(d)} [${d}]: ${t}`)].join("\n");
}

async function main() {
  console.log("\n[A] DETERMINÍSTICO — acceptedOfferSlot");
  {
    const acc = acceptedOfferSlot(REAL);
    ck("'Ok 6 will work' → o 6pm de HOJE (a oferta dizia 'Today')", !!acc && acc.date === today && acc.time === "18:00" && acc.label === "6pm" && acc.hour12 === 6, JSON.stringify(acc));
    const acc2 = acceptedOfferSlot(REAL_BOOK_TURN);
    ck("endereço depois da escolha: a escolha continua sendo hoje 18:00", !!acc2 && acc2.date === today && acc2.time === "18:00", JSON.stringify(acc2));
    const pref8 = acceptedOfferSlot([...REAL.slice(0, -1), U("I prefer 8")]);
    ck("'I prefer 8' → hoje 20:00 (Annabelle)", !!pref8 && pref8.date === today && pref8.time === "20:00", JSON.stringify(pref8));
    const six = acceptedOfferSlot([...REAL.slice(0, -1), U("6pm works")]);
    ck("'6pm works' → hoje 18:00", !!six && six.date === today && six.time === "18:00", JSON.stringify(six));
    const colon = acceptedOfferSlot([...REAL.slice(0, -1), U("Let's do 6:00")]);
    ck("'6:00' sem am/pm → pm da oferta (18:00)", !!colon && colon.time === "18:00", JSON.stringify(colon));
    ck("contraproposta 'can you do 4pm?' → null", acceptedOfferSlot([...REAL.slice(0, -1), U("can you do 4pm?")]) === null);
    ck("troca de dia 'actually tomorrow?' → null (a escolha antiga não vale)", acceptedOfferSlot([...REAL, HOLD, U("actually can we do tomorrow?")]) === null);
    ck("mensagem de dia sem hora ('Thursday is fine') → null (fica com a guarda de weekday)", acceptedOfferSlot([A("I have Thursday at 7pm or Friday at 7pm"), U("Thursday is fine")]) === null);
    const first = acceptedOfferSlot([A("Today I have 6pm or 8pm, which works?"), U("the first one")]);
    ck("'the first one' → 18:00", !!first && first.time === "18:00" && first.date === today, JSON.stringify(first));
    const yes = acceptedOfferSlot([A("I can come today at 6pm, does that work?"), U("yes")]);
    ck("'yes' a oferta de UM horário → hoje 18:00", !!yes && yes.time === "18:00" && yes.date === today, JSON.stringify(yes));
    const echo = acceptedOfferSlot([A("Today I have 6pm or 8pm"), U("6"), A("Perfect, 6pm it is! What's the address?"), U("ok")]);
    ck("'ok' ao eco sem dia → o dia vem da oferta anterior (hoje)", !!echo && echo.time === "18:00" && echo.date === today, JSON.stringify(echo));
    const thu = acceptedOfferSlot([A("Tomorrow works! I have Thursday at 3pm or 8pm, which one is better for you?"), U("3pm")]);
    ck("'Thursday at 3pm or 8pm' + '3pm' → a próxima quinta", !!thu && wdOf(thu.date) === 4 && thu.time === "15:00" && thu.date >= today && thu.date <= addDays(today, 7), JSON.stringify(thu));
    const twoDays = acceptedOfferSlot([A("I have Thursday at 7pm or Friday at 5pm"), U("7pm")]);
    ck("'Thursday 7pm or Friday 5pm' + '7pm' → quinta", !!twoDays && wdOf(twoDays.date) === 4 && twoDays.time === "19:00", JSON.stringify(twoDays));
    const clientDay = acceptedOfferSlot([A("I have Thursday at 7pm or Friday at 5pm"), U("Friday at 7")]);
    ck("dia dito pelo CLIENTE vence: 'Friday at 7' → sexta 19:00", !!clientDay && wdOf(clientDay.date) === 5 && clientDay.time === "19:00", JSON.stringify(clientDay));
    ck("mesma hora nos dois dias + só a hora → ambíguo, null", acceptedOfferSlot([A("I have Thursday at 7pm or Friday at 7pm"), U("7pm")]) === null);
    const es = acceptedOfferSlot([A("Hoy tengo 6pm o 8pm, cuál te queda mejor?"), U("Las 6 está bien")]);
    ck("ES: 'Las 6 está bien' → hoy 18:00", !!es && es.date === today && es.time === "18:00", JSON.stringify(es));
    const morning = acceptedOfferSlot([A("Mañana tengo 9am o 11am, o el sábado por la mañana a las 9am"), U("mañana a las 9")]);
    ck("ES: 'la mañana' não é amanhã; 'mañana a las 9' → amanhã 09:00", !!morning && morning.date === tomorrow && morning.time === "09:00", JSON.stringify(morning));
    ck("sem oferta com horário → null", acceptedOfferSlot([A("What's the zip code?"), U("33162")]) === null);
    ck("histórico vazio → null", acceptedOfferSlot([]) === null);
  }

  console.log("\n[A] DETERMINÍSTICO — reconcileBookingWeekday com a hora do [BOOK]");
  {
    const ep = bookingEpisodeHistory(REAL_BOOK_TURN);
    const keep = reconcileBookingWeekday(today, ep, "18:00");
    ck("[BOOK] hoje 18:00 fica em hoje (antes: era jogado para o dia da frase antiga)", !keep.corrected && keep.date === today, JSON.stringify(keep));
    const back = reconcileBookingWeekday(other, ep, "18:00");
    ck(`[BOOK] ${OTHER} 18:00 volta para hoje (o cliente aceitou o 6pm de HOJE)`, back.corrected && back.date === today, JSON.stringify(back));
    const legacy = reconcileBookingWeekday(today, ep);
    ck("chamada antiga (sem hora): a oferta com DOIS dias não puxa a data para o dia da semana", !legacy.corrected && legacy.date === today, JSON.stringify(legacy));
    const otherHour = reconcileBookingWeekday(other, ep, "09:00");
    ck("[BOOK] com OUTRA hora (9am) não usa a escolha do 6pm (fica para as outras guardas)", otherHour.date === other || otherHour.corrected, JSON.stringify(otherHour));
    ck("as outras guardas seguem deixando passar hoje 18:00", clientConfirmedSlot(ep) && !dayOnlyPickNeedsTime(ep) && bookedTimeSeenInConversation(ep, "18:00") && !bookedSlotMismatchesPromise(ep, today, "18:00").mismatch);
    // O caso clássico continua protegido: "Thursday is fine" nunca vira sexta.
    const classic = [A("I have Thursday at 7pm or Friday at 7pm this week, which works better for you?"), U("Thursday is fine"), A("Perfect, what's the property address?"), U("6247 SW 139 ave.")];
    const fri = (() => { let d = addDays(today, 1); while (wdOf(d) !== 5) d = addDays(d, 1); return d; })();
    const c1 = reconcileBookingWeekday(fri, classic, "19:00");
    ck("'Thursday is fine' + [BOOK] sexta 19:00 → corrigido para quinta", c1.corrected && wdOf(c1.date) === 4, JSON.stringify(c1));
  }

  console.log("\n[A2] DETERMINÍSTICO — casos da auditoria de 21 dias (30/09): dia do mês, data numérica, endereço, mesmo dia da semana");
  {
    // Timestamps reais (ET): "today"/dia da semana resolvem a partir do dia da mensagem.
    const At = (m: ChatMessage, at: string): ChatMessage => ({ ...m, at });
    const ariadna = [At(A("Tuesday the 29th works great, I have 9am or 11am, which one is better for you?"), "2026-09-18T20:41:00-04:00"), At(U("11 am would work best"), "2026-09-18T20:41:30-04:00")];
    const a1 = acceptedOfferSlot(ariadna);
    ck("'Tuesday the 29th ... 9am or 11am' + '11 am' → dia 29 (antes: a terça seguinte, 22)", a1?.date === "2026-09-29" && a1?.time === "11:00", JSON.stringify(a1));
    const amanda = [At(A("I have 9am on Wednesday September 30 open, which gets you done before the other company arrives at 10. Want to lock that in? Just send me the full property address with the zip code and the best phone number."), "2026-09-23T14:19:00-04:00"), At(U("Yes thank you! 1296 Waterway Cove Dr Wellington FL 33414 9548170095"), "2026-09-23T14:33:00-04:00")];
    const a2 = acceptedOfferSlot(amanda);
    ck("'9am on Wednesday September 30' + 'Yes' → 30/09 (a data vem DEPOIS da hora; antes: a quarta do dia)", a2?.date === "2026-09-30" && a2?.time === "09:00", JSON.stringify(a2));
    const patri = [At(A("Este fin de semana está lleno, el próximo sábado 26 tengo a las 9am o 11am, cual te queda mejor?"), "2026-09-19T16:17:00-04:00"), At(U("El Próximo sábado a las 11am"), "2026-09-19T16:22:00-04:00"), At(U("Sabado 26 a las 11am"), "2026-09-19T16:22:30-04:00")];
    const a3 = acceptedOfferSlot(patri);
    ck("'sábado 26' dito num SÁBADO → 26/09 (antes: o próprio dia 19)", a3?.date === "2026-09-26" && a3?.time === "11:00", JSON.stringify(a3));
    const street = [At(A("Wednesday at 5pm works, does that time suit you?"), "2026-09-21T16:26:00-04:00"), At(U("Yes. 5pm is good 12955 sw 16th ct #310 Pembroke pines 33027. Use the entrance at Pines Blvd."), "2026-09-21T16:27:00-04:00")];
    const a4 = acceptedOfferSlot(street);
    ck("'16th ct' no endereço NÃO é dia 16: → quarta 23/09 17:00", a4?.date === "2026-09-23" && a4?.time === "17:00", JSON.stringify(a4));
    const numeric = [At(A("I have 9am on 9/30 open, want to lock that in?"), "2026-09-23T14:19:00-04:00"), At(U("yes please"), "2026-09-23T14:20:00-04:00")];
    const a5 = acceptedOfferSlot(numeric);
    ck("data numérica '9/30' → 30/09 09:00", a5?.date === "2026-09-30" && a5?.time === "09:00", JSON.stringify(a5));
    const sameWd = [At(A("Saturday I have 9am or 11am, which works?"), "2026-09-19T10:00:00-04:00"), At(U("11am"), "2026-09-19T10:01:00-04:00")];
    ck("'Saturday' dito num sábado sem 'next' → ambíguo, null", acceptedOfferSlot(sameWd) === null, JSON.stringify(acceptedOfferSlot(sameWd)));
    const nextWd = [At(A("Next Saturday I have 9am or 11am, which works?"), "2026-09-19T10:00:00-04:00"), At(U("11am"), "2026-09-19T10:01:00-04:00")];
    ck("'Next Saturday' dito num sábado → 26/09", acceptedOfferSlot(nextWd)?.date === "2026-09-26", JSON.stringify(acceptedOfferSlot(nextWd)));
    const tomorrowWd = [At(A("Tomorrow works! I have Thursday at 3pm or 8pm, which one is better for you?"), "2026-09-23T12:58:00-04:00"), At(U("8pm"), "2026-09-23T13:00:00-04:00")];
    ck("'Tomorrow ... Thursday at 3pm or 8pm' dito na quarta 23 → quinta 24", acceptedOfferSlot(tomorrowWd)?.date === "2026-09-24", JSON.stringify(acceptedOfferSlot(tomorrowWd)));
    // "Tomorrow works!" is an acknowledgement; the weekday the client actually read wins.
    const clash = [At(A("Tomorrow works! I have Friday at 3pm or 8pm"), "2026-09-23T12:58:00-04:00"), At(U("8pm"), "2026-09-23T13:00:00-04:00")];
    ck("'Tomorrow works! I have Friday...' dito na quarta → a sexta que o cliente leu (25/09)", acceptedOfferSlot(clash)?.date === "2026-09-25", JSON.stringify(acceptedOfferSlot(clash)));
    // A guarda nunca move um [BOOK] que está no dia que a própria oferta deu àquela hora.
    const d3 = addDays(today, 3);
    const WD3 = DAY_NAMES[wdOf(d3)];
    const fut = [A(`${WD3} at 5pm works, does that time suit you?`), U("Yes. 5pm is good 12955 sw 16th ct #310 Pembroke pines 33027.")];
    const keep = reconcileBookingWeekday(d3, fut, "17:00");
    ck(`[BOOK] no dia da oferta (${WD3} ${d3}) fica`, !keep.corrected && keep.date === d3, JSON.stringify(keep));
    const moved = reconcileBookingWeekday(addDays(d3, 7), fut, "17:00");
    ck(`[BOOK] uma semana depois (${addDays(d3, 7)}, mesma hora) volta para ${d3}`, moved.corrected && moved.date === d3, JSON.stringify(moved));
    const clientSaid = [A("I have 9am or 11am on those days, which works?"), U(`${WD3} ${d3.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/")} at 9am please`)];
    const cs = reconcileBookingWeekday(d3, clientSaid, "09:00");
    ck("cliente escreveu a data numérica do [BOOK] → nunca movido", !cs.corrected && cs.date === d3, JSON.stringify(cs));
  }

  console.log("\n[A3] DETERMINÍSTICO — a rede de resposta curta preserva 'filled up'; scrubber antigo sem confirmação falsa");
  {
    // Sem hora na frase da desculpa: só a checagem nova segura o "filled up" (com hora, a de horários já segurava).
    const orig = "I'm sorry, that time filled up while we were talking. Today I still have 5pm, or tomorrow at 11am or 1pm. Which works better for you?";
    const dropped = "Today I still have 5pm, or tomorrow at 11am or 1pm, which works better for you?";
    const kept = "Sorry, that time filled up. Today I still have 5pm or tomorrow at 11am or 1pm, which works?";
    const v1 = tightenedIsSafe(orig, dropped, { asksForDetails: isAskingForBookingInfo });
    ck("rewrite que perde 'filled up' é rejeitado", !v1.ok && /slot-gone/.test((v1 as { reason?: string }).reason ?? ""), JSON.stringify(v1));
    const v2 = tightenedIsSafe(orig, kept, { asksForDetails: isAskingForBookingInfo });
    ck("rewrite que mantém 'filled up' passa", v2.ok, JSON.stringify(v2));
    for (const [name, file] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]] as const) {
      const s = readFileSync(join(process.cwd(), file), "utf-8");
      ck(`${name}: stripSlotConflictLanguage nunca mais troca a resposta por 'You're welcome, see you then!'`, !/cleaned = "You're welcome, see you then!"/.test(s) && !/\|\| "You're welcome, see you then!"/.test(s));
      ck(`${name}: stripSlotConflictLanguage devolve a resposta intacta quando ela oferece um horário`, /function stripSlotConflictLanguage[\s\S]{0,700}return original; \/\/ a real alternative is on the table/.test(s));
      ck(`${name}: stripSlotConflictLanguage não apaga mais 'no longer available' / 'taken'`, !/function stripSlotConflictLanguage[\s\S]{0,900}no\\s\+longer\\s\+available/.test(s));
    }
    const ai = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
    ck("reminder 24 carrega a exceção obrigatória (assumir o horário aceito que encheu)", /24\. NEVER SAY A SLOT WAS TAKEN, WITH ONE EXCEPTION:[^\n]*THE EXCEPTION, and it is mandatory[^\n]*A time is only "confirmed" while it is still listed/.test(ai));
    ck("reminder 24 não diz mais 'forbidden in EVERY situation'", !/forbidden in EVERY situation/.test(ai));
    const sp = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
    ck("prompt base, Step 3: o horário escolhido tem que estar na linha do dia", /Step 3:[^\n]*still listed on its day's line in the REAL-TIME SCHEDULE[^\n]*do not hold it and do not ask for the address/.test(sp));
    const dr = readFileSync(join(process.cwd(), "src/lib/dreaming.ts"), "utf-8");
    ck("Dreaming, trava 15: nunca aprender 'move straight to confirmation'", /15\. A TIME IS ONLY CONFIRMED WHILE IT IS STILL ON THE SCHEDULE[^\n]*NEVER write "move straight to confirmation"/.test(dr));
  }

  console.log("\n[A] DETERMINÍSTICO — acceptedSlotGone (nota + enlatada) e backstop");
  {
    const availGone = schedule([[today, "5pm"], [tomorrow, "11am, 1pm, 3pm"], [other, "9am, 11am, 1pm"]]);
    const gone = acceptedSlotGone(REAL, availGone, "en");
    ck("6pm aceito fora da linha de hoje → nota", !!gone && gone.slot.time === "18:00" && gone.slot.date === today, JSON.stringify(gone?.slot));
    ck("nota cita o 6pm, o dia e o 5pm real", !!gone && /accepting the 6pm/.test(gone.note) && gone.note.includes(`[${today}]`) && /same day: 5pm/.test(gone.note) && /no \[BOOK\]/.test(gone.note), gone?.note);
    ck("enlatada EN: desculpa + 5pm de hoje", gone?.reply === "I'm sorry, that 6pm today filled up while we were talking. Today I still have 5pm, does that work for you?", gone?.reply);
    const availOpen = schedule([[today, "5pm, 6pm"], [tomorrow, "11am, 1pm"]]);
    ck("6pm ainda na linha → null (nada muda)", acceptedSlotGone(REAL, availOpen, "en") === null);
    const availFull = schedule([[today, "fully booked"], [tomorrow, "11am, 1pm, 3pm"]]);
    const full = acceptedSlotGone(REAL, availFull, "en");
    ck("hoje lotado → enlatada oferece os 2 primeiros de amanhã", full?.reply === "I'm sorry, that 6pm today filled up while we were talking. The closest I have now is tomorrow at 11am or 1pm, which works better for you?", full?.reply);
    ck("hoje lotado → nota manda para o próximo dia com horários", !!full && /next day that has any: .*\[(\d{4}-\d{2}-\d{2})\] at 11am or 1pm/.test(full.note), full?.note);
    ck("escolha fora da rajada final (último é o endereço) → null", acceptedSlotGone(REAL_BOOK_TURN, availGone, "en") === null);
    ck("dia fora da janela (linha ausente) → null", acceptedSlotGone(REAL, schedule([[tomorrow, "11am"]]), "en") === null);
    ck("sem horário nenhum para oferecer → null (fica com o modelo/handoff)", acceptedSlotGone(REAL, schedule([[today, "fully booked"], [tomorrow, "fully booked"]]), "en") === null);
    const two = acceptedSlotGone(REAL, schedule([[today, "5pm, 7pm"], [tomorrow, "11am"]]), "en");
    ck("dois horários no mesmo dia → 'which works better'", two?.reply === "I'm sorry, that 6pm today filled up while we were talking. Today I still have 5pm or 7pm, which works better for you?", two?.reply);
    // Backstop
    const g = gone!;
    ck("backstop: 'holding that 6pm ... address?' é ignorar", replyIgnoresGoneSlot("Perfect, I'm holding that 6pm for you! What's the full property address with the zip code?", g));
    ck("backstop: 'Perfect! What's the address?' (sem hora) é ignorar", replyIgnoresGoneSlot("Perfect! What's the full address with the zip code?", g));
    ck("backstop: desculpa + 5pm NÃO é ignorar", !replyIgnoresGoneSlot(g.reply, g));
    ck("backstop: '6pm is gone but I have 5pm' NÃO é ignorar", !replyIgnoresGoneSlot("That 6pm is no longer open, but I have 5pm today. Does that work?", g));
    ck("backstop: oferta de outros horários sem citar o 6pm NÃO é ignorar", !replyIgnoresGoneSlot("Today I have 5pm or 7pm, which works better for you?", g));
    ck("backstop: recuperação do [BOOK] ('isn't open on my end') NÃO é ignorar", !replyIgnoresGoneSlot("That exact time isn't open on my end, but that same day I can do 5pm. Which works better for you?", g));
    ck("backstop: pergunta do cliente respondida sem hora e sem pedir dados NÃO é ignorar", !replyIgnoresGoneSlot("Yes, we bring all the samples to the visit.", g));
    ck("backstop: '[BOOK:...]' com o 6pm não conta como hora (tag mascarada)", replyIgnoresGoneSlot('Perfect, see you at 6pm! [BOOK:{"date":"' + today + '","time":"18:00"}]', g));
    // As enlatadas nos 3 idiomas são lidas pelo parser da desculpa (turno seguinte não repete).
    for (const lang of ["en", "es", "pt"] as const) {
      const r = acceptedSlotGoneReply(lang, { date: today, label: "6pm" }, ["5pm"], null, today);
      const parsed = parseSlotGoneApology(r.split(/(?<=[.!?])\s+/)[0]);
      ck(`enlatada ${lang} é uma desculpa de horário perdido para o parser (${r})`, !!parsed && parsed.times.has("6pm"), r);
      ck(`enlatada ${lang} sem ¿¡, sem travessão, sem emoji`, !/[¿¡—–]/.test(r) && !/[\u{1F300}-\u{1FAFF}]/u.test(r), r);
    }
    const wk = acceptedSlotGoneReply("en", { date: other, label: "6pm" }, [], { date: addDays(other, 1), times: ["9am", "11am"] }, today);
    ck("dia da semana: 'that Thursday 6pm filled up' + próximo dia", wk === `I'm sorry, that ${OTHER} 6pm filled up while we were talking. The closest I have now is ${DAY_NAMES[wdOf(addDays(other, 1))]} at 9am or 11am, which works better for you?`, wk);
    const stale = acceptedSlotGoneReply("en", { date: addDays(today, -1), label: "6pm" }, [], { date: today, times: ["5pm"] }, today);
    ck("dia que já passou: 'is no longer open' + hoje", stale === `I'm sorry, that ${DAY_NAMES[wdOf(addDays(today, -1))]} 6pm is no longer open. The closest I have now is today at 5pm, does that work for you?`, stale);
    const esR = acceptedSlotGoneReply("es", { date: today, label: "6pm" }, ["5pm", "7pm"], null, today);
    ck("ES: 'Lo siento, ese horario de las 6pm de hoy se llenó...' + 'Hoy todavía tengo 5pm o 7pm, cuál te queda mejor?'", esR === "Lo siento, ese horario de las 6pm de hoy se llenó mientras hablábamos. Hoy todavía tengo 5pm o 7pm, cuál te queda mejor?", esR);
    const ptR = acceptedSlotGoneReply("pt", { date: today, label: "6pm" }, ["5pm"], null, today);
    ck("PT: 'Desculpa, esse horário das 6pm de hoje encheu...' + 'Hoje ainda tenho 5pm, funciona para você?'", ptR === "Desculpa, esse horário das 6pm de hoje encheu enquanto a gente conversava. Hoje ainda tenho 5pm, funciona para você?", ptR);
  }

  console.log("\n[B] ESTÁTICO — os 3 webhooks");
  for (const [name, file] of [["IG", "src/app/api/webhook/route.ts"], ["FB", "src/app/api/fb-webhook/route.ts"], ["WA", "src/app/api/wa-webhook/route.ts"]] as const) {
    const s = readFileSync(join(process.cwd(), file), "utf-8");
    ck(`${name}: reconcileBookingWeekday recebe a hora do [BOOK]`, /reconcileBookingWeekday\(bookingData\.date, history, bookingData\.time\)/.test(s));
    ck(`${name}: nota acceptedSlotGone injetada em systemParts`, /acceptedGone = acceptedSlotGone\(messagesForAI, availability, lang\);[\s\S]{0,400}systemParts\.push\(acceptedGone\.note\)/.test(s));
    ck(`${name}: backstop replyIgnoresGoneSlot só sem visita gravada`, /if \(!booked && acceptedGone && replyIgnoresGoneSlot\((afterBooking|afterBookingText), acceptedGone\)\)/.test(s));
    ck(`${name}: backstop vem DEPOIS do softenPrematureLockIn`, s.indexOf("softenPrematureLockIn(") < s.indexOf("replyIgnoresGoneSlot("));
  }
  {
    const s = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
    ck("scheduler: reconcileBookingWeekday consulta acceptedOfferSlot ANTES da lógica de weekday", s.indexOf("const acc = acceptedOfferSlot(bookingEpisodeHistory(msgs));") < s.indexOf("let offerIdx = -1;"));
    ck("scheduler: recuperação do [BOOK] usa a desculpa quando o horário falho era o aceito", /accepted && acc\) \{\s*msg = acceptedSlotGoneReply\(lang, acc, times, null, todayStr\)/.test(s));
  }

  if (process.env.DET_ONLY) return done();

  console.log("\n[C] AO VIVO (DB, só leitura) — slotConflictRecoveryMessage assume o horário aceito");
  {
    const rec = await slotConflictRecoveryMessage("en", today, REAL_BOOK_TURN, "18:00");
    console.log("   →", rec);
    ck("recuperação abre com a desculpa do 6pm de hoje (nunca 'That exact time isn't open on my end')", !!rec && /^I'm sorry, that 6pm today filled up while we were talking\./.test(rec) && !/exact time isn't open/.test(rec), rec ?? "null");
    ck("recuperação não oferece o próprio 6pm nem horário que já passou", !rec || !/\b6pm\b/.test(rec.replace(/^I'm sorry, that 6pm today[^.]*\./, "")), rec ?? "null");
    const plain = await slotConflictRecoveryMessage("en", today, [], "18:00");
    ck("sem histórico (nada aceito): frase neutra de sempre", !plain || /exact time isn't open on my end|The soonest I have open/.test(plain), plain ?? "null");
  }

  console.log("\n[D] AO VIVO (modelo) — o turno 'Ok 6 will work' com o 6pm fora da linha, e o turno do endereço");
  {
    let avail = await getRealAvailabilityContext({ history: REAL });
    // Reproduz a agenda do meio-dia de 30/09: hoje só com 5pm (6pm e 8pm ocupados).
    avail = avail.split("\n").map((l) => (l.includes(`[${today}]`) ? l.replace(/\]: .*$/, "]: 5pm") : l)).join("\n");
    const gone = acceptedSlotGone(REAL, avail, "en");
    ck("com a agenda real (hoje = 5pm) a nota dispara", !!gone, avail.split("\n").find((l) => l.includes(`[${today}]`)));
    const waNote = `[WHATSAPP CHANNEL: You are chatting on WhatsApp, so you ALREADY have the client's phone number (17329668249). To confirm a visit, ask ONLY for the full property address with the zip code. NEVER ask the client for their phone number, and NEVER ask for their name (the name is not required, owner rule 2026-09-16). Once you have a confirmed day/time and the address with its zip code, generate [BOOK:...] using "17329668249" as the phone, with the name only if the client stated it and "name":"" otherwise.]`;
    let learnings: string | null = null;
    if (process.env.LEARNINGS) learnings = readFileSync(process.env.LEARNINGS, "utf-8");
    else {
      try {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        let storeId = process.env.ANTHROPIC_SYSTEM_STORE_ID;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = anthropic as any;
        if (!storeId) storeId = (await a.beta.memoryStores.list()).data.find((s: { name: string }) => s.name === "ozzifloors-system")?.id;
        const page = await a.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
        const item = page.data.find((x: { type: string; path: string }) => x.type === "memory" && x.path === "/learnings.md");
        learnings = (await a.beta.memoryStores.memories.retrieve(item.id, { memory_store_id: storeId })).content ?? null;
      } catch (e) { console.log("   (sem learnings:", (e as Error).message, ")"); }
    }
    const N = Number(process.env.N ?? 3);
    for (let i = 1; i <= N; i++) {
      const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), avail, waNote, gone!.note].join("\n\n")}]`;
      const msgs: ChatMessage[] = [...REAL.slice(0, -1), U("Ok 6 will work" + sys)];
      let t = (await getAIResponse(msgs, null, learnings, null, false)).text;
      const raw = t;
      if (replyIgnoresGoneSlot(t, gone!)) t = gone!.reply;
      console.log(`   pick #${i} →`, raw.replace(/\s+/g, " ").slice(0, 240), raw !== t ? "  [backstop]" : "");
      ck(`pick #${i}: resposta assume que o 6pm encheu (ou é a enlatada) e não 'segura' o 6pm`, !/holding|hold that|locked|all set/i.test(t) && /filled|no longer|not open|isn't open|gone|taken/i.test(t), t);
      ck(`pick #${i}: oferece o 5pm de hoje e não pede endereço ainda`, /\b5pm\b/.test(t) && !/address/i.test(t), t);
      ck(`pick #${i}: sem [BOOK]`, !/\[BOOK:/i.test(t), t);
    }
    for (let i = 1; i <= N; i++) {
      const sys = `\n\n[SYSTEM: ${[getEasternDateContext(), avail, waNote].join("\n\n")}]`;
      const msgs: ChatMessage[] = [...REAL, HOLD, U("835 ne 171 st 33162" + sys)];
      let t = (await getAIResponse(msgs, null, learnings, null, false)).text;
      if (!/\[BOOK:/i.test(t)) {
        const plain = msgs.map((x) => ({ role: x.role, content: x.content.split(/\n\n?\[SYSTEM:/)[0] }));
        const reason = forcedBookRetryReason(t, plain, true);
        if (reason) t = (await retryForBookTag(msgs, null, learnings, null, reason)) ?? t;
      }
      const m = /\[BOOK:(\{[\s\S]*?\})\]/.exec(t);
      console.log(`   address #${i} →`, t.replace(/\s+/g, " ").slice(0, 200));
      // Desde a 2ª rodada (reminder 24 + Step 3), com o 6pm fora da linha o modelo
      // pode preferir NÃO gravar e assumir na hora: também está certo, desde que
      // assuma, ofereça o 5pm real e não "segure" o 6pm. A guarda do [BOOK] em si
      // tem cobertura determinística acima.
      if (!m) {
        ck(`address #${i}: sem [BOOK] → assume que o 6pm encheu e oferece o 5pm (nunca 'holding')`, /filled|no longer|not open|isn't open|isn't on|not on (?:today's|the|my)|gone|taken|only \d{1,2}(?::\d{2})?\s*[ap]m/i.test(t) && /\b5pm\b/.test(t) && !/holding|locked|all set/i.test(t), t);
        continue;
      }
      const b = JSON.parse(m[1]);
      const ep = bookingEpisodeHistory(msgs.map((x) => ({ role: x.role, content: x.content })));
      const rec = reconcileBookingWeekday(b.date, ep, b.time);
      const date = rec.corrected ? rec.date : b.date;
      ck(`address #${i}: [BOOK] ${b.date} ${b.time} → depois da guarda é HOJE 18:00 (${rec.corrected ? "corrigido: " + rec.reason : "já certo"})`, date === today && b.time === "18:00", JSON.stringify({ b, rec }));
    }
  }
  done();
}
function done() {
  console.log(`\n=========== ACCEPTED-SLOT-GONE-VERIFY: ${pass} passed, ${fail} failed ===========`);
  if (fail) console.log("FAILED:", fails.join(" | "));
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
