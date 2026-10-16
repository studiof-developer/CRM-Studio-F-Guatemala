-- Migration 038: Limpiar ventas falsas por imágenes de ropa no reconocidas como comprobantes y reconciliar 15 de octubre
-- 1. Eliminar ventas falsas generadas por fotos de blusas/vestidos/catálogo ("no se reconoció como comprobante")
--    donde el cliente NO tiene ningún comprobante real (ocrAmount) ni mensaje de confirmación/alistamiento ese día.
DELETE FROM sales s
USING customers c
WHERE s.customer_id = c.id
  AND (s.created_at AT TIME ZONE 'America/Guatemala')::date != '2026-10-14'
  AND s.notes LIKE '%no se reconoció como comprobante%'
  AND NOT EXISTS (
    SELECT 1 FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
      AND (h.created_at AT TIME ZONE 'America/Guatemala')::date = (s.created_at AT TIME ZONE 'America/Guatemala')::date
      AND (
        (
          (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
          AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric >= 50
          AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric <= 10000
        )
        OR (
          h.message->>'type' = 'ai'
          AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
          AND h.message->>'content' ~* '(proceso\s+de\s+alistamiento|pedido\s+ya\s+est[aá]\s+en\s+proceso|gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado|verificado)|comprobante\s+(recibido|verificado|confirmado)|agregado\s+a\s+la\s+compra)'
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_audit aa
    WHERE aa.customer_id = s.customer_id
      AND aa.action = 'customer_marked_paid'
      AND aa.actor NOT ILIKE '%OCR%'
      AND aa.actor NOT ILIKE '%Sistema%'
      AND (aa.accessed_at AT TIME ZONE 'America/Guatemala')::date = (s.created_at AT TIME ZONE 'America/Guatemala')::date
  );

-- 2. Si un cliente que sí compró tenía múltiples registros el mismo día por haber enviado varias fotos de vestidos antes de pagar,
--    eliminar los duplicados de "no se reconoció como comprobante" dejando un único registro válido.
DELETE FROM sales s1
USING sales s2
WHERE s1.customer_id = s2.customer_id
  AND s1.id > s2.id
  AND (s1.created_at AT TIME ZONE 'America/Guatemala')::date = (s2.created_at AT TIME ZONE 'America/Guatemala')::date
  AND (s1.created_at AT TIME ZONE 'America/Guatemala')::date != '2026-10-14'
  AND s1.notes LIKE '%no se reconoció como comprobante%';

-- 3. Actualizar la hora y nota de las ventas reales que inicialmente se crearon con la foto de prenda pero que luego sí pagaron ese mismo día
UPDATE sales s
SET
  notes = 'Comprobante y alistamiento verificado en chat',
  created_at = COALESCE(
    (
      SELECT h.created_at
      FROM n8n_chat_histories h
      JOIN customers c ON c.id = s.customer_id
      WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
        AND (h.created_at AT TIME ZONE 'America/Guatemala')::date = (s.created_at AT TIME ZONE 'America/Guatemala')::date
        AND (
          ((h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$' AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric >= 50)
          OR (h.message->>'type' = 'ai' AND h.message->>'content' ~* '(proceso\s+de\s+alistamiento|gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado))')
        )
      ORDER BY h.id DESC
      LIMIT 1
    ),
    s.created_at
  )
WHERE s.notes LIKE '%no se reconoció como comprobante%'
  AND (s.created_at AT TIME ZONE 'America/Guatemala')::date != '2026-10-14';

-- 4. Reconciliación exacta de Yesenia Galvez (50246041682) el 15 de octubre:
--    Atendida y cerrada por Luisa Cristancho con dos compras reales por NeoLink:
--    1) Q 1,056.00 a las 10:48:07 (voucher OCR Q1056 + mensaje de alistamiento a las 11:06)
--    2) Q 649.00 a las 11:17:17 (segundo link NeoLink + voucher + "Agregado a la compra!" a las 11:31)
DELETE FROM sales s
USING customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number = '50246041682'
  AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-15';

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id, attributed_by)
SELECT c.id, 'Luisa Cristancho', 1056.00, 'tarjeta', 'confirmada', 'ocr', 'Pago NeoLink Q1,056 confirmado por OCR y alistamiento Luisa 15/10', '2026-10-15 10:48:07-06'::timestamptz, 1, 'asesor_en_turno_dia'
FROM customers c WHERE c.whatsapp_number = '50246041682' LIMIT 1;

INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at, whatsapp_number_id, attributed_by)
SELECT c.id, 'Luisa Cristancho', 649.00, 'tarjeta', 'confirmada', 'chat_cotizado', 'Segundo pedido NeoLink Q649 agregado a la compra Luisa 15/10', '2026-10-15 11:17:17-06'::timestamptz, 1, 'asesor_en_turno_dia'
FROM customers c WHERE c.whatsapp_number = '50246041682' LIMIT 1;

-- 5. Priorizar monto real leído por OCR en boleta bancaria / voucher del mismo día
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
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric >= 50
    AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric <= 10000
    AND (h.created_at AT TIME ZONE 'America/Guatemala')::date = (s.created_at AT TIME ZONE 'America/Guatemala')::date
  ORDER BY s.id, h.id DESC
) ocr_sub
WHERE sales.id = ocr_sub.sale_id
  AND (sales.created_at AT TIME ZONE 'America/Guatemala')::date != '2026-10-14'
  AND (sales.amount = 0 OR sales.amount IS NULL OR (sales.notes NOT LIKE '%Monto corregido%' AND sales.notes NOT LIKE '%Comprobante verificado%' AND sales.notes NOT LIKE '%Segundo pedido%' AND sales.amount_source != 'ocr'));

-- 6. Re-atribuir cada venta (excepto 14/10 blindado) a la asesora que atendió más recientemente al cliente justo antes del pago
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
      MAX(h.id) AS last_msg_id,
      COUNT(*) AS cnt
    FROM n8n_chat_histories h
    WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
      AND h.message->>'type' = 'ai'
      AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
      AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
      AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
      AND h.created_at <= s.created_at + interval '2 hours'
      AND h.created_at >= s.created_at - interval '24 hours'
    GROUP BY 1
    ORDER BY MAX(h.id) DESC, cnt DESC
    LIMIT 1
  ) adv_counts
  WHERE adv_counts.advisor_name IS NOT NULL
) day_adv
WHERE sales.id = day_adv.sale_id
  AND (sales.created_at AT TIME ZONE 'America/Guatemala')::date != '2026-10-14'
  AND (sales.notes IS NULL OR (
    sales.notes NOT LIKE '%14/10%'
    AND sales.notes NOT LIKE '%Monto corregido%'
    AND sales.notes NOT LIKE '%el 12 de octubre%'
    AND sales.notes NOT LIKE '%el 29 de septiembre%'
  ));

-- 7. Liberar estado de clientes que habían quedado bloqueados en pagado/despacho únicamente por fotos de ropa falsas
UPDATE customers c
SET paid_locked = false,
    manual_status = NULL,
    paid_method = NULL,
    updated_at = now()
WHERE c.paid_locked = true
  AND COALESCE(c.purchase_frequency, 0) = 0
  AND NOT EXISTS (
    SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.status = 'confirmada' AND s.amount > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM access_audit aa
    WHERE aa.customer_id = c.id
      AND aa.action = 'customer_marked_paid'
      AND aa.actor NOT ILIKE '%OCR%'
      AND aa.actor NOT ILIKE '%Sistema%'
  );

-- 8. Asegurar que todos los clientes con ventas reales confirmadas estén en Por Despacho
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
