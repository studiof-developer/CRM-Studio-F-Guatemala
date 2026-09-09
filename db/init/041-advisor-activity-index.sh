#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Backs GET /api/tickets/last-advisor-activity (the Pipeline's "Novedades" period
-- option): MAX(created_at) over just the advisor-sent rows. Partial so it stays a
-- single backward index scan — near-instant — no matter how large n8n_chat_histories
-- grows, instead of a full table scan every time someone opens that filter.
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_advisor_sent_at
  ON n8n_chat_histories (created_at)
  WHERE message->>'type' = 'ai' AND message->'additional_kwargs'->>'sentBy' = 'advisor';

EOSQL
