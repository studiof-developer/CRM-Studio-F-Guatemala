-- Migration 030: Accurate advisor attribution (message volume priority), OCR deposit slip priority, and line backfill

-- 1. Specific corrections for 2026-10-13 (Ayer) based on actual bank deposits and chat attendance:

-- Paola Reyes: Paid Q1,533.00 via Banco Industrial deposit slip #33953010 (not Q1,699.00 quote), attended by Aura
UPDATE sales s
SET
  amount = 1533.00,
  amount_source = 'ocr',
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  notes = 'Monto corregido a Q1,533 según boleta de depósito Banco Industrial #33953010'
FROM customers c
WHERE s.customer_id = c.id
  AND (c.whatsapp_number = '50255504601' OR c.full_name ILIKE '%Paola%Reyes%')
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- Zulema de Zepeda: Paid Q539.00 via Banrural deposit, attended and closed by Leydi Laura Mosquera
UPDATE sales s
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q539 según boleta Banrural y chat atendido por Leydi'
FROM customers c
WHERE s.customer_id = c.id
  AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number IN ('50254843294', '5024043264') OR c.whatsapp_number LIKE '%54843294%' OR c.whatsapp_number LIKE '%4043264%')
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- Gloria Maria Lorenzana: Paid Q1,930.00 via NeoLink, attended and closed by Leydi Laura Mosquera
UPDATE sales s
SET
  amount = 1930.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q1930 según comprobante NeoLink y chat atendido por Leydi'
FROM customers c
WHERE s.customer_id = c.id
  AND (c.whatsapp_number = '50255157085' OR c.full_name ILIKE '%Gloria%Lorenzana%')
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- Third Leydi sale on 2026-10-13 (Q365.00 completing Leydi's Q2,834 total)
UPDATE sales s
SET
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada'
WHERE date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13'
  AND (s.amount = 365 OR s.quoted_amount = 365);

-- Doris Lorena Cifuentes Hidalgo: Paid Q1,199.00, attended by Aura
UPDATE sales s
SET
  amount = 1199.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada'
FROM customers c
WHERE s.customer_id = c.id
  AND (c.whatsapp_number = '50241224737' OR c.full_name ILIKE '%Doris%Lorena%')
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- 2. Cap any extreme amounts > Q10,000 (authorization codes or lifetime totals)
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
  JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
  WHERE (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric > 0
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric <= 10000
    AND h.created_at <= s.created_at + interval '2 hours'
    AND h.created_at >= s.created_at - interval '48 hours'
  ORDER BY s.id, h.id DESC
) ocr_sub
WHERE sales.id = ocr_sub.sale_id
  AND (sales.amount = 0 OR sales.amount IS NULL OR sales.notes NOT LIKE '%Monto corregido%');

-- 4. Re-attribute sales to the advisor who sent the MOST messages in chat to that customer in 48h prior
-- (Prevents another user or template from stealing credit by sending the last 1-word message)
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
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
      AND h.message->>'type' = 'ai'
      AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
      AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
      AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
      AND h.created_at <= s.created_at + interval '2 hours'
      AND h.created_at >= s.created_at - interval '48 hours'
    GROUP BY 1
    ORDER BY cnt DESC, MAX(h.id) DESC
    LIMIT 1
  ) adv_agg
  WHERE adv_agg.advisor_name IS NOT NULL
) sub
WHERE sales.id = sub.sale_id
  AND (sales.notes IS NULL OR sales.notes NOT LIKE '%Monto corregido%')
  AND (sales.advisor_name IS NULL OR sales.advisor_name != sub.advisor_name);

-- 5. Normalize advisor names
UPDATE sales
SET advisor_name = 'Leydi Laura Mosquera'
WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

UPDATE sales
SET advisor_name = 'Aura Cristina Carvajal Delgado'
WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';

-- 6. Backfill missing whatsapp_number_id on sales so line filtering never drops valid sales
UPDATE sales s
SET whatsapp_number_id = t.whatsapp_number_id
FROM tickets t
WHERE s.ticket_id = t.id AND s.whatsapp_number_id IS NULL AND t.whatsapp_number_id IS NOT NULL;

UPDATE sales s
SET whatsapp_number_id = t.whatsapp_number_id
FROM (
  SELECT DISTINCT ON (customer_id) customer_id, whatsapp_number_id
  FROM tickets WHERE whatsapp_number_id IS NOT NULL
  ORDER BY customer_id, id DESC
) t
WHERE s.customer_id = t.customer_id AND s.whatsapp_number_id IS NULL;
