#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_actor_user_id_fkey;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_actor_user_id_fkey
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

EOSQL
