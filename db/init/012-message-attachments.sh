#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE IF NOT EXISTS message_attachments (
    id              SERIAL PRIMARY KEY,
    n8n_message_id  INTEGER NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('image', 'document', 'audio')),
    filename        TEXT,
    mime_type       TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_n8n_message_id ON message_attachments(n8n_message_id);

EOSQL
