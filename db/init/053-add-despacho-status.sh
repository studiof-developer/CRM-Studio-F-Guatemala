#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- New 8th pipeline stage, "Por despacho" — sits right after Pagado. Manual-only by
-- design (2026-09-11 request): TEMPERATURE_SQL never produces it on its own, an advisor
-- sets it themselves (drag from Pagado, or the Estado dropdown in the chat panel) once
-- shipping starts. Just widens the same CHECK constraint frio/tibio/caliente/pagado/pqrs
-- already use — no new column, no new table.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_manual_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_manual_status_check
  CHECK (manual_status IS NULL OR (manual_status = ANY (ARRAY['caliente', 'tibio', 'frio', 'pagado', 'despacho', 'pqrs'])));

EOSQL
