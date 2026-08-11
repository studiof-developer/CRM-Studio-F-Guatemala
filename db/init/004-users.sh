#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TYPE user_role AS ENUM ('asesor', 'supervisor');

CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            user_role NOT NULL DEFAULT 'asesor',
    zone            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

EOSQL
