# Otimização de rota dos vendedores (27/08/2026)

Camada de **priorização** acoplada ao agendamento existente. Ela nunca bloqueia
um horário válido, nunca muda o script de vendas e, em qualquer erro, o sistema
se comporta exatamente como antes.

## Onde ela atua

| Ponto | Antes | Agora |
|---|---|---|
| `[BOOK]` → `createBooking` / `rescheduleClientBooking` (`src/lib/scheduler.ts`) | primeiro vendedor livre por `priority` | mesmos candidatos (ativo, dia, horário, folga, slot livre); entre eles ganha o de **menor Route Score**; empate dentro da tolerância → `priority`. Invisível ao cliente. |
| Oferta de horários (`getRealAvailabilityContext({ history })`) | lista dos horários abertos por dia | a mesma lista + nota interna **ROUTE PRIORITY** (quando o ZIP/cidade do cliente já é conhecido): marca o **dia prioritário** (o mais próximo ainda abaixo da meta de ocupação) e ordena os horários de cada dia (buracos primeiro, depois melhor rota). O modelo continua oferecendo **a mesma quantidade** de opções (2), tiradas do dia prioritário. |
| Sem ZIP/cidade conhecido | oferecia os horários direto | nota **ZIP CODE FIRST**: a proposta da visita pede o ZIP em uma pergunta curta (mesmo tom), uma vez só. Gate determinístico: não entra se o cliente já nomeou dia/hora em qualquer bolha, se o bot já ofereceu horários, se é remarcação (endereço vem do booking) ou se o ZIP conhecido é fora da área. Desligável (`ROUTE_ASK_ZIP_BEFORE_OFFER=0`). |
| Mensagens enlatadas de recuperação (`needTimeChoiceMessage`, `slotConflictRecoveryMessage`) | primeiros N horários do dia | os N de melhor rota (mesma quantidade), apresentados em ordem cronológica. |

Arquivos novos: `src/lib/route-optimizer.ts` (pontuação, provedores de tempo,
notas, log), `src/lib/geo/zip-geo.ts` + `fl-zip-centroids.ts` (884 ZIPs
33xxx/34xxx da Flórida com centroide, GeoNames; apelidos de cidade/bairro).

## DATA PRIMEIRO, ROTA DEPOIS (regra do dono, 27/08)

Ordem de decisão: **1. dia mais próximo com vaga** (abaixo da meta de ocupação) → **2. buracos entre visitas** (Gap Score) → **3. rota dentro desse dia** → **4. regra atual de distribuição** → **5. preferência declarada do cliente vence tudo**.

* **Daily Fill Rate** = ocupadas ÷ capacidade (oportunidades vendedor × horário do dia, sem folga/dia desabilitado; hoje só os horários ainda ofertáveis).
* **Dia prioritário** = o primeiro dia (por data) com vaga e Fill Rate < `ROUTE_TARGET_NEXT_DAY_FILL_RATE` (0,9). A nota marca esse dia ("← PRIORITY DAY") e manda o bot tirar dele as 2 opções; um dia depois só entra quando o cliente não pode, pede outro dia ou a restrição dele não bate. Nunca comparamos rota entre dias (o antigo "Best overall" saiu): 25 min de rota melhor depois de amanhã não empurram ninguém.
* **Gap Score**: horário entre duas visitas já marcadas do mesmo vendedor, com rota viável (sem ida-e-volta, score ≤ `ROUTE_GAP_MAX_SCORE`), ganha desconto de `ROUTE_GAP_BONUS_MIN` (15) — vale na oferta e na escolha do vendedor no [BOOK].
* Um dia "praticamente cheio" (na meta) continua listado com o que sobrou; nada é escondido.

## Route Score

```
score = tempo(anterior → novo) + tempo(novo → próximo) + penalidade de zigue-zague
```

* só anterior (último do dia) ou só próximo (primeiro do dia) → só esse lado;
* vendedor sem visita no dia → **neutro** (`ROUTE_NEUTRAL_SCORE`, 30 min) → a regra atual decide;
* vizinho sem ZIP/cidade (booking do dono sem endereço completo) → a perna custa `ROUTE_UNKNOWN_LEG_MIN` (20), nunca 0; todos desconhecidos → neutro;
* zigue-zague = desvio (`t(a→n) + t(n→p) − t(a→p)`) acima de `ROUTE_ZIGZAG_FREE_MIN`
  × `ROUTE_ZIGZAG_WEIGHT`, mais `ROUTE_ZIGZAG_RETURN_PENALTY` quando a rota vai e
  **volta** (ângulo > 120°). Miami → West Palm → Miami ≈ 280; Miami → Fort
  Lauderdale → Boca ≈ 60.
* faixas: ≤30 excelente, ≤45 bom, ≤60 aceitável, >60 baixa prioridade (só ordenam).
* opções a até `ROUTE_TOLERANCE_MIN` (15) da melhor são equivalentes → `priority`
  (vendedores) / ordem cronológica (horários).

## Tempo de deslocamento

1. **Google Distance Matrix** se `GOOGLE_MAPS_API_KEY` estiver definida (linha e
   coluna do cliente, com trânsito);
2. **OSRM público** (`ROUTE_OSRM_URL`, padrão `https://router.project-osrm.org`, sem chave);
3. **estimativa** por distância (haversine × 1,3, velocidade média 30→85 km/h
   conforme a distância) — sempre disponível.

Cache em memória por par (24 h). Timeout `ROUTE_MAPS_TIMEOUT_MS` (2500 ms).
Qualquer falha cai para o próximo nível e é registrada (`fallbackReason`).

## Configuração (env; todos com padrão)

| Variável | Padrão | O que faz |
|---|---|---|
| `ROUTE_OPT_ENABLED` | `1` | desliga toda a camada (`0`) |
| `ROUTE_TOLERANCE_MIN` | `15` | equivalência entre opções |
| `ROUTE_EXCELLENT_MAX` / `ROUTE_GOOD_MAX` / `ROUTE_ACCEPTABLE_MAX` | `30/45/60` | faixas |
| `ROUTE_ZIGZAG_FREE_MIN` / `ROUTE_ZIGZAG_WEIGHT` / `ROUTE_ZIGZAG_RETURN_PENALTY` | `15 / 1 / 20` | penalidade de zigue-zague |
| `ROUTE_NEUTRAL_SCORE` | `30` | vendedor sem visita no dia |
| `ROUTE_UNKNOWN_LEG_MIN` | `20` | custo de uma perna cujo vizinho não tem ZIP/cidade (nunca 0) |
| `ROUTE_WEIGHT` | `1` | `0` = só a regra atual de distribuição |
| `ROUTE_OFFER_COUNT` / `ROUTE_EXPAND_COUNT` | `2 / 2` | opções oferecidas / abertas na recusa (a nota lista "offer first", "then", "also open") |
| `ROUTE_ASK_ZIP_BEFORE_OFFER` | `1` | pedir o ZIP na proposta da visita quando desconhecido |
| `ROUTE_NOTE_DAYS` | `10` | dias com vaga que entram na nota |
| `ROUTE_FILL_FIRST` | `1` | data primeiro: dia prioritário = primeiro dia com vaga abaixo da meta |
| `ROUTE_TARGET_NEXT_DAY_FILL_RATE` | `0.9` | meta de ocupação do dia prioritário (0–1) |
| `ROUTE_GAP_BONUS_MIN` / `ROUTE_GAP_MAX_SCORE` | `15 / 60` | bônus de buraco entre visitas / só se a rota for viável |
| `ROUTE_OVERALL_DAYS` | `3` | legado (só com `ROUTE_FILL_FIRST=0`) |
| `ROUTE_PROVIDER` | `auto` | `google` / `osrm` / `estimate` |
| `GOOGLE_MAPS_API_KEY` | — | ativa o Google (Distance Matrix API habilitada no projeto) |
| `ROUTE_OSRM_URL` | OSRM público | servidor OSRM próprio, se houver |
| `ROUTE_MAPS_TIMEOUT_MS` | `2500` | timeout das APIs |
| `ROUTE_EST_SPEED_MIN_KMH` / `ROUTE_EST_SPEED_MAX_KMH` / `ROUTE_EST_SPEED_RAMP_KM` / `ROUTE_EST_ROAD_FACTOR` / `ROUTE_EST_FIXED_MIN` | `30/85/25/1.3/4` | estimativa |

Mudar env em produção = `vercel env` + redeploy (ver memória `secrets-vercel-env-redeploy`).

## Localização do cliente

ZIP digitado em qualquer bolha do cliente (a mais recente vence) > cidade/bairro **com contexto de lugar** ("in Miami", "moro em Weston", "Hollywood, FL", ou a mensagem inteira sendo a cidade). Nomes de pessoa e palavras comuns ("this is Stuart", "at sunrise", "plantation shutters") não contam; legendas de anúncio compartilhado e análises de planta (colchetes gerados pelo sistema) são ignoradas; texto do bot nunca conta. Só cidades da área atendida têm apelido.

## Logs (controle interno)

* Vercel logs: uma linha `[route] {...}` por decisão (`kind`: `book`, `reschedule`,
  `offer`, `recovery`) com ZIP, vendedor escolhido, score, tier, provedor,
  fallback, opções consideradas (anterior/próximo, minutos, penalidade), motivo.
* Banco (app): linhas `route|<kind>|<igsid>|<data hora>|<vendedor>|<score>|<tier>|<provedor>|<zip>|<ts>`
  em `platform_settings.platform` para `book`/`reschedule` (compacto).
* Relatório: `node scripts/rotas-relatorio.mjs [dias]` — lista as decisões
  persistidas e cruza com os bookings da agenda.

## Testes

* `npx tsx src/evals/route-optimizer-verify.ts` — puro (sem API): geo, pontuação,
  tolerância, os 15 cenários obrigatórios, notas, config, acoplamento estático.
* `npx tsx src/evals/route-offer-verify.ts` — modelo real: obedece à ROUTE
  PRIORITY (2 horários preferidos), restrição do cliente vence, recusa abre os
  demais, ZIP-first em EN/ES, exceções, zero vazamento de rota.
* `npm run parity` — os 3 canais passam o mesmo contexto.
