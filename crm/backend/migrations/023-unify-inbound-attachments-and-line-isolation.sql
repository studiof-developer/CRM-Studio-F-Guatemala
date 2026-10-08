-- Migration 023: Unify inbound attachments, enforce line isolation and fix customer ticket duplicates
-- 1. Update update_customer_last_message trigger to safely detect line ID, backfill NEW row columns,
--    and update ONLY the matching ticket for the customer.
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

  -- 1. Detect line ID safely
  v_line_id := NEW.whatsapp_number_id;
  IF v_line_id IS NULL AND (NEW.message->'additional_kwargs'->>'whatsappNumberId') ~ '^[0-9]+$' THEN
    v_line_id := (NEW.message->'additional_kwargs'->>'whatsappNumberId')::int;
  END IF;
  IF v_line_id IS NULL AND NEW.session_id ~ '__line_[0-9]+' THEN
    v_line_id := (regexp_match(NEW.session_id, '__line_([0-9]+)'))[1]::int;
  END IF;

  -- If still null, resolve from the customer's active open ticket
  IF v_line_id IS NULL AND v_customer_id IS NOT NULL THEN
    SELECT t.whatsapp_number_id INTO v_line_id
    FROM tickets t
    WHERE t.customer_id = v_customer_id
      AND t.status != 'resuelto'
      AND t.whatsapp_number_id IS NOT NULL
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT 1;
  END IF;

  -- If still null, resolve from customer's most recent message with a line
  IF v_line_id IS NULL THEN
    SELECT whatsapp_number_id INTO v_line_id
    FROM n8n_chat_histories
    WHERE (session_id = v_phone OR session_id LIKE v_phone || '__%')
      AND whatsapp_number_id IS NOT NULL
    ORDER BY id DESC LIMIT 1;
  END IF;

  -- If still null, fall back to first active WhatsApp number
  IF v_line_id IS NULL THEN
    SELECT id INTO v_line_id FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1;
  END IF;
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
    SELECT t.whatsapp_number_id INTO v_line_id
    FROM tickets t
    JOIN customers c ON c.id = t.customer_id
    WHERE c.whatsapp_number = v_phone AND t.status != 'resuelto' AND t.whatsapp_number_id IS NOT NULL
    ORDER BY t.updated_at DESC, t.id DESC LIMIT 1;
  END IF;
  IF v_line_id IS NULL THEN
    SELECT id INTO v_line_id FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1;
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

-- 3. Backfill whatsapp_number_id for n8n_chat_histories rows that carry line in session_id
UPDATE n8n_chat_histories
SET whatsapp_number_id = (regexp_match(session_id, '__line_([0-9]+)'))[1]::int
WHERE whatsapp_number_id IS NULL AND session_id ~ '__line_[0-9]+';

-- 4. Repair Carolina Dávila (50237558506) and any split messages / duplicate tickets
DO $$
DECLARE
  v_cd_id INT;
  v_studio_line INT;
BEGIN
  SELECT id INTO v_cd_id FROM customers WHERE whatsapp_number = '50237558506';
  IF v_cd_id IS NOT NULL THEN
    -- Find Studio F line ID
    SELECT wn.id INTO v_studio_line
    FROM whatsapp_numbers wn
    WHERE wn.label ILIKE '%Studio F%' OR wn.verified_name ILIKE '%Studio F%'
    ORDER BY wn.id ASC LIMIT 1;

    IF v_studio_line IS NULL THEN
      -- Fallback to the line of Carolina's non-Zacapa ticket
      SELECT t.whatsapp_number_id INTO v_studio_line
      FROM tickets t
      LEFT JOIN whatsapp_numbers wn ON wn.id = t.whatsapp_number_id
      LEFT JOIN branches br ON br.id = wn.branch_id
      WHERE t.customer_id = v_cd_id AND (br.name IS NULL OR br.name NOT ILIKE '%Zacapa%')
      ORDER BY t.created_at DESC LIMIT 1;
    END IF;

    IF v_studio_line IS NOT NULL THEN
      -- Reassign all messages for Carolina Dávila to Studio F line
      UPDATE n8n_chat_histories
      SET whatsapp_number_id = v_studio_line,
          session_id = '50237558506__line_' || v_studio_line::text,
          message = jsonb_set(
            COALESCE(message, '{}'::jsonb),
            '{additional_kwargs,whatsappNumberId}',
            to_jsonb(v_studio_line)
          )
      WHERE session_id = '50237558506'
         OR session_id LIKE '50237558506__%';

      -- Close any other duplicate open ticket for Carolina Dávila (e.g. Basshert / Zacapa)
      UPDATE tickets
      SET status = 'resuelto',
          handoff_reason = 'unificado_en_linea_principal',
          updated_at = now()
      WHERE customer_id = v_cd_id
        AND whatsapp_number_id <> v_studio_line
        AND status <> 'resuelto';

      -- Update Carolina's Studio F ticket with the latest message and unread / awaiting state
      UPDATE tickets
      SET last_message = '📎 Adjunto',
          last_customer_message = '📎 Adjunto',
          awaiting_reply = true,
          has_unread = true,
          updated_at = now()
      WHERE customer_id = v_cd_id
        AND whatsapp_number_id = v_studio_line
        AND status <> 'resuelto';
    END IF;
  END IF;
END $$;
