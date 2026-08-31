#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Kept up to date by the trigger below instead of computed per-request via a LATERAL
-- lookup into n8n_chat_histories — the pipeline board's sort order and its displayed
-- "hace X" were silently using two DIFFERENT timestamps (stage_since to sort, a
-- LATERAL-fetched last-message time to display), which is exactly why the order looked
-- scrambled. One indexed column fixes both at once, and is cheap at any bucket size —
-- no more per-page LATERAL join needed at all.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_customer_message TEXT;
-- True only while the most recent message in the thread (of either side) is the
-- customer's — an advisor reply flips it back to false immediately, regardless of how
-- long it then takes the customer to answer. This is what "Atrasado" checks outside
-- No atendidos: the clock is only ever on us while this is true.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS awaiting_reply BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_customers_last_customer_message_at ON customers (last_customer_message_at);

CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
BEGIN
  -- Only real human/ai turns carry a meaningful sender — tool-call/tool-result rows
  -- (raw JSON, no visible text) don't represent anyone "replying" to anyone.
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  -- Same phone-from-session_id heuristic used everywhere else in the app (production
  -- session_ids are already the wa_id; legacy/test ones without a real phone are
  -- skipped rather than guessed at).
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
  ELSE
    UPDATE customers SET awaiting_reply = false WHERE whatsapp_number = v_phone;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_customer_last_message ON n8n_chat_histories;
CREATE TRIGGER trg_update_customer_last_message
AFTER INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION update_customer_last_message();

-- One-time backfill for every contact that already has history — a full scan is fine
-- here (this runs once, by hand, not on every pipeline request).
UPDATE customers c SET
  last_customer_message_at = lm.created_at,
  last_customer_message = lm.content,
  awaiting_reply = COALESCE(latest.type, '') = 'human'
FROM customers c2
LEFT JOIN LATERAL (
  SELECT h.created_at, h.message->>'content' AS content
  FROM n8n_chat_histories h
  WHERE h.session_id LIKE c2.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
    AND coalesce(h.message->>'content', '') <> ''
  ORDER BY h.id DESC LIMIT 1
) lm ON true
LEFT JOIN LATERAL (
  SELECT h.message->>'type' AS type
  FROM n8n_chat_histories h
  WHERE h.session_id LIKE c2.whatsapp_number || '%'
  ORDER BY h.id DESC LIMIT 1
) latest ON true
WHERE c.id = c2.id;

EOSQL
