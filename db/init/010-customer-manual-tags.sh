#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

ALTER TABLE customers ADD COLUMN IF NOT EXISTS manual_status TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS paid_locked BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_manual_status_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_manual_status_check
      CHECK (manual_status IS NULL OR manual_status IN ('caliente', 'tibio', 'frio', 'pagado', 'pqrs'));
  END IF;
END $$;

EOSQL
