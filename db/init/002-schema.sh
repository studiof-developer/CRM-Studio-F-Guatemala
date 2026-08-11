#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE TABLE stores (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    zone            TEXT NOT NULL,
    departments     TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
    id                  SERIAL PRIMARY KEY,
    whatsapp_number     TEXT NOT NULL UNIQUE,
    full_name           TEXT,
    dpi                 TEXT,
    birth_date          DATE,
    zone                TEXT,
    department          TEXT,
    email               TEXT,
    preferred_line      TEXT,
    purchase_status     TEXT,
    purchase_frequency  INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE consent_type AS ENUM ('basico', 'probador_digital', 'recordatorios', 'marketing');

CREATE TABLE consents (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    type            consent_type NOT NULL,
    accepted        BOOLEAN NOT NULL,
    policy_version  TEXT NOT NULL,
    channel         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id              SERIAL PRIMARY KEY,
    sku             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    line            TEXT,
    size            TEXT,
    color           TEXT,
    price           NUMERIC(10,2) NOT NULL,
    discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT true,
    image_url       TEXT
);

CREATE TYPE order_status AS ENUM ('carrito', 'pendiente_pago', 'pagado', 'enviado', 'entregado', 'cancelado');

CREATE TABLE orders (
    id                  SERIAL PRIMARY KEY,
    ticket_code         TEXT UNIQUE,
    customer_id         INTEGER NOT NULL REFERENCES customers(id),
    store_id            INTEGER REFERENCES stores(id),
    status              order_status NOT NULL DEFAULT 'carrito',
    payment_method      TEXT,
    shipping_address    TEXT,
    tracking_number     TEXT,
    total               NUMERIC(10,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id),
    product_id      INTEGER NOT NULL REFERENCES products(id),
    quantity        INTEGER NOT NULL DEFAULT 1,
    unit_price      NUMERIC(10,2) NOT NULL,
    discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0
);

CREATE TYPE ticket_status AS ENUM ('bot', 'esperando_asesor', 'en_atencion', 'resuelto');

CREATE TABLE tickets (
    id                  SERIAL PRIMARY KEY,
    order_id            INTEGER REFERENCES orders(id),
    customer_id         INTEGER NOT NULL REFERENCES customers(id),
    status              ticket_status NOT NULL DEFAULT 'bot',
    handoff_reason       TEXT,
    assigned_advisor    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE access_audit (
    id              SERIAL PRIMARY KEY,
    actor           TEXT NOT NULL,
    customer_id     INTEGER NOT NULL REFERENCES customers(id),
    action          TEXT NOT NULL,
    accessed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_decision_log (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER REFERENCES customers(id),
    message_in      TEXT NOT NULL,
    rag_context     TEXT,
    response_out    TEXT NOT NULL,
    confidence      NUMERIC(3,2),
    handed_off      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

EOSQL
