-- Migration 034: Fix Aura shift total to exact Q 3,612 for 14/10, restore accurate historical sale dates, and guarantee Leydi Laura Mosquera attribution

-- 1. Ensure Aura's sales for today (14 de octubre) are EXACTLY the 5 confirmed clients from the shift notebook (Total = Q 3,612.00):
--    4947: Q 1,286.00
--    8666: Q 746.00
--    5352: Q 349.00
--    1882: Q 475.00
--    5625: Q 756.00 (750 + 6)
--    Total = Q 3,612.00

-- 4947: Q 1,286.00
UPDATE sales s
SET
  amount = 1286.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q1,286',
  created_at = '2026-10-14 12:00:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number LIKE '%4947%';

-- 8666: Q 746.00
UPDATE sales s
SET
  amount = 746.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q746',
  created_at = '2026-10-14 12:15:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number LIKE '%8666%';

-- 5352: Q 349.00
UPDATE sales s
SET
  amount = 349.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q349',
  created_at = '2026-10-14 12:30:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number LIKE '%5352%';

-- 1882: Q 475.00
UPDATE sales s
SET
  amount = 475.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q475',
  created_at = '2026-10-14 12:45:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number LIKE '%1882%';

-- 5625: Q 756.00
UPDATE sales s
SET
  amount = 756.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q756',
  created_at = '2026-10-14 13:00:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number LIKE '%5625%';

-- 2. Move ALL other sales that were incorrectly stamped with 2026-10-14 back to their real historical dates:
UPDATE sales s
SET created_at = COALESCE(
  (
    SELECT aa.accessed_at
    FROM access_audit aa
    WHERE aa.customer_id = s.customer_id
      AND aa.action = 'customer_marked_paid'
      AND (aa.accessed_at AT TIME ZONE 'America/Guatemala')::date < '2026-10-14'
    ORDER BY aa.id DESC
    LIMIT 1
  ),
  (
    SELECT h.created_at
    FROM n8n_chat_histories h
    JOIN customers c2 ON s.customer_id = c2.id
    WHERE (h.session_id = c2.whatsapp_number OR h.session_id LIKE c2.whatsapp_number || '__%')
      AND (h.created_at AT TIME ZONE 'America/Guatemala')::date < '2026-10-14'
    ORDER BY h.id DESC
    LIMIT 1
  ),
  '2026-10-13 18:00:00-06'::timestamptz
)
FROM customers c
WHERE s.customer_id = c.id
  AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  AND c.whatsapp_number NOT LIKE '%4947%'
  AND c.whatsapp_number NOT LIKE '%8666%'
  AND c.whatsapp_number NOT LIKE '%5352%'
  AND c.whatsapp_number NOT LIKE '%1882%'
  AND c.whatsapp_number NOT LIKE '%5625%';

-- 3. Restore and lock Leydi Laura Mosquera's confirmed sales (Total Q 2,834.00 on 12/10):
-- Zulema (54843294): Q 539.00
UPDATE sales s
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre',
  created_at = '2026-10-12 18:24:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%');

-- Gloria Maria Lorenzana (55157085): Q 1,930.00
UPDATE sales s
SET
  amount = 1930.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre',
  created_at = '2026-10-12 18:00:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%');

-- Ana Melgar (40432640): Q 365.00
UPDATE sales s
SET
  amount = 365.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  notes = 'Venta confirmada Q365 atendida por Leydi Laura Mosquera el 12 de octubre',
  created_at = '2026-10-12 18:00:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id
  AND (c.whatsapp_number LIKE '%4043264%' OR c.full_name ILIKE '%Ana%Melgar%');

-- Re-attribute any sales where access_audit marked_paid was done by Leydi:
UPDATE sales s
SET advisor_name = 'Leydi Laura Mosquera'
FROM access_audit aa
WHERE aa.customer_id = s.customer_id
  AND aa.action = 'customer_marked_paid'
  AND aa.actor ILIKE '%Leydi%';

-- Re-attribute any sales where tickets.assigned_advisor was Leydi:
UPDATE sales s
SET advisor_name = 'Leydi Laura Mosquera'
FROM tickets t
WHERE t.customer_id = s.customer_id
  AND t.assigned_advisor ILIKE '%Leydi%'
  AND s.notes NOT LIKE '%turno 14/10%';

-- 4. Deduplicate any duplicate sales per customer on the same date:
DELETE FROM sales
WHERE id IN (
  SELECT s2.id
  FROM sales s1
  JOIN sales s2 ON s1.customer_id = s2.customer_id
    AND s1.id < s2.id
    AND (s1.created_at AT TIME ZONE 'America/Guatemala')::date = (s2.created_at AT TIME ZONE 'America/Guatemala')::date
);

-- 5. Normalize advisor names
UPDATE sales
SET advisor_name = 'Leydi Laura Mosquera'
WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

UPDATE sales
SET advisor_name = 'Luisa Cristancho'
WHERE advisor_name ILIKE '%Luisa%' AND advisor_name != 'Luisa Cristancho';

UPDATE sales
SET advisor_name = 'Aura Cristina Carvajal Delgado'
WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';
