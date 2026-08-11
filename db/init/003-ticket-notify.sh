#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE OR REPLACE FUNCTION notify_ticket_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ticket_changes', json_build_object('id', COALESCE(NEW.id, OLD.id), 'op', TG_OP)::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_notify_change
AFTER INSERT OR UPDATE ON tickets
FOR EACH ROW EXECUTE FUNCTION notify_ticket_change();

EOSQL
