-- Migration 025: Strict line isolation to prevent cross-line message leaks between Studio F and Basshert
-- Fixes bug where inbound messages without explicit line ID were guessing line from other lines' tickets.

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

  SELECT id INTO v_customer_id FROM customers WHERE whatsapp_number = v_phone;

  -- 1. Detect line ID strictly from message data
  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') ~ '^[0-9]+$' THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id ~ '__line_[0-9]+' THEN
    v_line_id := (regexp_match(NEW.session_id, '__line_([0-9]+)'))[1]::int;
  END IF;

  -- If still null, it came from n8n (bare phone session_id / no line provided), which is exclusively Line 1 (Studio F Virtual).
  -- NEVER guess line_id from tickets or previous messages of another line!
  IF v_line_id IS NULL THEN
    v_line_id := 1;
  END IF;

  -- Enforce line_id and line session_id on the NEW row before insert
  NEW.whatsapp_number_id := v_line_id;
  IF NEW.session_id !~ '__line_[0-9]+' THEN
    NEW.session_id := v_phone || '__line_' || v_line_id;
  END IF;
  IF (NEW.message->'additional_kwargs'->>'whatsappNumberId') IS NULL THEN
    NEW.message := jsonb_set(
      COALESCE(NEW.message, '{}'::jsonb),
      '{additional_kwargs,whatsappNumberId}',
      to_jsonb(v_line_id)
    );
  END IF;

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

  -- If customer sent a human message and has NO open ticket for THIS specific line,
  -- create an open ticket for this line so it shows up in the right queue and never borrows another line's ticket.
  IF v_type = 'human' AND NOT FOUND THEN
    INSERT INTO tickets (customer_id, whatsapp_number_id, status, handoff_reason, last_message, last_message_at, last_customer_message_at, last_customer_message, awaiting_reply, has_unread)
    VALUES (v_customer_id, v_line_id, 'esperando_asesor', 'mensaje_entrante_whatsapp', v_preview, NEW.created_at, NEW.created_at, v_preview, true, true);
  END IF;

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

CREATE OR REPLACE FUNCTION set_customer_last_message() RETURNS TRIGGER AS $$
BEGIN
  RETURN update_customer_last_message();
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_customer_last_message ON n8n_chat_histories;
CREATE TRIGGER trg_update_customer_last_message
BEFORE INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION update_customer_last_message();

-- 2. Update advance_pipeline_stage_from_advisor_message trigger
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

-- 3. Remap misattributed message from Luisa (573007387004) from today back to Studio F Virtual (Line 1)
UPDATE n8n_chat_histories
SET session_id = '573007387004__line_1',
    whatsapp_number_id = 1,
    message = jsonb_set(message, '{additional_kwargs,whatsappNumberId}', '1'::jsonb)
WHERE (session_id = '573007387004' OR session_id LIKE '573007387004__%')
  AND created_at >= '2026-10-09 00:00:00Z'
  AND message->>'type' = 'human';

-- Ensure Studio F has an open ticket for Luisa (573007387004)
INSERT INTO tickets (customer_id, whatsapp_number_id, status, handoff_reason, last_message, last_message_at, last_customer_message_at, last_customer_message, awaiting_reply, has_unread)
SELECT c.id, 1, 'esperando_asesor', 'mensaje_entrante_whatsapp', 'hola', now(), now(), 'hola', true, true
FROM customers c
WHERE c.whatsapp_number = '573007387004'
  AND NOT EXISTS (
    SELECT 1 FROM tickets t
    WHERE t.customer_id = c.id
      AND (t.whatsapp_number_id = 1 OR t.whatsapp_number_id IS NULL)
      AND t.status != 'resuelto'
  );
