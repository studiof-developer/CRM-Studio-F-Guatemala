#!/bin/bash
set -e

# n8n creates n8n_chat_histories lazily on first use of the Postgres Chat
# Memory node, so on a truly fresh install this table won't exist yet at
# init time. Guarded so it's a no-op then; re-run this file's SQL by hand
# after the first conversation if you're bootstrapping from scratch.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

DO $$
BEGIN
  IF to_regclass('public.n8n_chat_histories') IS NOT NULL THEN
    ALTER TABLE n8n_chat_histories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

EOSQL
