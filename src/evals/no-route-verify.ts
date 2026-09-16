/**
 * Validação ao vivo (16/09/2026) — rota REMOVIDA a pedido do dono.
 * Prova, com a agenda REAL e o modelo REAL:
 *  A. getRealAvailabilityContext() não traz nota ROUTE PRIORITY / ZIP CODE FIRST / PRIORITY DAY;
 *     a regra SOONEST DAY FIRST continua.
 *  B. needTimeChoiceMessage / slotConflictRecoveryMessage oferecem os PRIMEIROS horários do dia (ordem do relógio).
 *  C. Modelo: proposta de visita SEM pedir ZIP antes; oferece exatamente 2 horários = os dois primeiros
 *     do dia mais próximo com vaga; cliente escolhe → pede nome + endereço com ZIP + telefone juntos.
 * Run: npx tsx src/evals/no-route-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";
import { getEasternDateContext, getRealAvailabilityContext, needTimeChoiceMessage, slotConflictRecoveryMessage, getAvailableSlots, easternTodayStr } from "../lib/scheduler";

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
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 400)}»`); }
}
const ai = (msgs: ChatMessage[]) => getAIResponse(msgs, null, null, null, false).then((r) => r.text);
const clockTimes = (t: string) => [...t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi)].map((m) => `${parseInt(m[1], 10)}${m[2].toLowerCase()}`);
const fmt12 = (s: string) => { const [h, m] = s.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h >= 12 ? "pm" : "am"}`; };
const ZIP_ASK = /\bzip\b|c[oó]digo\s+postal|\bcep\b/i;
const LEAK = /\broute\b|\brouting\b|priority day|fill rate|% booked|preferred seller|offer first|soonest day first|owner'?s rule|no empty hours|distance|travel time|driving|on the way|closest opening/i;

async function run() {
  console.log("\n━━ A. agenda real: sem nota de rota / ZIP-first ━━");
  const avail = await getRealAvailabilityContext();
  console.log(avail.split("\n").slice(0, 6).join("\n"));
  ck("agenda lida (linhas de dias presentes)", /REAL-TIME SCHEDULE AVAILABILITY/.test(avail) && /\[\d{4}-\d{2}-\d{2}\]/.test(avail), avail.slice(0, 200));
  ck("sem nota ROUTE PRIORITY", !/ROUTE PRIORITY/.test(avail));
  ck("sem nota ZIP CODE FIRST", !/ZIP CODE FIRST/.test(avail));
  ck("sem PRIORITY DAY / fill rate / preferred seller", !/PRIORITY DAY|fill rate|preferred seller|% booked|offer first/i.test(avail));
  ck("regra SOONEST DAY FIRST continua (dia mais próximo + primeiros horários)", /SOONEST DAY FIRST/.test(avail) && /EARLIEST two open times/.test(avail));

  // Primeiro dia com vaga (linha da agenda) e seus horários.
  const dayLines = avail.split("\n").filter((l) => l.startsWith("• ") && !/fully booked/.test(l));
  const firstLine = dayLines[0] ?? "";
  const firstDate = (/\[(\d{4}-\d{2}-\d{2})\]/.exec(firstLine) ?? [])[1];
  const firstTimes = firstLine.split("]: ")[1]?.split(", ").map((s) => s.trim()) ?? [];
  console.log(`   primeiro dia com vaga: ${firstLine}`);
  ck("primeiro dia com vaga identificado", !!firstDate && firstTimes.length >= 2, firstLine);

  console.log("\n━━ B. enlatadas: horários em ordem do relógio ━━");
  if (firstDate) {
    const slots = await getAvailableSlots(firstDate);
    const isToday = firstDate === easternTodayStr();
    const ntc = await needTimeChoiceMessage("en", firstDate);
    console.log("   needTimeChoiceMessage →", ntc);
    const expectNtc = slots.slice(0, 4).map(fmt12);
    ck(`needTimeChoiceMessage lista os 4 primeiros do dia em ordem (${expectNtc.join(", ")})`, isToday || expectNtc.every((t) => ntc.includes(t)) && clockTimes(ntc).join(",") === expectNtc.map((t) => t.replace(/:\d{2}/, "")).join(","), ntc);
    const rec = await slotConflictRecoveryMessage("en", firstDate, [], slots[0]);
    console.log("   slotConflictRecoveryMessage →", rec);
    const expectRec = slots.slice(1, 4).map(fmt12);
    ck(`slotConflictRecoveryMessage (mesmo dia, ${fmt12(slots[0])} cheio) lista os 3 seguintes em ordem (${expectRec.join(", ")})`, isToday || (!!rec && clockTimes(rec).join(",") === expectRec.map((t) => t.replace(/:\d{2}/, "")).join(",")), rec ?? "null");
  }

  console.log("\n━━ C. modelo real com a agenda real ━━");
  const sys = () => `\n\n[SYSTEM: ${[getEasternDateContext(), avail].join("\n\n")}]`;
  const first2 = firstTimes.slice(0, 2).map((t) => t.replace(/:\d{2}/, ""));
  const listedSet = new Set(firstTimes.map((t) => t.replace(/:\d{2}/, "")));

  // C1: lead grande, primeiro contato, sem ZIP nenhum → proposta com 2 horários, sem pedir ZIP antes.
  const t1 = await ai([
    { role: "user", content: "Hi, I want luxury vinyl for my whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. When works for you?" },
    { role: "user", content: `I'm flexible, any day and time works for me.${sys()}` },
  ]);
  console.log("   C1 →", t1.replace(/\s+/g, " ").slice(0, 320));
  const c1 = clockTimes(t1);
  ck("C1: NÃO pede o ZIP antes de oferecer horários", !ZIP_ASK.test(t1), t1);
  ck("C1: oferece horários (clock times)", c1.length >= 1, t1);
  ck("C1: exatamente DOIS horários distintos", new Set(c1).size === 2, `${c1.join(",")} | ${t1}`);
  ck(`C1: os dois são os PRIMEIROS do dia mais próximo com vaga (${first2.join(", ")})`, c1.length === 2 && c1.every((t) => first2.includes(t)), `${c1.join(",")} | ${t1}`);
  ck("C1: nenhum vazamento (rota/prioridade/regra do dono)", !LEAK.test(t1), t1);

  // C2: cliente escolhe o primeiro horário → pede nome + endereço COM ZIP + telefone, sem [BOOK] ainda.
  const t2 = await ai([
    { role: "user", content: "Hi, I want luxury vinyl for my whole house, about 1200 sqft." },
    { role: "assistant", content: "For that size, I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. When works for you?" },
    { role: "user", content: "I'm flexible, any day and time works for me." },
    { role: "assistant", content: t1.split("\n\n[SYSTEM:")[0] },
    { role: "user", content: `${first2[0]} works${sys()}` },
  ]);
  console.log("   C2 →", t2.replace(/\s+/g, " ").slice(0, 320));
  ck("C2: pede o nome", /\bname\b/i.test(t2), t2);
  ck("C2: pede o endereço com o zip code", /\baddress\b/i.test(t2) && ZIP_ASK.test(t2), t2);
  ck("C2: pede o telefone", /\bphone\b|\bnumber\b/i.test(t2), t2);
  ck("C2: não gera [BOOK] sem os dados", !/\[BOOK:/i.test(t2), t2);
  ck("C2: nenhum vazamento", !LEAK.test(t2), t2);

  // C3: cliente com restrição de horário ("only after 5pm") → horários listados que batem; sem ZIP antes.
  const late = firstTimes.map((t) => t.replace(/:\d{2}/, "")).filter((t) => /pm$/.test(t) && parseInt(t, 10) >= 5 && parseInt(t, 10) < 12);
  const t3 = await ai([
    { role: "user", content: "Hola, quiero piso vinílico para toda la casa, unos 1500 sqft." },
    { role: "assistant", content: "Para ese tamaño necesito ir a medir en persona para darte el mejor precio, y llevo las muestras para que elijas ahí mismo. Qué día te queda bien?" },
    { role: "user", content: `Solo puedo después de las 5pm, salgo del trabajo a esa hora.${sys()}` },
  ]);
  console.log("   C3 →", t3.replace(/\s+/g, " ").slice(0, 320));
  const c3 = clockTimes(t3);
  ck("C3 (ES): NÃO pede o código postal antes de oferecer horários", !ZIP_ASK.test(t3), t3);
  ck("C3 (ES): oferece horário(s) da agenda", c3.length >= 1 && c3.every((t) => listedSet.has(t) || /pm$/.test(t)), `${c3.join(",")} | ${t3}`);
  ck("C3 (ES): respeita a restrição (só horários >= 5pm) ou explica", c3.length === 0 || c3.every((t) => /pm$/.test(t) && parseInt(t, 10) >= 5 && parseInt(t, 10) < 12), `${c3.join(",")} | ${t3} | listados tarde: ${late.join(",")}`);
  ck("C3 (ES): sem ¿ ¡", !/[¿¡]/.test(t3), t3);
  ck("C3 (ES): nenhum vazamento", !LEAK.test(t3), t3);

  console.log(`\n${fail === 0 ? "✅" : "❌"} no-route-verify: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
}
run().catch((e) => { console.error(e); process.exit(1); });
