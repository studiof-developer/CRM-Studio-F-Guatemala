-- Migration 006: Fix line session isolation, trigger cross-contamination, and clean up test ticket

-- 1. Add whatsapp_number_id to n8n_chat_histories
ALTER TABLE n8n_chat_histories ADD COLUMN IF NOT EXISTS whatsapp_number_id INT REFERENCES whatsapp_numbers(id);
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_line ON n8n_chat_histories(whatsapp_number_id);

-- 2. Update trigger update_customer_last_message to respect line isolation for difusion_enviada
CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_line_id INT;
  v_type TEXT := NEW.message->>'type';
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_preview TEXT := CASE WHEN v_content <> '' THEN v_content ELSE '📎 Adjunto' END;
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  -- Detect line ID
  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') IS NOT NULL THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id LIKE '%__line_%' THEN
    v_line_id := nullif(split_part(NEW.session_id, '__line_', 2), '')::int;
  END IF;

  UPDATE customers SET last_message_at = NEW.created_at, last_message = v_preview
  WHERE whatsapp_number = v_phone;

  IF v_type = 'human' THEN
    UPDATE customers SET
      last_customer_message_at = NEW.created_at,
      last_customer_message = v_preview,
      awaiting_reply = true,
      has_unread = true
    WHERE whatsapp_number = v_phone;

    -- Only reactivate difusion_enviada ticket for the matching line that received the message
    IF v_line_id IS NOT NULL THEN
      UPDATE tickets SET status = 'esperando_asesor', updated_at = now()
      WHERE status = 'difusion_enviada'
        AND whatsapp_number_id = v_line_id
        AND customer_id = (SELECT id FROM customers WHERE whatsapp_number = v_phone);
    ELSE
      -- Fallback for legacy line 1
      UPDATE tickets SET status = 'esperando_asesor', updated_at = now()
      WHERE status = 'difusion_enviada'
        AND (whatsapp_number_id = 1 OR whatsapp_number_id IS NULL)
        AND customer_id = (SELECT id FROM customers WHERE whatsapp_number = v_phone);
    END IF;
  ELSE
    UPDATE customers SET awaiting_reply = false WHERE whatsapp_number = v_phone;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Update trigger advance_pipeline_stage_from_advisor_message to respect line isolation
CREATE OR REPLACE FUNCTION advance_pipeline_stage_from_advisor_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_line_id INT;
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

  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') IS NOT NULL THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id LIKE '%__line_%' THEN
    v_line_id := nullif(split_part(NEW.session_id, '__line_', 2), '')::int;
  END IF;

  SELECT id, manual_status, paid_locked, purchase_frequency INTO v_customer
  FROM customers WHERE whatsapp_number = v_phone;
  IF NOT FOUND OR v_customer.paid_locked THEN
    RETURN NEW;
  END IF;

  v_advisor_name := NEW.message->'additional_kwargs'->>'advisorName';
  v_is_real_advisor := v_advisor_name IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE full_name = v_advisor_name);

  IF v_is_real_advisor THEN
    IF v_line_id IS NOT NULL THEN
      UPDATE tickets SET
        status = 'en_atencion',
        assigned_advisor = v_advisor_name,
        first_response_at = COALESCE(first_response_at, NEW.created_at),
        updated_at = now()
      WHERE customer_id = v_customer.id AND status != 'resuelto' AND assigned_advisor IS NULL AND whatsapp_number_id = v_line_id
      RETURNING id INTO v_ticket_id;
    ELSE
      UPDATE tickets SET
        status = 'en_atencion',
        assigned_advisor = v_advisor_name,
        first_response_at = COALESCE(first_response_at, NEW.created_at),
        updated_at = now()
      WHERE customer_id = v_customer.id AND status != 'resuelto' AND assigned_advisor IS NULL AND (whatsapp_number_id = 1 OR whatsapp_number_id IS NULL)
      RETURNING id INTO v_ticket_id;
    END IF;

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

  v_new_status := NULL;
  IF v_rank < 3 AND (
    v_content ~* '(transferencia|dep[oó]sito|tarjeta|link de pago|puedes pagar|cuenta bancaria|banco|boleta)'
    OR v_content ~* '(te comparto (el|los) datos? de pago|para realizar el pago)'
  ) THEN
    v_new_status := 'caliente';
  ELSIF v_rank < 2 AND (
    v_content ~* '(precio|cuesta|vale|total|cotizaci[oó]n|cat[aá]logo|disponible en talla|tallas?|colores?|env[ií]o)'
    OR (v_price IS NOT NULL AND v_price > 0)
  ) THEN
    v_new_status := 'tibio';
  END IF;

  SELECT value INTO v_extra_phrases FROM settings WHERE key = 'detection_extra_phrases';
  IF v_extra_phrases IS NOT NULL AND v_new_status IS NULL THEN
    FOR v_phrase IN SELECT jsonb_array_elements_text(COALESCE(v_extra_phrases->'caliente', '[]'::jsonb))
    LOOP
      IF v_rank < 3 AND v_content ILIKE '%' || v_phrase || '%' THEN
        v_new_status := 'caliente';
        EXIT;
      END IF;
    END LOOP;
    IF v_new_status IS NULL THEN
      FOR v_phrase IN SELECT jsonb_array_elements_text(COALESCE(v_extra_phrases->'tibio', '[]'::jsonb))
      LOOP
        IF v_rank < 2 AND v_content ILIKE '%' || v_phrase || '%' THEN
          v_new_status := 'tibio';
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE customers SET manual_status = v_new_status, updated_at = now()
    WHERE id = v_customer.id;
    INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details)
    VALUES (
      COALESCE(v_advisor_name, 'Sistema') || ' (auto)',
      NULL,
      v_customer.id,
      'customer_temperature_changed',
      v_effective_temp || ' → ' || v_new_status || ' (automático por mensaje del asesor: "' || left(v_content, 80) || '")'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Clean up test ticket and messages for Juan David Viveros (573151045201)
-- Reset Studio F ticket (line 1) back to difusion_enviada so Aura's pipeline is clean
UPDATE tickets
SET status = 'difusion_enviada', updated_at = now()
WHERE customer_id = (SELECT id FROM customers WHERE whatsapp_number = '573151045201')
  AND (whatsapp_number_id = 1 OR whatsapp_number_id IS NULL)
  AND status = 'esperando_asesor';

-- Ensure Basshert ticket (line 2) for Juan David Viveros is correctly set
UPDATE tickets
SET whatsapp_number_id = 2
WHERE customer_id = (SELECT id FROM customers WHERE whatsapp_number = '573151045201')
  AND status != 'difusion_enviada'
  AND (whatsapp_number_id = 2 OR whatsapp_number_id IS NULL);

-- Backfill whatsapp_number_id on legacy n8n_chat_histories to 1 (Studio F Virtual)
UPDATE n8n_chat_histories
SET whatsapp_number_id = 1
WHERE whatsapp_number_id IS NULL;

-- Isolate today's test messages for 573151045201 to Basshert (Line 2)
UPDATE n8n_chat_histories
SET whatsapp_number_id = 2,
    session_id = '573151045201__line_2',
    message = jsonb_set(message, '{additional_kwargs,whatsappNumberId}', '2'::jsonb)
WHERE session_id LIKE '573151045201%'
  AND created_at >= '2026-09-25 00:00:00+00'
  AND (message->>'type' = 'human' OR (message->'additional_kwargs'->>'sentBy') = 'advisor');
