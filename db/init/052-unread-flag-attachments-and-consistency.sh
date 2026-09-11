#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Two bugs found comparing Pipeline's new has_unread-based total against Conversaciones'
-- own /unread-count (2026-09-11 report — the two didn't match):
--   1. A human message with an attachment but no caption text never set has_unread —
--      the INSERT trigger only fired on content <> ''. Conversaciones' own unread-count
--      counts "content <> '' OR has an attachment" (see readable CTE there); this only
--      matched the text half of that. Attachments link to n8n_chat_histories in a
--      SEPARATE insert (linkExistingFile, after the message row already exists), so this
--      needs its own trigger on message_attachments, not a wider condition on the
--      message-insert trigger alone.
--   2. sync_customer_unread_on_read() (recomputing on a conversation_reads change) never
--      required non-empty content OR an attachment at all — just type='human' — so it
--      was actually BROADER than the insert trigger, inconsistent with it. Both are now
--      the same "content <> '' OR has an attachment" rule as Conversaciones.
CREATE OR REPLACE FUNCTION sync_customer_unread_on_read() RETURNS TRIGGER AS $$
BEGIN
  UPDATE customers SET has_unread = EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE h.session_id LIKE NEW.phone || '%'
      AND h.message->>'type' = 'human'
      AND h.id > NEW.last_read_message_id
      AND (
        coalesce(h.message->>'content', '') <> ''
        OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
      )
  )
  WHERE whatsapp_number = NEW.phone;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- New: a human message's attachment link arriving marks the thread unread too, same
-- phone-resolution as the other triggers on this table.
CREATE OR REPLACE FUNCTION sync_customer_unread_on_attachment() RETURNS TRIGGER AS $$
DECLARE
  v_type TEXT;
  v_session_id TEXT;
  v_phone TEXT;
BEGIN
  SELECT h.message->>'type', h.session_id INTO v_type, v_session_id
  FROM n8n_chat_histories h WHERE h.id = NEW.n8n_message_id;

  IF v_type = 'human' THEN
    v_phone := split_part(v_session_id, '__', 1);
    IF v_phone ~ '^\d{7,15}$' THEN
      UPDATE customers SET has_unread = true WHERE whatsapp_number = v_phone;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_unread_on_attachment ON message_attachments;
CREATE TRIGGER trg_sync_customer_unread_on_attachment
AFTER INSERT ON message_attachments
FOR EACH ROW EXECUTE FUNCTION sync_customer_unread_on_attachment();

-- Re-backfill with the same broadened rule so existing attachment-only unread messages
-- (sent before this migration) are reflected too, not just new ones going forward.
UPDATE customers c SET has_unread = EXISTS (
  SELECT 1 FROM n8n_chat_histories h
  WHERE h.session_id LIKE c.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
    AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
    AND (
      coalesce(h.message->>'content', '') <> ''
      OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
    )
);

EOSQL
