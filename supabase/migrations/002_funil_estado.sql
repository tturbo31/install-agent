-- Funnel-event state per conversation (2026-07-09): which events were already
-- sent to the owner's analytics platform (ozzi-plataforma), the captured phone,
-- and the click-to-message ad the lead came from. One row per conversation,
-- created lazily on the first funnel-relevant action. Deleting a conversation
-- cascades here, so test cleanup is automatic.
create table if not exists funil_estado (
  conversation_id uuid primary key references instagram_conversations(id) on delete cascade,
  telefone text,
  ad_id text,
  ad_name text,
  campanha text,
  lead_criado_at timestamptz,
  conversando_last_at timestamptz,
  agendamento_at timestamptz,
  sumido_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The silence sweep scans only leads already reported, not yet marked gone.
create index if not exists idx_funil_estado_ativos
  on funil_estado (lead_criado_at)
  where lead_criado_at is not null and sumido_at is null;

-- Tiny key-value store for cross-invocation throttles (e.g. the 6h
-- parou_de_responder sweep trigger piggybacked on webhook traffic).
create table if not exists funil_meta (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
