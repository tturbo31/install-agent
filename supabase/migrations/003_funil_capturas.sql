-- Caixa-preta dos webhooks (missão referral 28/07): body bruto completo de todo
-- POST recebido em /api/webhook (ig), /api/fb-webhook (fb) e /api/wa-webhook (wa).
-- O código (src/lib/funil-raw.ts::capturarWebhookRaw) tenta esta tabela primeiro
-- e cai no fallback em platform_settings enquanto ela não existir — aplicar esta
-- migração quando o acesso DDL ao Supabase for restaurado; nenhum deploy é
-- necessário (o código detecta a tabela sozinho).
-- Retenção: 7 dias, garantida por limparCapturasAntigas() no próprio app.

CREATE TABLE IF NOT EXISTS funil_capturas (
  id           BIGSERIAL PRIMARY KEY,
  canal        TEXT NOT NULL CHECK (canal IN ('ig', 'fb', 'wa')),
  sig_ok       BOOLEAN,          -- assinatura Meta / token Z-API válidos? NULL = não checado
  body         TEXT NOT NULL,    -- JSON bruto como chegou (cap 100KB no app)
  recebido_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funil_capturas_recebido_em ON funil_capturas (recebido_em);
CREATE INDEX IF NOT EXISTS idx_funil_capturas_canal ON funil_capturas (canal, recebido_em);
