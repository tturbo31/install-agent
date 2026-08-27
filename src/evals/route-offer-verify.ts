/**
 * OTIMIZAÇÃO DE ROTA — o MODELO obedece à nota interna sem mudar o script (27/08/2026).
 *
 * O route-optimizer-verify prova a matemática; este eval prova, com o modelo
 * REAL (getAIResponse, mesmo caminho dos 3 webhooks), que:
 *  1. com "ROUTE PRIORITY" no contexto, os DOIS horários oferecidos são os
 *     "offer first" do dia, e os demais (que continuam listados) não aparecem;
 *  2. a restrição declarada do cliente ("só de manhã") vence a ordem de rota e
 *     o bot NUNCA diz que não há disponibilidade;
 *  3. quando o cliente recusa os dois primeiros e pede outro horário, o bot
 *     abre os horários seguintes (que sempre estiveram disponíveis);
 *  4. nenhuma resposta fala de rota, distância, deslocamento, "perto", "na
 *     área" ou de como a equipe organiza o dia;
 *  5. com "ZIP CODE FIRST": a proposta da visita pede o ZIP em UMA pergunta
 *     curta e sem listar horários; em espanhol pede o "código postal";
 *  6. exceções do ZIP-first: cliente que já nomeou o dia recebe horários; ZIP
 *     já pedido antes → oferece horários sem perguntar de novo;
 *  7. respondido o ZIP, o próximo turno oferece os dois horários preferidos.
 *
 * ~10 chamadas ao modelo. Run: npx tsx src/evals/route-offer-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { getEasternDateContext, easternTodayStr, clientAlreadyNamedSlot } from "../lib/scheduler";
import { buildRoutePriorityNote, buildZipFirstNote, getRouteConfig, type DayRanking, type SlotRank, type RouteSeller } from "../lib/route-optimizer";
import { zipCentroid } from "../lib/geo/zip-geo";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);

// ── agenda sintética com o MESMO formato da produção ─────────────────────────
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function addDays(dateStr: string, n: number): string { const d = new Date(dateStr + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function display(dateStr: string): string { const d = new Date(dateStr + "T12:00:00Z"); return `${DAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} [${dateStr}]`; }
const fmt12 = (s: string) => { const [h, m] = s.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h >= 12 ? "pm" : "am"}`; };
const weekdayOf = (dateStr: string) => DAY_NAMES[new Date(dateStr + "T12:00:00Z").getUTCDay()];

const today = easternTodayStr();
// Dois dias úteis a partir de depois de amanhã (evita "hoje" e o corte de 2h).
let d1 = addDays(today, 2); while ([0, 6].includes(new Date(d1 + "T12:00:00Z").getUTCDay())) d1 = addDays(d1, 1);
let d2 = addDays(d1, 1); while ([0, 6].includes(new Date(d2 + "T12:00:00Z").getUTCDay())) d2 = addDays(d2, 1);
const SLOTS = ["09:00", "11:00", "13:00", "15:00", "17:00"];

const scheduleBlock = () =>
  [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    `• ${display(d1)}: ${SLOTS.map(fmt12).join(", ")}`,
    `• ${display(d2)}: ${SLOTS.map(fmt12).join(", ")}`,
    "",
    "IMPORTANT — read carefully before offering any time:",
    "- ONLY offer times listed above. Never mention a time shown as 'fully booked'.",
    "- When you name a weekday to the client, you MUST use the exact date in [brackets] shown on that SAME line, and ONLY the times listed on that same line.",
    "- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line.",
    "- NEVER tell a client a time was 'just taken' or is 'no longer available'. If a time is not listed, simply offer a different time that IS listed, naturally.",
  ].join("\n");

// ROUTE PRIORITY real (mesma função da produção): cliente em West Palm (33401);
// d1: 3pm e 5pm melhores, depois 1pm, depois 9am/11am. d2: 9am e 11am melhores.
const CFG = getRouteConfig({});
const cris: RouteSeller = { id: "c", name: "Cris", priority: 3 };
const mk = (slot: string, score: number, rank: number): SlotRank => ({ slot, score, tier: score <= 30 ? "excellent" : score <= 45 ? "good" : score <= 60 ? "acceptable" : "low", bestSeller: cris, rank, equivalentToBest: rank === 1 });
const days: DayRanking[] = [
  { dateStr: d1, displayDate: display(d1), ranked: [mk("15:00", 22, 1), mk("17:00", 28, 2), mk("13:00", 55, 3), mk("09:00", 95, 4), mk("11:00", 110, 5)], capacity: 10, open: 5 },
  { dateStr: d2, displayDate: display(d2), ranked: [mk("09:00", 18, 1), mk("11:00", 25, 2), mk("15:00", 70, 3), mk("13:00", 90, 4), mk("17:00", 120, 5)], capacity: 10, open: 7 },
];
// d1 praticamente cheio (9 de 10): o dia prioritário passa a ser d2; o 1pm que sobrou em d1 continua listado.
const daysAlmostFull: DayRanking[] = [
  { dateStr: d1, displayDate: display(d1), ranked: [mk("13:00", 55, 1)], capacity: 10, open: 1 },
  { dateStr: d2, displayDate: display(d2), ranked: [mk("09:00", 18, 1), mk("11:00", 25, 2), mk("15:00", 70, 3), mk("13:00", 90, 4), mk("17:00", 120, 5)], capacity: 10, open: 7 },
];
const WPB = zipCentroid("33401")!;
const ROUTE_NOTE = buildRoutePriorityNote(days, WPB, CFG, fmt12)!;
const ROUTE_NOTE_ALMOST_FULL = buildRoutePriorityNote(daysAlmostFull, WPB, CFG, fmt12)!;
const PREFERRED = new Set(["3pm", "5pm", "9am", "11am"]); // offer-first de d1 ∪ d2
const NOT_PREFERRED_D1 = ["9am", "11am", "1pm"];

const sys = (...parts: string[]) => `\n\n[SYSTEM: ${[getEasternDateContext(), scheduleBlock(), ...parts].join("\n\n")}]`;
const clockTimes = (t: string) => [...t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi)].map((m) => `${parseInt(m[1], 10)}${m[2].toLowerCase()}`);
const LEAK = /\broute\b|\brouting\b|distance|travel time|driving|\bdrive\b|nearby|near you|in your area|in the area|on the way|on our way|organi[sz]e (?:our|the) day|closest opening|our team is close|efficien/i;
const NO_AVAIL = /no availability|don't have (?:any )?availability|nothing available|fully booked|not available/i;

async function run() {
  console.log(`\n(dias sintéticos: ${display(d1)} e ${display(d2)}; cliente em West Palm 33401)`);

  console.log("\n━━ 1. ROUTE PRIORITY → oferece os dois horários preferidos ━━");
  const t1 = await ai([
    { role: "user", content: "Hi, I want luxury vinyl for my whole house, about 1200 sqft. The house is in West Palm Beach, 33401." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. Which day works best for you?" },
    { role: "user", content: `I'm flexible, any day and time works for me.${sys(ROUTE_NOTE)}` },
  ]);
  console.log("   →", t1.replace(/\s+/g, " ").slice(0, 300));
  const c1 = clockTimes(t1);
  ck("T1: oferece horários (clock times presentes)", c1.length >= 1, t1);
  ck("T1: oferece exatamente DOIS horários (mesma quantidade de sempre)", new Set(c1).size === 2, `${c1.join(",")} | ${t1}`);
  ck("T1: DATA PRIMEIRO: os dois horários são do dia prioritário (1º dia, 50% ocupado): 3pm e 5pm", c1.every((t) => ["3pm", "5pm"].includes(t)) && PREFERRED.has(c1[0] ?? "3pm"), `${c1.join(",")} | ${t1}`);
  ck("T1: não oferece os horários de rota ruim do 1º dia (1pm) nem diz que faltam vagas", !/\b1\s*pm\b/i.test(t1) && !NO_AVAIL.test(t1), t1);
  ck("T1: nenhum vazamento de rota/distância", !LEAK.test(t1), t1);

  console.log("\n━━ 2. Restrição do cliente vence a ordem de rota ━━");
  const t2 = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft, in West Palm Beach 33401." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. Which day works best for you?" },
    { role: "user", content: `I can only do mornings, before noon.${sys(ROUTE_NOTE)}` },
  ]);
  console.log("   →", t2.replace(/\s+/g, " ").slice(0, 300));
  const c2 = clockTimes(t2);
  ck("T2: oferece horário(s) da manhã (9am/11am) mesmo sendo rota pior no 1º dia", c2.length >= 1 && c2.every((t) => ["9am", "11am"].includes(t)), `${c2.join(",")} | ${t2}`);
  ck("T2: não inventa falta de disponibilidade", !NO_AVAIL.test(t2), t2);
  ck("T2: nenhum vazamento de rota", !LEAK.test(t2), t2);

  console.log("\n━━ 3. Cliente recusa os dois primeiros → abre os demais horários ━━");
  const t3 = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft, in West Palm Beach 33401." },
    { role: "assistant", content: `For that size I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. I have ${weekdayOf(d1)} at 3pm or 5pm, which works better for you?` },
    { role: "user", content: `Neither works for me that day. Do you have anything earlier on ${weekdayOf(d1)}?${sys(ROUTE_NOTE)}` },
  ]);
  console.log("   →", t3.replace(/\s+/g, " ").slice(0, 300));
  const c3 = clockTimes(t3);
  ck("T3: abre horários mais cedo do MESMO dia (1pm/9am/11am), que continuavam disponíveis", c3.length >= 1 && c3.some((t) => NOT_PREFERRED_D1.includes(t)), `${c3.join(",")} | ${t3}`);
  ck("T3: não diz que não há disponibilidade", !NO_AVAIL.test(t3), t3);
  ck("T3: nenhum vazamento de rota", !LEAK.test(t3), t3);

  console.log("\n━━ 4. ZIP CODE FIRST → proposta da visita pede o ZIP, sem listar horários ━━");
  const ZIP_NOTE = buildZipFirstNote(false);
  const t4 = await ai([
    { role: "user", content: "Hi, I saw your ad, I'm interested in the luxury vinyl." },
    { role: "assistant", content: "Great, are you planning to do just one area, or will it be the entire house?" },
    { role: "user", content: `The whole house, about 1400 sqft.${sys(ZIP_NOTE)}` },
  ]);
  console.log("   →", t4.replace(/\s+/g, " ").slice(0, 300));
  ck("T4: propõe a visita (measure / visit / samples)", /visit|measure|sample|come by|stop by/i.test(t4), t4);
  ck("T4: pede o zip code em UMA pergunta", /zip/i.test(t4) && (t4.match(/\?/g) ?? []).length <= 2, t4);
  ck("T4: NÃO lista horários ainda", clockTimes(t4).length === 0, t4);
  ck("T4: não dá preço (lead grande) e não vaza rota", !/\$\s?\d/.test(t4) && !LEAK.test(t4), t4);
  ck("T4: sem travessões e sem emoji", !/[—–]/.test(t4) && !/[\u{1F300}-\u{1FAFF}]/u.test(t4), t4);

  console.log("\n━━ 5. ZIP CODE FIRST em espanhol → 'código postal' ━━");
  const t5 = await ai([
    { role: "user", content: "Hola, vi el anuncio del piso vinílico." },
    { role: "assistant", content: "Hola, ¿es para una sola área o para toda la casa?" },
    { role: "user", content: `Toda la casa, como 1300 pies cuadrados.${sys(ZIP_NOTE)}` },
  ]);
  console.log("   →", t5.replace(/\s+/g, " ").slice(0, 300));
  ck("T5: pede el código postal / zip en espanhol", /c[oó]digo postal|zip/i.test(t5), t5);
  ck("T5: não lista horários ainda e não vaza rota", clockTimes(t5).length === 0 && !LEAK.test(t5), t5);

  console.log("\n━━ 6. Exceções do ZIP-first ━━");
  const t6 = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. What's the zip code of the property?" },
    { role: "user", content: `Can you come ${weekdayOf(d1)}? What times do you have?${sys(buildZipFirstNote(true))}` },
  ]);
  console.log("   →", t6.replace(/\s+/g, " ").slice(0, 300));
  ck("T6a: ZIP já pedido + cliente pede horários → oferece horários (não pergunta o ZIP de novo)", clockTimes(t6).length >= 1 && !/zip/i.test(t6), t6);
  // Em produção a nota ZIP-first NÃO entra quando o cliente já nomeou dia/hora
  // (clientAlreadyNamedSlot, deterministico) — o fluxo normal segue.
  const h6b: ChatMessage[] = [
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft." },
    { role: "assistant", content: "Great, are you planning to do just one area, or will it be the entire house?" },
    { role: "user", content: `Whole house. Can you come ${weekdayOf(d1)} at 3pm?` },
  ];
  ck("T6b: gate deterministico: cliente nomeou dia+hora → ZIP-first suprimido", clientAlreadyNamedSlot(h6b) === true);
  ck("T6b: gate deterministico: sem dia/hora → ZIP-first permitido", clientAlreadyNamedSlot([{ role: "user", content: "Whole house, about 1200 sqft." }]) === false);
  const t6b = await ai([...h6b.slice(0, 2), { role: "user", content: `${h6b[2].content}${sys()}` }]);
  console.log("   →", t6b.replace(/\s+/g, " ").slice(0, 300));
  ck("T6b: cliente já nomeou dia e hora → confirma/oferece horário em vez de travar no ZIP", clockTimes(t6b).length >= 1 || /\b3\s*pm\b|three/i.test(t6b), t6b);
  ck("T6b: segue o script normal (pede nome + endereço com zip + telefone juntos), não o ZIP sozinho", /\bname\b/i.test(t6b) && /address/i.test(t6b) && /phone|number/i.test(t6b), t6b);
  ck("T6b: nenhum vazamento de rota", !LEAK.test(t6b), t6b);

  console.log("\n━━ 7. Após o ZIP → os dois horários preferidos ━━");
  const t7 = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. What's the zip code of the property?" },
    { role: "user", content: `33401${sys(ROUTE_NOTE)}` },
  ]);
  console.log("   →", t7.replace(/\s+/g, " ").slice(0, 300));
  const c7 = clockTimes(t7);
  ck("T7: oferece horários logo após o ZIP", c7.length >= 1, t7);
  ck("T7: exatamente dois, todos 'offer first'", new Set(c7).size === 2 && c7.every((t) => PREFERRED.has(t)), `${c7.join(",")} | ${t7}`);
  ck("T7: não pede o ZIP de novo e não vaza rota", !/(?:what|which|cu[aá]l|qual)[^.?!]{0,40}\bzip|zip[^.?!]{0,30}\?/i.test(t7) && !LEAK.test(t7), t7);

  console.log("\n━━ 8. DIA PRIORITÁRIO: 1º dia praticamente cheio → oferece o 2º dia (o que sobrou no 1º continua disponível) ━━");
  const t8 = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft, in West Palm Beach 33401." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. Which day works best for you?" },
    { role: "user", content: `I'm flexible, any day and time works for me.${sys(ROUTE_NOTE_ALMOST_FULL)}` },
  ]);
  console.log("   →", t8.replace(/\s+/g, " ").slice(0, 300));
  const c8 = clockTimes(t8);
  ck("T8: oferece os dois 'offer first' do 2º dia (9am, 11am)", new Set(c8).size === 2 && c8.every((t) => ["9am", "11am"].includes(t)), `${c8.join(",")} | ${t8}`);
  ck("T8: não diz que o 1º dia está cheio/ocupado e não vaza rota", !/\bfull\b|booked|busy|occupied|capacity/i.test(t8) && !LEAK.test(t8), t8);
  const t8b = await ai([
    { role: "user", content: "Hi, luxury vinyl for the whole house, about 1200 sqft, in West Palm Beach 33401." },
    { role: "assistant", content: `For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. I have ${weekdayOf(d2)} at 9am or 11am, which works better for you?` },
    { role: "user", content: `Can't do ${weekdayOf(d2)}. Anything on ${weekdayOf(d1)}?${sys(ROUTE_NOTE_ALMOST_FULL)}` },
  ]);
  console.log("   →", t8b.replace(/\s+/g, " ").slice(0, 300));
  ck("T8b: cliente pede o 1º dia → o 1pm que sobrou é oferecido (nunca 'não tenho')", clockTimes(t8b).includes("1pm") && !NO_AVAIL.test(t8b), t8b);

  console.log(`\n${fail === 0 ? "✅" : "❌"} route-offer-verify: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
run().catch((e) => { console.error(e); process.exit(1); });
