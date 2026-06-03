-- Claude Code Daily Intelligence — Supabase Migration
-- Run this in the Supabase SQL editor to create the daily_reports table.

create table if not exists daily_reports (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now(),
  analysis_date text not null,
  run_number integer not null default 1,
  youtube_insights jsonb not null default '[]',
  github_projects jsonb not null default '[]',
  implementation_guide text not null default '',
  priority_actions jsonb not null default '[]',
  executive_summary text not null default '',
  memory_store_id text not null default '',
  claude_improvements jsonb not null default '[]',
  connectable_apis jsonb not null default '[]',
  topic_summaries jsonb not null default '[]'
);

-- Migração incremental (rode se a tabela já existia antes desses campos):
alter table daily_reports add column if not exists claude_improvements jsonb not null default '[]';
alter table daily_reports add column if not exists connectable_apis jsonb not null default '[]';
alter table daily_reports add column if not exists topic_summaries jsonb not null default '[]';

-- Enable Row Level Security
alter table daily_reports enable row level security;

-- Allow public read access (dashboard is public)
create policy "Public read" on daily_reports
  for select
  using (true);

-- Allow service role / agent to insert
create policy "Service insert" on daily_reports
  for insert
  with check (true);

-- Optional: index on created_at for fast ordering
create index if not exists daily_reports_created_at_idx
  on daily_reports (created_at desc);

-- Optional: index on analysis_date
create index if not exists daily_reports_analysis_date_idx
  on daily_reports (analysis_date desc);
