# AUDITORIA — O agente perde algum rastreio? (04/08/2026)

**Pergunta da missão:** o Messenger entrega 100% de atribuição e o Instagram 65% —
há assimetria de código do lado do agente? E os 6 casos sem criativo?

**Veredito em uma linha:** o agente **não perde nada do que recebe** — todos os
460 remetentes com referral IG/FB e os 15 `externalAdReply` do WhatsApp
registrados na caixa-preta (7 dias) têm `funil_adx_` persistido, **zero perdas**.
A diferença 65% vs 100% é comportamento da **Meta**: no Messenger o referral
chega **duas vezes** por clique (evento avulso `messaging_referral` + dentro da
mensagem); no Instagram chega **uma só** (`message.referral`) — e em muitos
leads de anúncio **não chega nenhuma** (caso Erin Fuller, §2). Ainda assim a
auditoria achou e corrigiu 3 furos reais: returns antecipados que engoliam
referral antes da persistência, o standalone que descartava referral só com
`ref`/`source`, e **o GC da caixa-preta que nunca apagava nada** (bug de
produção silencioso).

---

## 1. Paridade entre os 3 canais (linha a linha)

| Tratamento | IG (`webhook`) | Messenger (`fb-webhook`) | WhatsApp (`wa-webhook`) |
|---|---|---|---|
| Caixa-preta no topo do POST (antes de assinatura/parse/filtro) | ✅ | ✅ | ✅ |
| Lê referral DENTRO da mensagem (`message.referral`) | ✅ | ✅ | ✅ `externalAdReply` na raiz |
| Lê referral no EVENTO avulso (sem `mid`) | ✅ | ✅ | n/a (Z-API não tem) |
| Lê referral no `postback.referral` | ✅ (avulso e mensagem) | ✅ (avulso; postback nunca tem mid) | n/a |
| Avulso persiste referral só com `ref`/`source` | ✅ **corrigido 04/08** | ✅ **corrigido 04/08** | n/a |
| `clicked_at` do timestamp do evento (s→ms normalizado) | ✅ | ✅ | ✅ (`momment`) |
| Persistência antes do gate `mode=human` / debounce / IA | ✅ | ✅ | ✅ |
| Return de sticker persiste atribuição antes de sair | ✅ **corrigido 04/08** | ✅ **corrigido 04/08** | n/a (cai no caso "tipo não reconhecido") |
| Return de emoji-only persiste atribuição antes de sair | ✅ **corrigido 04/08** | ✅ **corrigido 04/08** | ✅ **corrigido 04/08** |
| Tipo de callback não reconhecido persiste atribuição | n/a (referral seta `rawText`) | n/a | ✅ **corrigido 04/08** (reaction/location/sticker/chamada) |
| Referral tardio (mensagem não-primeira) re-envia `lead_criado` | ✅ | ✅ | ✅ |
| Clique novo em conversa pré-marco dispara `lead_criado` | ✅ | ✅ | ✅ |
| Contrato vai também no `agendamento_marcado` | ✅ | ✅ | ✅ |

**Números da caixa-preta (7 dias, 3.854 POSTs completos + 981 capturas enxutas):**

| Medição | IG | FB | WA |
|---|---|---|---|
| POSTs capturados | 1.490 | 2.025 | 294 |
| POSTs com mais de 1 `entry`/`messaging` (risco do `entry[0].messaging[0]`) | **0** | **0** | n/a |
| Eventos com referral | 205 | 713 | 15 |
| Onde o referral veio | 100% `message.referral` (0 avulso, 0 postback) | avulso **e** mensagem (~2 por clique, 3s de intervalo) | 100% `externalAdReply` na **raiz**, 100% em mensagem `text` |
| Remetentes com referral → `funil_adx_` persistido | **100%** | **100%** | **15/15** |

É exatamente isso que explica o 100% vs 65%: **o Messenger tem duas chances por
clique e o Instagram uma** — e no Instagram uma fração dos leads de anúncio chega
sem referral nenhum (§2, Erin Fuller). A conta do Instagram está inscrita em
`messages, messaging_postbacks, messaging_optins, message_reactions,
agent_messages, messaging_referral` desde 31/07 e o evento avulso **continua não
vindo** — limitação conhecida da Meta para IG, não configuração nossa.

---

## 2. Os 6 casos, no código e na caixa-preta

Método: primeiro webhook bruto de cada um reconstituído da caixa-preta (que grava
o body completo ANTES de qualquer parse/filtro/return) + janela de ±20 min
procurando qualquer evento com o id do cliente.

| Caso | Canal | 1º contato | O que o payload bruto tinha | Campo de origem ignorado? | Veredito |
|---|---|---|---|---|---|
| Jackie Fernández | IG | 30/07 23:04 | `message{mid,text:"Hi"}` — sem referral/postback/anexo/reply_to | Nenhum | **Ausência da Meta** (cliente recorrente: "you came to my house maybe about a year ago") |
| Erin Fuller | IG | 29/07 16:03 | `message{mid,text:"Do you offer any discounts for larger spaces?"}` — **texto de botão de FAQ de anúncio, SEM referral** | Nenhum | **Ausência da Meta** — a prova viva do teto de 65%: entrou por anúncio e a Meta não anexou referral em NENHUM dos 19 eventos da janela |
| Bethany Lamar | IG | 31/07 19:19 | `message{mid,text:"Good Afternoon, just bought a conf…"}` — texto digitado | Nenhum | **Ausência da Meta** (entrada orgânica) |
| Mark Cimini | IG | conversa de 24/06 (pré-rastreio), retomada 01/08 | retomada: só `message{mid,text}` em 4 eventos | Nenhum | **Ausência da Meta** — conversa nasceu antes do rastreio (28/07) e não houve clique novo na janela |
| Evelyn (Lara) | IG | 02/08 10:21 | `message{mid,text:"Can you come and view the job for Tuesday?"}` | Nenhum | **Ausência da Meta** (entrada orgânica — interior designer) |
| Jose Libre | WA | 03/08 21:03 | Payload conferido **campo a campo** (24 chaves): `text.message` = "…Just tried giving you a call…", sem `externalAdReply`, sem `adContext`, sem `referral`, sem quoted/`referenceMessageId` | Nenhum | **Ausência da Z-API/Meta** — o cliente chegou pelo TELEFONE ("just tried giving you a call"), não por anúncio |

**Conclusão da Parte 2: 6 de 6 são ausência real de sinal da plataforma.** Nenhum
payload trazia campo de origem que o código tenha ignorado. (Obs.: Jose Libre
conversa pelo WhatsApp de "Mohamed El Banna" — o nome Jose Libre foi dado para a
visita; e o caso "Mark Cimini" é a conversa IG de @alexcimini1.)

---

## 3. Reforços no agente

### 3.1 Fontes de origem recebidas e não usadas — existe alguma?

- **`entry_point` / `entryPointConversionSource`**: **nunca apareceu** em nenhum
  dos 3.515 POSTs da Meta na caixa-preta. Não há o que usar.
- **Resposta de STORY (`message.reply_to.story`)**: 7 ocorrências em 7 dias,
  **nenhuma com referral**. O objeto traz só a URL/asset do story — não prova
  anúncio (story orgânico e story ad chegam iguais). Persistir isso como
  atribuição seria inferência; fica registrado na caixa-preta para diagnóstico.
  Se um reply de story ad vier COM `message.referral`, o caminho normal já
  persiste. `story_mention` (1 ocorrência): idem.
- **Icebreaker/postback IG**: 0 ocorrências em 7 dias (os "botões de FAQ" da
  Meta chegam como `message.text` normal — e às vezes sem referral, caso Erin).
- **Z-API fora do `externalAdReply`**: o `adContext` chega **vazio** (strings
  vazias, Buffers zerados — confirmado desde 28/07); as demais chaves não
  listadas (`referenceMessageId`, `expiresAt`, `callDirection`, `isVideo`,
  `editMessageId`, `liveLocation`) não carregam origem. O `externalAdReply` veio
  na raiz em 15/15 casos reais, inclusive já validado contra link comum
  compartilhado (só vira atribuição com `sourceType:"ad"` ou `sourceId`/`ctwaClid`).

**Resposta: não há fonte com PROVA que o agente receba e não use.**

### 3.2 O contrato `funil_adx_` é gravado antes de qualquer erro da IA?

**Sim.** `persistirAnuncioDaConversa` é a **primeira linha** de
`funilOnInboundMessage` (`src/lib/funil.ts`), disparada via `waitUntil`
imediatamente após o insert da mensagem — **antes** do gate `mode=human`, do
debounce de 10s, do rate-limit e da chamada de IA. Os blocos standalone (IG/FB)
persistem direto, sem IA nenhuma. Falha da IA, pausa do dono ou queda do envio
**não perdem atribuição**. Com as correções de 04/08, o contrato agora é gravado
até quando a bolha é **descartada** (sticker/emoji/tipo desconhecido).

**Limites documentados (não corrigidos, por decisão):**
1. **Canal pausado** (`platform_settings.paused`): o gate está no topo do handler
   e descarta o evento inteiro — um clique de anúncio durante uma pausa de canal
   fica só na caixa-preta. Pausa de canal é ação manual e rara; corrigir exigiria
   duplicar o parse antes do gate.
2. **Insert da mensagem com erro não-duplicata**: o funil (e a persistência
   in-message) não roda. O mesmo banco que falhou o insert tende a falhar a
   persistência — sem correção prática.
3. **`entry[0].messaging[0]`**: os 3 webhooks Meta processam só o primeiro
   evento do POST. Medição: **0 POSTs com lote** em 3.515. Se a Meta um dia
   passar a agrupar, a caixa-preta prova e o replay resgata.

---

## 4. O que foi corrigido (04/08/2026)

| # | Furo | Correção | Arquivo |
|---|---|---|---|
| 1 | **IG/FB**: 1ª bolha sticker ou emoji-only com referral → return ANTES do funil, atribuição morria | Referral extraído no topo do handler e persistido antes de qualquer descarte | `src/app/api/webhook/route.ts`, `src/app/api/fb-webhook/route.ts` |
| 2 | **WA**: callback de tipo não reconhecido (reaction, location, sticker, chamada) ou texto só-emoji → return ANTES de `extractWaAdReferral`, `externalAdReply` morria | Extração içada para antes da triagem por tipo + persistência nos dois descartes | `src/app/api/wa-webhook/route.ts` |
| 3 | **IG/FB standalone**: referral só com `ref`/`source` (sem `ad_id`/título) era descartado no evento avulso, enquanto o caminho de mensagem persistia (`ad_ref`/`ad_source_type`) | Condição estendida nos dois blocos standalone — paridade total | ambos webhooks Meta |
| 4 | **GC da caixa-preta NUNCA apagava** (bug de produção): `.delete().in()` com 100 chaves de ~1,7KB estourava a URL do PostgREST, o erro não era checado e o log dizia "N apagadas" com 0 apagadas — a caixa-preta crescia para sempre (121 linhas vencidas acumuladas) | Range delete por canal (epoch de 13 dígitos na chave ⇒ ordem lexicográfica = numérica): 1 requisição curta por canal, erro checado, contagem real. Rodou e apagou as 121 pendentes | `src/lib/funil-raw.ts` |

Nenhuma mudança no comportamento de resposta ao cliente — só persistência de
atribuição e GC.

## 5. Guardas permanentes adicionadas

`src/evals/referral-contract-verify.ts` — nova seção **A6** (+ GC atualizado):

- IG/FB: persistem atribuição nos returns de sticker E emoji-only (contagem ≥2 por arquivo);
- IG/FB: extração do referral vem ANTES do return de sticker;
- WA: `extractWaAdReferral` vem ANTES da triagem por tipo; persiste nos 2 descartes;
- IG/FB: standalone persiste referral só com `ref`/`source`;
- GC: usa range delete por canal e checa o erro do delete (o check funcional B3
  "GC apaga 8 dias e preserva recente" agora passa DE VERDADE — antes passava por
  acaso quando havia poucas chaves velhas).

## 6. Testes executados

- `npx tsc --noEmit` — limpo.
- `referral-contract-verify` — **56/56** (antes 43; +11 guardas novas, GC funcional real).
- `referral-smoke-e2e` — **31/31** (rota completa nos 3 canais).
- `platform-parity` — **47/47** · `creative-attribution-verify` 21/21.
- Verifies estáticos que leem os webhooks: ad-message 27, ad-type 82, booked-time 30,
  booking-slot 35, date 27, delivery 73, enviar 178, name-required 39, outage 33,
  policy 43, postbooking-gate OK, reschedule 43, review3 57, review5d 62,
  silence-fixes 24, whatsapp-booking 19, zip-required 65 — **todos 0 falhas**.

## 7. Scripts reutilizáveis desta auditoria (não versionados)

- `scripts/tmp-audit-raw-casos.mjs` — reconstrói webhooks brutos da caixa-preta
  por janela de tempo + id do cliente (IG/FB estrutural, WA campo a campo).
- `scripts/tmp-audit-cruzar-persistencia.mjs` — o detector de perda: cruza TODO
  referral recebido (caixa-preta) com o `funil_adx_` persistido; qualquer buraco
  é perda do lado do agente. Hoje: **0 perdas**.
- `scripts/tmp-audit-scan-box.mjs` — estatística estrutural da caixa-preta
  (lotes, onde o referral vem, tipos de anexo/callback, chaves desconhecidas).
