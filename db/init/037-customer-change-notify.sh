#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- The Pipeline board only ever got real-time pushes from the tickets table (003) — a
-- plain temperature move (dragging a card, the OCR auto-Pagado, "Marcar como Pagado")
-- writes to customers instead, so none of those showed up until the board's own 60s
-- poll fallback caught up. Reuses the same 'ticket_changes' channel/payload shape
-- rather than adding a second one, since every listener already treats it as "go
-- reload" and doesn't care which table triggered it.
CREATE OR REPLACE FUNCTION notify_customer_pipeline_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ticket_changes', json_build_object('customerId', NEW.id, 'op', 'customer_update')::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_notify_pipeline_change ON customers;
CREATE TRIGGER customers_notify_pipeline_change
AFTER UPDATE ON customers
FOR EACH ROW
WHEN (OLD.manual_status IS DISTINCT FROM NEW.manual_status OR OLD.paid_locked IS DISTINCT FROM NEW.paid_locked)
EXECUTE FUNCTION notify_customer_pipeline_change();

EOSQL
