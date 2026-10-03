-- Migration 018: Clean up Line 2 false last_messages, ensure lightning-fast triggers and clean unread counts

-- 1. Reset corrupted last_message on Line 2 tickets so they don't share Débora's "Gracias"
UPDATE tickets
SET
  last_message = NULL,
  last_message_at = NULL,
  last_customer_message = NULL,
  last_customer_message_at = NULL,
  has_unread = false
WHERE whatsapp_number_id = 2;

-- 2. Ensure update_customer_last_message trigger isolates updates strictly per line and phone
CREATE OR REPLACE FUNCTION update_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_preview TEXT := CASE WHEN v_content <> '' THEN substring(v_content FROM 1 FOR 255) ELSE '📎 Adjunto' END;
  v_line_id INT;
  v_customer_id INT;
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  -- Detect line ID safely
  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') ~ '^[0-9]+$' THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id ~ '__line_[0-9]+' THEN
    v_line_id := (regexp_match(NEW.session_id, '__line_([0-9]+)'))[1]::int;
  END IF;
  IF v_line_id IS NULL THEN
    v_line_id := 1;
  END IF;

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = v_phone;
  IF v_customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Update ONLY the ticket for THIS line (v_line_id)
  UPDATE tickets SET
    last_message = v_preview,
    last_message_at = NEW.created_at,
    last_customer_message_at = CASE WHEN v_type = 'human' THEN NEW.created_at ELSE last_customer_message_at END,
    last_customer_message = CASE WHEN v_type = 'human' THEN v_preview ELSE last_customer_message END,
    awaiting_reply = CASE WHEN v_type = 'human' THEN true ELSE false END,
    has_unread = CASE WHEN v_type = 'human' THEN true ELSE has_unread END,
    status = CASE WHEN v_type = 'human' AND status = 'difusion_enviada' THEN 'esperando_asesor' ELSE status END,
    updated_at = now()
  WHERE customer_id = v_customer_id
    AND (whatsapp_number_id = v_line_id OR (v_line_id = 1 AND whatsapp_number_id IS NULL))
    AND status != 'resuelto';

  -- Update customer fallback record
  UPDATE customers SET
    last_message_at = NEW.created_at,
    last_message = v_preview,
    last_customer_message_at = CASE WHEN v_type = 'human' THEN NEW.created_at ELSE last_customer_message_at END,
    last_customer_message = CASE WHEN v_type = 'human' THEN v_preview ELSE last_customer_message END,
    awaiting_reply = CASE WHEN v_type = 'human' THEN true ELSE false END
  WHERE id = v_customer_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Synonym in case referenced elsewhere
CREATE OR REPLACE FUNCTION set_customer_last_message() RETURNS TRIGGER AS $$
BEGIN
  RETURN update_customer_last_message();
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_customer_last_message ON n8n_chat_histories;
CREATE TRIGGER trg_update_customer_last_message
BEFORE INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION update_customer_last_message();

-- 3. Ensure advance_pipeline_stage_from_advisor_message trigger updates ONLY tickets of the matching line
CREATE OR REPLACE FUNCTION advance_pipeline_stage_from_advisor_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_line_id INT;
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_preview TEXT := CASE WHEN v_content <> '' THEN substring(v_content FROM 1 FOR 255) ELSE '📎 Adjunto' END;
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
  IF v_line_id IS NULL THEN
    v_line_id := 1;
  END IF;

  SELECT id, manual_status, paid_locked, purchase_frequency INTO v_customer
  FROM customers WHERE whatsapp_number = v_phone;
  IF NOT FOUND OR v_customer.paid_locked THEN
    RETURN NEW;
  END IF;

  v_advisor_name := NEW.message->'additional_kwargs'->>'advisorName';
  v_is_real_advisor := v_advisor_name IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE full_name = v_advisor_name);

  IF v_is_real_advisor THEN
    UPDATE tickets SET
      status = 'en_atencion',
      assigned_advisor = v_advisor_name,
      first_response_at = COALESCE(first_response_at, now()),
      last_message = v_preview,
      last_message_at = NEW.created_at,
      awaiting_reply = false,
      updated_at = now()
    WHERE customer_id = v_customer.id
      AND status IN ('esperando_asesor', 'difusion_enviada')
      AND (whatsapp_number_id = v_line_id OR (v_line_id = 1 AND whatsapp_number_id IS NULL));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_advance_pipeline_stage ON n8n_chat_histories;
CREATE TRIGGER trg_advance_pipeline_stage
BEFORE INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION advance_pipeline_stage_from_advisor_message();
