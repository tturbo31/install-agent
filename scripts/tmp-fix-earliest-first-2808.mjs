// Regra do dono (28/08/2026, 2ª vez): lotar o dia mais próximo e, dentro dele, os PRIMEIROS horários
// (9am antes de 11am antes de 1pm) — nada de buraco na semana. A rota fica só para escolher o vendedor.
import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  // ── config
  {
    file: "src/lib/route-optimizer.ts",
    find: `  fillFirst: boolean; // ROUTE_FILL_FIRST — DATA PRIMEIRO: preencher o dia mais próximo antes de olhar rota de dias seguintes`,
    replace: `  fillFirst: boolean; // ROUTE_FILL_FIRST — DATA PRIMEIRO: preencher o dia mais próximo antes de olhar rota de dias seguintes
  earliestFirst: boolean; // ROUTE_EARLIEST_FIRST — dentro do dia, os PRIMEIROS horários livres vêm primeiro (ordem do relógio); a rota só escolhe o vendedor (regra do dono 28/08)`,
  },
  {
    file: "src/lib/route-optimizer.ts",
    find: `    fillFirst: bool(env.ROUTE_FILL_FIRST, true),`,
    replace: `    fillFirst: bool(env.ROUTE_FILL_FIRST, true),
    // Regra do dono (28/08): "sempre os primeiros horários para enchimento, para
    // não ficar com buracos durante a semana". Com isto ligado a rota NÃO muda a
    // ordem dos horários oferecidos — só qual vendedor pega o horário no [BOOK].
    earliestFirst: bool(env.ROUTE_EARLIEST_FIRST, true),`,
  },
  // ── rankSlotsForDay: ordem do relógio quando earliestFirst
  {
    file: "src/lib/route-optimizer.ts",
    find: `  const ordered = groups.flatMap((g) => rankByScore(g, (o) => o.score, chrono, cfg).map(({ item }) => item));
  const best = scored.length ? Math.min(...scored.map((o) => o.score * cfg.routeWeight)) : 0;`,
    replace: `  // Regra do dono (28/08): dentro do dia, os PRIMEIROS horários livres vêm
  // primeiro (9am, 11am, 1pm...) — nada de buraco na agenda. A rota continua
  // calculada (bestSeller/score valem para o [BOOK] e para o log), só não
  // reordena os horários.
  const ordered = cfg.earliestFirst
    ? [...scored].sort(chrono)
    : groups.flatMap((g) => rankByScore(g, (o) => o.score, chrono, cfg).map(({ item }) => item));
  const best = scored.length ? Math.min(...scored.map((o) => o.score * cfg.routeWeight)) : 0;`,
  },
  // ── nota: ordem do relógio também quando o chamador já trouxe o ranking (ponto único de garantia)
  {
    file: "src/lib/route-optimizer.ts",
    find: `export function buildRoutePriorityNote(days: DayRanking[], client: GeoPoint, cfg: RouteConfig, fmt12: (slot: string) => string): string | null {
  const withSlots = days.filter((d) => d.ranked.length > 0).slice(0, cfg.noteDays);`,
    replace: `export function buildRoutePriorityNote(days: DayRanking[], client: GeoPoint, cfg: RouteConfig, fmt12: (slot: string) => string): string | null {
  // Regra do dono (28/08): os primeiros horários do dia primeiro — garantido
  // aqui também, seja qual for a ordem em que o ranking chegou.
  const byClock = (d: DayRanking): DayRanking =>
    cfg.earliestFirst ? { ...d, ranked: [...d.ranked].sort((a, b) => slotMinutes(a.slot) - slotMinutes(b.slot)).map((r, i) => ({ ...r, rank: i + 1 })) } : d;
  const withSlots = days.map(byClock).filter((d) => d.ranked.length > 0).slice(0, cfg.noteDays);`,
  },
  {
    file: "src/lib/route-optimizer.ts",
    find: `The times below are the SAME open times listed above, just ordered by which ones fit the team's day best. This changes ONLY which of the listed times you name first, nothing else about how you talk or sell.\`);`,
    replace: `The times below are the SAME open times listed above, in the order they must be offered: the EARLIEST open times of the priority day first (the team's day fills from the first hour, no holes). This changes ONLY which of the listed times you name first, nothing else about how you talk or sell.\`);`,
  },
  {
    file: "src/lib/route-optimizer.ts",
    find: `  lines.push(\`- NO EMPTY HOURS: the team's day must not be left with open hours while a later day gets booked.`,
    replace: `  lines.push(\`- NO EMPTY HOURS: the team's day must not be left with open hours while a later day gets booked, and within a day the earliest open times go first (offer 9am before 11am before 1pm; the "then" and "also open" times only after the client cannot do the earlier ones).`,
  },
  // ── agenda (regra fixa, vale sem nota de rota)
  {
    file: "src/lib/scheduler.ts",
    find: String.raw`take your two options from the FIRST line above that has open times, today if today still has times listed, otherwise the next day. If that line has only one open time, offer it plus the first open time of the next line that has any.`,
    replace: String.raw`take your two options from the FIRST line above that has open times, today if today still has times listed, otherwise the next day, and take that line's EARLIEST two open times (its first two listed: 9am before 11am before 1pm), so the day fills from the first hour with no holes. If that line has only one open time, offer it plus the first open time of the next line that has any.`,
  },
  // ── prompt regra 33
  {
    file: "src/lib/ai.ts",
    find: `Both options come from the SOONEST day in the schedule that has open times (today first, then tomorrow; see SOONEST DAY FIRST in the schedule), and if that day has only one open time, that one plus the first open time of the next day.`,
    replace: `Both options come from the SOONEST day in the schedule that has open times (today first, then tomorrow; see SOONEST DAY FIRST in the schedule) and are that day's EARLIEST open times (its first two listed, 9am before 11am before 1pm), and if that day has only one open time, that one plus the first open time of the next day.`,
  },
]);
