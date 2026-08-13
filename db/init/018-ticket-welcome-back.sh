#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS welcome_back_sent BOOLEAN NOT NULL DEFAULT false;

EOSQL
