#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- 048 fixed the pure-NULL case (a message with no additional_kwargs at all falling
-- through the sentBy guard), but real report (2026-09-11): plenty of automated
-- messages DO carry sentBy:'advisor' with a generic advisorName (literally "asesor" —
-- not a person) rather than none at all, and those were still auto-claiming tickets.
-- The robust fix isn't chasing every placeholder string one at a time — it's requiring
-- the name to match an ACTUAL registered staff member before claiming anything.
-- Anything else (a bot/automation using any generic tag) leaves the ticket alone, same
-- as before 047: it stays in No atendidos until a real advisor takes it (or replies)
-- so the audit trail always says who genuinely claimed it.
CREATE OR REPLACE FUNCTION advance_pipeline_stage_from_advisor_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_customer RECORD;
  v_effective_temp TEXT;
  v_rank INT;
  v_new_status TEXT;
  v_price NUMERIC;
  v_advisor_name TEXT;
  v_is_real_advisor BOOLEAN;
  v_extra_phrases JSONB;
  v_phrase TEXT;
  v_ticket_id INT;
BEGIN
  IF NEW.message->>'type' <> 'ai' OR (NEW.message->'additional_kwargs'->>'sentBy') IS DISTINCT FROM 'advisor' THEN
    RETURN NEW;
  END IF;

  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  SELECT id, manual_status, paid_locked, purchase_frequency INTO v_customer
  FROM customers WHERE whatsapp_number = v_phone;
  IF NOT FOUND OR v_customer.paid_locked THEN
    RETURN NEW;
  END IF;

  v_advisor_name := NEW.message->'additional_kwargs'->>'advisorName';
  v_is_real_advisor := v_advisor_name IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE full_name = v_advisor_name);

  -- Only a genuine registered staff member's own reply claims the ticket — a bot/
  -- automation tagging itself sentBy:'advisor' (any advisorName, including none or a
  -- generic placeholder) leaves it untouched instead of silently taking credit for it.
  IF v_is_real_advisor THEN
    UPDATE tickets SET
      status = 'en_atencion',
      assigned_advisor = COALESCE(assigned_advisor, v_advisor_name),
      first_response_at = COALESCE(first_response_at, NEW.created_at),
      updated_at = now()
    WHERE customer_id = v_customer.id AND status IN ('esperando_asesor', 'difusion_enviada')
    RETURNING id INTO v_ticket_id;

    IF v_ticket_id IS NOT NULL THEN
      INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details)
      VALUES (v_advisor_name || ' (auto)', NULL, v_customer.id, 'ticket_status_changed', 'No atendido → En atención (automático, respondió el asesor)');
    END IF;
  END IF;

  v_effective_temp := COALESCE(
    v_customer.manual_status,
    CASE
      WHEN v_customer.purchase_frequency > 0 THEN 'pagado'
      WHEN EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = v_customer.id AND o.status = 'pendiente_pago') THEN 'caliente'
      WHEN EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.customer_id = v_customer.id AND o.status = 'carrito') THEN 'tibio'
      ELSE 'frio'
    END
  );
  v_rank := CASE v_effective_temp WHEN 'frio' THEN 0 WHEN 'tibio' THEN 1 WHEN 'caliente' THEN 2 ELSE 3 END;

  v_price := NULLIF(regexp_replace(substring(v_content from 'Q\.?\s?(\d{1,3}(?:,\d{3})*)'), ',', '', 'g'), '')::NUMERIC;

  IF v_rank < 2 AND v_content ~* '(m[eé]todo\s+de\s+pago|medio\s+de\s+pago|c[oó]mo\s+(vas\s+a|deseas|quieres|prefieres)\s+pagar|puedes?\s+pagar\s+(por|con)\s+(transferencia|dep[oó]sito|efectivo|tarjeta)|(link|enlace)\s+(de|para)\s+(el\s+)?pago|https?://|n[uú]mero\s+de\s+cuenta|completar\s+tu\s+env[ií]o|nit\s+o\s+dpi)' THEN
    v_new_status := 'caliente';
  END IF;

  IF v_new_status IS NULL AND v_rank < 2 THEN
    SELECT value INTO v_extra_phrases FROM app_settings WHERE key = 'extra_caliente_phrases';
    IF v_extra_phrases IS NOT NULL THEN
      FOR v_phrase IN SELECT jsonb_array_elements_text(v_extra_phrases) LOOP
        IF v_content ILIKE '%' || v_phrase || '%' THEN
          v_new_status := 'caliente';
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_new_status IS NULL AND v_rank < 1 AND v_price IS NOT NULL AND v_price BETWEEN 0 AND 10000 THEN
    v_new_status := 'tibio';
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE customers SET manual_status = v_new_status, updated_at = now() WHERE id = v_customer.id;

    INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details)
    VALUES (
      COALESCE(v_advisor_name, 'Automático') || ' (auto)',
      NULL,
      v_customer.id,
      'customer_status_changed',
      (CASE v_effective_temp
         WHEN 'frio' THEN 'Frío' WHEN 'tibio' THEN 'Tibio' WHEN 'caliente' THEN 'Caliente'
         WHEN 'pagado' THEN 'Pagado' WHEN 'pqrs' THEN 'PQRS' ELSE v_effective_temp END)
      || ' → ' ||
      (CASE v_new_status
         WHEN 'frio' THEN 'Frío' WHEN 'tibio' THEN 'Tibio' WHEN 'caliente' THEN 'Caliente'
         WHEN 'pagado' THEN 'Pagado' WHEN 'pqrs' THEN 'PQRS' ELSE v_new_status END)
      || ' (automático)'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

EOSQL
