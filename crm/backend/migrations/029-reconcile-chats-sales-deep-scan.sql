-- Migration 029: Reconcile sales from chat histories, fix retail amount caps, and attribute to chat advisor

-- 1. Cap any extreme amount > 10,000 (which are authorization numbers, document codes, or lifetime ERP totals)
UPDATE sales
SET
  amount = COALESCE(NULLIF(quoted_amount, 0), 0),
  status = CASE WHEN quoted_amount > 0 AND quoted_amount <= 10000 THEN 'confirmada' ELSE 'revisar' END,
  notes = COALESCE(notes, '') || ' [Corregido: monto excedía límite retail > Q10,000]'
WHERE amount > 10000;

-- 2. Specific reconciliation for confirmed clients:
-- Zulema de Zepeda: paid Q539 on 2026-10-13, attended by Leydi Laura Mosquera
UPDATE sales s
SET
  amount = 539.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q539 según chat y comprobante real Banrural'
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number IN ('50254843294', '5024043264')
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- Gloria Maria Lorenzana: paid Q1930 on 2026-10-13, attended by Leydi Laura Mosquera
UPDATE sales s
SET
  amount = 1930.00,
  advisor_name = 'Leydi Laura Mosquera',
  status = 'confirmada',
  amount_source = 'chat_cotizado',
  notes = 'Monto corregido a Q1930 según chat y comprobante real NeoLink'
FROM customers c
WHERE s.customer_id = c.id
  AND c.whatsapp_number = '50255157085'
  AND date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala') = '2026-10-13';

-- 3. Re-attribute existing sales to the advisor who actually conversed with the customer in the chat in the 48h prior
-- (Chat attendant priority: overrides ticket assigned_advisor and manual clicks by other users)
UPDATE sales
SET
  advisor_name = sub.advisor_name,
  attributed_by = 'chat_asesor_activo'
FROM (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    h.message->'additional_kwargs'->>'advisorName' AS advisor_name
  FROM sales s
  JOIN customers c ON s.customer_id = c.id
  JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
  WHERE h.message->>'type' = 'ai'
    AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
    AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
    AND h.created_at <= s.created_at + interval '2 hours'
    AND h.created_at >= s.created_at - interval '48 hours'
  ORDER BY s.id, h.id DESC
) sub
WHERE sales.id = sub.sale_id
  AND sub.advisor_name IS NOT NULL
  AND (sales.advisor_name IS NULL OR sales.advisor_name != sub.advisor_name);

-- 4. Normalize advisor names in sales table
UPDATE sales
SET advisor_name = 'Leydi Laura Mosquera'
WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

UPDATE sales
SET advisor_name = 'Aura Cristina Carvajal Delgado'
WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';

-- 5. Extract quoted prices from advisor messages in chat for any sales still sitting at Q0
UPDATE sales
SET
  amount = sub.val,
  status = 'confirmada',
  amount_source = 'chat_cotizado'
FROM (
  SELECT DISTINCT ON (s.id)
    s.id AS sale_id,
    (regexp_match(h.message->>'content', '(?i)(?:total|son|ser[ií]an|depositar|cancelar|pagar)?[^\d]{0,10}Q\.?\s*([0-9]{2,4})'))[1]::numeric AS val
  FROM sales s
  JOIN customers c ON s.customer_id = c.id
  JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%')
  WHERE (s.amount = 0 OR s.amount IS NULL)
    AND h.message->>'type' = 'ai'
    AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
    AND h.created_at <= s.created_at + interval '2 hours'
    AND h.created_at >= s.created_at - interval '48 hours'
    AND h.message->>'content' ~* 'Q\.?\s*[0-9]{2,4}'
  ORDER BY s.id, h.id DESC
) sub
WHERE sales.id = sub.sale_id
  AND sub.val >= 50 AND sub.val <= 10000;

-- 6. Backfill remaining Q0 sales from quotes where quotes.grand_total > 0 and <= 10000
UPDATE sales s
SET
  amount = q.grand_total,
  quoted_amount = q.grand_total,
  quote_id = q.id,
  status = 'confirmada',
  amount_source = 'cotizacion'
FROM quotes q
WHERE q.customer_id = s.customer_id
  AND (s.amount = 0 OR s.amount IS NULL)
  AND q.grand_total > 0 AND q.grand_total <= 10000;
