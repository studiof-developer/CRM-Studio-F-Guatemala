#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- VwExistencia has no price field at all — forcing a fake 0 would be actively
-- misleading (an advisor could read "Q0.00" as real). NULL means "not synced from
-- the ERP, set manually" instead of a false price.
ALTER TABLE products ALTER COLUMN price DROP NOT NULL;

-- Mirrors VwClienteResumenCRM. numero_cliente is the ERP's own stable customer id, used
-- directly as the primary key. telefono/celular are indexed since that's how this joins
-- against our own customers.whatsapp_number when showing an advisor a customer's real
-- purchase history alongside the WhatsApp conversation.
CREATE TABLE IF NOT EXISTS erp_customers (
    numero_cliente          INTEGER PRIMARY KEY,
    nit_dpi                 TEXT,
    nombre                  TEXT,
    telefono                TEXT,
    celular                 TEXT,
    email                   TEXT,
    fecha_cumpleanos        DATE,
    direccion               TEXT,
    departamento            TEXT,
    ciudad                  TEXT,
    fecha_ultima_compra     DATE,
    dias_sin_compra         INTEGER,
    segmento_sin_compra     TEXT,
    sucursal_preferida      TEXT,
    sucursal_ultima_compra  TEXT,
    numero_ultima_factura   TEXT,
    vendedor_ultima_factura TEXT,
    facturas_totales        INTEGER,
    unidades_totales        INTEGER,
    venta_neta_total        NUMERIC(12,2),
    unidades_full_precio    INTEGER,
    unidades_promocion      INTEGER,
    venta_full_precio       NUMERIC(12,2),
    venta_promocion         NUMERIC(12,2),
    porcentaje_full_precio  NUMERIC(6,4),
    blusas                  INTEGER,
    jeans                   INTEGER,
    vestidos                INTEGER,
    pantalones              INTEGER,
    otros                   INTEGER,
    talla_blusa             TEXT,
    talla_jean              TEXT,
    talla_calzado           TEXT,
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_erp_customers_telefono ON erp_customers(telefono);
CREATE INDEX IF NOT EXISTS idx_erp_customers_celular ON erp_customers(celular);

EOSQL
