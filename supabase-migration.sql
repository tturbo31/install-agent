-- Migration: add memory_store_id to instagram_conversations
-- Run this in your Supabase dashboard > SQL Editor

ALTER TABLE instagram_conversations
  ADD COLUMN IF NOT EXISTS memory_store_id TEXT DEFAULT NULL;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_conversations_memory_store
  ON instagram_conversations (memory_store_id)
  WHERE memory_store_id IS NOT NULL;
