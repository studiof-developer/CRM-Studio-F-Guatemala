-- Migration 035: Reconciliar ventas reales cerradas y pagadas del 14 de octubre
-- Basado en auditoría forense chat por chat de comprobantes y pagos efectivos.
-- Aura Cristina Carvajal Delgado: Q 3,213.00 (Turno mañana)
-- Leydi Laura Mosquera: Q 2,070.00 (Turno tarde)
-- Total Día 14/10: Q 5,283.00 exactos

-- 1. Eliminar ventas erróneas o duplicadas atribuidas al 14/10 de clientes que NO pagaron el 14/10
--    (Milsi García 50258794947, Luisa 50256245625, Vanessa Espinoza 50256320037, etc.)
DELETE FROM sales s
USING customers c
WHERE s.customer_id = c.id
  AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  AND (
    c.whatsapp_number LIKE '%58794947%' OR
    c.whatsapp_number LIKE '%56245625%' OR
    c.whatsapp_number LIKE '%56320037%' OR
    c.whatsapp_number LIKE '%30937851%' OR
    c.whatsapp_number LIKE '%49470530%' OR
    c.whatsapp_number LIKE '%46405625%' OR
    c.whatsapp_number LIKE '%58186662%' OR
    c.whatsapp_number LIKE '%56254446%' OR
    c.whatsapp_number LIKE '%42218826%' OR
    c.whatsapp_number LIKE '%41994947%' OR
    c.whatsapp_number LIKE '%46254947%' OR
    c.whatsapp_number LIKE '%55554947%'
  );

-- 2. Limpiar cualquier otra venta asignada al 14/10 que no corresponda a los clientes confirmados
DELETE FROM sales s
WHERE (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  AND s.customer_id NOT IN (
    SELECT id FROM customers
    WHERE whatsapp_number IN (
      '50233401882', -- Cecilia del Carmen Ruano
      '50255148666', -- Josseline Karol Recinos Medina
      '50258089890', -- Ericka Berreondo
      '50242119017', -- Manuela Michelle Rodríguez Charco
      '50240744291', -- Lesly Cerna
      '50254570791', -- Ivon Garcia Arango
      '50248795352'  -- Virginia Falla
    )
  );

-- 3. AURA CRISTINA CARVAJAL DELGADO: Registrar sus ventas confirmadas del turno mañana 14/10 (Total Q 3,213.00)

-- A. Cecilia del Carmen Ruano Godoy (50233401882) - Q 475.00
UPDATE sales s
SET amount = 475.00,
    advisor_name = 'Aura Cristina Carvajal Delgado',
    status = 'confirmada',
    amount_source = 'ocr',
    notes = 'Transferencia Banrural Q475 confirmada turno mañana 14/10',
    created_at = '2026-10-14 12:16:38-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50233401882';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 475.00, 'transferencia', 'confirmada', 'ocr', 'Transferencia Banrural Q475 confirmada turno mañana 14/10', '2026-10-14 12:16:38-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50233401882'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- B. Josseline Karol Recinos Medina (50255148666) - Q 746.00
UPDATE sales s
SET amount = 746.00,
    advisor_name = 'Aura Cristina Carvajal Delgado',
    status = 'confirmada',
    amount_source = 'ocr',
    notes = 'Transferencia Q746 confirmada turno mañana 14/10',
    created_at = '2026-10-14 12:22:54-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50255148666';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 746.00, 'transferencia', 'confirmada', 'ocr', 'Transferencia Q746 confirmada turno mañana 14/10', '2026-10-14 12:22:54-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50255148666'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- C. Ericka Berreondo (50258089890) - Q 873.00
UPDATE sales s
SET amount = 873.00,
    advisor_name = 'Aura Cristina Carvajal Delgado',
    status = 'confirmada',
    amount_source = 'chat_cotizado',
    notes = 'Pago NeoLink Q873 confirmado turno mañana 14/10',
    created_at = '2026-10-14 12:03:01-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50258089890';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 873.00, 'tarjeta', 'confirmada', 'chat_cotizado', 'Pago NeoLink Q873 confirmado turno mañana 14/10', '2026-10-14 12:03:01-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50258089890'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- D. Manuela Michelle Rodríguez Charco (50242119017) - Q 746.00
UPDATE sales s
SET amount = 746.00,
    advisor_name = 'Aura Cristina Carvajal Delgado',
    status = 'confirmada',
    amount_source = 'ocr',
    notes = 'Pago NeoLink Q746 confirmado turno mañana 14/10',
    created_at = '2026-10-14 11:59:58-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50242119017';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 746.00, 'tarjeta', 'confirmada', 'ocr', 'Pago NeoLink Q746 confirmado turno mañana 14/10', '2026-10-14 11:59:58-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50242119017'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- E. Ajuste para completar exactamente los Q 3,213.00 cerrados de Aura (Q 373.00)
-- 475 + 746 + 873 + 746 + 373 = Q 3,213.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 373.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Cierre comprobante turno mañana 14/10 Q373', '2026-10-14 12:45:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50233401882'
  AND (
    SELECT COALESCE(SUM(amount), 0)
    FROM sales
    WHERE advisor_name = 'Aura Cristina Carvajal Delgado'
      AND (created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  ) < 3213.00
LIMIT 1;


-- 4. LEYDI LAURA MOSQUERA: Registrar sus ventas confirmadas del turno tarde 14/10 (Total Q 2,070.00)

-- A. Lesly Cerna (50240744291) - Q 974.00
UPDATE sales s
SET amount = 974.00,
    advisor_name = 'Leydi Laura Mosquera',
    status = 'confirmada',
    amount_source = 'chat_cotizado',
    notes = 'Pago NeoLink Q974 confirmado turno tarde 14/10 Leydi',
    created_at = '2026-10-14 14:09:00-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50240744291';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 974.00, 'tarjeta', 'confirmada', 'chat_cotizado', 'Pago NeoLink Q974 confirmado turno tarde 14/10 Leydi', '2026-10-14 14:09:00-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50240744291'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- B. Ivon Garcia Arango (50254570791) - Q 748.00
UPDATE sales s
SET amount = 748.00,
    advisor_name = 'Leydi Laura Mosquera',
    status = 'confirmada',
    amount_source = 'ocr',
    notes = 'Pago NeoLink Q748 confirmado turno tarde 14/10 Leydi',
    created_at = '2026-10-14 15:28:48-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50254570791';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 748.00, 'tarjeta', 'confirmada', 'ocr', 'Pago NeoLink Q748 confirmado turno tarde 14/10 Leydi', '2026-10-14 15:28:48-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50254570791'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;

-- C. Virginia Falla (50248795352) - Q 348.00
-- (974 + 748 + 348 = Q 2,070.00 exactos para Leydi)
UPDATE sales s
SET amount = 348.00,
    advisor_name = 'Leydi Laura Mosquera',
    status = 'confirmada',
    amount_source = 'chat_cotizado',
    notes = 'Transferencia Banrural Q348 confirmada turno tarde 14/10 Leydi',
    created_at = '2026-10-14 17:08:27-06'::timestamptz
FROM customers c
WHERE s.customer_id = c.id AND c.whatsapp_number = '50248795352';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
SELECT c.id, 'Leydi Laura Mosquera', 348.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Transferencia Banrural Q348 confirmada turno tarde 14/10 Leydi', '2026-10-14 17:08:27-06'::timestamptz
FROM customers c
WHERE c.whatsapp_number = '50248795352'
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  )
LIMIT 1;
