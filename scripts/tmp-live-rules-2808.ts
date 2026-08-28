// Sondagem AO VIVO das regras do dono (28/08): dia mais próximo + primeiros
// horários + espanhol sem ¿¡ + "você escolhe" não perde o horário. READ-ONLY.
import { readFileSync } from "fs";
import { join } from "path";
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  const i = t.indexOf("=");
  if (i > 0 && !t.startsWith("#")) {
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const display = (d: string) => { const x = new Date(d + "T12:00:00Z"); return `${DAYS[x.getUTCDay()]}, ${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()} [${d}]`; };

const SOONEST_RULE =
  "- SOONEST DAY FIRST (owner's rule, the team must not be left with empty hours): when you propose the visit, take your two options from the FIRST line above that has open times, today if today still has times listed, otherwise the next day, and take that line's EARLIEST two open times (its first two listed: 9am before 11am before 1pm), so the day fills from the first hour with no holes. If that line has only one open time, offer it plus the first open time of the next line that has any. Move to a later day ONLY when the client says they cannot do that day, asks for another day, or their stated availability has no match on it, and even then use the SOONEST matching line (for 'next week' that is the first listed day of next week, not a later one). Never skip a day that has open times because a later day has more of them.";

function schedule(d1: string, t1: string[], d2: string, t2: string[]) {
  return [
    "REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):",
    `• ${display(d1)}: ${t1.length ? t1.join(", ") : "fully booked"}`,
    `• ${display(d2)}: ${t2.join(", ")}`,
    "",
    "IMPORTANT — read carefully before offering any time:",
    "- ONLY offer times listed above. Never mention a time shown as 'fully booked'.",
    SOONEST_RULE,
    "- When you name a weekday to the client, you MUST use the exact date in [brackets] shown on that SAME line, and ONLY the times listed on that same line.",
  ].join("\n");
}

// Horários OFERECIDOS. Duas armadilhas vistas ao vivo em 28/08:
//  (1) o bot ecoa a restrição do cliente ("the only after-6pm slot...") e o
//      "6pm" dali não é uma oferta → descartado;
//  (2) em português o bot escreve "9h ou 11h da manhã" (sem am/pm) → conta.
const clock = (raw: string) => {
  const t = raw.replace(/\bafter[-\s]*\d{1,2}\s*(?:am|pm)?\b/gi, " ").replace(/\bdepois d[ao]s?\s*\d{1,2}\s*h?\b/gi, " ").replace(/\bdespu[ée]s de (?:las\s*)?\d{1,2}\s*(?:am|pm)?\b/gi, " ");
  const ampm = [...t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi)].map((m) => `${parseInt(m[1], 10)}${m[2].toLowerCase()}`);
  // "9h"/"11h" (PT) — manhã se <= 11 e a frase fala em manhã, senão pm quando >= 12.
  const pt = [...t.matchAll(/\b(\d{1,2})\s*h\b/gi)].map((m) => {
    const h = parseInt(m[1], 10);
    return h >= 12 ? `${h % 12 || 12}pm` : /manh[ãa]/i.test(t) ? `${h}am` : `${h}am`;
  });
  return [...new Set([...ampm, ...pt])];
};

async function main() {
  const { getAIResponse } = await import("../src/lib/ai");
  const { getEasternDateContext, easternTodayStr } = await import("../src/lib/scheduler");
  const today = easternTodayStr();
  let d1 = addDays(today, 2);
  while ([0, 6].includes(new Date(d1 + "T12:00:00Z").getUTCDay())) d1 = addDays(d1, 1);
  const d2 = addDays(d1, 1);
  const wd1 = DAYS[new Date(d1 + "T12:00:00Z").getUTCDay()];

  const sys = (sched: string) => `\n\n[SYSTEM: ${getEasternDateContext()}\n\n${sched}]`;
  const ai = (msgs: Array<{ role: string; content: string }>) => getAIResponse(msgs as never, null, null, null, false).then((r) => r.text);

  const casos: Array<{ nome: string; msgs: Array<{ role: string; content: string }>; check: (t: string) => string | null }> = [
    {
      nome: "A. dia1 com 5 horários → tem que oferecer 9am e 11am (os primeiros)",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `Any day works.${sys(schedule(d1, ["9am", "11am", "1pm", "3pm", "5pm"], d2, ["9am", "11am", "1pm"]))}` },
      ],
      check: (t) => { const c = clock(t); return c.length && c.every((x) => ["9am", "11am"].includes(x)) ? null : `esperava 9am/11am, veio ${c.join(",")}`; },
    },
    {
      nome: "B. dia1 só com 5pm → 5pm + o primeiro do dia2 (nada de pular o dia1)",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `Any day works.${sys(schedule(d1, ["5pm"], d2, ["9am", "11am", "1pm"]))}` },
      ],
      check: (t) => (clock(t).includes("5pm") ? null : `o 5pm do dia mais próximo foi pulado: ${clock(t).join(",")}`),
    },
    {
      nome: "C. dia1 lotado → dia2 pelos primeiros (9am/11am)",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `Any day works.${sys(schedule(d1, [], d2, ["9am", "11am", "1pm", "3pm"]))}` },
      ],
      check: (t) => { const c = clock(t); return c.length && c.every((x) => ["9am", "11am"].includes(x)) ? null : `esperava 9am/11am do dia2, veio ${c.join(",")}`; },
    },
    {
      nome: "D. cliente só depois das 18h → restrição vence (nada de 9am/11am)",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `I can only do after 6pm.${sys(schedule(d1, ["9am", "11am", "1pm", "7pm"], d2, ["9am", "7pm"]))}` },
      ],
      check: (t) => { const c = clock(t); return c.length === 0 || c.every((x) => ["7pm", "8pm"].includes(x)) ? null : `ofereceu horário fora da restrição: ${c.join(",")}`; },
    },
    {
      nome: "E. 'you choose' → NÃO pode perder a frase com o horário (guard anti-pressão)",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `You choose, I'm flexible.${sys(schedule(d1, ["9am", "11am", "1pm"], d2, ["9am", "11am"]))}` },
      ],
      check: (t) => (clock(t).length >= 1 ? null : `resposta ficou sem horário: ${t}`),
    },
    {
      nome: "F. espanhol → sem ¿ ¡ e com os primeiros horários",
      msgs: [
        { role: "user", content: "Hola, quiero piso vinilico para toda la casa, como 1200 pies, en Miami 33130." },
        { role: "assistant", content: "Para ese tamaño necesito ir a medir en persona para darte el mejor precio, y llevo las muestras. Que dia te queda mejor?" },
        { role: "user", content: `Cualquier dia, el mas pronto posible.${sys(schedule(d1, ["9am", "11am", "1pm"], d2, ["9am", "11am"]))}` },
      ],
      check: (t) => { const c = clock(t); if (/[¿¡]/.test(t)) return `VAZOU pontuação invertida: ${t}`; return c.length && c.every((x) => ["9am", "11am"].includes(x)) ? null : `esperava 9am/11am, veio ${c.join(",")}`; },
    },
    {
      nome: "G. português 'amanhã pode ser' → mantém o horário na resposta",
      msgs: [
        { role: "user", content: "Oi, quero piso vinilico para a casa toda, uns 1200 pes, em Miami 33130." },
        { role: "assistant", content: "Para esse tamanho preciso ir medir pessoalmente para dar o melhor preco, e levo as amostras. Qual dia fica melhor?" },
        { role: "user", content: `Qualquer dia, o mais cedo possivel.${sys(schedule(d1, ["9am", "11am", "1pm"], d2, ["9am", "11am"]))}` },
      ],
      check: (t) => (clock(t).length >= 1 ? null : `resposta ficou sem horário: ${t}`),
    },
    {
      nome: "H. nenhuma resposta pode citar rota/ocupação/regra interna",
      msgs: [
        { role: "user", content: "Hi, luxury vinyl for my whole house, about 1200 sqft, in Miami 33130." },
        { role: "assistant", content: "For that size I need to measure in person to give you the best price, and I bring the samples. Which day works best for you?" },
        { role: "user", content: `Whatever is soonest.${sys(schedule(d1, ["9am", "11am", "1pm"], d2, ["9am", "11am"]))}` },
      ],
      check: (t) => (/route|distance|nearby|in the area|on the way|soonest day first|empty hours|owner'?s rule|priority day|% booked|offer first/i.test(t) ? `vazou: ${t}` : null),
    },
  ];

  let ruins = 0;
  for (const c of casos) {
    const t = (await ai(c.msgs)).replace(/\s+/g, " ").trim();
    const err = c.check(t);
    if (err) ruins++;
    console.log(`\n${err ? "❌" : "✅"} ${c.nome}\n   → ${t.slice(0, 230)}${err ? `\n   PROBLEMA: ${err}` : ""}`);
  }
  console.log(`\n${ruins === 0 ? "✅ AO VIVO: todos os casos passaram" : `❌ AO VIVO: ${ruins} caso(s) com problema`} (${casos.length} casos, wd1=${wd1})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
