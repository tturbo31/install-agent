import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  // ── route-optimizer.ts: meta padrão = 1 (qualquer vaga torna o dia prioritário)
  { file: "src/lib/route-optimizer.ts",
    find: `  targetNextDayFillRate: number; // ROUTE_TARGET_NEXT_DAY_FILL_RATE — 0..1; dia abaixo da meta = dia prioritário (padrão 0.9)`,
    replace: `  targetNextDayFillRate: number; // ROUTE_TARGET_NEXT_DAY_FILL_RATE — 0..1; dia abaixo da meta = dia prioritário (padrão 1: QUALQUER vaga no dia mais próximo o torna prioritário — regra do dono 28/08: nenhum horário vago fica para trás)` },
  { file: "src/lib/route-optimizer.ts",
    find: `    targetNextDayFillRate: Math.min(1, Math.max(0, num(env.ROUTE_TARGET_NEXT_DAY_FILL_RATE, 0.9))),`,
    replace: `    // Regra do dono (28/08): o dia mais próximo com QUALQUER vaga é o prioritário
    // (meta 1). A meta de 0.9 deixava a última vaga de hoje/amanhã para trás.
    targetNextDayFillRate: Math.min(1, Math.max(0, num(env.ROUTE_TARGET_NEXT_DAY_FILL_RATE, 1))),` },
  { file: "src/lib/route-optimizer.ts",
    find: `// DIA PRIORITÁRIO = o primeiro dia (em ordem de data) que ainda tem vaga e está
// abaixo da meta de ocupação. Se todos estão na meta ou acima, o primeiro dia
// com vaga. "Primeiro deixamos amanhã cheio; depois deixamos amanhã inteligente."`,
    replace: `// DIA PRIORITÁRIO = o primeiro dia (em ordem de data) que ainda tem vaga e está
// abaixo da meta de ocupação. Se todos estão na meta ou acima, o primeiro dia
// com vaga. "Primeiro deixamos amanhã cheio; depois deixamos amanhã inteligente."
// Com a meta padrão 1 (28/08) isto é simplesmente: hoje se hoje ainda tem vaga,
// senão amanhã, e assim por diante — a rota só ordena os horários DENTRO do dia.` },
  { file: "src/lib/route-optimizer.ts",
    find: `Do NOT skip to a later day because it looks more convenient; a later day only comes in when the client cannot do the priority day, asks for another day, or their stated availability has no match on it.\`);`,
    replace: `Do NOT skip to a later day because it looks more convenient; a later day only comes in when the client cannot do the priority day, asks for another day, or their stated availability has no match on it.\`);
  lines.push(\`- NO EMPTY HOURS: the team's day must not be left with open hours while a later day gets booked. If the priority day has fewer than \${cfg.offerCount} open times, offer ALL of its open times and take the remaining option from the NEXT day that has open times (its "offer first" times). When the client asks for a later day, "next week", a weekend or an evening, use the SOONEST listed day that matches, never a later one.\`);` },

  // ── scheduler.ts: regra fixa no bloco da agenda (vale COM ou SEM nota de rota)
  { file: "src/lib/scheduler.ts",
    find: String.raw`        "\n- ONLY offer times listed above. Never mention a time shown as 'fully booked'." +`,
    replace: String.raw`        "\n- ONLY offer times listed above. Never mention a time shown as 'fully booked'." +
        "\n- SOONEST DAY FIRST (owner's rule, the team must not be left with empty hours): when you propose the visit, take your two options from the FIRST line above that has open times, today if today still has times listed, otherwise the next day. If that line has only one open time, offer it plus the first open time of the next line that has any. Move to a later day ONLY when the client says they cannot do that day, asks for another day, or their stated availability has no match on it, and even then use the SOONEST matching line (for 'next week' that is the first listed day of next week, not a later one). Never skip a day that has open times because a later day has more of them." +` },

  // ── ai.ts: regra 33 aponta para o dia mais próximo
  { file: "src/lib/ai.ts",
    find: `33. EXACTLY TWO SLOTS RULE: When offering visit times, offer exactly TWO concrete options ("Thursday at 9am or 11am"), never three or more in one message. A long slot menu reads desperate and overwhelms the client. The CLIENT AVAILABILITY RULE still applies first.`,
    replace: `33. EXACTLY TWO SLOTS RULE: When offering visit times, offer exactly TWO concrete options ("Thursday at 9am or 11am"), never three or more in one message. A long slot menu reads desperate and overwhelms the client. Both options come from the SOONEST day in the schedule that has open times (today first, then tomorrow; see SOONEST DAY FIRST in the schedule), and if that day has only one open time, that one plus the first open time of the next day. The CLIENT AVAILABILITY RULE still applies first.` },

  // ── evals
  { file: "src/evals/route-optimizer-verify.ts",
    find: `    ck("amanhã 90% ocupado (na meta) → dia prioritário = depois de amanhã", pickPriorityDay([almostFull, dayAfter], CFG)?.dateStr === "2026-08-29");`,
    replace: `    ck("REGRA DO DONO 28/08: amanhã 90% ocupado (1 vaga) CONTINUA prioritário com a meta padrão (1): nenhuma vaga fica para trás", pickPriorityDay([almostFull, dayAfter], CFG)?.dateStr === "2026-08-28");
    ck("meta antiga 0.9 (só por env): amanhã 90% ocupado → dia prioritário = depois de amanhã", pickPriorityDay([almostFull, dayAfter], { ...CFG, targetNextDayFillRate: 0.9 })?.dateStr === "2026-08-29");
    ck("nota: NO EMPTY HOURS — dia prioritário com menos de 2 vagas oferece todas + a primeira do dia seguinte; 'next week' = o dia mais próximo que bate", /NO EMPTY HOURS/.test(note) && /offer ALL of its open times and take the remaining option from the NEXT day/.test(note) && /use the SOONEST listed day that matches, never a later one/.test(note), note);` },
  { file: "src/evals/route-optimizer-verify.ts",
    find: String.raw`/\[2026-08-28\] \(90% booked\): offer first 7pm/.test(note2)`,
    replace: String.raw`/\[2026-08-28\] \(90% booked\) ← PRIORITY DAY: offer first 7pm/.test(note2)` },
  { file: "src/evals/route-optimizer-verify.ts",
    find: `    ck("config: padrões fillFirst=1, meta 0.9, gap bonus 15, gap max 60", CFG.fillFirst && CFG.targetNextDayFillRate === 0.9 && CFG.gapBonusMin === 15 && CFG.gapMaxScore === 60);
    const sched2 = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");`,
    replace: `    ck("config: padrões fillFirst=1, meta 1 (qualquer vaga = dia prioritário), gap bonus 15, gap max 60", CFG.fillFirst && CFG.targetNextDayFillRate === 1 && CFG.gapBonusMin === 15 && CFG.gapMaxScore === 60);
    ck("meta 1 aceita por env (ROUTE_TARGET_NEXT_DAY_FILL_RATE=0.9 ainda funciona)", getRouteConfig({ ROUTE_TARGET_NEXT_DAY_FILL_RATE: "0.9" }).targetNextDayFillRate === 0.9 && getRouteConfig({}).targetNextDayFillRate === 1);
    const sched2 = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
    ck("agenda: regra SOONEST DAY FIRST fixa no bloco da agenda (vale sem ZIP/sem nota de rota)", /SOONEST DAY FIRST/.test(sched2) && /take your two options from the FIRST line above that has open times, today if today still has times listed/.test(sched2) && /Never skip a day that has open times because a later day has more of them/.test(sched2));
    const aiSrc2 = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
    ck("prompt: regra 33 (dois horários) manda tirar os dois do dia MAIS PRÓXIMO com vaga", /Both options come from the SOONEST day in the schedule that has open times/.test(aiSrc2));` },
]);
