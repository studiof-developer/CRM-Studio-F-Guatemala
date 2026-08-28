#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- A global "search every chat for this word" (not just the currently-open one) scans
-- message content across the whole table — trigram GIN makes an ILIKE '%word%' fast
-- regardless of how large n8n_chat_histories grows, the same reasoning that already
-- justified every other index added this month.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_content_trgm
  ON n8n_chat_histories USING GIN ((message->>'content') gin_trgm_ops);

EOSQL
