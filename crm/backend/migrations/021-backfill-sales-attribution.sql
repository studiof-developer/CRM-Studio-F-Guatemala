-- Migration 021: Backfill sales attribution from payment events in September and October

-- 1. Insert sales from access_audit where customer_marked_paid occurred in September/October
INSERT INTO sales (customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, notes, whatsapp_number_id, created_at)
SELECT
  a.customer_id,
  t.id AS ticket_id,
  u.id AS advisor_id,
  COALESCE(
    CASE 
      WHEN a.actor ILIKE '%Leydi%' THEN 'Leydi Laura Mosquera'
      WHEN a.actor ILIKE '%Aura%' THEN 'Aura'
      ELSE u.full_name
    END,
    adv_msg.advisor_name,
    t.assigned_advisor,
    'Asesor'
  ) AS advisor_name,
  COALESCE(q.total, ocr_msg.ocr_amount, 0) AS amount,
  COALESCE(a.details, c.paid_method, 'transferencia') AS payment_method,
  'Atribuido automáticamente por registro de pago' AS notes,
  t.whatsapp_number_id,
  a.accessed_at AS created_at
FROM access_audit a
JOIN customers c ON c.id = a.customer_id
LEFT JOIN LATERAL (
  SELECT id, whatsapp_number_id, assigned_advisor
  FROM tickets t
  WHERE t.customer_id = a.customer_id
  ORDER BY (status = 'resuelto') ASC, id DESC
  LIMIT 1
) t ON true
LEFT JOIN LATERAL (
  SELECT id, full_name
  FROM users u
  WHERE (u.full_name ILIKE '%' || a.actor || '%' OR a.actor ILIKE '%' || u.full_name || '%')
  LIMIT 1
) u ON true
LEFT JOIN LATERAL (
  SELECT total
  FROM quotes q
  WHERE q.customer_id = a.customer_id
    AND q.created_at <= a.accessed_at + interval '1 day'
  ORDER BY id DESC
  LIMIT 1
) q ON true
LEFT JOIN LATERAL (
  SELECT
    h.message->'additional_kwargs'->>'advisorName' AS advisor_name
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->>'type' = 'ai'
    AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
    AND h.created_at <= a.accessed_at + interval '2 hours'
  ORDER BY h.id DESC
  LIMIT 1
) adv_msg ON true
LEFT JOIN LATERAL (
  SELECT (h.message->'additional_kwargs'->>'ocrAmount')::numeric AS ocr_amount
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
    AND h.created_at <= a.accessed_at + interval '1 day'
  ORDER BY h.id DESC
  LIMIT 1
) ocr_msg ON true
WHERE a.action = 'customer_marked_paid'
  AND a.accessed_at >= '2026-09-01T00:00:00-06:00'
  AND NOT EXISTS (
    SELECT 1 FROM sales s
    WHERE s.customer_id = a.customer_id
      AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = date_trunc('day', a.accessed_at AT TIME ZONE 'America/Guatemala')
  );

-- 2. Insert sales for customers who are paid_locked or in status pagado/despacho without prior sales entry
INSERT INTO sales (customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, notes, whatsapp_number_id, created_at)
SELECT
  c.id AS customer_id,
  t.id AS ticket_id,
  u.id AS advisor_id,
  COALESCE(
    adv_msg.advisor_name,
    t.assigned_advisor,
    'Asesor'
  ) AS advisor_name,
  COALESCE(q.total, ocr_msg.ocr_amount, 0) AS amount,
  COALESCE(c.paid_method, 'transferencia') AS payment_method,
  'Atribuido automáticamente por estado pagado' AS notes,
  t.whatsapp_number_id,
  COALESCE(adv_msg.last_advisor_msg_at, c.updated_at) AS created_at
FROM customers c
LEFT JOIN LATERAL (
  SELECT id, whatsapp_number_id, assigned_advisor, status
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
    AND h.created_at >= '2026-09-01T00:00:00-06:00'
  ORDER BY h.id DESC
  LIMIT 1
) adv_msg ON true
LEFT JOIN LATERAL (
  SELECT (h.message->'additional_kwargs'->>'ocrAmount')::numeric AS ocr_amount
  FROM n8n_chat_histories h
  WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
    AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
    AND h.created_at >= '2026-09-01T00:00:00-06:00'
  ORDER BY h.id DESC
  LIMIT 1
) ocr_msg ON true
LEFT JOIN LATERAL (
  SELECT total
  FROM quotes q
  WHERE q.customer_id = c.id AND q.created_at >= '2026-09-01T00:00:00-06:00'
  ORDER BY id DESC
  LIMIT 1
) q ON true
LEFT JOIN LATERAL (
  SELECT id, full_name
  FROM users u
  WHERE u.full_name = adv_msg.advisor_name OR u.full_name = t.assigned_advisor
  LIMIT 1
) u ON true
WHERE (c.paid_locked = true OR c.manual_status IN ('pagado', 'despacho') OR t.status IN ('pagado', 'despacho'))
  AND COALESCE(adv_msg.last_advisor_msg_at, c.updated_at) >= '2026-09-01T00:00:00-06:00'
  AND NOT EXISTS (
    SELECT 1 FROM sales s
    WHERE s.customer_id = c.id
  );

