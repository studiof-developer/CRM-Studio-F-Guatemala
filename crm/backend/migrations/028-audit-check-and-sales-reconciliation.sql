-- Migration 028: Fix access_audit check constraint, add advisor columns to social_messages,
-- and backfill historical sales with accurate attribution.

-- 1. Update access_audit constraint to allow sales and marketing actions
ALTER TABLE access_audit DROP CONSTRAINT IF EXISTS access_audit_action_check;
ALTER TABLE access_audit ADD CONSTRAINT access_audit_action_check CHECK (
  action = ANY (ARRAY[
    'view_customer'::text,
    'view_ticket'::text,
    'view_conversation'::text,
    'login'::text,
    'user_created'::text,
    'user_updated'::text,
    'user_deleted'::text,
    'whatsapp_number_created'::text,
    'whatsapp_number_updated'::text,
    'whatsapp_number_deleted'::text,
    'ticket_status_changed'::text,
    'customer_status_changed'::text,
    'customer_marked_paid'::text,
    'sale_recorded'::text,
    'sale_updated'::text,
    'sale_deleted'::text,
    'customer_opted_out'::text,
    'customer_opted_in'::text
  ])
);

-- 2. Add advisor attribution columns to social_messages
ALTER TABLE social_messages
  ADD COLUMN IF NOT EXISTS advisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS advisor_name TEXT;

CREATE INDEX IF NOT EXISTS idx_social_messages_advisor_id ON social_messages(advisor_id);
CREATE INDEX IF NOT EXISTS idx_social_messages_advisor_name ON social_messages(advisor_name);

-- 3. Reconcile existing sales with Q0 amount where a quote or OCR receipt exists
UPDATE sales s
SET
  amount = COALESCE(q.grand_total, ocr_msg.ocr_amount, s.amount),
  quote_id = COALESCE(s.quote_id, q.id),
  quoted_amount = COALESCE(s.quoted_amount, q.grand_total),
  receipt_amount = COALESCE(s.receipt_amount, ocr_msg.ocr_amount),
  amount_source = CASE
    WHEN q.grand_total > 0 THEN 'cotizacion'
    WHEN ocr_msg.ocr_amount > 0 THEN 'ocr'
    ELSE s.amount_source
  END,
  status = CASE
    WHEN COALESCE(q.grand_total, ocr_msg.ocr_amount, s.amount) > 0 AND s.advisor_name NOT IN ('Asesor', 'Sin atribuir') THEN 'confirmada'
    ELSE s.status
  END
FROM customers c
LEFT JOIN LATERAL (
  SELECT id, grand_total FROM quotes
  WHERE customer_id = c.id AND grand_total > 0
  ORDER BY id DESC LIMIT 1
) q ON true
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (h.message->'additional_kwargs'->>'ocrAmount')::numeric
    ELSE 0
  END AS ocr_amount
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
  ORDER BY h.id DESC LIMIT 1
) ocr_msg ON true
WHERE s.customer_id = c.id
  AND (s.amount = 0 OR s.amount IS NULL);

-- 4. Backfill any paid customers who still have no sale entry in sales
INSERT INTO sales (
  customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method,
  quote_id, notes, whatsapp_number_id, created_at, status, amount_source,
  quoted_amount, receipt_amount, attributed_by, confirmed_at, channel
)
SELECT
  c.id AS customer_id,
  t.id AS ticket_id,
  u.id AS advisor_id,
  COALESCE(adv_msg.advisor_name, t.assigned_advisor, 'Sin atribuir') AS advisor_name,
  COALESCE(q.grand_total, ocr_msg.ocr_amount, 0) AS amount,
  COALESCE(c.paid_method, 'transferencia') AS payment_method,
  q.id AS quote_id,
  'Reconciliación de ventas históricas' AS notes,
  t.whatsapp_number_id,
  COALESCE(adv_msg.last_advisor_msg_at, c.updated_at, now()) AS created_at,
  CASE
    WHEN COALESCE(q.grand_total, ocr_msg.ocr_amount, 0) > 0 AND COALESCE(adv_msg.advisor_name, t.assigned_advisor) IS NOT NULL THEN 'confirmada'
    ELSE 'revisar'
  END AS status,
  CASE
    WHEN q.grand_total > 0 THEN 'cotizacion'
    WHEN ocr_msg.ocr_amount > 0 THEN 'ocr'
    ELSE 'manual'
  END AS amount_source,
  q.grand_total AS quoted_amount,
  ocr_msg.ocr_amount AS receipt_amount,
  'backfill_historico' AS attributed_by,
  COALESCE(adv_msg.last_advisor_msg_at, c.updated_at, now()) AS confirmed_at,
  'whatsapp' AS channel
FROM customers c
LEFT JOIN LATERAL (
  SELECT id, whatsapp_number_id, assigned_advisor
  FROM tickets t
  WHERE t.customer_id = c.id
  ORDER BY (status = 'resuelto') ASC, id DESC
  LIMIT 1
) t ON true
LEFT JOIN LATERAL (
  SELECT
    h.message->'additional_kwargs'->>'advisorName' AS advisor_name,
    h.created_at AS last_advisor_msg_at
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->>'type' = 'ai'
    AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
  ORDER BY h.id DESC
  LIMIT 1
) adv_msg ON true
LEFT JOIN LATERAL (
  SELECT CASE
    WHEN (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (h.message->'additional_kwargs'->>'ocrAmount')::numeric
    ELSE 0
  END AS ocr_amount
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
  ORDER BY h.id DESC
  LIMIT 1
) ocr_msg ON true
LEFT JOIN LATERAL (
  SELECT id, grand_total
  FROM quotes q
  WHERE q.customer_id = c.id AND q.grand_total > 0
  ORDER BY id DESC
  LIMIT 1
) q ON true
LEFT JOIN LATERAL (
  SELECT id, full_name
  FROM users u
  WHERE u.full_name = adv_msg.advisor_name OR u.full_name = t.assigned_advisor
  LIMIT 1
) u ON true
WHERE (c.paid_locked = true OR c.manual_status IN ('pagado', 'despacho'))
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id
  );
