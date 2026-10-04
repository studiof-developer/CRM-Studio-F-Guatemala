-- Migration 019: Clean up stale unread flags and align conversation_reads with advisor activity

-- 1. For any customer where an advisor has sent a message, ensure conversation_reads is at least up to that message
INSERT INTO conversation_reads (phone, last_read_message_id, updated_at)
SELECT 
  split_part(h.session_id, '__', 1) AS phone,
  max(h.id) AS last_read_message_id,
  now() AS updated_at
FROM n8n_chat_histories h
WHERE (
  (h.message->>'type') = 'ai' 
  AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
)
AND split_part(h.session_id, '__', 1) ~ '^\d{7,15}$'
GROUP BY split_part(h.session_id, '__', 1)
ON CONFLICT (phone) DO UPDATE SET
  last_read_message_id = GREATEST(conversation_reads.last_read_message_id, EXCLUDED.last_read_message_id),
  updated_at = now();

-- 2. Clean up customers.has_unread: only true if there is genuinely a human message newer than conversation_reads
UPDATE customers c
SET has_unread = EXISTS (
  SELECT 1 FROM n8n_chat_histories h
  WHERE h.session_id LIKE c.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
    AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
    AND (
      coalesce(h.message->>'content', '') <> ''
      OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
    )
);

-- 3. Clean up customers.awaiting_reply and tickets.awaiting_reply / has_unread:
-- If the customer does NOT have a human message newer than conversation_reads, awaiting_reply is false
UPDATE customers c
SET awaiting_reply = false
WHERE NOT EXISTS (
  SELECT 1 FROM n8n_chat_histories h
  WHERE h.session_id LIKE c.whatsapp_number || '%'
    AND h.message->>'type' = 'human'
    AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
);

UPDATE customers c
SET awaiting_reply = false
WHERE (c.last_message_at > c.last_customer_message_at)
   OR (c.last_message_at IS NOT NULL AND c.last_customer_message_at IS NULL);

-- Clean up tickets:
-- A ticket is NOT unread and NOT awaiting reply if the advisor already replied
-- (last_message_at > last_customer_message_at) or if customer has no unread messages.
UPDATE tickets t
SET awaiting_reply = false,
    has_unread = false
WHERE (t.last_message_at > t.last_customer_message_at)
   OR (t.last_message_at IS NOT NULL AND t.last_customer_message_at IS NULL)
   OR t.awaiting_reply IS FALSE;

UPDATE tickets t
SET awaiting_reply = false,
    has_unread = false
FROM customers c
WHERE t.customer_id = c.id
  AND (c.has_unread = false OR c.awaiting_reply = false);

-- 4. Replace sync_customer_unread_on_read trigger to update both customers and tickets
CREATE OR REPLACE FUNCTION sync_customer_unread_on_read() RETURNS TRIGGER AS $$
DECLARE
  v_has_unread BOOLEAN;
BEGIN
  v_has_unread := EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE h.session_id LIKE NEW.phone || '%'
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
