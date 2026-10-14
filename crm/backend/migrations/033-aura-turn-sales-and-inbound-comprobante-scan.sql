-- Migration 033: Record and confirm Aura's sales from shift notebook on 14/10 and auto-sync inbound receipts

-- 1. Insert or update sales for each of Aura's clients from shift closing on 14 de octubre:

-- 4947: Q 1,286.00
UPDATE sales
SET
  amount = 1286.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q1,286',
  created_at = '2026-10-14 12:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%4947%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 1286.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q1,286', '2026-10-14 12:00:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%4947%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 5352: Q 349.00
UPDATE sales
SET
  amount = 349.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q349',
  created_at = '2026-10-14 12:30:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%5352%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 349.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q349', '2026-10-14 12:30:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%5352%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 5625: Q 750.00
UPDATE sales
SET
  amount = 750.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q750',
  created_at = '2026-10-14 13:00:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%5625%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 750.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q750', '2026-10-14 13:00:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%5625%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 0037: Q 474.50
UPDATE sales
SET
  amount = 474.50,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q474.50',
  created_at = '2026-10-14 13:15:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%0037%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 474.50, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q474.50', '2026-10-14 13:15:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%0037%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 7851: Q 705.00
UPDATE sales
SET
  amount = 705.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q705',
  created_at = '2026-10-14 13:30:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%7851%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 705.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q705', '2026-10-14 13:30:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%7851%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 4291: Q 974.00
UPDATE sales
SET
  amount = 974.00,
  advisor_name = 'Aura Cristina Carvajal Delgado',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Comprobante verificado turno 14/10 Q974',
  created_at = '2026-10-14 13:45:00-06'::timestamptz
FROM customers c
WHERE sales.customer_id = c.id
  AND c.whatsapp_number LIKE '%4291%';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 974.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Comprobante verificado turno 14/10 Q974', '2026-10-14 13:45:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number LIKE '%4291%'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- 2. Mark corresponding customers as paid_locked and pagado
UPDATE customers
SET paid_locked = true, manual_status = 'pagado', updated_at = now()
WHERE whatsapp_number LIKE '%4947%'
   OR whatsapp_number LIKE '%5352%'
   OR whatsapp_number LIKE '%5625%'
   OR whatsapp_number LIKE '%0037%'
   OR whatsapp_number LIKE '%7851%'
   OR whatsapp_number LIKE '%4291%';

-- 3. Backfill line IDs on newly created sales
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
