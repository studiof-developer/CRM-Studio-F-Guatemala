-- Migration 020: Clean up stale unread flags on resolved, unassigned, and already-read tickets

-- 1. Resolved tickets can never be unread
UPDATE tickets SET has_unread = false WHERE status = 'resuelto' AND has_unread = true;

-- 2. Unassigned tickets (esperando_asesor / No atendidos) are a queue to take, not advisor unread
UPDATE tickets SET has_unread = false WHERE status = 'esperando_asesor' AND has_unread = true;

-- 3. For any active ticket in attention, if no human message exists after the last read message id, mark has_unread = false
UPDATE tickets t
SET has_unread = false
WHERE t.status NOT IN ('esperando_asesor', 'resuelto')
  AND t.has_unread = true
  AND NOT EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    JOIN customers c ON c.id = t.customer_id
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
      AND h.message->>'type' = 'human'
      AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
      AND (
        coalesce(h.message->>'content', '') <> ''
        OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
      )
  );

-- 4. Sync customers.has_unread for those same customers
UPDATE customers c
SET has_unread = false
WHERE c.has_unread = true
  AND NOT EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
      AND h.message->>'type' = 'human'
      AND h.id > COALESCE((SELECT last_read_message_id FROM conversation_reads WHERE phone = c.whatsapp_number), 0)
      AND (
        coalesce(h.message->>'content', '') <> ''
        OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
      )
  );
