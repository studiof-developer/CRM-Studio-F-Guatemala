#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

-- Existing accounts and the first admin were backfilled by hand once, directly
-- against the live DB — not scripted here, so no real credential ever lands in
-- git history. On a fresh install: no users exist yet, so username being
-- NOT NULL below is trivially satisfied; create the first admin by hand via
-- psql (INSERT with a bcrypt hash), then manage everyone else from Usuarios.
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

ALTER TABLE access_audit ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_action_check;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_action_check
  CHECK (action IN ('view_customer', 'view_ticket', 'view_conversation', 'login', 'user_created', 'user_updated', 'user_deleted'));

EOSQL
