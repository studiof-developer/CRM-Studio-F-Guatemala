#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Pipeline cards only ever showed last_customer_message (031) — correct for the
-- Auditoría/SLA logic that specifically needs "when did the CUSTOMER last write", but
-- on the board itself it meant an advisor's own reply never updated the card preview:
-- the text and "hace X" kept showing the customer's now-answered message, reading as
-- if nobody had replied yet. These two are generic — whichever side wrote last — kept
-- separate from last_customer_message_at/last_customer_message, which keep their
-- existing customer-only meaning untouched.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_message TEXT;

-- Extends 031's trigger (already extended by 045 for the difusion_enviada reactivation)
-- with one more independent update — direction (customer vs. us) is already known from
-- awaiting_reply, no new column needed for that.
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

-- One-time backfill for existing threads — same reasoning as 031's, just not limited
-- to human messages this time.
UPDATE customers c SET
  last_message_at = lm.created_at,
  last_message = lm.content
FROM customers c2
LEFT JOIN LATERAL (
  SELECT h.created_at, h.message->>'content' AS content
  FROM n8n_chat_histories h
  WHERE h.session_id LIKE c2.whatsapp_number || '%'
    AND h.message->>'type' IN ('human', 'ai')
    AND coalesce(h.message->>'content', '') <> ''
  ORDER BY h.id DESC LIMIT 1
) lm ON true
WHERE c.id = c2.id AND lm.created_at IS NOT NULL;

EOSQL
