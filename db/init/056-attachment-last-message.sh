#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- 2026-09-14 report: a customer who sent 2 photos with no caption after an advisor's
-- last text reply still showed that advisor's old text as the Pipeline card's preview
-- and "hace X" timestamp, reading as if nobody had followed up. Root cause: 051's
-- `IF v_content <> '' THEN` guards silently skipped last_message/last_customer_message
-- (and has_unread) entirely for a human/ai row with empty content — but
-- conversations.js's own list query already treats exactly that shape (empty content,
-- human/ai type) as a real message, an attachment sent with no caption, not nothing
-- (see its `readable` CTE). This drops those guards and falls back to a generic
-- placeholder instead of leaving the old text/timestamp/unread-flag stuck. Deliberately
-- NOT checking message_attachments to name the actual kind — attachments.js inserts
-- that row in a separate, later statement, so it doesn't exist yet at trigger time; a
-- generic placeholder beats a race condition. Otherwise identical to 051 — same
-- has_unread maintenance, same difusion_enviada reactivation.
CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_preview TEXT := CASE WHEN v_content <> '' THEN v_content ELSE '📎 Adjunto' END;
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  UPDATE customers SET last_message_at = NEW.created_at, last_message = v_preview
  WHERE whatsapp_number = v_phone;

  IF v_type = 'human' THEN
    UPDATE customers SET
      last_customer_message_at = NEW.created_at,
      last_customer_message = v_preview,
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

-- One-time backfill (same LATERAL pattern as 046's own backfill) so an already-affected
-- card like the one reported gets fixed immediately instead of waiting for its next
-- message.
UPDATE customers c SET
  last_message_at = lm.created_at,
  last_message = CASE WHEN coalesce(lm.content, '') <> '' THEN lm.content ELSE '📎 Adjunto' END
FROM customers c2
LEFT JOIN LATERAL (
  SELECT h.created_at, h.message->>'content' AS content
  FROM n8n_chat_histories h
  WHERE h.session_id LIKE c2.whatsapp_number || '%'
    AND h.message->>'type' IN ('human', 'ai')
  ORDER BY h.id DESC LIMIT 1
) lm ON true
WHERE c.id = c2.id AND lm.created_at IS NOT NULL;

UPDATE customers c SET
  last_customer_message_at = lcm.created_at,
  last_customer_message = CASE WHEN coalesce(lcm.content, '') <> '' THEN lcm.content ELSE '📎 Adjunto' END
FROM customers c2
LEFT JOIN LATERAL (
  SELECT h.created_at, h.message->>'content' AS content
  FROM n8n_chat_histories h
  WHERE h.session_id LIKE c2.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
  ORDER BY h.id DESC LIMIT 1
) lcm ON true
WHERE c.id = c2.id AND lcm.created_at IS NOT NULL;

EOSQL
