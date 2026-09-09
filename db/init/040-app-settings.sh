#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Generic key/value settings table — one place for every "number/flag an admin should
-- be able to change without a code deploy" this app grows, not a bespoke column or
-- table per setting. JSONB value so a setting can be a bare number today (the OCR
-- context window) and a whole array/object later (Pipeline column config) with no
-- schema change either way.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- How far back (in hours) attachments.js looks for payment context/a quoted price
-- before OCR-checking a photo — was a hardcoded `interval '3 hours'` in two queries.
INSERT INTO app_settings (key, value) VALUES ('ocr_context_hours', '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

EOSQL
