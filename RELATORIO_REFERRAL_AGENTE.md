# RELATÓRIO — Captura, persistência e repasse do REFERRAL de anúncio (28/07/2026)

Lado do **agente de atendimento** pronto. Este documento é o contrato para a
atualização da **ozzi-plataforma** consumir os novos campos.

---

## 1. Mapa do fluxo (como o referral viaja)

Os 3 webhooks vivem neste projeto (Next.js na Vercel, banco Supabase do app):

| Canal | Endpoint | Objeto Meta | Handler |
|---|---|---|---|
| Instagram | `POST /api/webhook` | `instagram` | `src/app/api/webhook/route.ts` |
| Messenger | `POST /api/fb-webhook` | `page` | `src/app/api/fb-webhook/route.ts` |
| WhatsApp (Z-API) | `POST /api/wa-webhook` | callback Z-API (`ReceivedCallback`) | `src/app/api/wa-webhook/route.ts` |

O `hub.challenge` (verificação da Meta) é o `GET` dos mesmos endpoints IG/FB.

Fluxo por mensagem recebida:

```
POST do webhook
 ├─ (NOVO) capturarWebhookRaw() — body BRUTO completo gravado ANTES de
 │   qualquer parsing/filtro/return (echo, delivery, assinatura inválida etc.)
 ├─ verificação de assinatura (IG/FB: HMAC Meta; WA: token Z-API)
 ├─ parsing → dedup por message id → find/create conversa (tabela
 │   instagram_conversations, compartilhada pelos 3 canais; igsid tem prefixo
 │   fb_/wa_ fora do Instagram)
 ├─ insert da mensagem (instagram_messages)
 ├─ FUNIL (fire-and-forget, nunca bloqueia o atendimento):
 │   ├─ extração do referral (3 formatos — ver §3)
 │   ├─ persistirAnuncioDaConversa() — atribuição gravada no contato (§4)
 │   └─ funilOnInboundMessage() → lead_criado / conversando / retomou_conversa
 │        └─ enviarEventoFunil() → HTTP POST autenticado para
 │           PLATAFORMA_URL + /api/webhooks/atendimento  (é AQUI que o lead
 │           chega na plataforma — não há insert direto no Supabase dela)
 └─ ... resposta da IA (INALTERADA por esta missão)
```

O repasse é **HTTP** (header `x-webhook-token`), com timeout 5s + 2 retries;
campos vazios ficam fora do payload e a plataforma ignora chaves desconhecidas
— por isso os campos novos **não quebram** a plataforma atual (§5).

## 2. Captura RAW — a caixa-preta (ETAPA 2)

`src/lib/funil-raw.ts::capturarWebhookRaw(canal, rawBody, {sigOk})`, chamada no
**primeiro ponto** dos 3 POSTs, antes de qualquer parsing/filtro/return. Nada
(echo, delivery, read, JSON inválido, assinatura errada) impede a gravação.

- **Armazenamento hoje** (sem DDL — token de gerenciamento do Supabase morto):
  linhas em `platform_settings`, JSON url-encodado embutido na chave, em chunks:
  `funil_raw_<canal>_<epochMs>_<rand>_<i>of<n>[_s0][_trunc]::<chunk>`
  (`_s0` = assinatura/token inválido; `_trunc` = body > ~12,8KB).
- **Upgrade pronto**: `supabase/migrations/003_funil_capturas.sql` cria a tabela
  `funil_capturas (canal, sig_ok, body, recebido_em)`. O código tenta a tabela
  primeiro e cai no fallback sozinho — aplicar a migração quando o DDL voltar,
  sem redeploy.
- **Retenção**: 7 dias, GC automático no máximo 1x/dia (`limparCapturasAntigas`),
  cobrindo tabela e fallback.

**Como consultar as capturas:**

```sql
-- fallback atual (Supabase do app, tabela platform_settings)
select platform from platform_settings
 where platform like 'funil_raw_ig_%'   -- ou _fb_ / _wa_
 order by platform desc limit 50;
```

Agrupar por `<canal>_<epochMs>_<rand>`, ordenar pelos `<i>of<n>`, concatenar o
que vem depois de `::` e aplicar `decodeURIComponent` → body JSON completo.

## 3. Extração do referral — 3 formatos (ETAPA 3)

- **Instagram/Messenger**: lidos os TRÊS lugares —
  `messaging[].message.referral` (novo), `messaging[].referral`
  (evento `messaging_referral(s)`, inclusive **standalone sem message.mid**) e
  `messaging[].postback.referral`. Campos: `ref`, `ad_id`, `source`, `type`,
  `ads_context_data.{ad_title, photo_url, video_url, post_id}`.
- **WhatsApp** (Z-API): `referral` do callback (com variantes de chave que a
  Z-API usa) — `source_id`(=ad_id), `source_type`, `source_url`, `headline`,
  `body`, `media_type`, `image_url`/`video_url`, `ctwa_clid`.
- **`ad_clicked_at`** = timestamp do EVENTO que trouxe o referral (IG/FB:
  `messaging.timestamp`; WA: `momment` do Z-API). A Meta não manda o instante
  exato do clique; este é o melhor proxy disponível.

## 4. Persistência no contato (ETAPA 3.6)

A tabela de conversas **não tem colunas de anúncio** (e DDL está indisponível),
então a atribuição vive em `platform_settings`, 1 linha por conversa:

- `funil_adx_<convId>::<JSON url-encodado do contrato §5>` — contrato completo.
  Regras: o referral só vem na 1ª mensagem; se a conversa já tem atribuição,
  novos eventos só **preenchem campos faltantes** (o valor existente sempre
  vence); referral vazio **nunca** sobrescreve nada.
- `funil_ad_<convId>::<ad_id>::<ad_title>` — chave legada mantida (compat com
  scripts existentes).

**Bugs reais corrigidos de quebra** (gravações em colunas-fantasma
`ad_id/ad_title/creative_url` que NÃO existem no banco):

1. IG/FB: o update de perfil incluía essas colunas → o update INTEIRO falhava
   silencioso e **nome/username não eram salvos justamente para leads de
   anúncio**. Corrigido (colunas removidas do update).
2. IG: o select do booking pedia essas colunas → falhava e a nota da visita
   perdia o @handle e o criativo. Agora usa colunas reais + atribuição
   persistida (o criativo volta a aparecer na nota do agendamento).
3. IG/FB: persistência do tipo de piso do anúncio em `ad_title` → trocada pelo
   mesmo padrão em memória já usado no WA (comportamento efetivo idêntico).

## 5. Repasse à plataforma — O CONTRATO (ETAPA 4)

`lead_criado` agora leva, além dos campos que a plataforma já consome
(`ig_id`, `ig_username`, `telefone`, `nome`, `canal`, `ad_name`, `campanha`,
`data_visita` etc.), o contrato de atribuição com **estes nomes exatos**
(campo ausente = não veio da Meta; nunca vai `null`/vazio):

| Campo | Tipo | Origem |
|---|---|---|
| `ad_id` | string | IG/FB `referral.ad_id`; WA `referral.source_id` |
| `ctwa_clid` | string | WA (CTWA) — id de clique p/ Conversions API |
| `ad_source_type` | string | IG/FB `referral.source` (ex. `ADS`, fallback `type`); WA `source_type` (`ad`/`post`) |
| `ad_title` | string | IG/FB `ads_context_data.ad_title`; WA `headline + body` |
| `ad_media_url` | string | `photo_url`/`image_url`, senão `video_url` |
| `ad_post_id` | string | IG/FB `ads_context_data.post_id` |
| `ad_ref` | string | IG/FB `referral.ref` |
| `ad_clicked_at` | string ISO 8601 | timestamp do evento que trouxe o referral |

Exemplo de payload real (smoke test, canal WhatsApp):

```json
{
  "evento": "lead_criado",
  "telefone": "+15550100999",
  "canal": "whatsapp",
  "ad_id": "120200000000000003",
  "ctwa_clid": "clid_SMOKE...",
  "ad_source_type": "ad",
  "ad_title": "TILE 1000 sqft ... Installation special",
  "ad_media_url": "https://example.com/smoke-wa.jpg",
  "ad_clicked_at": "2026-07-28T...Z",
  "ad_name": "TILE 1000 sqft ... Installation special"
}
```

Retrocompatibilidade: a rota da plataforma já ignora chaves desconhecidas e os
legados `ad_name`/`campanha` continuam sendo enviados — nada quebra antes da
plataforma ser atualizada. O backfill de lead antigo que agenda visita
(`funilOnBookingConfirmed`) também leva o contrato (lido da persistência §4).

## 6. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `src/lib/funil-raw.ts` | caixa-preta `capturarWebhookRaw` + GC 7 dias (`limparCapturasAntigas`); captura enxuta antiga mantida |
| `src/lib/funil.ts` | `ReferralIG` completo, `ContratoAnuncio` (8 campos), `contratoAnuncio()`, persistência `funil_adx_` com merge, `dadosDeAnuncioDaConversa` estendida, `lead_criado` com contrato |
| `src/lib/types.ts` | `message.referral` no tipo do payload IG |
| `src/app/api/webhook/route.ts` (IG) | captura no topo do POST; lê `message.referral`; `clicked_at`; fixes de colunas-fantasma (perfil, booking select, tipo do anúncio) |
| `src/app/api/fb-webhook/route.ts` | captura no topo; lê `message.referral`; standalone/postback com `clicked_at` e campos completos; fixes de colunas-fantasma |
| `src/app/api/wa-webhook/route.ts` | captura no topo (antes do token); extração de `source_type`/`video_url`; `clicked_at` do `momment` |
| `supabase/migrations/003_funil_capturas.sql` | tabela dedicada de capturas (aplicar quando DDL voltar) |
| `src/evals/referral-contract-verify.ts` | **novo** — 40 checks (fonte + funcional contra o banco) |
| `src/evals/referral-smoke-e2e.ts` | **novo** — smoke E2E de rota completa com sink HTTP no lugar da plataforma |

## 7. Testes executados

- `npx tsc --noEmit` — limpo.
- `referral-contract-verify` — **40/40**: mapeamento do contrato, merge sem
  sobrescrita, captura raw legível, GC apaga 8 dias e preserva recentes.
- `referral-smoke-e2e` — rota completa nos 3 canais COM referral + 1 sem:
  captura raw no banco + `funil_adx_` persistido + `lead_criado` com os 8
  campos no sink; mensagem sem referral não quebra e sai sem `ad_*`.
- Verifies estáticos existentes: `creative-attribution` 23/23,
  `booking-slot` 35/35, `delivery` 56/56, `followup` 48/48, `marker-leak`
  15/15, `postbooking-gate` OK, `smartquote` 17/17, `funil-jornada` 4/4.
  (`booking-date-verify` tem 4 falhas PRÉ-EXISTENTES de drift de data no
  próprio eval — idênticas no commit anterior, sem relação com esta missão.)

⚠️ `funil-jornada` enviou um lead de teste REAL para a plataforma (telefone
`+1 (555) 010-4477`) — apagar lá, como o próprio eval instrui.

## 8. Próximo passo (lado da plataforma)

A rota `POST /api/webhooks/atendimento` da ozzi-plataforma pode passar a
persistir os 8 campos do §5 no lead. Nomes batem 1:1 — nenhuma tradução
necessária. Enquanto isso não acontece, os valores já ficam registrados nos
logs da Vercel deste projeto (payload completo logado em falha) e na
persistência local (`funil_adx_`), então **nenhum clique de anúncio se perde**
a partir deste deploy.
