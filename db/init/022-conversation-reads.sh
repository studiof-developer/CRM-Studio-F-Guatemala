#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE conversation_reads (
    phone                 TEXT PRIMARY KEY,
    last_read_message_id  INTEGER NOT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

EOSQL
