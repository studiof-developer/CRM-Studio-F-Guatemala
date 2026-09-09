#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- New ticket status: a customer whose ticket was esperando_asesor (No atendidos) just
-- got reached by a broadcast (campaigns.js). They shouldn't count as "En atención" —
-- no advisor actually claimed them — but leaving status alone would mean the same
-- contact resurfaces in every future broadcast/export forever. This takes them off the
-- Pipeline board entirely (tickets.js's HIDDEN_TICKET_STATUSES_SQL, same treatment as
-- 'bot') until they actually write back, at which point the trigger below flips them
-- straight back to esperando_asesor with a fresh timestamp — a normal, recently-arrived
-- "No atendido" again, not a stale one. Never settable through the ticket PATCH route
-- (not added to ticketStatus.js's VALID_STATUSES) — purely automatic.
ALTER TYPE ticket_status ADD VALUE IF NOT EXISTS 'difusion_enviada';
EOSQL

# A newly-added enum value can't be referenced in the same transaction/session that
# added it — a fresh psql invocation guarantees the CREATE OR REPLACE FUNCTION below
# (which only stores the value in a UPDATE ... SET status = 'difusion_enviada' string
# literal parsed at CALL time, not at CREATE time) runs cleanly regardless of PG version.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Extends 031's existing "customer wrote something real" trigger — already fires on
-- every inbound human message, so reactivating a paused-by-broadcast ticket belongs
-- right here rather than as a second trigger on the same table/event.
CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  IF v_type = 'human' AND coalesce(NEW.message->>'content', '') <> '' THEN
    UPDATE customers SET
      last_customer_message_at = NEW.created_at,
      last_customer_message = NEW.message->>'content',
      awaiting_reply = true
    WHERE whatsapp_number = v_phone;

    UPDATE tickets SET status = 'esperando_asesor', updated_at = now()
    WHERE status = 'difusion_enviada'
      AND customer_id = (SELECT id FROM customers WHERE whatsapp_number = v_phone);
  ELSE
    UPDATE customers SET awaiting_reply = false WHERE whatsapp_number = v_phone;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

EOSQL
