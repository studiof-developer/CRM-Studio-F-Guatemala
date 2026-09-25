-- Migration 007: Fix triggers to safely extract line ID from session_id
-- Prevents integer casting error when session_id contains suffix like __line_2__Postgres_Chat_Memory

CREATE OR REPLACE FUNCTION set_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_preview TEXT := substring(coalesce(NEW.message->>'content', '') FROM 1 FOR 255);
  v_line_id INT;
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  -- Detect line ID safely without integer casting errors
  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') ~ '^[0-9]+$' THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id ~ '__line_[0-9]+' THEN
    v_line_id := (regexp_match(NEW.session_id, '__line_([0-9]+)'))[1]::int;
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

    IF v_line_id IS NOT NULL THEN
      UPDATE tickets SET status = 'esperando_asesor', updated_at = now()
      WHERE status = 'difusion_enviada'
        AND whatsapp_number_id = v_line_id
        AND customer_id = (SELECT id FROM customers WHERE whatsapp_number = v_phone);
    ELSE
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

CREATE OR REPLACE FUNCTION advance_pipeline_stage_from_advisor_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_line_id INT;
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_customer RECORD;
  v_advisor_name TEXT;
  v_is_real_advisor BOOLEAN;
BEGIN
  IF NEW.message->>'type' <> 'ai' OR (NEW.message->'additional_kwargs'->>'sentBy') IS DISTINCT FROM 'advisor' THEN
    RETURN NEW;
  END IF;

  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') ~ '^[0-9]+$' THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id ~ '__line_[0-9]+' THEN
    v_line_id := (regexp_match(NEW.session_id, '__line_([0-9]+)'))[1]::int;
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
        first_response_at = COALESCE(first_response_at, now()),
        updated_at = now()
      WHERE customer_id = v_customer.id
        AND status IN ('esperando_asesor', 'difusion_enviada')
        AND whatsapp_number_id = v_line_id;
    ELSE
      UPDATE tickets SET
        status = 'en_atencion',
        assigned_advisor = v_advisor_name,
        first_response_at = COALESCE(first_response_at, now()),
        updated_at = now()
      WHERE customer_id = v_customer.id
        AND status IN ('esperando_asesor', 'difusion_enviada')
        AND (whatsapp_number_id = 1 OR whatsapp_number_id IS NULL);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
