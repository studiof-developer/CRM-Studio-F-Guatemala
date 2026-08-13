#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'admin';

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;

UPDATE users SET username = 'asupervisora' WHERE full_name = 'Ana Supervisora' AND username IS NULL;

INSERT INTO users (full_name, username, email, password_hash, role)
VALUES ('Mauricio Rodriguez', 'mrodriguez', NULL, '$2b$10$E61ja3QRf8n.xOihF.2AeOm4xBIsMi.8rl2cneDF/iKWqNIecGWKm', 'admin')
ON CONFLICT (username) DO NOTHING;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

ALTER TABLE access_audit ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_action_check;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_action_check
  CHECK (action IN ('view_customer', 'view_ticket', 'view_conversation', 'login', 'user_created', 'user_updated', 'user_deleted'));

EOSQL
