#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_size TEXT;

EOSQL
