#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Same trigger as 033, plus an access_audit row whenever it actually advances a
-- customer — the automatic advance was invisible in the audit trail before this,
-- even though the manual version (customers.js's PATCH /:id/tags) already logs one.
-- actor_user_id stays NULL (no logged-in request here, just a DB trigger reacting to
-- a chat insert) — the advisor's name, read straight off the message that triggered
-- it (additional_kwargs.advisorName, set wherever an advisor sends a message), is
-- what actually identifies who said the thing that caused the move.
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
BEGIN
  IF NEW.message->>'type' <> 'ai' OR (NEW.message->'additional_kwargs'->>'sentBy') <> 'advisor' THEN
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

  v_price := NULLIF(substring(v_content from 'Q\s?(\d{1,5})'), '')::NUMERIC;

  IF v_rank < 2 AND v_content ~* '(m[eé]todo\s+de\s+pago|medio\s+de\s+pago|c[oó]mo\s+(vas\s+a|deseas|quieres|prefieres)\s+pagar|(link|enlace)\s+(de|para)\s+(el\s+)?pago|completar\s+tu\s+env[ií]o|nit\s+o\s+dpi)' THEN
    v_new_status := 'caliente';
  ELSIF v_rank < 1 AND v_price IS NOT NULL AND v_price BETWEEN 0 AND 10000 THEN
    v_new_status := 'tibio';
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE customers SET manual_status = v_new_status, updated_at = now() WHERE id = v_customer.id;

    v_advisor_name := NEW.message->'additional_kwargs'->>'advisorName';
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
