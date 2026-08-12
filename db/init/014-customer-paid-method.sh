#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE customers ADD COLUMN IF NOT EXISTS paid_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_paid_method_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_paid_method_check
      CHECK (paid_method IS NULL OR paid_method IN ('tarjeta', 'efectivo', 'transferencia', 'deposito'));
  END IF;
END $$;

EOSQL
