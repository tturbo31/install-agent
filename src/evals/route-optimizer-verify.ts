/**
 * OTIMIZAÇÃO DE ROTA DOS VENDEDORES — guarda de regressão (regra do dono, 27/08/2026).
 *
 * Prova, sem nenhuma chamada de API nem de banco, que a camada de rota
 * (src/lib/route-optimizer.ts + src/lib/geo/zip-geo.ts):
 *  - prioriza e ORDENA opções válidas, nunca elimina nenhuma;
 *  - respeita a tolerância (empate → regra atual: priority / cronológico);
 *  - pune o zigue-zague (Miami → West Palm → Miami) e deixa Miami → Fort
 *    Lauderdale → Boca em paz;
 *  - trata primeiro/último compromisso do dia e vendedor sem visitas (neutro);
 *  - cai para a estimativa quando a API de mapas falha e nunca lança;
 *  - resolve ZIP/cidade/endereço do texto do cliente sem confundir número de
 *    casa, preço ou metragem com ZIP;
 *  - os 15 CENÁRIOS obrigatórios do pedido;
 *  - e (estático) que scheduler + 3 webhooks estão acoplados nos pontos certos.
 *
 * Run: npx tsx src/evals/route-optimizer-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  getRouteConfig,
  scoreOption,
  rankByScore,
  rankSellersForSlot,
  rankSlotsForDay,
  pickSlotsByRoute,
  buildRoutePriorityNote,
  buildZipFirstNote,
  zipAlreadyAskedInHistory,
  clientLocationFromHistory,
  travelMatrix,
  estimateMinutes,
  neighbours,
  toExistingVisits,
  tierOf,
  type ExistingVisit,
  type RouteSeller,
  type RouteConfig,
  type DayRanking,
  type SlotRank,
} from "../lib/route-optimizer";
import { zipCentroid, locationFromText, locationFromAddress, zipsInText, cityAliasZip, knownZipCount, haversineKm, type GeoPoint } from "../lib/geo/zip-geo";
import { extractZip } from "../lib/scheduler";

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 220)}»`); }
}

// ── fixtures ────────────────────────────────────────────────────────────────
const CFG: RouteConfig = { ...getRouteConfig({}), provider: "estimate" };
const P = (zip: string): GeoPoint => { const p = zipCentroid(zip); if (!p) throw new Error(`fixture zip ${zip} missing`); return p; };
const MIAMI = P("33130");        // downtown Miami
const MIAMI2 = P("33125");       // Little Havana (~5 km)
const FTL = P("33301");          // Fort Lauderdale
const BOCA = P("33432");         // Boca Raton
const DELRAY = P("33444");       // Delray Beach
const WPB = P("33401");          // West Palm Beach
const HOMESTEAD = P("33030");    // Homestead

const ALEX: RouteSeller = { id: "alex", name: "Alexandre", priority: 1 };
const DIEGO: RouteSeller = { id: "diego", name: "Diego", priority: 2 };
const CRIS: RouteSeller = { id: "cris", name: "Cris", priority: 3 };
const V = (sellerId: string, time: string, point: GeoPoint): ExistingVisit => ({ sellerId, time, point, address: point.label });

// Estimativa determinística (sem rede): a mesma que o fallback de produção usa.
const est = (a: GeoPoint, b: GeoPoint) => estimateMinutes(a, b, CFG);

console.log("\n━━ 1. Geo: tabela, ZIP em texto, cidades, endereços ━━");
ck("tabela embutida cobre ≥ 850 ZIPs 33xxx/34xxx", knownZipCount() >= 850, String(knownZipCount()));
ck("33130 → downtown Miami", Math.abs(MIAMI.lat - 25.767) < 0.02 && Math.abs(MIAMI.lng + 80.206) < 0.02, JSON.stringify(MIAMI));
ck("Miami → West Palm ≈ 100+ km", haversineKm(MIAMI, WPB) > 95 && haversineKm(MIAMI, WPB) < 125, String(haversineKm(MIAMI, WPB)));
ck("estimativa Miami→WPB fica entre 75 e 120 min", est(MIAMI, WPB) >= 75 && est(MIAMI, WPB) <= 120, String(est(MIAMI, WPB)));
ck("estimativa Miami→Fort Lauderdale fica entre 30 e 60 min", est(MIAMI, FTL) >= 30 && est(MIAMI, FTL) <= 60, String(est(MIAMI, FTL)));
ck("estimativa Delray→WPB fica entre 25 e 50 min", est(DELRAY, WPB) >= 25 && est(DELRAY, WPB) <= 50, String(est(DELRAY, WPB)));
ck("estimativa Miami→Little Havana < 20 min", est(MIAMI, MIAMI2) < 20, String(est(MIAMI, MIAMI2)));
ck("ZIP sozinho na resposta ('33130') é reconhecido", zipsInText("33130").join() === "33130");
ck("ZIP dentro de frase ('my zip is 33458')", zipsInText("my zip is 33458").join() === "33458");
ck("número de casa NÃO é ZIP ('33055 SW 12 St')", zipsInText("33055 SW 12 St, Miami").length === 0, zipsInText("33055 SW 12 St, Miami").join());
ck("endereço completo: ZIP no fim vence ('11417 SW 251st St, Homestead FL 33032')", zipsInText("11417 SW 251st St, Homestead FL 33032").join() === "33032");
ck("preço não é ZIP ('$33,500')", zipsInText("quote was $33,500").length === 0);
ck("metragem não é ZIP ('33000 sqft')", zipsInText("about 33000 sqft").length === 0);
ck("telefone não é ZIP ('3305551234')", zipsInText("call 3305551234").length === 0);
ck("ZIP inexistente na tabela ignorado ('33999')", zipsInText("33999").length === 0);
ck("ZIP fora da área (34952 Port St Lucie) resolve (o prompt recusa, a rota não quebra)", !!zipCentroid("34952"));
ck("cidade: 'West Palm' → 33401", cityAliasZip("I'm in West Palm") === "33401");
ck("cidade: 'Ft. Lauderdale' → 33301", cityAliasZip("ft. lauderdale area") === "33301");
ck("cidade: 'Miami Gardens' vence 'Miami'", cityAliasZip("miami gardens") === "33056");
ck("cidade: 'north miami beach' vence 'miami beach'", cityAliasZip("North Miami Beach") === "33162");
ck("cidade: acentos ('Hialeah' em 'estoy en Hialéah')", cityAliasZip("estoy en Hialéah") === "33010");
ck("cidade: 'Kendall' → 33176", cityAliasZip("kendall") === "33176");
ck("cidade: 'Plantation' não pega dentro de 'implantation'", cityAliasZip("implantation") === null);
ck("cidade: 'Weston' não pega 'Western'", cityAliasZip("western style") === null);
// Apelidos exigem CONTEXTO DE LUGAR (revisão 27/08: "this is Stuart" virava Stuart FL → recusa fora de área)
ck("nome de pessoa NÃO é cidade ('Hi this is Stuart, 800 sqft in Miami' → Miami)", locationFromText("Hi this is Stuart, I need 800 sqft vinyl in Miami")?.zip === "33130");
ck("'my name is Kendall' → nada", locationFromText("my name is Kendall") === null);
ck("'I can do it at sunrise' → nada", locationFromText("I can do it at sunrise") === null);
ck("'hollywood style floors' / 'plantation shutters' → nada", locationFromText("hollywood style floors") === null && locationFromText("plantation shutters") === null);
ck("'de boca en boca' / 'Wellington boots' / 'it's a marathon' → nada", locationFromText("me lo dijeron de boca en boca") === null && locationFromText("wellington boots") === null && locationFromText("it's a marathon") === null);
ck("'I'm in Boca' (inglês) → Boca Raton", locationFromText("I'm in Boca")?.zip === "33432");
ck("'I'm from Naples originally, house is in Miami' → Miami (não Naples)", locationFromText("I'm from Naples originally, house is in Miami")?.zip === "33130");
ck("cidade fora da área não é apelido ('in Stuart' → nada; o prompt recusa pelo nome)", locationFromText("the house is in Stuart") === null);
ck("mensagem inteira = cidade ('Boca Raton.') → vale", locationFromText("Boca Raton.")?.zip === "33432");
ck("'Hollywood, FL' (contexto depois) → vale", locationFromText("Hollywood, FL")?.zip === "33020");
ck("'moro em Weston' (pt) → vale", locationFromText("moro em Weston")?.zip === "33326");
ck("'33130 USD' / '33150 SQFT' não são ZIP (case-insensitive)", zipsInText("about 33130 USD").length === 0 && zipsInText("33150 SQFT").length === 0);
ck("'33308 ft lauderdale' é ZIP (ft ≠ feet)", zipsInText("33308 ft lauderdale").join() === "33308");
ck("'33055 Southwest 12th Street' é número de casa, não ZIP", zipsInText("33055 Southwest 12th Street, Miami").length === 0);
ck("'apt 33130' / '#33130' são unidade, não ZIP", zipsInText("apt 33130").length === 0 && zipsInText("#33130").length === 0);
ck("ponto derivado de cidade não expõe ZIP âncora no rótulo", /area$/.test(locationFromText("I live in Delray Beach")?.label ?? "") && !/\d{5}/.test(locationFromText("I live in Delray Beach")?.label ?? ""));
ck("locationFromText prioriza ZIP sobre cidade", locationFromText("Boca Raton, 33130")?.zip === "33130");
ck("locationFromText: cidade sozinha", locationFromText("I live in Delray Beach")?.zip === "33444");
ck("locationFromText: nada → null", locationFromText("hi, how much for 800 sqft?") === null);
ck("locationFromAddress: endereço com ZIP", locationFromAddress("300 S Biscayne Blvd Apt 2116, Miami FL 33131")?.zip === "33131");
ck("locationFromAddress: endereço sem ZIP mas com cidade", locationFromAddress("123 Main St, Boynton Beach")?.zip === "33435");
ck("locationFromAddress: vazio → null", locationFromAddress("") === null && locationFromAddress(null) === null);
ck("extractZip (scheduler) e zipsInText concordam no endereço real", extractZip("6327 SW 12th Street West Miami, FL 33144") === "33144" && zipsInText("6327 SW 12th Street West Miami, FL 33144").join() === "33144");

// todos os apelidos apontam para ZIPs que existem
{
  const src = readFileSync(join(process.cwd(), "src/lib/geo/zip-geo.ts"), "utf-8");
  const zips = [...src.matchAll(/\["[^"]+",\s*"(\d{5})"\]/g)].map((m) => m[1]);
  const missing = zips.filter((z) => !zipCentroid(z));
  ck(`todos os ${zips.length} apelidos de cidade apontam para ZIP existente`, zips.length > 100 && missing.length === 0, missing.join(","));
}

console.log("\n━━ 2. Histórico do cliente → localização (ignora [SYSTEM:], pega a mais recente) ━━");
{
  const h = [
    { role: "user", content: "hi, vinyl for 900 sqft" },
    { role: "assistant", content: "For that size I need to visit. What's the zip code of the property?" },
    { role: "user", content: "33458\n\n[SYSTEM: REAL-TIME SCHEDULE ... 2026-08-27: 9am, 11am ... 33130]" },
  ];
  ck("ZIP digitado sozinho na resposta é a localização", clientLocationFromHistory(h)?.zip === "33458");
  const h2 = [{ role: "user", content: "I'm in Boca" }, { role: "assistant", content: "ok" }, { role: "user", content: "actually the property is 33401" }];
  ck("a menção MAIS RECENTE vence", clientLocationFromHistory(h2)?.zip === "33401");
  const h3 = [{ role: "user", content: "hello" }, { role: "assistant", content: "Hi! Which one are you interested in?" }];
  ck("sem menção → null", clientLocationFromHistory(h3) === null);
  const h4 = [{ role: "assistant", content: "Great, the property is in Miami 33130 right?" }, { role: "user", content: "yes" }];
  ck("texto do BOT não conta como localização do cliente", clientLocationFromHistory(h4) === null);
  const h5 = [{ role: "user", content: "33130" }, { role: "assistant", content: "What name should I put the visit under?" }, { role: "user", content: "Stuart" }];
  ck("ZIP digitado antes vence um nome/cidade digitado depois (Stuart não desfaz o 33130)", clientLocationFromHistory(h5)?.zip === "33130");
  const h6 = [{ role: "user", content: `[Client shared a post/reel from our ad: "Flooring in Miami, Broward & Palm Beach"]` }];
  ck("legenda do anúncio compartilhado NÃO é localização do cliente", clientLocationFromHistory(h6) === null);
  const h7 = [{ role: "user", content: "[Floor plan analysis: 3 bedrooms, in Boca Raton style layout]" }, { role: "user", content: "[Voice: the house is in Pembroke Pines]" }];
  ck("análise de planta ignorada; transcrição de voz ([Voice:]) conta", clientLocationFromHistory(h7)?.zip === "33024");
  ck("zipAlreadyAskedInHistory: pergunta nossa com 'zip code'", zipAlreadyAskedInHistory(h) === true);
  ck("zipAlreadyAskedInHistory: sem pergunta", zipAlreadyAskedInHistory(h3) === false);
  ck("zipAlreadyAskedInHistory: 'código postal' (es)", zipAlreadyAskedInHistory([{ role: "assistant", content: "¿Cuál es el código postal?" }]) === true);
}

console.log("\n━━ 3. Pontuação (Route Score) ━━");
{
  // Vendedor: 11am Miami, [1pm livre], 3pm Miami. Novo cliente em WPB.
  const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2)];
  const zz = scoreOption(WPB, visits, "alex", "13:00", est, CFG);
  ck("Miami→WPB→Miami: score muito alto (> 150)", zz.score > 150, JSON.stringify(zz));
  ck("Miami→WPB→Miami: penalidade de zigue-zague aplicada", zz.zigzagPenalty > 30 && zz.reversal === true, JSON.stringify(zz));
  ck("Miami→WPB→Miami: tier 'low'", zz.tier === "low");
  ck("ambos os lados considerados (prev e next preenchidos)", !!zz.prev && !!zz.next && zz.prev.time === "11:00" && zz.next.time === "15:00");
  // Miami → Fort Lauderdale → Boca (sempre para o norte)
  const north = [V("cris", "11:00", MIAMI), V("cris", "15:00", BOCA)];
  const ok = scoreOption(FTL, north, "cris", "13:00", est, CFG);
  ck("Miami→FTL→Boca: sem penalidade de retorno", ok.reversal === false && ok.zigzagPenalty <= 5, JSON.stringify(ok));
  ck("Miami→FTL→Boca muito melhor que Miami→WPB→Miami", ok.score < zz.score / 2, `${ok.score} vs ${zz.score}`);
  // Boca → Delray → WPB (rota lógica para o norte) com novo cliente em WPB
  const pb = [V("cris", "11:00", BOCA), V("cris", "13:00", DELRAY)];
  const good = scoreOption(WPB, pb, "cris", "15:00", est, CFG);
  ck("Delray → WPB (último do dia): só o anterior conta", good.prev?.time === "13:00" && good.next === null, JSON.stringify(good));
  ck("Delray → WPB: tier excelente/bom", good.tier === "excellent" || good.tier === "good", JSON.stringify(good));
  // Primeiro do dia
  const first = scoreOption(WPB, [V("diego", "15:00", WPB)], "diego", "09:00", est, CFG);
  ck("primeiro do dia: só o próximo conta", first.prev === null && first.next?.time === "15:00" && first.score < 15, JSON.stringify(first));
  // Mesma região
  const same = scoreOption(MIAMI2, [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI)], "alex", "13:00", est, CFG);
  ck("mesma região dos compromissos: excelente", same.tier === "excellent" && same.score < 30, JSON.stringify(same));
  // Neutro
  const neutral = scoreOption(WPB, [], "diego", "13:00", est, CFG);
  ck("sem visitas no dia: neutro com pontuação configurada", neutral.neutral && neutral.tier === "neutral" && neutral.score === CFG.neutralScoreMin, JSON.stringify(neutral));
  // Vizinho sem localização não penaliza
  const unk = scoreOption(WPB, [{ sellerId: "alex", time: "11:00", point: null, address: "sem zip" }, V("alex", "15:00", WPB)], "alex", "13:00", est, CFG);
  ck("vizinho sem localização custa ROUTE_UNKNOWN_LEG_MIN (nunca 0 = 'do lado')", unk.unknownLegs === 1 && unk.score === CFG.unknownLegMin + 0, JSON.stringify(unk));
  const unk2 = scoreOption(WPB, [{ sellerId: "alex", time: "11:00", point: null, address: "sem zip" }, { sellerId: "alex", time: "15:00", point: null, address: "sem zip 2" }], "alex", "13:00", est, CFG);
  ck("TODOS os vizinhos sem localização → neutro (regra atual decide)", unk2.neutral && unk2.score === CFG.neutralScoreMin && unk2.unknownLegs === 2, JSON.stringify(unk2));
  // Revisão 27/08: vizinho sem ZIP valia 0 e passava por cima do priority-1
  {
    const vis = [{ sellerId: "cris", time: "11:00", point: null, address: "casa do João" }, V("diego", "11:00", P("33134"))];
    const r = rankByScore([{ s: ALEX, sc: scoreOption(MIAMI, vis, "alex", "13:00", est, CFG).score }, { s: DIEGO, sc: scoreOption(MIAMI, vis, "diego", "13:00", est, CFG).score }, { s: CRIS, sc: scoreOption(MIAMI, vis, "cris", "13:00", est, CFG).score }], (o) => o.sc, (a, b) => a.s.priority - b.s.priority, CFG);
    const cris = r.find((x) => x.item.s.name === "Cris")!;
    const diego = r.find((x) => x.item.s.name === "Diego")!;
    ck("vizinho SEM ZIP vale neutro (30), não 0: Cris nunca fica acima de Diego (16 min real)", cris.item.sc === CFG.neutralScoreMin && cris.rank > diego.rank, JSON.stringify(r.map((x) => [x.item.s.name, x.item.sc])));
  }
  // neighbours: pega os IMEDIATOS
  const nb = neighbours([V("a", "09:00", MIAMI), V("a", "11:00", FTL), V("a", "17:00", BOCA), V("a", "19:00", WPB), V("b", "13:00", WPB)], "a", "13:00");
  ck("neighbours: anterior = 11:00, próximo = 17:00 (ignora outro vendedor)", nb.prev?.time === "11:00" && nb.next?.time === "17:00");
  ck("tierOf nas faixas: 30 exc, 45 bom, 60 aceitável, 61 low", tierOf(30, CFG) === "excellent" && tierOf(45, CFG) === "good" && tierOf(60, CFG) === "acceptable" && tierOf(61, CFG) === "low");
}

console.log("\n━━ 4. Classes de equivalência (tolerância) + regra atual de desempate ━━");
{
  const items = [{ n: "A", s: 40, p: 1 }, { n: "B", s: 32, p: 3 }, { n: "C", s: 36, p: 2 }, { n: "D", s: 90, p: 1 }];
  const r = rankByScore(items, (i) => i.s, (a, b) => a.p - b.p, CFG).map((x) => x.item.n);
  ck("32/36/40 são equivalentes (≤15) → priority decide: A, C, B; depois D", r.join("") === "ACBD", r.join(""));
  const r2 = rankByScore(items, (i) => i.s, (a, b) => a.p - b.p, { ...CFG, toleranceMin: 2 }).map((x) => x.item.n);
  ck("tolerância 2 → ordem pura por score: B, C, A, D", r2.join("") === "BCAD", r2.join(""));
  const r3 = rankByScore(items, (i) => i.s, (a, b) => a.p - b.p, { ...CFG, routeWeight: 0 }).map((x) => x.item.n);
  ck("ROUTE_WEIGHT=0 → só a regra atual (priority): A, D, C, B", r3.join("") === "ADCB", r3.join(""));
  ck("equivalentToBest marca só a classe da melhor", rankByScore(items, (i) => i.s, (a, b) => a.p - b.p, CFG).filter((x) => x.equivalentToBest).length === 3);
}

console.log("\n━━ 5. Os 15 cenários obrigatórios ━━");
const byName = (ranked: Array<{ seller: RouteSeller }>) => ranked.map((r) => r.seller.name);
async function run() {
  // CENÁRIO 1: Alex 11am Miami / 1pm livre / 3pm Miami; cliente WPB; Cris perto de WPB (Boca 11am → Delray 3pm) e livre 1pm.
  {
    const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)];
    const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX, CRIS], visits, cfg: CFG });
    ck("C1: prioriza o vendedor perto de West Palm (Cris) em vez do zigue-zague de Alexandre", byName(ranked)[0] === "Cris", JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
    ck("C1: Alexandre continua como OPÇÃO (não eliminado)", ranked.length === 2 && byName(ranked)[1] === "Alexandre");
  }
  // CENÁRIO 2: mesmo Alex, nenhum outro vendedor disponível → marca mesmo assim.
  {
    const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2)];
    const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX], visits, cfg: CFG });
    ck("C2: único vendedor válido é escolhido mesmo com rota ruim (não perde a venda)", ranked.length === 1 && ranked[0].seller.name === "Alexandre" && ranked[0].route.tier === "low");
  }
  // CENÁRIO 3: dois vendedores com scores praticamente iguais → regra atual (priority).
  {
    const visits = [V("alex", "11:00", FTL), V("diego", "11:00", P("33304"))]; // ambos em Fort Lauderdale
    const { ranked } = await rankSellersForSlot({ client: P("33308"), slot: "13:00", candidates: [DIEGO, ALEX], visits, cfg: CFG });
    ck("C3: scores equivalentes → priority decide (Alexandre=1 antes de Diego=2)", byName(ranked)[0] === "Alexandre" && ranked[0].equivalentToBest && ranked[1].equivalentToBest, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
  }
  // CENÁRIO 4: cliente totalmente flexível → horários mais eficientes primeiro (nota "Best overall").
  {
    const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)];
    const open = new Map<string, RouteSeller[]>([["09:00", [ALEX, CRIS]], ["13:00", [ALEX, CRIS]], ["17:00", [ALEX, CRIS]], ["19:00", [CRIS]]]);
    const ranked = rankSlotsForDay(WPB, open, visits, est, CFG);
    // 17:00 (Cris após Delray, rumo norte) e 09:00 (Cris antes de Boca) são as
    // duas boas; 13:00 entre Boca e Delray é um desvio (vai a WPB e volta) e
    // 19:00 depois de Delray só com Cris também. Dentro da tolerância, a regra
    // atual (cronológica) decide a ordem entre as equivalentes.
    const top2 = ranked.slice(0, 2).map((r) => r.slot);
    ck("C4: os 2 melhores para WPB são 9am e 5pm (nunca o 1pm de ida-e-volta)", top2.includes("17:00") && top2.includes("09:00") && !top2.includes("13:00"), JSON.stringify(ranked));
    ck("C4: 13:00 (Boca→WPB→Delray) fica classificado abaixo, com desvio penalizado", (ranked.find((r) => r.slot === "13:00")?.score ?? 0) > (ranked.find((r) => r.slot === "17:00")?.score ?? 0) + CFG.toleranceMin);
    ck("C4: bestSeller do 13:00 é Cris (não Alexandre, que faria Miami→WPB→Miami)", ranked.find((r) => r.slot === "13:00")?.bestSeller?.name === "Cris");
    ck("C4: TODOS os 4 slots continuam na lista", ranked.length === 4);
  }
  // CENÁRIO 5: cliente só pode às 3pm → melhor vendedor para 3pm.
  {
    const visits = [V("alex", "13:00", MIAMI), V("diego", "13:00", WPB), V("cris", "13:00", HOMESTEAD)];
    const { ranked } = await rankSellersForSlot({ client: P("33409"), slot: "15:00", candidates: [ALEX, DIEGO, CRIS], visits, cfg: CFG });
    ck("C5: às 3pm o melhor vendedor é Diego (vem de WPB)", byName(ranked)[0] === "Diego", JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
    ck("C5: os 3 continuam como opção", ranked.length === 3);
  }
  // CENÁRIO 6: primeiro appointment do dia → considera o próximo.
  {
    const a = scoreOption(WPB, [V("alex", "11:00", WPB)], "alex", "09:00", est, CFG);
    const b = scoreOption(WPB, [V("diego", "11:00", HOMESTEAD)], "diego", "09:00", est, CFG);
    ck("C6: 9am antes de 11am em WPB (Alex) vence 9am antes de 11am em Homestead (Diego)", a.score < b.score && a.prev === null && b.prev === null, `${a.score} vs ${b.score}`);
  }
  // CENÁRIO 7: último appointment do dia → considera o anterior.
  {
    const a = scoreOption(WPB, [V("alex", "15:00", DELRAY)], "alex", "17:00", est, CFG);
    const b = scoreOption(WPB, [V("diego", "15:00", HOMESTEAD)], "diego", "17:00", est, CFG);
    ck("C7: 5pm depois de Delray vence 5pm depois de Homestead", a.score < b.score && a.next === null && b.next === null, `${a.score} vs ${b.score}`);
  }
  // CENÁRIO 8: vendedor sem appointment no dia → neutro → regra atual.
  {
    const visits = [V("alex", "11:00", FTL)]; // Alex está a ~45-60 min de WPB; Diego vazio
    const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX, DIEGO], visits, cfg: CFG });
    const diego = ranked.find((r) => r.seller.name === "Diego")!;
    ck("C8: vendedor vazio é neutro (score = neutralScoreMin)", diego.route.neutral && diego.route.score === CFG.neutralScoreMin, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
    // e quando o outro está na MESMA região, a regra atual decide entre equivalentes
    const visits2 = [V("alex", "11:00", P("33409"))]; // Alex já em WPB
    const { ranked: r2 } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [DIEGO, ALEX], visits: visits2, cfg: CFG });
    ck("C8b: vazio (30) vs mesma região (~10) → equivalentes (≤15)? não: diferença 20 → mesma região vence", r2[0].seller.name === "Alexandre", JSON.stringify(r2.map((r) => [r.seller.name, r.route.score])));
    const { ranked: r3 } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [DIEGO, ALEX], visits: [V("alex", "11:00", P("33460"))], cfg: CFG }); // Lake Worth ~20 min
    ck("C8c: vazio (30) vs Lake Worth (~20) → equivalentes → priority (Alexandre)", r3[0].seller.name === "Alexandre" && r3[0].equivalentToBest && r3[1].equivalentToBest, JSON.stringify(r3.map((r) => [r.seller.name, r.route.score])));
  }
  // CENÁRIO 9: API de mapas indisponível → fallback e segue.
  {
    const bad: RouteConfig = { ...CFG, provider: "osrm", osrmUrl: "http://127.0.0.1:9/nope", mapsTimeoutMs: 300 };
    const m = await travelMatrix([P("33018"), P("33487")], bad); // pontos ainda não cacheados
    ck("C9: OSRM fora → provider 'estimate' com motivo registrado, matriz válida", m.provider === "estimate" && !!m.fallbackReason && m.minutes[0][1] > 30, JSON.stringify(m));
    const again = await travelMatrix([P("33018"), P("33487")], bad);
    ck("C9d: segunda chamada dos mesmos pares vem do cache (sem rede)", again.provider === "cache" && again.fromCache === 2 && again.minutes[0][1] === m.minutes[0][1], JSON.stringify(again));
    const badGoogle: RouteConfig = { ...CFG, provider: "google", googleKey: "invalid-key", mapsTimeoutMs: 300 };
    const g = await travelMatrix([P("33019"), P("33486")], badGoogle);
    ck("C9b: Google inválido → estimativa, nunca lança", g.provider === "estimate" && g.minutes[0][1] > 10, JSON.stringify(g));
    const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX, CRIS], visits: [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)], cfg: bad });
    ck("C9c: mesmo sem mapas a classificação continua certa (Cris primeiro)", byName(ranked)[0] === "Cris");
  }
  // CENÁRIO 10: cliente na mesma região dos appointments → forte prioridade.
  {
    const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)];
    const { ranked } = await rankSellersForSlot({ client: P("33135"), slot: "13:00", candidates: [CRIS, ALEX], visits, cfg: CFG });
    ck("C10: cliente em Little Havana → Alexandre (Miami) com folga, tier excelente", byName(ranked)[0] === "Alexandre" && ranked[0].route.tier === "excellent" && !ranked[1].equivalentToBest, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
  }
  // CENÁRIO 11: 4 horários, sistema mostra 2 → mostra os 2 melhores; 6pm/7pm continuam existindo.
  {
    const visits = [V("cris", "13:00", DELRAY), V("alex", "15:00", HOMESTEAD), V("alex", "19:00", HOMESTEAD)];
    const open = new Map<string, RouteSeller[]>([["15:00", [CRIS]], ["17:00", [CRIS]], ["18:00", [ALEX]], ["19:00", [DIEGO]]]);
    const visits2 = [...visits, V("diego", "17:00", HOMESTEAD)];
    const ranked = rankSlotsForDay(WPB, open, visits2, est, CFG);
    const two = pickSlotsByRoute(ranked, 2);
    ck("C11: oferece 3pm e 5pm (os 2 melhores), em ordem cronológica", two.join(",") === "15:00,17:00", JSON.stringify({ two, ranked }));
    ck("C11: não oferece só 1 opção", two.length === 2);
    ck("C11: 6pm e 7pm NÃO foram eliminados (seguem classificados)", ranked.length === 4 && ranked.some((r) => r.slot === "18:00") && ranked.some((r) => r.slot === "19:00"));
    // CENÁRIO 12: cliente recusa e pede mais tarde → abrir 6pm/7pm
    const later = ranked.filter((r) => r.slot > "17:00").map((r) => r.slot).sort();
    ck("C12: 'algo mais tarde?' → 6pm e 7pm disponíveis mesmo com score pior", later.join(",") === "18:00,19:00");
    const note = buildRoutePriorityNote([{ dateStr: "2026-09-01", displayDate: "Tuesday, September 1, 2026 [2026-09-01]", ranked }], WPB, CFG, (s) => s);
    ck("C12b: a nota manda abrir os outros horários quando o cliente não pode", /cannot do those|other options/i.test(note ?? "") && /(also open|then)/.test(note ?? ""), note ?? "");
  }
  // CENÁRIO 13: todos os horários parecidos → comportamento atual (ordem cronológica).
  {
    const visits = [V("alex", "11:00", WPB)];
    const open = new Map<string, RouteSeller[]>([["13:00", [ALEX]], ["15:00", [ALEX]], ["17:00", [ALEX]]]);
    const ranked = rankSlotsForDay(P("33409"), open, visits, est, CFG);
    ck("C13: scores parecidos → ordem cronológica preservada (13, 15, 17)", ranked.map((r) => r.slot).join(",") === "13:00,15:00,17:00" && ranked.every((r) => r.equivalentToBest), JSON.stringify(ranked));
  }
  // CENÁRIO 14: só um horário → só ele.
  {
    const open = new Map<string, RouteSeller[]>([["19:00", [DIEGO]]]);
    const ranked = rankSlotsForDay(WPB, open, [V("diego", "17:00", MIAMI)], est, CFG);
    ck("C14: único horário disponível é oferecido sozinho (não inventa segundo)", pickSlotsByRoute(ranked, 2).join(",") === "19:00");
  }
  // CENÁRIO 15: único horário que atende a restrição é ruim → permitir e escolher o melhor vendedor.
  {
    const visits = [V("alex", "17:00", MIAMI), V("alex", "21:00", MIAMI2), V("diego", "17:00", HOMESTEAD), V("diego", "21:00", HOMESTEAD)];
    const { ranked } = await rankSellersForSlot({ client: WPB, slot: "19:00", candidates: [ALEX, DIEGO], visits, cfg: CFG });
    ck("C15: 7pm (única opção do cliente) é permitida; ambos ruins, o menos ruim primeiro (Alexandre)", ranked.length === 2 && ranked[0].seller.name === "Alexandre" && ranked[0].route.tier === "low", JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score])));
  }

  console.log("\n━━ 6. Nota interna para o modelo ━━");
  {
    const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)];
    const open = new Map<string, RouteSeller[]>([["09:00", [ALEX, CRIS]], ["13:00", [ALEX, CRIS]], ["17:00", [ALEX, CRIS]], ["19:00", [CRIS]]]);
    const ranked = rankSlotsForDay(WPB, open, visits, est, CFG);
    const days: DayRanking[] = [{ dateStr: "2026-08-28", displayDate: "Friday, August 28, 2026 [2026-08-28]", ranked }];
    const fmt = (s: string) => { const [h, m] = s.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + m : ""}${h >= 12 ? "pm" : "am"}`; };
    const note = buildRoutePriorityNote(days, WPB, CFG, fmt)!;
    ck("nota existe e tem o cabeçalho interno", !!note && note.startsWith("ROUTE PRIORITY"));
    ck("nota mantém a MESMA quantidade de opções (offer first = 2)", /offer first \d{1,2}(?::\d{2})?[ap]m, \d{1,2}(?::\d{2})?[ap]m/.test(note), note);
    ck("nota lista TODOS os horários do dia (nenhum some)", ["9am", "1pm", "5pm", "7pm"].every((t) => note.includes(t)), note);
    ck("nota proíbe falar de rota/distância com o cliente", /NEVER tell the client anything about routes/.test(note));
    ck("nota diz que os horários listados continuam disponíveis", /stays fully available/.test(note));
    ck("nota respeita restrição declarada do cliente", /their constraint wins/.test(note));
    ck("nota usa o mesmo formato de data da agenda ([YYYY-MM-DD])", note.includes("[2026-08-28]"));
    ck("nota vazia quando não há horários", buildRoutePriorityNote([{ dateStr: "2026-08-28", displayDate: "x", ranked: [] }], WPB, CFG, fmt) === null);
    const zipNote = buildZipFirstNote(false);
    ck("nota ZIP-first: pede o ZIP UMA vez, na proposta da visita, sem falar de rota", /zip code/i.test(zipNote) && /at most ONCE/.test(zipNote) && /never mention routes/i.test(zipNote));
    ck("nota ZIP-first: exceções para não perder a venda (dia/hora já pedido, endereço enviado)", /already named a specific day or time/.test(zipNote) && /full address/.test(zipNote));
    ck("nota ZIP-first (já perguntado): NÃO pergunta de novo, oferece os horários", /Do NOT ask for it again/.test(buildZipFirstNote(true)));
    ck("toExistingVisits resolve o ponto pelo endereço e ignora sem vendedor", (() => { const v = toExistingVisits([{ seller_id: "a", booking_time: "13:00:00", address: "5330 Lake Blvd, Delray Beach FL 33484" }, { seller_id: null, booking_time: "15:00", address: "x" }]); return v.length === 1 && v[0].time === "13:00" && v[0].point?.zip === "33484"; })());
  }

  console.log("\n━━ 6b. DATA PRIMEIRO (Fill Rate), Gap Score, dia prioritário (regra do dono 27/08) ━━");
  {
    const { fillRateOf, pickPriorityDay } = await import("../lib/route-optimizer");
    const mk = (slot: string, score: number, rank: number): SlotRank => ({ slot, score, tier: tierOf(score, CFG), bestSeller: ALEX, rank, equivalentToBest: rank === 1 });
    // Exemplo do pedido: amanhã 11am=40, 1pm=80, 3pm=25, 5pm=50, 7pm=95; depois de amanhã 11am=20, 1pm=22, 3pm=18.
    const tomorrow: DayRanking = { dateStr: "2026-08-28", displayDate: "Friday, August 28, 2026 [2026-08-28]", ranked: [mk("15:00", 25, 1), mk("11:00", 40, 2), mk("17:00", 50, 3), mk("13:00", 80, 4), mk("19:00", 95, 5)], capacity: 10, open: 5 };
    const dayAfter: DayRanking = { dateStr: "2026-08-29", displayDate: "Saturday, August 29, 2026 [2026-08-29]", ranked: [mk("15:00", 18, 1), mk("11:00", 20, 2), mk("13:00", 22, 3)], capacity: 10, open: 3 };
    ck("Fill Rate: 5 livres de 10 = 50%; 0 capacidade = 100%", fillRateOf(tomorrow) === 0.5 && fillRateOf({ capacity: 0, open: 0 }) === 1);
    ck("dia prioritário = amanhã (50% < meta 90%) mesmo com depois de amanhã tendo rotas melhores", pickPriorityDay([tomorrow, dayAfter], CFG)?.dateStr === "2026-08-28");
    const fmt = (s: string) => { const [h, m] = s.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + m : ""}${h >= 12 ? "pm" : "am"}`; };
    const note = buildRoutePriorityNote([tomorrow, dayAfter], WPB, CFG, fmt)!;
    ck("nota: amanhã marcado como PRIORITY DAY, com 'offer first 3pm, 11am; then 5pm, 1pm; also open 7pm' (ordem do exemplo do pedido)", /Friday, August 28, 2026 \[2026-08-28\] \(50% booked\) ← PRIORITY DAY: offer first 3pm, 11am; then 5pm, 1pm; also open 7pm/.test(note), note);
    ck("nota: linha final aponta o dia prioritário e manda começar por ele (3pm, 11am)", /PRIORITY DAY: Friday, August 28, 2026 \[2026-08-28\] — start there: 3pm, 11am\./.test(note), note);
    ck("nota: NÃO compara dias entre si ('Best overall' sumiu)", !/Best overall/.test(note));
    ck("nota: proíbe pular para um dia depois por conveniência e diz quando o próximo dia entra", /Do NOT skip to a later day/.test(note) && /cannot do the priority day, asks for another day, or their stated availability has no match/.test(note));
    ck("nota: restrição do cliente ('tomorrow doesn't work') vence", /tomorrow doesn't work/.test(note) && /their constraint wins/.test(note));
    ck("nota: nunca falar de ocupação com o cliente", /how full a day is/.test(note));
    // amanhã praticamente cheio (9 de 10) → dia prioritário passa a ser depois de amanhã; o horário que sobrou continua listado
    const almostFull: DayRanking = { ...tomorrow, ranked: [mk("19:00", 95, 1)], capacity: 10, open: 1 };
    ck("amanhã 90% ocupado (na meta) → dia prioritário = depois de amanhã", pickPriorityDay([almostFull, dayAfter], CFG)?.dateStr === "2026-08-29");
    const note2 = buildRoutePriorityNote([almostFull, dayAfter], WPB, CFG, fmt)!;
    ck("nota: o horário que sobrou amanhã continua listado (nunca some)", /\[2026-08-28\] \(90% booked\): offer first 7pm/.test(note2), note2);
    ck("meta configurável: com ROUTE_TARGET_NEXT_DAY_FILL_RATE=0.95 amanhã (90%) volta a ser prioritário", pickPriorityDay([almostFull, dayAfter], { ...CFG, targetNextDayFillRate: 0.95 })?.dateStr === "2026-08-28");
    ck("todos os dias na meta → o primeiro com vaga é o prioritário", pickPriorityDay([{ ...tomorrow, capacity: 10, open: 0, ranked: [] }, { ...dayAfter, capacity: 10, open: 1 }], CFG)?.dateStr === "2026-08-29");
    ck("ROUTE_FILL_FIRST=0 → primeiro dia com vaga, sem olhar ocupação", pickPriorityDay([almostFull, dayAfter], { ...CFG, fillFirst: false })?.dateStr === "2026-08-28");
    ck("25 min de rota melhor depois de amanhã NÃO empurram o cliente: amanhã (score 55) continua prioritário", pickPriorityDay([{ ...tomorrow, ranked: [mk("13:00", 55, 1)], open: 6 }, { ...dayAfter, ranked: [mk("13:00", 30, 1)] }], CFG)?.dateStr === "2026-08-28");
    // GAP SCORE: 9am/11am ocupados, 1pm vazio, 3pm/5pm ocupados → 1pm fecha o buraco
    const gapVisits = [V("alex", "09:00", MIAMI), V("alex", "11:00", MIAMI2), V("alex", "15:00", MIAMI), V("alex", "17:00", MIAMI2)];
    const gap = scoreOption(P("33135"), gapVisits, "alex", "13:00", est, CFG);
    const edge = scoreOption(P("33135"), gapVisits, "alex", "19:00", est, CFG);
    ck("Gap Score: 1pm entre 11am e 3pm recebe o bônus (gapFill) e fica abaixo do 7pm (fim do dia)", gap.gapFill && !edge.gapFill && gap.score < edge.score, JSON.stringify({ gap, edge }));
    ck("Gap Score não vale com ida-e-volta (Miami→WPB→Miami segue penalizado, sem bônus)", scoreOption(WPB, [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2)], "alex", "13:00", est, CFG).gapFill === false);
    ck("Gap Score não vale quando a rota é inviável (score > ROUTE_GAP_MAX_SCORE)", scoreOption(P("33418"), [V("alex", "11:00", HOMESTEAD), V("alex", "15:00", HOMESTEAD)], "alex", "13:00", est, CFG).gapFill === false);
    // Gap também decide o vendedor no [BOOK]: quem tem o buraco (rota viável) vence quem estenderia o dia
    {
      const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("diego", "11:00", MIAMI)];
      const { ranked } = await rankSellersForSlot({ client: P("33135"), slot: "13:00", candidates: [DIEGO, ALEX], visits, cfg: CFG });
      ck("[BOOK]: Alexandre (1pm fecha o buraco 11am→3pm) vence Diego (1pm só estende o dia)", ranked[0].seller.name === "Alexandre" && ranked[0].route.gapFill, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score, r.route.gapFill])));
    }
    ck("config: padrões fillFirst=1, meta 0.9, gap bonus 15, gap max 60", CFG.fillFirst && CFG.targetNextDayFillRate === 0.9 && CFG.gapBonusMin === 15 && CFG.gapMaxScore === 60);
    const sched2 = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
    ck("agenda calcula capacidade/ocupação por dia (Fill Rate) e repassa à nota", /capacity\+\+;/.test(sched2) && /days\.push\(\{ dateStr: d\.dateStr, displayDate: d\.displayDate, ranked, capacity: d\.capacity, open: d\.open \}\)/.test(sched2));
  }

  console.log("\n━━ 6c. VENDEDOR PREFERIDO: encher a agenda do Alexandre primeiro (regra do dono 27/08) ━━");
  {
    const { preferredSellerIds } = await import("../lib/route-optimizer");
    const ALL = [ALEX, DIEGO, CRIS];
    ck("preferido por padrão = menor priority (Alexandre)", [...preferredSellerIds(ALL, CFG)].join() === "alex");
    ck("ROUTE_PREFERRED_SELLER=Cris → Cris (nome, case-insensitive)", [...preferredSellerIds(ALL, { ...CFG, preferredSellerName: "CRIS" })].join() === "cris");
    ck("nome fixo que não está entre os ativos (Alexandre desativado) → NINGUÉM herda a preferência", preferredSellerIds([DIEGO, CRIS], CFG).size === 0 && preferredSellerIds(ALL, { ...CFG, preferredSellerName: "Fulano" }).size === 0);
    ck("ROUTE_PREFERRED_SELLER=auto → menor priority", [...preferredSellerIds(ALL, { ...CFG, preferredSellerName: "auto" })].join() === "alex");
    ck("sem a lista de ativos (allSellers ausente) → ninguém preferido", preferredSellerIds(undefined, CFG).size === 0);
    ck("padrão de produção: nome 'Alexandre', teto de sacrifício 45 min", CFG.preferredSellerName === "Alexandre" && CFG.preferredSellerMaxExtraMin === 45);
    // Revisão 27/08: Alexandre com visitas SEM ZIP (itinerário desconhecido) não é "rota viável"
    {
      const visits = [{ sellerId: "alex", time: "11:00", point: null, address: "sem zip" }, { sellerId: "alex", time: "15:00", point: null, address: "sem zip" }, V("cris", "11:00", P("33409"))];
      const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX, CRIS], visits, cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre com visitas sem ZIP (neutro por desconhecimento) NÃO passa na frente de Chris a 10 min", ranked[0].seller.name === "Cris" && !ranked.some((r) => r.preferred), JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
    }
    // Revisão 27/08: teto do sacrifício (ROUTE_PREFERRED_SELLER_MAX_EXTRA_MIN=45)
    {
      const ok = await rankSellersForSlot({ client: P("33020"), slot: "13:00", candidates: [ALEX, DIEGO], visits: [V("alex", "11:00", P("33301")), V("diego", "11:00", P("33020"))], cfg: CFG, allSellers: ALL }); // Alex vem de Fort Lauderdale (~25), Diego já em Hollywood
      ck("[BOOK] sacrifício pequeno (Alexandre ~25 vs Diego ~5) → Alexandre", ok.ranked[0].seller.name === "Alexandre" && ok.ranked[0].preferred, JSON.stringify(ok.ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
      const big = await rankSellersForSlot({ client: P("33020"), slot: "13:00", candidates: [ALEX, DIEGO], visits: [V("alex", "11:00", P("33301")), V("alex", "15:00", P("33301")), V("diego", "11:00", P("33020"))], cfg: { ...CFG, preferredSellerMaxExtraMin: 20 }, allSellers: ALL });
      ck("[BOOK] teto configurável: com MAX_EXTRA=20 o mesmo Alexandre (~50) perde para Diego (~5)", big.ranked[0].seller.name === "Diego" && !big.ranked[0].preferred, JSON.stringify(big.ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
    }
    // Revisão 27/08: Gap Score como chave de partição (o desconto de 15 se perdia na tolerância de 15)
    {
      const visits = [V("alex", "13:00", P("33409")), V("alex", "17:00", P("33401"))];
      const open = new Map<string, RouteSeller[]>([["09:00", [ALEX]], ["11:00", [ALEX]], ["15:00", [ALEX]], ["19:00", [ALEX]]]);
      const ranked = rankSlotsForDay(P("33405"), open, visits, est, CFG, ALL);
      ck("OFERTA: o horário que fecha o buraco (3pm entre 1pm e 5pm) vem PRIMEIRO, mesmo com 9am/11am/7pm a poucos minutos", ranked[0].slot === "15:00" && ranked[0].gapFill === true, JSON.stringify(ranked.map((r) => [r.slot, r.score, r.gapFill])));
      const visits2 = [V("diego", "11:00", P("33409")), V("cris", "11:00", P("33409")), V("cris", "15:00", P("33401"))];
      const { ranked: r2 } = await rankSellersForSlot({ client: P("33405"), slot: "13:00", candidates: [DIEGO, CRIS], visits: visits2, cfg: CFG, allSellers: ALL });
      ck("[BOOK] Chris (1pm fecha buraco 11am→3pm) vence Diego (1pm só estende o dia) mesmo com scores parecidos e priority pior", r2[0].seller.name === "Cris" && r2[0].route.gapFill, JSON.stringify(r2.map((r) => [r.seller.name, r.route.score, r.route.gapFill])));
    }
    {
      const { stripReasoningLeak } = require("../lib/ai") as { stripReasoningLeak: (t: string) => string };
      const leaked = "Saturday is the priority day, it's only 70% booked. I have Saturday at 9am or 1pm, which works better for you?";
      const out = stripReasoningLeak(leaked);
      ck("stripReasoningLeak remove 'priority day' / '70% booked' e mantém a oferta", !/priority day|70% booked/i.test(out) && /Saturday at 9am or 1pm/.test(out), out);
      ck("stripReasoningLeak (es): 'día prioritario' / '80% ocupado' saem", !/prioritario|80% ocupado/i.test(stripReasoningLeak("El sábado es el día prioritario, está 80% ocupado. Tengo el sábado a las 9am o 1pm, ¿cuál te queda mejor?")));
    }
    ck("recuperação: horário não confirmado recebe vendedor sintético neutro (nunca 'Alexandre livre')", /__unconfirmed__/.test(readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8")));
    ck("ROUTE_PREFERRED_SELLER_FIRST=0 → ninguém preferido", preferredSellerIds(ALL, { ...CFG, preferredSellerFirst: false }).size === 0);
    // [BOOK]: Alexandre livre com rota viável (bom, 30-45 min) vence Chris com rota excelente
    {
      const visits = [V("alex", "11:00", P("33435")), V("cris", "11:00", P("33409"))]; // cliente WPB: Alex vem de Boynton (~30, viável), Chris já está em WPB (~10)
      const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [CRIS, ALEX], visits, cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre livre + rota viável → Alexandre primeiro mesmo com Chris a 10 min", ranked[0].seller.name === "Alexandre" && ranked[0].preferred && ranked[0].route.score <= CFG.preferredSellerMaxScore, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
      ck("[BOOK] Chris continua como opção (rank 2, não preferido)", ranked[1].seller.name === "Cris" && !ranked[1].preferred);
      const far = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [CRIS, ALEX], visits: [V("alex", "11:00", FTL), V("cris", "11:00", P("33409"))], cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre com rota acima do limite (Fort Lauderdale→WPB ≈ 68 > 60) NÃO passa na frente; Chris vence", far.ranked[0].seller.name === "Cris" && !far.ranked[1].preferred, JSON.stringify(far.ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
      const wide = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [CRIS, ALEX], visits: [V("alex", "11:00", FTL), V("cris", "11:00", P("33409"))], cfg: { ...CFG, preferredSellerMaxScore: 90, preferredSellerMaxExtraMin: 90 }, allSellers: ALL });
      ck("[BOOK] ROUTE_PREFERRED_SELLER_MAX_SCORE=90 + MAX_EXTRA=90 → o mesmo caso volta a ser do Alexandre (limites configuráveis)", wide.ranked[0].seller.name === "Alexandre" && wide.ranked[0].preferred);
    }
    // [BOOK]: Alexandre com zigue-zague (Miami→WPB→Miami) NÃO passa na frente
    {
      const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA), V("cris", "15:00", DELRAY)];
      const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [ALEX, CRIS], visits, cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre em ida-e-volta → Cris primeiro; Alexandre segue disponível (rank 2, sem preferência)", ranked[0].seller.name === "Cris" && ranked[1].seller.name === "Alexandre" && !ranked[1].preferred, JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
    }
    // [BOOK]: Alexandre ocupado no horário → Diego NÃO herda a preferência; rota decide
    {
      const visits = [V("diego", "11:00", HOMESTEAD), V("cris", "11:00", P("33409"))];
      const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [DIEGO, CRIS], visits, cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre ocupado → Diego não vira 'preferido'; Chris (WPB) vence Diego (Homestead) por rota", ranked[0].seller.name === "Cris" && ranked.every((r) => !r.preferred), JSON.stringify(ranked.map((r) => [r.seller.name, r.route.score, r.preferred])));
    }
    // [BOOK]: Alexandre sem visita no dia (neutro 30) → viável → preferido
    {
      const { ranked } = await rankSellersForSlot({ client: WPB, slot: "13:00", candidates: [CRIS, ALEX], visits: [V("cris", "11:00", P("33409"))], cfg: CFG, allSellers: ALL });
      ck("[BOOK] Alexandre com agenda vazia (neutro) → preferido (enche a agenda dele primeiro)", ranked[0].seller.name === "Alexandre" && ranked[0].preferred && ranked[0].route.neutral);
    }
    // OFERTA: horários em que o Alexandre está livre vêm primeiro no dia
    {
      const visits = [V("alex", "11:00", P("33409")), V("cris", "09:00", P("33409")), V("cris", "13:00", P("33409"))];
      const open = new Map<string, RouteSeller[]>([["09:00", [ALEX]], ["13:00", [ALEX]], ["15:00", [ALEX, CRIS]], ["17:00", [CRIS]], ["19:00", [CRIS]]]);
      const ranked = rankSlotsForDay(WPB, open, visits, est, CFG, ALL);
      const pref = ranked.filter((r) => r.preferredOpen).map((r) => r.slot);
      ck("OFERTA: os horários livres do Alexandre (9am, 1pm, 3pm) vêm antes dos que só o Chris tem (5pm, 7pm)", pref.length === 3 && ranked.slice(0, 3).every((r) => r.preferredOpen) && ranked.slice(3).every((r) => !r.preferredOpen), JSON.stringify(ranked.map((r) => [r.slot, r.score, r.bestSeller?.name, r.preferredOpen])));
      ck("OFERTA: dentro dos horários do Alexandre, buraco/rota mandam (1pm entre 11am e ... ou 9am antes de 11am)", ["09:00", "13:00"].includes(ranked[0].slot), JSON.stringify(ranked.slice(0, 3)));
      ck("OFERTA: bestSeller dos horários preferidos é o Alexandre", ranked.filter((r) => r.preferredOpen).every((r) => r.bestSeller?.name === "Alexandre"));
      ck("OFERTA: nada some — os 5 horários continuam listados", ranked.length === 5);
    }
    // OFERTA: onde a rota do Alexandre é ida-e-volta, o horário não é 'dele'
    {
      const visits = [V("alex", "11:00", MIAMI), V("alex", "15:00", MIAMI2), V("cris", "11:00", BOCA)];
      const open = new Map<string, RouteSeller[]>([["13:00", [ALEX, CRIS]]]);
      const r = rankSlotsForDay(WPB, open, visits, est, CFG, ALL);
      ck("OFERTA: Alexandre em ida-e-volta no 1pm → horário fica com o Chris (não preferido)", r[0].bestSeller?.name === "Cris" && !r[0].preferredOpen, JSON.stringify(r));
    }
    ck("config: padrões preferredSellerFirst=1, nome 'Alexandre', max 60", CFG.preferredSellerFirst && CFG.preferredSellerName === "Alexandre" && CFG.preferredSellerMaxScore === 60);
    const sched3 = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
    ck("scheduler passa TODOS os ativos ao ranking (quem é o preferido) no [BOOK], na oferta e na recuperação", /rankSellersForSlot\(\{[^}]*allSellers: sellers\.map\(asRouteSeller\) \}\)/.test(sched3) && (sched3.match(/rankSlotsForDay\([^;]*sellers\.map\(asRouteSeller\)\)/g) ?? []).length === 2);
    ck("log do [BOOK] explica a escolha pelo preferido", /preferred seller \(fill/.test(sched3));
  }

  console.log("\n━━ 7. Config ━━");
  {
    const d = getRouteConfig({});
    ck("padrões: tolerância 15, faixas 30/45/60, 2 opções, ZIP-first ligado, provider auto", d.toleranceMin === 15 && d.excellentMaxMin === 30 && d.goodMaxMin === 45 && d.acceptableMaxMin === 60 && d.offerCount === 2 && d.askZipBeforeOffer && d.provider === "auto" && d.enabled);
    const e = getRouteConfig({ ROUTE_OPT_ENABLED: "0", ROUTE_TOLERANCE_MIN: "10", ROUTE_ASK_ZIP_BEFORE_OFFER: "false", ROUTE_PROVIDER: "estimate", ROUTE_OFFER_COUNT: "3", GOOGLE_MAPS_API_KEY: " k " });
    ck("env sobrescreve: desliga, tolerância 10, sem ZIP-first, provider estimate, 3 opções, chave trim", !e.enabled && e.toleranceMin === 10 && !e.askZipBeforeOffer && e.provider === "estimate" && e.offerCount === 3 && e.googleKey === "k");
    ck("valor inválido cai no padrão", getRouteConfig({ ROUTE_TOLERANCE_MIN: "abc" }).toleranceMin === 15);
  }

  console.log("\n━━ 8. Acoplamento (estático): scheduler + 3 webhooks ━━");
  {
    const sched = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
    ck("createBooking escolhe vendedor pelo picker com rota", /pickSellerForSlotRouted\(db, sellers, bookings, req\.bookingDate, req\.bookingTime, daysOff/.test(sched));
    ck("reschedule escolhe vendedor pelo picker com rota (endereço do booking salvo)", /pickSellerForSlotRouted\(db, sellers, bookings, newDate, newTime, daysOff/.test(sched) && /clientAddress: old\.address/.test(sched));
    ck("picker com rota: mesmos candidatos da regra atual (sellerOpenForSlot + priority)", /pickSellerForSlotRouted[\s\S]{0,700}sellerOpenForSlot\(s, dateStr, weekday, slot, bookings, daysOff\)\)[\s\S]{0,120}priority - b\.priority/.test(sched));
    ck("picker com rota: fallback para candidates[0] em erro", /seller pick failed[\s\S]{0,400}return candidates\[0\]/.test(sched));
    ck("picker com rota: nunca devolve null quando há candidato (só quando 0)", /if \(candidates\.length === 0\) return null;/.test(sched));
    ck("getRealAvailabilityContext aceita opções e só adiciona a nota com opts", /getRealAvailabilityContext\(opts\?: AvailabilityContextOptions\)/.test(sched) && /if \(opts\) \{[\s\S]{0,200}routeNoteForAvailability/.test(sched));
    ck("texto da agenda original intacto (regras IMPORTANT antes da nota)", sched.indexOf("IMPORTANT — read carefully before offering any time") < sched.indexOf("const routeNote = await routeNoteForAvailability"));
    ck("nota de rota falha → null (sem nota), nunca derruba a agenda", /availability note failed[\s\S]{0,300}return null;/.test(sched));
    ck("needTimeChoiceMessage / slotConflictRecoveryMessage usam routeOrderedSlots com a MESMA contagem (4 / 3 / 2)", /routeOrderedSlots\(dateStr, slots, clientAddress, 4\)/.test(sched) && /routeOrderedSlots\(requestedDate, slots, clientAddress, 3\)/.test(sched) && /routeOrderedSlots\(first\.dateStr, first\.times, clientAddress, 2\)/.test(sched));
    ck("routeOrderedSlots: base = slice(0, count) e retorna base em qualquer erro", /const base = slots\.slice\(0, count\);/.test(sched) && /routeOrderedSlots failed[\s\S]{0,120}return base;/.test(sched));
    ck("visitas com endereço excluem canceladas", /\.is\("cancelled_at", null\)/.test(sched));
    ck("visitas com endereço excluem o booking do PRÓPRIO cliente (remarcação)", /fetchVisitsWithAddress\(db, dateStr, dateStr, ctx\.igsid\)/.test(sched) && /startsWith\(own\)/.test(sched) && /fetchVisitsWithAddress\(db, noteDays\[0\]\.dateStr, noteDays\[noteDays\.length - 1\]\.dateStr, opts\.igsid\)/.test(sched));
    ck("ZIP-first NÃO entra quando o cliente já nomeou/aceitou dia ou hora (clientAlreadyNamedSlot → clientConfirmedSlot)", /!clientAlreadyNamedSlot\(opts\.history\)/.test(sched) && /function clientAlreadyNamedSlot[\s\S]{0,200}clientConfirmedSlot\(history\)/.test(sched));
    ck("gate ZIP-first varre TODO o histórico (bot já ofereceu horário / cliente nomeou dia em qualquer bolha)", /function clientAlreadyNamedSlot[\s\S]{0,900}CLOCK_TIME_TOKEN\.test\(t\)[\s\S]{0,600}SLOT_DAY_REF\.test\(t\)/.test(sched));
    ck("remarcação: endereço vem do booking (getUpcomingBookingRecord) e NUNCA ZIP-first para cliente agendado", /opts\.rescheduling && opts\.igsid[\s\S]{0,200}getUpcomingBookingRecord\(opts\.igsid\)[\s\S]{0,150}if \(!client\) return null;/.test(sched));
    ck("ZIP fora da área (não 33xxx) → nenhuma nota (o prompt recusa a visita)", /!isServiceAreaZip\(client\.zip\)\) return null;/.test(sched));
    ck("matriz da nota só com os dias que entram na nota (≤ noteDays) e índice ausente → estimativa, nunca 0", /if \(noteDays\.length >= cfg\.noteDays\) break;/.test(sched) && /ia === undefined \|\| ib === undefined \? estimateMinutes\(a, b, cfg\)/.test(sched));
    const aiSrc = readFileSync(join(process.cwd(), "src/lib/ai.ts"), "utf-8");
    ck("anti-pressão: proposta de visita que pede o ZIP conta como push (não cola horários na resposta informativa seguinte)", /isSchedulingPush\(m\.content\) \|\| isVisitProposalWithZipAsk\(m\.content\)/.test(aiSrc));
    {
      // Vazamento real visto no eval ao vivo (27/08): a guarda determinística tem que remover o monólogo e manter a oferta.
      const { stripReasoningLeak } = require("../lib/ai") as { stripReasoningLeak: (t: string) => string };
      const leaked = "The client can only do mornings before noon, so from the schedule the matching slots are Monday at 9am or 11am, and Tuesday at 9am or 11am. I need to offer exactly two. Tuesday 9am and Tuesday 11am fit the route priority and the client's constraint best. Tuesday September 1st at 9am or 11am works, which is better for you?";
      const scrubbed = stripReasoningLeak(leaked);
      ck("stripReasoningLeak remove o monólogo com 'route priority' / 'the client can only' / 'I need to offer'", !/route priority|the client|i need to offer|matching slots/i.test(scrubbed) && /Tuesday September 1st at 9am or 11am works/.test(scrubbed), scrubbed);
      ck("stripReasoningLeak (es/pt): 'prioridad de ruta' / 'o cliente só pode' saem", !/prioridad de ruta/i.test(stripReasoningLeak("El cliente solo puede por la mañana según la prioridad de ruta. Tengo el martes a las 9am o 11am, ¿cuál te queda mejor?")) && !/o cliente só pode/i.test(stripReasoningLeak("O cliente só pode de manhã. Tenho terça às 9am ou 11am, qual fica melhor para você?")));
      ck("stripReasoningLeak não mexe numa oferta normal", stripReasoningLeak("I have Monday at 3pm or 5pm open, which works better for you?") === "I have Monday at 3pm or 5pm open, which works better for you?");
    }
    {
      // Turno de resposta do ZIP: o anti-pressão NÃO pode cortar a oferta de horários (T7 do route-offer-verify).
      const { antiPressureShouldFire, isLocationAnswer } = require("../lib/ai") as { antiPressureShouldFire: (m: Array<{ role: "user" | "assistant"; content: string }>) => boolean; isLocationAnswer: (t: string) => boolean };
      const proposal = "For that size I need to visit and measure in person to give you the best price, and I bring the samples so you can pick right there. What's the zip code of the property?";
      const base = [{ role: "user" as const, content: "vinyl, whole house 1200 sqft" }, { role: "assistant" as const, content: proposal }];
      ck("anti-pressão: resposta '33401' à pergunta de ZIP → NÃO dispara (oferta de horários passa)", antiPressureShouldFire([...base, { role: "user", content: "33401" }]) === false);
      ck("anti-pressão: resposta 'Boca Raton' à pergunta de ZIP → NÃO dispara", antiPressureShouldFire([...base, { role: "user", content: "Boca Raton" }]) === false);
      ck("anti-pressão: pergunta informativa após a proposta-com-ZIP → dispara (lista de horários colada é cortada)", antiPressureShouldFire([...base, { role: "user", content: "Is the vinyl waterproof?" }]) === true);
      ck("isLocationAnswer: '33401' / 'in Hollywood' sim; 'is it waterproof?' não", isLocationAnswer("33401") && isLocationAnswer("in Hollywood") && !isLocationAnswer("Is the vinyl waterproof?"));
    }
    {
      const { isVisitProposalWithZipAsk } = require("../lib/ai") as { isVisitProposalWithZipAsk: (t: string) => boolean };
      ck("isVisitProposalWithZipAsk: proposta+ZIP → true; pergunta de endereço com zip (Step 3) sem proposta → false", isVisitProposalWithZipAsk("For that size I need to visit and measure in person, I bring the samples. What's the zip code of the property?") && !isVisitProposalWithZipAsk("Can I have your name, the full property address with the zip code, and the best phone number?"));
    }
    ck("getAvailableSlots (lista bruta) inalterado: fallback fixo mantido", /return \["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"\];/.test(sched));
    ck("sellerOpenForSlot (regras atuais) intacto", /s\.active &&\s*s\.enabled_weekdays\.includes\(weekday\) &&\s*s\.time_slots\.includes\(slot\) &&\s*!daysOff\.has/.test(sched));
    for (const [name, file] of [["WhatsApp", "src/app/api/wa-webhook/route.ts"], ["Messenger", "src/app/api/fb-webhook/route.ts"], ["Instagram", "src/app/api/webhook/route.ts"]] as const) {
      const src = readFileSync(join(process.cwd(), file), "utf-8");
      ck(`[${name}] passa o histórico para a agenda (nota de rota / ZIP-first) + flag de remarcação`, /getRealAvailabilityContext\(\{ history, igsid: \w+, rescheduling: isRescheduling \}\)/.test(src));
      ck(`[${name}] needTimeChoiceMessage recebe o endereço do [BOOK] (2 chamadas)`, (src.match(/needTimeChoiceMessage\(lang, [^)]*bookingData\.address\)/g) ?? []).length === 2);
      ck(`[${name}] slotConflictRecoveryMessage recebe o endereço do [BOOK]`, /slotConflictRecoveryMessage\(lang, bookingData\.date, history, bookingData\.time, bookingData\.address\)/.test(src));
      ck(`[${name}] nenhuma frase de rota/logística no código de mensagens ao cliente`, !/nearby|on the way|our route|closest opening/i.test(src.replace(/\/\/.*$/gm, "")));
    }
    const prompt = readFileSync(join(process.cwd(), "src/lib/system-prompt.ts"), "utf-8");
    ck("script de vendas: 'Offer exactly TWO specific time slots' intacto", prompt.includes("Offer exactly TWO specific time slots from real-time availability in context. Never more, never fewer."));
    ck("script de vendas: sequência de confirmação (Step 1/2/3) intacta", prompt.includes("Step 3: Ask for the client's name, full address with the ZIP CODE, and phone ONLY after the client explicitly names a specific slot"));
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} route-optimizer-verify: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILED:\n - " + fails.join("\n - ")); process.exit(1); }
}
run().catch((e) => { console.error(e); process.exit(1); });
