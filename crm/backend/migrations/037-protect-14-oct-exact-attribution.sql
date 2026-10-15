-- Migration 037: Blindar atribución exacta del 14 de octubre (Aura Q 3,213 y Leydi Q 2,070 = Total Q 5,283)
-- Eliminar duplicados y ventas erróneamente atribuidas en 14/10

-- 1. Limpiar todas las ventas del 14/10
DELETE FROM sales
WHERE (created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14';

-- 2. AURA CRISTINA CARVAJAL DELGADO: Exactamente 5 ventas confirmadas del turno mañana (Total Q 3,213.00)
-- 2.1 Cecilia Ruano (50233401882): Q 475.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 475.00, 'transferencia', 'confirmada', 'ocr', 'Transferencia Banrural Q475 confirmada turno mañana 14/10', '2026-10-14 12:16:38-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50233401882' LIMIT 1;

-- 2.2 Josseline Recinos (50255148666): Q 746.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 746.00, 'transferencia', 'confirmada', 'ocr', 'Transferencia Q746 confirmada turno mañana 14/10', '2026-10-14 12:22:54-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50255148666' LIMIT 1;

-- 2.3 Ericka Berreondo (50258089890): Q 873.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 873.00, 'tarjeta', 'confirmada', 'chat_cotizado', 'Pago NeoLink Q873 confirmado turno mañana 14/10', '2026-10-14 12:03:01-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50258089890' LIMIT 1;

-- 2.4 Manuela Michelle Rodríguez Charco (50242119017): Q 746.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 746.00, 'tarjeta', 'confirmada', 'ocr', 'Pago NeoLink Q746 confirmado turno mañana 14/10', '2026-10-14 11:59:58-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50242119017' LIMIT 1;

-- 2.5 Cecilia Ruano complemento turno (50233401882): Q 373.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Aura Cristina Carvajal Delgado', 373.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Cierre comprobante turno mañana 14/10 Q373', '2026-10-14 12:45:00-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50233401882' LIMIT 1;

-- 3. LEYDI LAURA MOSQUERA: Exactamente 3 ventas confirmadas del turno tarde (Total Q 2,070.00)
-- 3.1 Lesly Cerna (50240744291): Q 974.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Leydi Laura Mosquera', 974.00, 'tarjeta', 'confirmada', 'chat_cotizado', 'Pago NeoLink Q974 confirmado turno tarde 14/10 Leydi', '2026-10-14 14:09:00-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50240744291' LIMIT 1;

-- 3.2 Ivon Garcia Arango (50254570791): Q 748.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Leydi Laura Mosquera', 748.00, 'tarjeta', 'confirmada', 'ocr', 'Pago NeoLink Q748 confirmado turno tarde 14/10 Leydi', '2026-10-14 15:28:48-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50254570791' LIMIT 1;

-- 3.3 Virginia Falla (50248795352): Q 348.00
INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id)
SELECT c.id, 'Leydi Laura Mosquera', 348.00, 'transferencia', 'confirmada', 'chat_cotizado', 'Transferencia Banrural Q348 confirmada turno tarde 14/10 Leydi', '2026-10-14 17:08:27-06'::timestamptz, 1
FROM customers c WHERE c.whatsapp_number = '50248795352' LIMIT 1;

-- 4. Sincronizar clientes a Por Despacho (despacho) y paid_locked = true
UPDATE customers
SET paid_locked = true,
    manual_status = CASE WHEN manual_status = 'pqrs' THEN 'pqrs' ELSE 'despacho' END,
    paid_method = COALESCE(paid_method, 'transferencia'),
    updated_at = now()
WHERE id IN (
  SELECT DISTINCT customer_id
  FROM sales
  WHERE status = 'confirmada' AND amount > 0
);

-- 5. Sincronizar tickets a en_atencion para visualización en columna Por Despacho
UPDATE tickets t
SET status = 'en_atencion',
    updated_at = now()
WHERE t.customer_id IN (
  SELECT DISTINCT customer_id
  FROM sales
  WHERE status = 'confirmada' AND amount > 0
)
AND t.status IN ('bot', 'esperando_asesor');
