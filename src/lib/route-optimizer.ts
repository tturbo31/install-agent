// ─── Otimização de rota dos vendedores (camada de PRIORIZAÇÃO, nunca de bloqueio) ──
// Pedido do dono (27/08/2026): parar o zigue-zague Miami → West Palm → Miami sem
// mudar NADA da conversa de vendas. Esta camada roda DEPOIS que as regras atuais
// (vendedor ativo, dia habilitado, horário do vendedor, folga, slot livre) já
// disseram quais combinações vendedor+horário são válidas, e ANTES de:
//   1. o [BOOK] escolher o vendedor (createBooking / rescheduleClientBooking):
//      entre os vendedores livres naquele slot, ganha o de melhor rota; empate
//      dentro da tolerância → regra atual (priority). Invisível ao cliente.
//   2. o modelo montar a oferta de horários (getRealAvailabilityContext): quando
//      o ZIP/cidade do cliente já é conhecido, uma nota interna ordena os
//      horários de cada dia da melhor rota para a pior. O script continua
//      oferecendo a MESMA quantidade de opções; nada é escondido.
//   3. as mensagens enlatadas de recuperação (needTimeChoiceMessage /
//      slotConflictRecoveryMessage): a mesma quantidade de horários, só que os
//      de melhor rota primeiro (apresentados em ordem cronológica).
//
// Route Score (minutos, menor = melhor) = ida do compromisso anterior até o novo
// + ida do novo até o próximo + penalidade de zigue-zague (desvio além do
// tolerado e retorno à região de onde veio). Sem vizinho de um lado, só o outro
// lado conta. Vendedor sem nenhuma visita no dia = NEUTRO (pontuação fixa
// configurável) para a regra atual de distribuição decidir.
//
// Tempo de deslocamento: Google Distance Matrix (GOOGLE_MAPS_API_KEY) → OSRM
// público (sem chave) → estimativa por distância (haversine × fator de via ÷
// velocidade média). QUALQUER erro cai para o próximo provedor e, no limite,
// para o comportamento atual do sistema. A otimização nunca derruba um
// agendamento.
import { supabaseAdmin } from "./supabase";
import {
  type GeoPoint,
  bearingDeg,
  geoKey,
  haversineKm,
  locationFromAddress,
  locationFromText,
  turnAngleDeg,
  zipsInText,
  zipCentroid,
} from "./geo/zip-geo";

// ─── Configuração (env com padrões; nada hardcoded no fluxo) ────────────────
export interface RouteConfig {
  enabled: boolean; // ROUTE_OPT_ENABLED (1/0) — desliga toda a camada
  toleranceMin: number; // ROUTE_TOLERANCE_MIN — opções a até N min da melhor são equivalentes
  excellentMaxMin: number; // ROUTE_EXCELLENT_MAX — faixa "excelente" (0-30)
  goodMaxMin: number; // ROUTE_GOOD_MAX — "bom" (31-45)
  acceptableMaxMin: number; // ROUTE_ACCEPTABLE_MAX — "aceitável" (46-60); acima = baixa prioridade
  zigzagFreeMin: number; // ROUTE_ZIGZAG_FREE_MIN — desvio (anterior→novo→próximo menos anterior→próximo) tolerado sem penalidade
  zigzagWeight: number; // ROUTE_ZIGZAG_WEIGHT — multiplicador do desvio excedente
  zigzagReturnPenaltyMin: number; // ROUTE_ZIGZAG_RETURN_PENALTY — penalidade fixa quando a rota vai e VOLTA (ângulo > 120°)
  neutralScoreMin: number; // ROUTE_NEUTRAL_SCORE — pontuação de um vendedor sem visitas no dia
  unknownLegMin: number; // ROUTE_UNKNOWN_LEG_MIN — custo de uma perna cujo vizinho não tem ZIP/cidade (nunca 0: sem endereço não é "perto")
  routeWeight: number; // ROUTE_WEIGHT — 1 = peso total; 0 = só a regra atual de distribuição
  offerCount: number; // ROUTE_OFFER_COUNT — quantas opções o script oferece (o prompt diz "exactly TWO")
  expandCount: number; // ROUTE_EXPAND_COUNT — quantas opções extras abrir quando o cliente recusa as primeiras
  askZipBeforeOffer: boolean; // ROUTE_ASK_ZIP_BEFORE_OFFER — sem ZIP/cidade conhecido, pedir o ZIP na proposta da visita
  noteDays: number; // ROUTE_NOTE_DAYS — quantos dias (com vaga) entram na nota de prioridade
  overallDays: number; // ROUTE_OVERALL_DAYS — (legado) dias considerados quando ROUTE_FILL_FIRST=0
  fillFirst: boolean; // ROUTE_FILL_FIRST — DATA PRIMEIRO: preencher o dia mais próximo antes de olhar rota de dias seguintes
  targetNextDayFillRate: number; // ROUTE_TARGET_NEXT_DAY_FILL_RATE — 0..1; dia abaixo da meta = dia prioritário (padrão 0.9)
  gapBonusMin: number; // ROUTE_GAP_BONUS_MIN — desconto (min) para um horário que fecha um BURACO entre duas visitas do vendedor
  gapMaxScore: number; // ROUTE_GAP_MAX_SCORE — o bônus de buraco só vale se a rota for viável (score antes do bônus ≤ este valor)
  provider: "auto" | "google" | "osrm" | "estimate"; // ROUTE_PROVIDER
  googleKey: string | null; // GOOGLE_MAPS_API_KEY
  osrmUrl: string; // ROUTE_OSRM_URL
  mapsTimeoutMs: number; // ROUTE_MAPS_TIMEOUT_MS
  estSpeedMinKmh: number; // ROUTE_EST_SPEED_MIN_KMH — estimativa: velocidade média em trajeto curto/urbano
  estSpeedMaxKmh: number; // ROUTE_EST_SPEED_MAX_KMH — estimativa: velocidade média em trajeto longo (I-95/Turnpike)
  estSpeedRampKm: number; // ROUTE_EST_SPEED_RAMP_KM — estimativa: distância em que a média sobe do mínimo ao máximo
  estRoadFactor: number; // ROUTE_EST_ROAD_FACTOR — estimativa: fator linha reta → via
  estFixedMin: number; // ROUTE_EST_FIXED_MIN — estimativa: minutos fixos por deslocamento
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : !/^(0|false|off|no)$/i.test(v.trim());

export function getRouteConfig(env: Record<string, string | undefined> = process.env): RouteConfig {
  const provider = (env.ROUTE_PROVIDER ?? "auto").toLowerCase();
  return {
    enabled: bool(env.ROUTE_OPT_ENABLED, true),
    toleranceMin: num(env.ROUTE_TOLERANCE_MIN, 15),
    excellentMaxMin: num(env.ROUTE_EXCELLENT_MAX, 30),
    goodMaxMin: num(env.ROUTE_GOOD_MAX, 45),
    acceptableMaxMin: num(env.ROUTE_ACCEPTABLE_MAX, 60),
    zigzagFreeMin: num(env.ROUTE_ZIGZAG_FREE_MIN, 15),
    zigzagWeight: num(env.ROUTE_ZIGZAG_WEIGHT, 1),
    zigzagReturnPenaltyMin: num(env.ROUTE_ZIGZAG_RETURN_PENALTY, 20),
    neutralScoreMin: num(env.ROUTE_NEUTRAL_SCORE, 30),
    unknownLegMin: num(env.ROUTE_UNKNOWN_LEG_MIN, 20),
    routeWeight: Math.max(0, num(env.ROUTE_WEIGHT, 1)),
    offerCount: Math.max(1, Math.round(num(env.ROUTE_OFFER_COUNT, 2))),
    expandCount: Math.max(0, Math.round(num(env.ROUTE_EXPAND_COUNT, 2))),
    askZipBeforeOffer: bool(env.ROUTE_ASK_ZIP_BEFORE_OFFER, true),
    noteDays: Math.max(1, Math.round(num(env.ROUTE_NOTE_DAYS, 10))),
    overallDays: Math.max(1, Math.round(num(env.ROUTE_OVERALL_DAYS, 3))),
    fillFirst: bool(env.ROUTE_FILL_FIRST, true),
    targetNextDayFillRate: Math.min(1, Math.max(0, num(env.ROUTE_TARGET_NEXT_DAY_FILL_RATE, 0.9))),
    gapBonusMin: Math.max(0, num(env.ROUTE_GAP_BONUS_MIN, 15)),
    gapMaxScore: num(env.ROUTE_GAP_MAX_SCORE, 60),
    provider: provider === "google" || provider === "osrm" || provider === "estimate" ? provider : "auto",
    googleKey: (env.GOOGLE_MAPS_API_KEY ?? "").trim() || null,
    osrmUrl: (env.ROUTE_OSRM_URL ?? "https://router.project-osrm.org").replace(/\/+$/, ""),
    mapsTimeoutMs: num(env.ROUTE_MAPS_TIMEOUT_MS, 2500),
    estSpeedMinKmh: num(env.ROUTE_EST_SPEED_MIN_KMH, 30),
    estSpeedMaxKmh: num(env.ROUTE_EST_SPEED_MAX_KMH, 85),
    estSpeedRampKm: num(env.ROUTE_EST_SPEED_RAMP_KM, 25),
    estRoadFactor: num(env.ROUTE_EST_ROAD_FACTOR, 1.3),
    estFixedMin: num(env.ROUTE_EST_FIXED_MIN, 4),
  };
}

// ─── Tipos ───────────────────────────────────────────────────────────────────
export interface RouteSeller {
  id: string;
  name: string;
  priority: number;
}

// Uma visita já marcada (fixa) de um vendedor num dia.
export interface ExistingVisit {
  sellerId: string;
  time: string; // "HH:MM"
  address?: string | null;
  point?: GeoPoint | null;
}

export type RouteTier = "excellent" | "good" | "acceptable" | "low" | "neutral";

export interface RouteLeg {
  time: string; // horário do vizinho
  label: string; // ZIP/cidade do vizinho (log)
  minutes: number | null; // null = local do vizinho desconhecido
}

export interface RouteScore {
  score: number; // minutos equivalentes; menor = melhor
  tier: RouteTier;
  neutral: boolean;
  prev: RouteLeg | null;
  next: RouteLeg | null;
  detourMin: number; // anterior→novo→próximo menos anterior→próximo
  zigzagPenalty: number;
  reversal: boolean; // a rota vai e volta (ângulo > 120°)
  unknownLegs: number; // vizinhos sem localização (custam ROUTE_UNKNOWN_LEG_MIN, nunca 0)
  gapFill: boolean; // o horário fecha um buraco entre duas visitas do vendedor com rota viável (bônus aplicado)
}

export interface RankedOption {
  seller: RouteSeller;
  slot: string;
  route: RouteScore;
  rank: number; // 1 = melhor
  equivalentToBest: boolean;
}

export type TravelProvider = "google" | "osrm" | "estimate" | "cache";

// ─── Tempo de deslocamento ───────────────────────────────────────────────────
// Matriz completa n×n em minutos. Cache em memória por par (a instância Fluid
// Compute é reaproveitada entre requisições) com TTL de 24h.
type PairCache = Map<string, { min: number; at: number; provider: TravelProvider }>;
const PAIR_CACHE: PairCache = new Map();
const PAIR_TTL_MS = 24 * 60 * 60 * 1000;
const pairKey = (a: GeoPoint, b: GeoPoint) => `${geoKey(a)}>${geoKey(b)}`;

export function estimateMinutes(a: GeoPoint, b: GeoPoint, cfg: RouteConfig): number {
  const km = haversineKm(a, b);
  if (km < 0.05) return 0;
  const roadKm = km * cfg.estRoadFactor;
  // Velocidade média cresce com a distância: 5 km pela cidade rodam a ~40 km/h,
  // Miami→West Palm pela I-95 roda a ~80 km/h. Calibrado para Miami→WPB ≈ 100
  // min, Miami→Fort Lauderdale ≈ 45 min, Delray→WPB ≈ 35 min.
  const speed = cfg.estSpeedMinKmh + (cfg.estSpeedMaxKmh - cfg.estSpeedMinKmh) * (1 - Math.exp(-km / Math.max(1, cfg.estSpeedRampKm)));
  return Math.round(cfg.estFixedMin + (roadKm / speed) * 60);
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// OSRM /table: uma chamada devolve a matriz inteira (limite do servidor público
// ≈ 100 coordenadas; acima disso a estimativa assume).
async function osrmMatrix(points: GeoPoint[], cfg: RouteConfig): Promise<(number | null)[][]> {
  if (points.length > 90) throw new Error(`osrm: too many points (${points.length})`);
  const coords = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const url = `${cfg.osrmUrl}/table/v1/driving/${coords}?annotations=duration`;
  const json = (await fetchJsonWithTimeout(url, cfg.mapsTimeoutMs, { headers: { "User-Agent": "ozzi-floors-agent/1.0" } })) as {
    code?: string;
    durations?: (number | null)[][];
  };
  if (json?.code !== "Ok" || !Array.isArray(json.durations)) throw new Error(`osrm: ${json?.code ?? "bad response"}`);
  return json.durations.map((row) => row.map((sec) => (typeof sec === "number" ? Math.round(sec / 60) : null)));
}

// Google Distance Matrix: só a LINHA e a COLUNA do ponto de interesse (índice
// 0 = cliente) são consultadas (≤ 25 destinos por chamada); os pares entre
// visitas existentes usam a estimativa. Mantém o custo em 2 chamadas por turno.
async function googleRowAndColumn(points: GeoPoint[], cfg: RouteConfig): Promise<(number | null)[][]> {
  const n = points.length;
  const m: (number | null)[][] = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  const fmt = (p: GeoPoint) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  const others = points.slice(1);
  const chunk = <T,>(arr: T[], size: number) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
  const call = async (origins: GeoPoint[], dests: GeoPoint[]) => {
    const url =
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins.map(fmt).join("|"))}` +
      `&destinations=${encodeURIComponent(dests.map(fmt).join("|"))}&departure_time=now&key=${cfg.googleKey}`;
    const json = (await fetchJsonWithTimeout(url, cfg.mapsTimeoutMs)) as {
      status?: string;
      rows?: Array<{ elements?: Array<{ status?: string; duration_in_traffic?: { value: number }; duration?: { value: number } }> }>;
    };
    if (json?.status !== "OK") throw new Error(`google: ${json?.status ?? "bad response"}`);
    return json.rows ?? [];
  };
  // Todas as chamadas em PARALELO (linha e coluna de cada chunk): o tempo do
  // turno fica limitado a ~1 timeout, não a 2 × chunks × timeout.
  const parts = chunk(others, 25);
  const offsets = parts.map((_, i) => parts.slice(0, i).reduce((n, p) => n + p.length, 0));
  await Promise.all(
    parts.flatMap((part, k) => [
      call([points[0]], part).then((rows) => {
        const els = rows[0]?.elements ?? [];
        els.forEach((el, j) => {
          const sec = el?.status === "OK" ? (el.duration_in_traffic?.value ?? el.duration?.value) : undefined;
          m[0][offsets[k] + j + 1] = typeof sec === "number" ? Math.round(sec / 60) : null;
        });
      }),
      call(part, [points[0]]).then((cols) => {
        cols.forEach((row, i) => {
          const el = row?.elements?.[0];
          const sec = el?.status === "OK" ? (el.duration_in_traffic?.value ?? el.duration?.value) : undefined;
          m[offsets[k] + i + 1][0] = typeof sec === "number" ? Math.round(sec / 60) : null;
        });
      }),
    ])
  );
  m[0][0] = 0;
  return m;
}

export interface TravelMatrix {
  minutes: number[][];
  provider: TravelProvider;
  fallbackReason?: string;
  fromCache: number; // pares servidos do cache
}

// Matriz completa; pares sem resposta do provedor (null) ou não consultados
// caem para a estimativa individualmente. Nunca lança.
export async function travelMatrix(points: GeoPoint[], cfg: RouteConfig): Promise<TravelMatrix> {
  const n = points.length;
  const out: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0));
  const now = Date.now();
  let fromCache = 0;
  let missing = 0;
  const cached: (number | null)[][] = Array.from({ length: n }, () => Array<number | null>(n).fill(null));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) { cached[i][j] = 0; continue; }
      const hit = PAIR_CACHE.get(pairKey(points[i], points[j]));
      if (hit && now - hit.at < PAIR_TTL_MS) { cached[i][j] = hit.min; fromCache++; }
      else missing++;
    }
  }

  let provider: TravelProvider = "estimate";
  let fallbackReason: string | undefined;
  let fetched: (number | null)[][] | null = null;
  if (missing > 0 && n > 1 && cfg.provider !== "estimate") {
    const tryGoogle = (cfg.provider === "google" || cfg.provider === "auto") && !!cfg.googleKey;
    const tryOsrm = cfg.provider === "osrm" || (cfg.provider === "auto" && !!cfg.osrmUrl);
    if (tryGoogle) {
      try { fetched = await googleRowAndColumn(points, cfg); provider = "google"; }
      catch (err) { fallbackReason = `google failed: ${String((err as Error)?.message ?? err)}`; console.warn(`[route] ${fallbackReason}`); }
    }
    if (!fetched && tryOsrm) {
      try { fetched = await osrmMatrix(points, cfg); provider = "osrm"; }
      catch (err) { const r = `osrm failed: ${String((err as Error)?.message ?? err)}`; fallbackReason = fallbackReason ? `${fallbackReason}; ${r}` : r; console.warn(`[route] ${r}`); }
    }
  }
  if (!fetched && missing > 0 && n > 1 && cfg.provider !== "estimate" && !fallbackReason) fallbackReason = "no provider configured";

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let v = cached[i][j];
      if (v === null) {
        const f = fetched?.[i]?.[j];
        if (typeof f === "number" && Number.isFinite(f) && f >= 0) {
          v = f;
          PAIR_CACHE.set(pairKey(points[i], points[j]), { min: v, at: now, provider });
        } else {
          v = estimateMinutes(points[i], points[j], cfg);
          // A estimativa também vai ao cache (TTL curto: 1h) para não recalcular
          // a cada turno quando o provedor está fora.
          PAIR_CACHE.set(pairKey(points[i], points[j]), { min: v, at: now - PAIR_TTL_MS + 60 * 60 * 1000, provider: "estimate" });
        }
      }
      out[i][j] = v;
    }
  }
  if (PAIR_CACHE.size > 20000) PAIR_CACHE.clear();
  return { minutes: out, provider: fetched ? provider : missing === 0 && n > 1 ? "cache" : "estimate", fallbackReason, fromCache };
}

// ─── Pontuação ───────────────────────────────────────────────────────────────
export const slotMinutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})/.exec((hhmm ?? "").trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : NaN;
};

export function tierOf(score: number, cfg: RouteConfig): RouteTier {
  if (score <= cfg.excellentMaxMin) return "excellent";
  if (score <= cfg.goodMaxMin) return "good";
  if (score <= cfg.acceptableMaxMin) return "acceptable";
  return "low";
}

// Vizinhos imediatos (anterior e próximo) do novo slot na agenda do vendedor.
export function neighbours(visits: ExistingVisit[], sellerId: string, slot: string): { prev: ExistingVisit | null; next: ExistingVisit | null } {
  const t = slotMinutes(slot);
  let prev: ExistingVisit | null = null;
  let next: ExistingVisit | null = null;
  for (const v of visits) {
    if (v.sellerId !== sellerId) continue;
    const vt = slotMinutes(v.time);
    if (!Number.isFinite(vt) || vt === t) continue;
    if (vt < t && (!prev || vt > slotMinutes(prev.time))) prev = v;
    if (vt > t && (!next || vt < slotMinutes(next.time))) next = v;
  }
  return { prev, next };
}

// Pontua UMA combinação vendedor+slot dado o novo cliente e a agenda fixa do dia.
// `minutesBetween(a, b)` vem da matriz (ou da estimativa).
export function scoreOption(
  client: GeoPoint,
  visits: ExistingVisit[],
  sellerId: string,
  slot: string,
  minutesBetween: (a: GeoPoint, b: GeoPoint) => number,
  cfg: RouteConfig
): RouteScore {
  const { prev, next } = neighbours(visits, sellerId, slot);
  const hasAny = visits.some((v) => v.sellerId === sellerId);
  if (!prev && !next) {
    return { score: cfg.neutralScoreMin, tier: "neutral", neutral: true, prev: null, next: null, detourMin: 0, zigzagPenalty: 0, reversal: false, unknownLegs: hasAny ? 1 : 0, gapFill: false };
  }
  let unknownLegs = 0;
  const legFor = (v: ExistingVisit | null, dir: "in" | "out"): RouteLeg | null => {
    if (!v) return null;
    if (!v.point) { unknownLegs++; return { time: v.time, label: shortLabel(v), minutes: null }; }
    const min = dir === "in" ? minutesBetween(v.point, client) : minutesBetween(client, v.point);
    return { time: v.time, label: shortLabel(v), minutes: min };
  };
  const pl = legFor(prev, "in");
  const nl = legFor(next, "out");
  // Vizinho SEM localização (booking do dono sem ZIP): a perna não pode valer 0
  // — "não sei onde é" viraria "está do lado" e passaria por cima da regra de
  // prioridade (revisão 27/08). Todas as pernas desconhecidas → neutro; uma só
  // → custo fixo ROUTE_UNKNOWN_LEG_MIN naquela perna.
  const knownLegs = [pl, nl].filter((l) => l && l.minutes !== null).length;
  if (knownLegs === 0) {
    return { score: cfg.neutralScoreMin, tier: "neutral", neutral: true, prev: pl, next: nl, detourMin: 0, zigzagPenalty: 0, reversal: false, unknownLegs, gapFill: false };
  }
  let score = (pl ? (pl.minutes ?? cfg.unknownLegMin) : 0) + (nl ? (nl.minutes ?? cfg.unknownLegMin) : 0);
  let detourMin = 0;
  let zigzagPenalty = 0;
  let reversal = false;
  if (pl?.minutes !== null && pl?.minutes !== undefined && nl?.minutes !== null && nl?.minutes !== undefined && prev?.point && next?.point) {
    const direct = minutesBetween(prev.point, next.point);
    detourMin = Math.max(0, pl.minutes + nl.minutes - direct);
    zigzagPenalty += Math.max(0, detourMin - cfg.zigzagFreeMin) * cfg.zigzagWeight;
    // "Foi e voltou": o rumo de anterior→novo e de novo→próximo diverge mais de
    // 120° com pernas relevantes (> 15 min). Miami→WPB→Miami pega aqui; Miami→
    // Fort Lauderdale→Boca (sempre para o norte) não.
    if (pl.minutes > 15 && nl.minutes > 15 && haversineKm(prev.point, client) > 3 && haversineKm(client, next.point) > 3) {
      const angle = turnAngleDeg(bearingDeg(prev.point, client), bearingDeg(client, next.point));
      if (angle > 120) { reversal = true; zigzagPenalty += cfg.zigzagReturnPenaltyMin; }
    }
  }
  score += zigzagPenalty;
  score = Math.round(score);
  // GAP SCORE (regra do dono, 27/08): um horário ENTRE duas visitas já marcadas
  // do vendedor fecha um buraco na agenda — vale mais, desde que a rota seja
  // viável (sem ida-e-volta, score ≤ ROUTE_GAP_MAX_SCORE). Bônus = desconto
  // fixo; nunca abaixo de 0. Vale para a oferta E para a escolha do vendedor.
  let gapFill = false;
  if (pl && nl && pl.minutes !== null && nl.minutes !== null && !reversal && score <= cfg.gapMaxScore && cfg.gapBonusMin > 0) {
    gapFill = true;
    score = Math.max(0, score - cfg.gapBonusMin);
  }
  return { score, tier: tierOf(score, cfg), neutral: false, prev: pl, next: nl, detourMin: Math.round(detourMin), zigzagPenalty: Math.round(zigzagPenalty), reversal, unknownLegs, gapFill };
}

function shortLabel(v: ExistingVisit): string {
  if (v.point?.label) return v.point.label;
  const zip = v.point?.zip ?? (v.address ?? "").match(/\b3[34]\d{3}\b/)?.[0];
  return zip ?? "no-zip"; // nunca o endereço de outro cliente no log
}

// Ordena por pontuação em CLASSES DE EQUIVALÊNCIA (tolerância) e, dentro de
// cada classe, pela regra atual (`tieBreak`). Assim uma diferença de poucos
// minutos nunca decide sozinha, e a regra de distribuição continua mandando
// entre opções parecidas.
export function rankByScore<T>(
  items: T[],
  scoreOf: (t: T) => number,
  tieBreak: (a: T, b: T) => number,
  cfg: RouteConfig
): Array<{ item: T; rank: number; equivalentToBest: boolean }> {
  const weighted = (t: T) => scoreOf(t) * cfg.routeWeight;
  const sorted = [...items].sort((a, b) => weighted(a) - weighted(b) || tieBreak(a, b));
  const out: Array<{ item: T; rank: number; equivalentToBest: boolean }> = [];
  const best = sorted.length ? weighted(sorted[0]) : 0;
  let i = 0;
  while (i < sorted.length) {
    const start = weighted(sorted[i]);
    let j = i;
    while (j < sorted.length && weighted(sorted[j]) - start <= cfg.toleranceMin) j++;
    const group = sorted.slice(i, j).sort(tieBreak);
    for (const item of group) out.push({ item, rank: out.length + 1, equivalentToBest: weighted(item) - best <= cfg.toleranceMin });
    i = j;
  }
  return out;
}

// ─── Núcleo: classificar vendedores para UM slot ─────────────────────────────
export interface RankSellersInput {
  client: GeoPoint;
  slot: string;
  candidates: RouteSeller[]; // JÁ filtrados pelas regras atuais (livres, ativos, sem folga)
  visits: ExistingVisit[]; // visitas fixas do dia (todos os vendedores), com point resolvido
  cfg: RouteConfig;
}

export async function rankSellersForSlot(input: RankSellersInput): Promise<{ ranked: RankedOption[]; matrix: TravelMatrix }> {
  const { client, slot, candidates, visits, cfg } = input;
  const points = collectPoints(client, visits);
  const matrix = await travelMatrix(points.list, cfg);
  const between = (a: GeoPoint, b: GeoPoint) => matrix.minutes[points.index(a)][points.index(b)];
  const scored = candidates.map((seller) => ({ seller, slot, route: scoreOption(client, visits, seller.id, slot, between, cfg) }));
  const ranked = rankByScore(scored, (o) => o.route.score, (a, b) => a.seller.priority - b.seller.priority, cfg)
    .map(({ item, rank, equivalentToBest }) => ({ ...item, rank, equivalentToBest }));
  return { ranked, matrix };
}

function collectPoints(client: GeoPoint, visits: ExistingVisit[]): { list: GeoPoint[]; index: (p: GeoPoint) => number } {
  const list: GeoPoint[] = [client];
  const idx = new Map<string, number>([[geoKey(client), 0]]);
  for (const v of visits) {
    if (!v.point) continue;
    const k = geoKey(v.point);
    if (!idx.has(k)) { idx.set(k, list.length); list.push(v.point); }
  }
  return { list, index: (p) => idx.get(geoKey(p)) ?? 0 };
}

// ─── Núcleo: classificar os SLOTS de um dia (para a oferta) ──────────────────
// Para cada slot livre, a melhor pontuação entre os vendedores livres nele.
export interface SlotRank {
  slot: string;
  score: number;
  tier: RouteTier;
  bestSeller: RouteSeller | null;
  rank: number;
  equivalentToBest: boolean;
}

export function rankSlotsForDay(
  client: GeoPoint,
  openBySlot: Map<string, RouteSeller[]>,
  visits: ExistingVisit[],
  minutesBetween: (a: GeoPoint, b: GeoPoint) => number,
  cfg: RouteConfig
): SlotRank[] {
  const scored: Array<Omit<SlotRank, "rank" | "equivalentToBest">> = [];
  for (const [slot, sellers] of openBySlot) {
    if (sellers.length === 0) continue;
    let best: { seller: RouteSeller; score: number } | null = null;
    for (const s of [...sellers].sort((a, b) => a.priority - b.priority)) {
      const r = scoreOption(client, visits, s.id, slot, minutesBetween, cfg);
      if (!best || r.score < best.score - 1e-9) best = { seller: s, score: r.score };
    }
    if (best) scored.push({ slot, score: best.score, tier: tierOf(best.score, cfg), bestSeller: best.seller });
  }
  // Empate dentro da tolerância → ordem cronológica (a regra atual: o mais cedo primeiro).
  return rankByScore(scored, (o) => o.score, (a, b) => slotMinutes(a.slot) - slotMinutes(b.slot), cfg)
    .map(({ item, rank, equivalentToBest }) => ({ ...item, rank, equivalentToBest }));
}

// Devolve os `count` melhores slots por rota, apresentados em ORDEM CRONOLÓGICA
// (o cliente lê "1pm, 3pm ou 5pm", não "3pm, 1pm, 5pm"). Mesma quantidade que
// a lista original teria: nunca reduz opções.
export function pickSlotsByRoute(ranked: SlotRank[], count: number): string[] {
  return ranked.slice(0, count).map((r) => r.slot).sort((a, b) => slotMinutes(a) - slotMinutes(b));
}

// ─── Nota interna para o modelo (oferta de horários) ─────────────────────────
export interface DayRanking {
  dateStr: string;
  displayDate: string; // "Thursday, August 27, 2026 [2026-08-27]" — o MESMO formato da linha de agenda
  ranked: SlotRank[];
  capacity?: number; // oportunidades (vendedor × horário) do dia, já sem folga/dia desabilitado
  open?: number; // oportunidades ainda livres
}

// Daily Fill Rate = ocupadas / capacidade. Sem capacidade → 1 (cheio).
export function fillRateOf(d: { capacity?: number; open?: number }): number {
  const cap = d.capacity ?? 0;
  if (cap <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - (d.open ?? 0) / cap));
}

// DIA PRIORITÁRIO = o primeiro dia (em ordem de data) que ainda tem vaga e está
// abaixo da meta de ocupação. Se todos estão na meta ou acima, o primeiro dia
// com vaga. "Primeiro deixamos amanhã cheio; depois deixamos amanhã inteligente."
export function pickPriorityDay(days: DayRanking[], cfg: RouteConfig): DayRanking | null {
  const withSlots = days.filter((d) => d.ranked.length > 0);
  if (withSlots.length === 0) return null;
  if (!cfg.fillFirst) return withSlots[0];
  return withSlots.find((d) => fillRateOf(d) < cfg.targetNextDayFillRate) ?? withSlots[0];
}

export const ROUTE_NOTE_HEADER = "ROUTE PRIORITY (internal, never mention it)";
export const ZIP_FIRST_NOTE_HEADER = "ZIP CODE FIRST (internal)";

export function buildRoutePriorityNote(days: DayRanking[], client: GeoPoint, cfg: RouteConfig, fmt12: (slot: string) => string): string | null {
  const withSlots = days.filter((d) => d.ranked.length > 0).slice(0, cfg.noteDays);
  if (withSlots.length === 0) return null;
  const firstN = cfg.offerCount + cfg.expandCount;
  const priority = pickPriorityDay(withSlots, cfg);
  const pct = (d: DayRanking) => `${Math.round(fillRateOf(d) * 100)}% booked`;
  const lines: string[] = [];
  lines.push(`${ROUTE_NOTE_HEADER}: the client's property is around ${client.label ?? client.zip ?? "the given area"}. The times below are the SAME open times listed above, just ordered by which ones fit the team's day best. This changes ONLY which of the listed times you name first, nothing else about how you talk or sell.`);
  lines.push(`- DATE FIRST: we fill the closest day before anything else. Offer the same number of options you always offer (${cfg.offerCount}), and take them from the PRIORITY DAY named below, from its "offer first" times, in the order given (when that day has ${cfg.offerCount} or more open times, both options are on that day). Do NOT skip to a later day because it looks more convenient; a later day only comes in when the client cannot do the priority day, asks for another day, or their stated availability has no match on it.`);
  lines.push(`- If the client needs a specific day, use that day's "offer first" times. If the client cannot do the offered times, asks for something later/earlier, or asks for other options, open the "then" times of the SAME day next, and after that ANY other time listed on that day's line above; only then move to the next day. Every time listed above stays fully available; NEVER say a listed time is unavailable, and NEVER offer fewer options than the line has just because of this ordering.`);
  lines.push(`- If the client states their own constraint ("only after 6", "only Saturday", "I can only do 3pm", "tomorrow doesn't work"), their constraint wins: offer whatever listed times match it, whatever the order here.`);
  lines.push(`- If the client's latest message is their zip code or area (answering your question), do not stop at acknowledging it: in that SAME reply offer your usual ${cfg.offerCount} time slots from the priority day's "offer first" times and ask which works better, exactly as you always do.`);
  lines.push(`- NEVER tell the client anything about routes, distance, travel time, "being nearby", "in the area", "on the way", how full a day is, or how the team organizes its day. To the client this is just you naming open times.`);
  lines.push(`- Write ONLY the message to the client. Never write this note, its labels ("offer first", "priority day", "route priority", "booked"), the client's constraints in the third person, or any reasoning about which times to pick.`);
  for (const d of withSlots) {
    const first = d.ranked.slice(0, firstN);
    const offerFirst = first.slice(0, cfg.offerCount);
    const then = first.slice(cfg.offerCount);
    const rest = d.ranked.slice(firstN);
    const tag = priority && d.dateStr === priority.dateStr ? " ← PRIORITY DAY" : "";
    let line = `• ${d.displayDate} (${pct(d)})${tag}: offer first ${offerFirst.map((r) => fmt12(r.slot)).join(", ")}`;
    if (then.length) line += `; then ${then.map((r) => fmt12(r.slot)).join(", ")}`;
    if (rest.length) line += `; also open ${rest.map((r) => fmt12(r.slot)).join(", ")}`;
    lines.push(line);
  }
  if (priority) {
    const pf = priority.ranked.slice(0, cfg.offerCount).map((r) => fmt12(r.slot)).join(", ");
    lines.push(`PRIORITY DAY: ${priority.displayDate} — start there: ${pf}. Move to the next day only when the client cannot do it, asks for another day, or their stated availability has no match on it.`);
  }
  return lines.join("\n");
}

// Nota quando o ZIP/cidade do cliente ainda não é conhecido no momento de
// oferecer horários. Mesmo tom do script: uma pergunta curta, nada de rota.
export function buildZipFirstNote(zipAlreadyAsked: boolean): string {
  if (zipAlreadyAsked) {
    return `${ZIP_FIRST_NOTE_HEADER}: you already asked for the zip code once and the client has not sent it. Do NOT ask for it again now and do not mention it. Simply follow all your normal rules as if this note did not exist (answer what the client asked; name time slots only when your normal rules call for it, never as an add-on to an informational answer), and collect the zip code later together with the full address, as usual.`;
  }
  return (
    `${ZIP_FIRST_NOTE_HEADER}: the client's zip code or city is not known yet. The ONLY change to your normal flow: in the SAME message where you propose the free visit (or when the client asks about availability, days, or times), do not list the time slots yet; instead ask, in ONE short natural question in the client's language, for the zip code of the property (for example "What's the zip code of the property?" / "¿Cuál es el código postal de la propiedad?" / "Qual é o zip code do imóvel?"). Keep everything else about that message exactly as you normally write it (same tone, same sales points, no dashes, no emojis). As soon as they send the zip code, offer your usual two time slots in your next message.` +
    ` Exceptions, so a sale is never lost: if the client already named a specific day or time they want, if they already sent their full address, or if they ask for the times again after your question, do NOT ask for the zip code on its own: continue exactly as you normally would (confirm or offer the slots, then ask for the name, the full address with the zip code and the phone together, as usual). Ask for the zip code at most ONCE. Never explain why you ask it, never mention routes, distance, travel time or how the team organizes its day, and never write this note or your reasoning in the reply.`
  );
}

// Já pedimos o ZIP a este cliente? (qualquer pergunta nossa com zip/código postal)
export function zipAlreadyAskedInHistory(history: Array<{ role: string; content: string }>): boolean {
  return (history ?? []).some(
    (m) => m.role === "assistant" && /\bzip\b|zip\s*code|c[oó]digo\s+postal|\bcep\b/i.test((m.content || "").split(/\n\n?\[SYSTEM:/)[0])
  );
}

// O ponto do cliente a partir do histórico: a menção MAIS RECENTE do próprio
// cliente (ZIP digitado, endereço, cidade/bairro), ignorando as notas [SYSTEM:].
// Bolhas de cliente carregam texto GERADO pelo sistema entre colchetes: a
// legenda do anúncio compartilhado ("[Client shared a post/reel from our ad:
// 'Flooring in Miami, Broward & Palm Beach']"), a análise de planta baixa, o
// eco do anúncio respondido. Nada disso é o cliente dizendo onde mora.
// "[Voice: ...]" fica: é a fala do cliente transcrita.
const SYSTEM_BRACKETS = /\[(?:Client (?:shared|replied)|Floor plan analysis|Image|Photo|Attachment|Sticker|Video)[^\]]*\]/gi;
export function clientOwnText(content: string): string {
  return (content || "").split(/\n\n?\[SYSTEM:/)[0].replace(SYSTEM_BRACKETS, " ");
}

export function clientLocationFromHistory(history: Array<{ role: string; content: string }>): GeoPoint | null {
  const msgs = history ?? [];
  // 1ª passada: um ZIP digitado em QUALQUER bolha do cliente (a mais recente
  // vence). 2ª passada: cidade/bairro com contexto de lugar. Um ZIP é sempre
  // mais confiável que um nome de cidade — e "Stuart" respondendo "qual seu
  // nome?" não pode desfazer o 33130 digitado três bolhas antes.
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const zips = zipsInText(clientOwnText(msgs[i].content));
    if (zips.length > 0) {
      const p = zipCentroid(zips[zips.length - 1]);
      if (p) return p;
    }
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const p = locationFromText(clientOwnText(msgs[i].content));
    if (p) return p;
  }
  return null;
}

export { locationFromAddress, locationFromText };

// ─── Log das decisões (controle interno; nunca vai ao cliente) ───────────────
export interface RouteDecisionLog {
  kind: "book" | "reschedule" | "recovery" | "offer";
  igsid?: string | null;
  clientLabel?: string | null;
  zip?: string | null;
  date: string;
  slot?: string;
  chosenSeller?: string | null;
  chosenScore?: number | null;
  chosenTier?: RouteTier | null;
  reason: string;
  provider?: TravelProvider | "none";
  fallback?: string | null;
  presented?: string[];
  options?: Array<Record<string, unknown>>;
  ms?: number;
}

export function logRouteDecision(d: RouteDecisionLog, persist: boolean): void {
  try {
    console.log(`[route] ${JSON.stringify(d)}`);
  } catch {
    /* nunca falha */
  }
  if (!persist) return;
  // Linha compacta em platform_settings (mesmo padrão dos rastros sendfail-last|):
  // route|<kind>|<igsid>|<date> <slot>|<seller>|<score>|<tier>|<provider>|<ts>
  try {
    const key = `route|${d.kind}|${d.igsid ?? "?"}|${d.date} ${d.slot ?? ""}|${d.chosenSeller ?? "?"}|${d.chosenScore ?? "?"}|${d.chosenTier ?? "?"}|${d.provider ?? "?"}|${d.zip ?? "?"}|${new Date().toISOString()}`.slice(0, 250);
    void supabaseAdmin
      .from("platform_settings")
      .insert({ platform: key, paused: false })
      .then(
        ({ error }) => { if (error) console.warn("[route] log persist failed:", error.message); },
        (err: unknown) => console.warn("[route] log persist rejected:", String((err as Error)?.message ?? err))
      );
    // GC ocasional (1 em 25): linhas route| com mais de ROUTE_LOG_KEEP_DAYS dias.
    if (Math.random() < 0.04) void pruneRouteLogs();
  } catch {
    /* best-effort */
  }
}

const ROUTE_LOG_KEEP_DAYS = 30;
async function pruneRouteLogs(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from("platform_settings").select("platform").like("platform", "route|%");
    if (error || !data) return;
    const cutoff = Date.now() - ROUTE_LOG_KEEP_DAYS * 86400000;
    for (const r of data as Array<{ platform: string }>) {
      const ts = Date.parse(r.platform.split("|").pop() ?? "");
      if (Number.isFinite(ts) && ts < cutoff) await supabaseAdmin.from("platform_settings").delete().eq("platform", r.platform);
    }
  } catch {
    /* best-effort */
  }
}

// Resumo de uma opção para o log.
export function optionForLog(o: RankedOption): Record<string, unknown> {
  return {
    seller: o.seller.name,
    slot: o.slot,
    score: o.route.score,
    tier: o.route.tier,
    rank: o.rank,
    eq: o.equivalentToBest,
    prev: o.route.prev ? `${o.route.prev.time} ${o.route.prev.label} → ${o.route.prev.minutes ?? "?"}min` : null,
    next: o.route.next ? `${o.route.next.minutes ?? "?"}min → ${o.route.next.time} ${o.route.next.label}` : null,
    detour: o.route.detourMin || undefined,
    zigzag: o.route.zigzagPenalty || undefined,
    reversal: o.route.reversal || undefined,
    neutral: o.route.neutral || undefined,
    gapFill: o.route.gapFill || undefined,
  };
}

// Visitas fixas do dia com o ponto resolvido (a partir do endereço gravado).
export function toExistingVisits(rows: Array<{ seller_id: string | null; booking_time: string; address?: string | null }>): ExistingVisit[] {
  const out: ExistingVisit[] = [];
  for (const r of rows) {
    if (!r.seller_id) continue;
    const time = (r.booking_time ?? "").toString().slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    out.push({ sellerId: r.seller_id, time, address: r.address ?? null, point: locationFromAddress(r.address) });
  }
  return out;
}
