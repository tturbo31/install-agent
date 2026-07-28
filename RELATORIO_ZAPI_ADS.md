# RELATÓRIO — Atribuição de anúncio no WhatsApp via Z-API (externalAdReply)

**Missão 28/07/2026 (2ª rodada) — concluída e em produção** (commit `7fe8bcd`,
deploy Vercel Ready, aliás `instagram-dm-agent-chi.vercel.app`).

A descoberta que motivou a missão se confirmou: a Z-API **entrega** os dados do
anúncio, mas no formato próprio dela (`externalAdReply` no nível raiz do
webhook "Ao receber") — nunca no formato Cloud API (`referral`) que a extração
anterior procurava. Agora o canal WhatsApp extrai, persiste e repassa a
atribuição pelo mesmo pipeline que já funciona no Instagram/Messenger.

---

## 1. O que os payloads REAIS mostraram (caixa-preta)

Varredura dos bodies brutos `funil_raw_wa_` (5 capturas nos últimos dias):

| Achado | Quantidade |
|---|---|
| Payloads com `externalAdReply` de **anúncio** | **2** (cliques reais em 28/07, 20:52 e 21:39 UTC) |
| Payloads sem `externalAdReply` (mensagens comuns) | 3 |

O clique real de 20:52 UTC veio exatamente como a documentação da Z-API
descreve — `externalAdReply` na **raiz** do callback, junto de `momment`,
`phone` etc.:

```json
"externalAdReply": {
  "title": "📩 Free Quote | Serving South Florida",
  "body": "✨ 1000 sq.ft. FOR JUST $2,350 ❌ materials …",
  "mediaType": "VIDEO",
  "thumbnailUrl": "https://scontent-mia5-1.xx.fbcdn.net/… (457 chars)",
  "sourceType": "ad",
  "sourceId": "120248894662390443",
  "sourceUrl": "https://fb.me/7Gn44NET1",
  "ctwaClid": "AfiFj5e0nEnBArwH… (138 chars)",
  "showAdAttribution": true
}
```

Observações importantes dos dados reais:

- `mediaType` veio como string (`"VIDEO"`), não numérico como no exemplo da
  doc — irrelevante para nós (não usamos o campo).
- O `thumbnailUrl` (457 chars) é a **imagem do criativo pronta**, mesmo em
  anúncio de vídeo.
- O payload traz também um objeto `adContext`, mas veio **vazio** (strings
  vazias e Buffers zerados) — inútil; ignorado.
- O 2º clique real (21:39 UTC) estava numa captura **truncada** (`_trunc`: o
  `adContext` com Buffer serializado estourou o teto de ~12,8KB da caixa-preta).
  Como o `externalAdReply` é plano e vem antes do corte, ele é recuperável por
  regex — o monitor e o backfill fazem isso.
- **Caixa-preta confirmada no ponto certo**: `capturarWebhookRaw("wa", rawBody)`
  é a primeira coisa que o POST faz, antes de token/parsing/filtro
  (verificado pelo eval `referral-contract-verify`, check A1).

## 2. O que foi implementado

### Extração no formato Z-API (`src/app/api/wa-webhook/route.ts`)

`extractWaAdReferral` agora lê `body.externalAdReply` **primeiro** (o formato
legado `referral` continua como fallback defensivo). Mapeamento:

| Z-API | Contrato |
|---|---|
| `sourceId` | `ad_id` |
| `ctwaClid` | `ctwa_clid` |
| `sourceType` | `ad_source_type` |
| `title` + `body` | `ad_title` |
| `thumbnailUrl` (ou `originalImageUrl`) | `ad_media_url` |
| `sourceUrl` | `ad_ref` *(novo no caminho WA)* |
| `momment` do callback | `ad_clicked_at` (ISO) |

**Validação anti-falsa-atribuição**: `externalAdReply` também aparece quando o
cliente compartilha um link comum. Só vira atribuição quando `sourceType` é
`"ad"` **ou** existe `sourceId`/`ctwaClid`; senão é ignorado (o `ctwaClid` pode
vir ausente em alguns cliques — por isso a regra tripla).

### Pipeline reaproveitado (nada reimplementado)

- **Persistência** `funil_adx_<convId>` com merge fill-if-empty (existente
  vence, vazio nunca sobrescreve) — mesma `persistirAnuncioDaConversa` do IG.
- **Referral tardio**: `funilOnInboundMessage` já re-envia `lead_criado` com
  identidade + contrato quando a atribuição chega em mensagem não-primeira —
  é agnóstico de canal e a extração WA roda em **toda** mensagem, então o
  WhatsApp está coberto.
- **Limite de 1000 chars** em `ad_media_url`: fica no `contratoAnuncio`
  compartilhado, então vale para o caminho Z-API (thumbnail real de 457 chars
  passa com folga).

### Monitor atualizado (`scripts/monitor-referral-fb.mjs`)

Reconhece `externalAdReply` (inclusive em capturas truncadas, via regex) e o
rodapé **parou de dizer que é limitação da Z-API** — agora:
- com clique: `✅ WA: N clique(s) de anúncio via externalAdReply — formato Z-API SUPORTADO`;
- sem clique: orienta o teste "TESTE CRIATIVO WA" e, se um clique de teste não
  aparecer, conferir no painel da Z-API se o webhook "Ao receber" está na
  versão que envia o campo.

## 3. Testes

- `npx tsc --noEmit` — limpo.
- **`referral-contract-verify` — 43/43** (3 checks novos: lê `externalAdReply`
  na raiz; validação de anúncio; `sourceUrl→ad_ref`).
- **`referral-smoke-e2e` — 31/31**, com o caso WA reescrito no formato REAL da
  Z-API e dois casos negativos novos, rota completa (POST no webhook → captura
  raw → extração → `funil_adx_` → `lead_criado` num sink HTTP local no lugar
  da plataforma):
  - **anúncio** (`externalAdReply` completo com `ctwaClid`): `lead_criado`
    chegou com os 8 campos do contrato, incluindo `ad_ref` do `sourceUrl`;
  - **link comum** (`externalAdReply` sem `sourceType`/`sourceId`/`ctwaClid`):
    nada quebrou, payload SEM campos `ad_*`, NENHUM `funil_adx_` criado;
  - **orgânico** (sem `externalAdReply`): idem — sem falsa atribuição.

## 4. Retroativo (executado)

`scripts/backfill-wa-ads.ts` varreu a caixa-preta e reenviou a atribuição dos
**2 cliques reais** encontrados — plataforma respondeu HTTP 200 com merge sem
sobrescrita nos dois:

| Clique (UTC) | ad_id | Resultado |
|---|---|---|
| 28/07 20:52 | `120248894662390443` | ✅ "Lead já existia — dados atualizados, estágio mantido" |
| 28/07 21:39 | `120248894707800443` | ✅ "Lead já existia — dados atualizados, estágio mantido" |

O script é reutilizável e idempotente (merge fill-if-empty nas duas pontas):
`npx tsx scripts/backfill-wa-ads.ts` (`--dry` para só listar).

## 5. Validação final (passo do dono)

1. Clicar num anúncio de WhatsApp (Click-to-WhatsApp) e mandar **"TESTE
   CRIATIVO WA"**.
2. Rodar: `node --env-file=.env.local scripts/monitor-referral-fb.mjs 24`
3. Esperado: `✅ WA: 1 clique(s) de anúncio via externalAdReply …` e, na
   plataforma, o lead com anúncio/criativo preenchidos.

Se um clique de teste NÃO aparecer no monitor: conferir no painel da Z-API
(Configurações da instância → Webhooks → "Ao receber") se a URL aponta para
`https://instagram-dm-agent-chi.vercel.app/api/wa-webhook` e se a instância
está numa versão que envia `externalAdReply` — os payloads reais de 28/07
provam que a instância atual envia, então hoje **nenhum ajuste é necessário**.

## 6. Arquivos alterados (commit `7fe8bcd`)

| Arquivo | Mudança |
|---|---|
| `src/app/api/wa-webhook/route.ts` | extração `externalAdReply` com validação de anúncio + `sourceUrl→ad_ref` |
| `scripts/monitor-referral-fb.mjs` | reconhece formato Z-API (e capturas truncadas); rodapé "caminho suportado" |
| `scripts/backfill-wa-ads.ts` | **novo** — retroativo da caixa-preta (já executado: 2 leads) |
| `src/evals/referral-contract-verify.ts` | +3 checks estáticos do formato Z-API (43/43) |
| `src/evals/referral-smoke-e2e.ts` | caso WA no formato real + link comum + orgânico (31/31) |

Obs.: a missão citava um `verificar-teste-criativo.mjs` — esse arquivo não
existe neste projeto; o verificador equivalente é o `monitor-referral-fb.mjs`,
que foi atualizado conforme pedido.
