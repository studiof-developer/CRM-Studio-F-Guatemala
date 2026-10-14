-- Migration 032: Fix real turn advisor attribution, eliminate duplicates, and set accurate purchase dates

-- 1. Deduplicate duplicate sales (keep the first record, delete duplicate entries with same customer & amount within 24h)
DELETE FROM sales
WHERE id IN (
  SELECT s2.id
  FROM sales s1
  JOIN sales s2 ON s1.customer_id = s2.customer_id
    AND s1.id < s2.id
    AND ABS(s1.amount - s2.amount) < 1
    AND ABS(EXTRACT(EPOCH FROM (s1.created_at - s2.created_at))) < 86400
);

-- 2. Delete bogus Q0 sales where a real sale already exists for that customer
DELETE FROM sales
WHERE amount = 0
  AND customer_id IN (SELECT customer_id FROM sales WHERE amount > 0);

-- 3. Specific historical corrections with accurate dates and real attending advisors in turn:

-- Nancy Rodas (50240345864): Bought on 29 de septiembre via NeoLink Q439, attended by Luisa Cristancho
UPDATE sales
SET
  amount = 439.00,
  advisor_name = 'Luisa Cristancho',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Venta confirmada Q439 atendida por Luisa Cristancho el 29 de septiembre',
  created_at = '2026-09-29 14:46:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number LIKE '%40345864%' OR c.full_name ILIKE '%Nancy%Rodas%');

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Luisa Cristancho', 439.00, 'neolink', 'confirmada', 'chat_cotizado', 'Venta confirmada Q439 atendida por Luisa Cristancho el 29 de septiembre', '2026-09-29 14:46:00-06'::timestamptz
FROM customers c
WHERE (c.whatsapp_number LIKE '%40345864%' OR c.full_name ILIKE '%Nancy%Rodas%')
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-09-29'
  )
LIMIT 1;

-- Zulema de Zepeda (50254843294): Bought on 12 de octubre via Banrural deposit Q539, attended and closed by Leydi Laura Mosquera
UPDATE sales
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre',
  created_at = '2026-10-12 18:24:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%');

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 539.00, 'deposito', 'confirmada', 'chat_cotizado', 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre', '2026-10-12 18:24:00-06'::timestamptz
FROM customers c
WHERE (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%')
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-12'
  )
LIMIT 1;

-- Gloria Maria Lorenzana (50255157085): Bought on 12 de octubre via NeoLink Q1,930, attended and closed by Leydi Laura Mosquera
UPDATE sales
SET
  amount = 1930.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre',
  created_at = '2026-10-12 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%');

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 1930.00, 'neolink', 'confirmada', 'chat_cotizado', 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre', '2026-10-12 18:00:00-06'::timestamptz
FROM customers c
WHERE (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%')
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-12'
  )
LIMIT 1;

-- Ana Melgar (50240432640): Attended by Leydi
UPDATE sales
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  created_at = '2026-10-12 18:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number LIKE '%4043264%' OR c.full_name ILIKE '%Ana%Melgar%');

-- Paola Reyes (50255504601): Paid Q1,533.00 on 13 de octubre via Banco Industrial boleta #33953010, attended by Aura
UPDATE sales
SET
  amount = 1533.00,
  amount_source = 'ocr',
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  notes = 'Monto corregido a Q1,533 según boleta Banco Industrial #33953010',
  created_at = '2026-10-13 14:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number LIKE '%55504601%' OR c.full_name ILIKE '%Paola%Reyes%');

-- Doris Lorena Cifuentes Hidalgo (50241224737): Paid Q1,199.00 on 13 de octubre, attended by Aura
UPDATE sales
SET
  amount = 1199.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  created_at = '2026-10-13 15:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND (c.whatsapp_number LIKE '%41224737%' OR c.full_name ILIKE '%Doris%Lorena%');

-- 4. Smart Re-attribution: Attribute each sale to the advisor in turn who actually conversed with that customer on the purchase date
UPDATE sales
SET
  advisor_name = day_adv.advisor_name,
  attributed_by = 'asesor_en_turno_dia'
FROM (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    adv_counts.advisor_name
  FROM sales s
  JOIN customers c ON s.customer_id = c.id
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Leydi%' THEN 'Leydi Laura Mosquera'
        WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Luisa%' THEN 'Luisa Cristancho'
        WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Aura%' THEN 'Aura Cristina Carvajal Delgado'
        ELSE h.message->'additional_kwargs'->>'advisorName'
      END AS advisor_name,
      COUNT(*) AS cnt
    FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
      AND h.message->>'type' = 'ai'
      AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
      AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
      AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
      AND h.created_at <= s.created_at + interval '4 hours'
      AND h.created_at >= s.created_at - interval '36 hours'
    GROUP BY 1
    ORDER BY cnt DESC, MAX(h.id) DESC
    LIMIT 1
  ) adv_counts
  WHERE adv_counts.advisor_name IS NOT NULL
) day_adv
WHERE sales.id = day_adv.sale_id
  AND (sales.notes IS NULL OR (sales.notes NOT LIKE '%Monto corregido%' AND sales.notes NOT LIKE '%Venta confirmada%'));

-- 5. Final Normalization
UPDATE sales
SET advisor_name = 'Leydi Laura Mosquera'
WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

UPDATE sales
SET advisor_name = 'Luisa Cristancho'
WHERE advisor_name ILIKE '%Luisa%' AND advisor_name != 'Luisa Cristancho';

UPDATE sales
SET advisor_name = 'Aura Cristina Carvajal Delgado'
WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';

-- 6. Backfill line IDs
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
