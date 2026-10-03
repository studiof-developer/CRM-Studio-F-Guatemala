-- Migration 015: Backfill historical sales from access_audit and paid_locked customers

-- 1. Insertar ventas registradas en la bitacora access_audit
INSERT INTO sales (customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, notes, whatsapp_number_id, created_at, updated_at)
SELECT DISTINCT ON (aa.customer_id, date_trunc('day', aa.accessed_at))
  aa.customer_id,
  (
    SELECT t.id FROM tickets t
    WHERE t.customer_id = aa.customer_id
    ORDER BY ABS(EXTRACT(EPOCH FROM (t.created_at - aa.accessed_at))) ASC
    LIMIT 1
  ) AS ticket_id,
  aa.actor_user_id AS advisor_id,
  COALESCE(NULLIF(TRIM(REGEXP_REPLACE(aa.actor, '\s*\(auto\)$', '')), ''), 'Asesor') AS advisor_name,
  COALESCE(
    (
      SELECT q.grand_total FROM quotes q
      WHERE q.customer_id = aa.customer_id
      ORDER BY ABS(EXTRACT(EPOCH FROM (q.created_at - aa.accessed_at))) ASC
      LIMIT 1
    ),
    0
  ) AS amount,
  CASE
    WHEN aa.details IN ('tarjeta', 'efectivo', 'transferencia', 'deposito') THEN aa.details
    ELSE COALESCE(c.paid_method, 'transferencia')
  END AS payment_method,
  'Registrado desde bitacora de auditoria' AS notes,
  (
    SELECT t.whatsapp_number_id FROM tickets t
    WHERE t.customer_id = aa.customer_id
    LIMIT 1
  ) AS whatsapp_number_id,
  aa.accessed_at AS created_at,
  aa.accessed_at AS updated_at
FROM access_audit aa
JOIN customers c ON c.id = aa.customer_id
WHERE (aa.action = 'customer_marked_paid' OR (aa.action = 'customer_status_changed' AND aa.details ILIKE '%Pagado%'))
  AND NOT EXISTS (
    SELECT 1 FROM sales s
    WHERE s.customer_id = aa.customer_id
      AND ABS(EXTRACT(EPOCH FROM (s.created_at - aa.accessed_at))) < 120
  )
ORDER BY aa.customer_id, date_trunc('day', aa.accessed_at), aa.accessed_at DESC;

-- 2. Asegurar que clientes con paid_locked = true tambien esten en sales
INSERT INTO sales (customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, notes, whatsapp_number_id, created_at, updated_at)
SELECT
  c.id AS customer_id,
  t.id AS ticket_id,
  u.id AS advisor_id,
  COALESCE(t.assigned_advisor, u.full_name, 'Asesor') AS advisor_name,
  COALESCE(
    (
      SELECT q.grand_total FROM quotes q
      WHERE q.customer_id = c.id
      ORDER BY q.created_at DESC
      LIMIT 1
    ),
    0
  ) AS amount,
  COALESCE(c.paid_method, 'transferencia') AS payment_method,
  'Cliente marcado como Pagado' AS notes,
  t.whatsapp_number_id,
  c.updated_at AS created_at,
  c.updated_at AS updated_at
FROM customers c
LEFT JOIN LATERAL (
  SELECT id, assigned_advisor, whatsapp_number_id FROM tickets
  WHERE customer_id = c.id
  ORDER BY (status = 'resuelto') ASC, id DESC LIMIT 1
) t ON true
LEFT JOIN users u ON u.full_name = t.assigned_advisor OR u.username = t.assigned_advisor
WHERE c.paid_locked = true
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id
  );
