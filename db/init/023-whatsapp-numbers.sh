#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE whatsapp_numbers (
    id                    SERIAL PRIMARY KEY,
    label                 TEXT NOT NULL,
    waba_id               TEXT NOT NULL,
    phone_number_id       TEXT NOT NULL UNIQUE,
    display_phone_number  TEXT,
    verified_name         TEXT,
    access_token_enc      TEXT NOT NULL,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    last_tested_at        TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by            TEXT
);

EOSQL
