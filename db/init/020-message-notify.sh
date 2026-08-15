#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

CREATE OR REPLACE FUNCTION notify_message_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('message_changes', json_build_object('session_id', NEW.session_id)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_history_notify_change
AFTER INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION notify_message_change();

EOSQL
