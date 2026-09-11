#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Replaces the reverted "No leídos" aggregate (2026-09-11 outage: a correlated EXISTS
-- subquery running over every row in the whole dataset, on every /pipeline call) with a
-- maintained column instead of a per-request scan — same pattern last_customer_message_at/
-- awaiting_reply already use. Kept in sync at the two moments it can actually change,
-- each touching ONE customer, not the whole table:
--   - a new human message arrives -> definitely unread now (its id is newer than
--     whatever was last read, by definition)
--   - conversation_reads changes (thread opened, a campaign send marks it read, the
--     explicit "mark unread" rolling the watermark back) -> recompute for that one phone
-- Reading it afterwards (tickets.js's bucket_unread_total) is then just a plain indexed
-- boolean already sitting on the row already being scanned, not a correlated subquery.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS has_unread BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_customers_has_unread ON customers (has_unread) WHERE has_unread;

CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_content TEXT := coalesce(NEW.message->>'content', '');
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  IF v_content <> '' THEN
    UPDATE customers SET last_message_at = NEW.created_at, last_message = v_content
    WHERE whatsapp_number = v_phone;
  END IF;

  IF v_type = 'human' AND v_content <> '' THEN
    UPDATE customers SET
      last_customer_message_at = NEW.created_at,
      last_customer_message = v_content,
      awaiting_reply = true,
      has_unread = true
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

CREATE OR REPLACE FUNCTION sync_customer_unread_on_read() RETURNS TRIGGER AS $$
BEGIN
  UPDATE customers SET has_unread = EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE h.session_id LIKE NEW.phone || '%'
      AND h.message->>'type' = 'human'
      AND h.id > NEW.last_read_message_id
  )
  WHERE whatsapp_number = NEW.phone;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_unread_on_read ON conversation_reads;
CREATE TRIGGER trg_sync_customer_unread_on_read
AFTER INSERT OR UPDATE ON conversation_reads
FOR EACH ROW EXECUTE FUNCTION sync_customer_unread_on_read();

-- One-time backfill (run once, by hand, not per-request — same reasoning as 031's) so
-- the column starts correct instead of every customer defaulting to false.
UPDATE customers c SET has_unread = EXISTS (
  SELECT 1 FROM n8n_chat_histories h
  WHERE h.session_id LIKE c.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
    AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
);

EOSQL
