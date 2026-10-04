-- Migration 019: Clean up stale unread flags and align conversation_reads with advisor activity (Instant execution)

-- 1. Fast cleanup on tickets: if advisor replied last, clear awaiting_reply and has_unread
UPDATE tickets
SET awaiting_reply = false,
    has_unread = false
WHERE (last_message_at > last_customer_message_at)
   OR (last_message_at IS NOT NULL AND last_customer_message_at IS NULL);

-- 2. Fast cleanup on customers: if advisor replied last, clear awaiting_reply and has_unread
UPDATE customers
SET awaiting_reply = false,
    has_unread = false
WHERE (last_message_at > last_customer_message_at)
   OR (last_message_at IS NOT NULL AND last_customer_message_at IS NULL);

-- 3. Replace sync_customer_unread_on_read trigger to update both customers and tickets
CREATE OR REPLACE FUNCTION sync_customer_unread_on_read() RETURNS TRIGGER AS $$
DECLARE
  v_has_unread BOOLEAN;
BEGIN
  v_has_unread := EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE (h.session_id = NEW.phone OR h.session_id LIKE NEW.phone || '__%')
      AND h.message->>'type' = 'human'
      AND h.id > NEW.last_read_message_id
      AND (
        coalesce(h.message->>'content', '') <> ''
        OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
      )
  );

  UPDATE customers SET has_unread = v_has_unread WHERE whatsapp_number = NEW.phone;

  UPDATE tickets SET has_unread = v_has_unread, updated_at = now()
  WHERE customer_id = (SELECT id FROM customers WHERE whatsapp_number = NEW.phone)
    AND status != 'resuelto';

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_unread_on_read ON conversation_reads;
CREATE TRIGGER trg_sync_customer_unread_on_read
AFTER INSERT OR UPDATE ON conversation_reads
FOR EACH ROW EXECUTE FUNCTION sync_customer_unread_on_read();
