#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE quick_replies (
    id              SERIAL PRIMARY KEY,
    shortcut        TEXT NOT NULL,
    content         TEXT NOT NULL,
    scope           TEXT NOT NULL CHECK (scope IN ('personal', 'global')),
    owner_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_quick_replies_scope ON quick_replies(scope);
CREATE INDEX idx_quick_replies_owner ON quick_replies(owner_user_id);

EOSQL
