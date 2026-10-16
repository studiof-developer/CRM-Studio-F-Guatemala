-- Migration 039: Clean up duplicate cross-line Pipeline cards (Basshert phantom tickets on Studio F customers)
-- and deduplicate double-submitted campaign broadcasts (e.g. promo_jeans).

BEGIN;

-- 1. Backfill last_message / last_customer_message on legitimate Line 2 (Basshert) tickets
-- from actual Line 2 messages in n8n_chat_histories so legitimate Basshert tickets have their own timestamps.
WITH line2_latest AS (
  SELECT
    t.id AS ticket_id,
    (
      SELECT h.message->>'content'
      FROM n8n_chat_histories h
      WHERE h.session_id LIKE c.whatsapp_number || '%'
        AND (h.whatsapp_number_id = 2 OR h.session_id LIKE '%__line_2%')
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 1
    ) AS last_msg,
    (
      SELECT h.created_at
      FROM n8n_chat_histories h
      WHERE h.session_id LIKE c.whatsapp_number || '%'
        AND (h.whatsapp_number_id = 2 OR h.session_id LIKE '%__line_2%')
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 1
    ) AS last_msg_at,
    (
      SELECT h.message->>'content'
      FROM n8n_chat_histories h
      WHERE h.session_id LIKE c.whatsapp_number || '%'
        AND (h.whatsapp_number_id = 2 OR h.session_id LIKE '%__line_2%')
        AND h.message->>'type' = 'human'
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 1
    ) AS last_cust_msg,
    (
      SELECT h.created_at
      FROM n8n_chat_histories h
      WHERE h.session_id LIKE c.whatsapp_number || '%'
        AND (h.whatsapp_number_id = 2 OR h.session_id LIKE '%__line_2%')
        AND h.message->>'type' = 'human'
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT 1
    ) AS last_cust_msg_at
  FROM tickets t
  JOIN customers c ON c.id = t.customer_id
  WHERE t.whatsapp_number_id = 2
)
UPDATE tickets t
SET
  last_message = COALESCE(t.last_message, l2.last_msg),
  last_message_at = COALESCE(t.last_message_at, l2.last_msg_at),
  last_customer_message = COALESCE(t.last_customer_message, l2.last_cust_msg),
  last_customer_message_at = COALESCE(t.last_customer_message_at, l2.last_cust_msg_at)
FROM line2_latest l2
WHERE t.id = l2.ticket_id
  AND l2.last_msg_at IS NOT NULL;

-- 2. Delete phantom Line 2 (Basshert) tickets for customers (like Monica and Suly) who have ZERO messages
-- on Line 2 and already have a ticket or messages on Line 1 (Studio F).
DELETE FROM tickets t
USING customers c
WHERE c.id = t.customer_id
  AND t.whatsapp_number_id = 2
  AND NOT EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE h.session_id LIKE c.whatsapp_number || '%'
      AND (h.whatsapp_number_id = 2 OR h.session_id LIKE '%__line_2%')
  )
  AND (
    EXISTS (
      SELECT 1 FROM tickets t1
      WHERE t1.customer_id = t.customer_id
        AND COALESCE(t1.whatsapp_number_id, 1) = 1
    )
    OR EXISTS (
      SELECT 1 FROM n8n_chat_histories h1
      WHERE h1.session_id LIKE c.whatsapp_number || '%'
        AND COALESCE(h1.whatsapp_number_id, 1) = 1
        AND h1.session_id NOT LIKE '%__line_2%'
    )
  );

-- 3. Collapse any duplicate open (non-resuelto) tickets on the same (customer_id, line)
WITH ranked_open AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY customer_id, COALESCE(whatsapp_number_id, 1)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM tickets
  WHERE status <> 'resuelto'
)
DELETE FROM tickets
WHERE id IN (SELECT id FROM ranked_open WHERE rn > 1);

-- 4. Deduplicate double-submitted campaign rows created within 120 seconds of each other
-- (such as the duplicate promo_jeans broadcast).
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      c1.id AS keep_id,
      c2.id AS drop_id
    FROM campaigns c1
    JOIN campaigns c2
      ON c1.template_name = c2.template_name
     AND COALESCE(c1.whatsapp_number_id, 1) = COALESCE(c2.whatsapp_number_id, 1)
     AND COALESCE(c1.created_by, '') = COALESCE(c2.created_by, '')
     AND c1.id < c2.id
     AND ABS(EXTRACT(EPOCH FROM (c2.created_at - c1.created_at))) <= 120
  LOOP
    -- Delete duplicate chat history rows sent by drop_id if keep_id already sent to the same session_id
    DELETE FROM n8n_chat_histories h_drop
    WHERE h_drop.message->'additional_kwargs'->>'campaignId' = rec.drop_id::text
      AND EXISTS (
        SELECT 1 FROM n8n_chat_histories h_keep
        WHERE h_keep.session_id = h_drop.session_id
          AND h_keep.message->'additional_kwargs'->>'campaignId' = rec.keep_id::text
      );

    -- Reassign any remaining chat history rows from drop_id to keep_id
    UPDATE n8n_chat_histories
    SET message = jsonb_set(message, '{additional_kwargs,campaignId}', to_jsonb(rec.keep_id::text))
    WHERE message->'additional_kwargs'->>'campaignId' = rec.drop_id::text;

    -- Remove the duplicate campaign row
    DELETE FROM campaigns WHERE id = rec.drop_id;
  END LOOP;
END $$;

-- 5. Mark any stale 'sending' campaigns older than 10 minutes as 'completed'
UPDATE campaigns ca
SET status = 'completed',
    completed_at = COALESCE(completed_at, now())
WHERE ca.status = 'sending'
  AND ca.created_at < now() - interval '10 minutes';

COMMIT;
