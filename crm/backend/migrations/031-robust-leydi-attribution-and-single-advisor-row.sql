-- Migration 031: Robust Leydi attribution, insertion of missing confirmed sales, OCR priority and single advisor row consolidation

-- 1. Specific corrections for confirmed clients (regardless of exact timestamp format)
-- Zulema de Zepeda: Paid Q539.00 via Banrural deposit, attended and closed by Leydi Laura Mosquera
UPDATE sales
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q539 según boleta Banrural y chat atendido por Leydi',
  created_at = '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number IN ('50254843294', '5024043264') OR c.whatsapp_number LIKE '%54843294%' OR c.whatsapp_number LIKE '%4043264%');

-- If Zulema didn't have an existing sale recorded, insert it
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 539.00, 'deposito', 'confirmada', 'chat_cotizado', 'Monto corregido a Q539 según boleta Banrural y chat atendido por Leydi', '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number IN ('50254843294', '5024043264') OR c.whatsapp_number LIKE '%54843294%' OR c.whatsapp_number LIKE '%4043264%')
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-13'
  )
LIMIT 1;

-- Gloria Maria Lorenzana: Paid Q1,930.00 via NeoLink, attended and closed by Leydi Laura Mosquera
UPDATE sales
SET
  amount = 1930.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q1930 según comprobante NeoLink y chat atendido por Leydi',
  created_at = '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number = '50255157085' OR c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%');

-- If Gloria didn't have an existing sale recorded, insert it
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 1930.00, 'neolink', 'confirmada', 'chat_cotizado', 'Monto corregido a Q1930 según comprobante NeoLink y chat atendido por Leydi', '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE (c.whatsapp_number = '50255157085' OR c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%')
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-13'
  )
LIMIT 1;

-- Third Leydi sale on 2026-10-13 (Q365.00 completing Leydi's Q2,834 total)
UPDATE sales
SET
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  notes = 'Venta confirmada Q365 atendida por Leydi',
  created_at = '2026-10-13 18:00:00-06'::timestamptz
WHERE (amount = 365 OR quoted_amount = 365)
  AND (created_at AT TIME ZONE 'America/Guatemala')::date BETWEEN '2026-10-10' AND '2026-10-14';

-- Paola Reyes: Paid Q1,533.00 via Banco Industrial deposit slip #33953010 (not Q1,699.00 quote), attended by Aura
UPDATE sales
SET
  amount = 1533.00,
  amount_source = 'ocr',
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  notes = 'Monto corregido a Q1,533 según boleta de depósito Banco Industrial #33953010',
  created_at = '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number = '50255504601' OR c.whatsapp_number LIKE '%55504601%' OR c.full_name ILIKE '%Paola%Reyes%');

-- Doris Lorena Cifuentes Hidalgo: Paid Q1,199.00, attended by Aura
UPDATE sales
SET
  amount = 1199.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  created_at = '2026-10-13 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number = '50241224737' OR c.whatsapp_number LIKE '%41224737%' OR c.full_name ILIKE '%Doris%Lorena%');

-- 2. Cap amounts > 10,000 (abnormal retail amounts / auth numbers / lifetime ERP totals)
UPDATE sales
SET
  amount = COALESCE(NULLIF(quoted_amount, 0), 0),
  status = CASE WHEN quoted_amount > 0 AND quoted_amount <= 10000 THEN 'confirmada' ELSE 'revisar' END,
  notes = COALESCE(notes, '') || ' [Corregido: monto excedía límite retail > Q10,000]'
WHERE amount > 10000;

-- 3. Prioritize actual OCR receipt amounts from chat deposit slips over preliminary quotes
UPDATE sales
SET
  amount = ocr_sub.val,
  status = 'confirmada',
  amount_source = 'ocr'
FROM (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    (h.message->'additional_kwargs'->>'ocrAmount')::numeric AS val
  FROM sales s
  JOIN customers c ON s.customer_id = c.id
  JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
  WHERE (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric > 0
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric <= 10000
    AND h.created_at <= s.created_at + interval '24 hours'
    AND h.created_at >= s.created_at - interval '7 days'
  ORDER BY s.id, h.id DESC
) ocr_sub
WHERE sales.id = ocr_sub.sale_id
  AND (sales.amount = 0 OR sales.amount IS NULL OR (sales.notes NOT LIKE '%Monto corregido%' AND sales.amount_source != 'ocr'));

-- 4. Re-attribute sales to the advisor who sent the MOST messages in chat to that customer in 7 days prior
UPDATE sales
SET
  advisor_name = sub.advisor_name,
  attributed_by = 'chat_asesor_activo'
FROM (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    adv_agg.advisor_name
  FROM sales s
  JOIN customers c ON s.customer_id = c.id
  CROSS JOIN LATERAL (
    SELECT
      h.message->'additional_kwargs'->>'advisorName' AS advisor_name,
      COUNT(*) AS cnt
    FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
      AND h.message->>'type' = 'ai'
      AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
      AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
      AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
      AND h.created_at <= s.created_at + interval '24 hours'
      AND h.created_at >= s.created_at - interval '7 days'
    GROUP BY 1
    ORDER BY cnt DESC, MAX(h.id) DESC
    LIMIT 1
  ) adv_agg
  WHERE adv_agg.advisor_name IS NOT NULL
) sub
WHERE sales.id = sub.sale_id
  AND (sales.notes IS NULL OR sales.notes NOT LIKE '%Monto corregido%')
  AND (sales.advisor_name IS NULL OR sales.advisor_name != sub.advisor_name);

-- 5. Attributed to Leydi any sale where Leydi attended the customer in chat
UPDATE sales
SET
  advisor_name = 'Leydi Laura Mosquera',
  attributed_by = 'chat_asesor_leydi'
FROM customers c
WHERE sales.customer_id = c.id
  AND EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
      AND (h.message->'additional_kwargs'->>'advisorName') ILIKE '%Leydi%'
  )
  AND (sales.notes IS NULL OR (sales.notes NOT LIKE '%Aura%' AND sales.notes NOT LIKE '%Doris%' AND sales.notes NOT LIKE '%Paola%'));

-- 6. Normalize advisor names
UPDATE sales
SET advisor_name = 'Leydi Laura Mosquera'
WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

UPDATE sales
SET advisor_name = 'Aura Cristina Carvajal Delgado'
WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';

-- 7. Backfill missing whatsapp_number_id on sales so line filtering never drops valid sales
UPDATE sales
SET whatsapp_number_id = t.whatsapp_number_id
FROM tickets t
WHERE sales.ticket_id = t.id AND sales.whatsapp_number_id IS NULL AND t.whatsapp_number_id IS NOT NULL;

UPDATE sales
SET whatsapp_number_id = t.whatsapp_number_id
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, whatsapp_number_id
  FROM tickets WHERE whatsapp_number_id IS NOT NULL
  ORDER BY customer_id, id DESC
) t
WHERE sales.customer_id = t.customer_id AND sales.whatsapp_number_id IS NULL;
