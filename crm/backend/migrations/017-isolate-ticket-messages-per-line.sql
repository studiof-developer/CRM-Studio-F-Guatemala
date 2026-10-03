-- Migration 017: Isolate ticket messages, activity and dormancy strictly per WhatsApp line
-- Prevents messages on Line 2 (Basshert) from reviving or contaminating Line 1 (Studio F) tickets

-- 1. Add line-scoped activity columns to tickets table
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_message TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_customer_message_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_customer_message TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS awaiting_reply BOOLEAN DEFAULT false;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS has_unread BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tickets_line_last_msg_at ON tickets(whatsapp_number_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_line_last_cust_msg_at ON tickets(whatsapp_number_id, last_customer_message_at DESC);

-- 2. Backfill tickets with line-isolated last messages from n8n_chat_histories
WITH latest_per_ticket AS (
  SELECT DISTINCT ON (t.id)
    t.id AS ticket_id,
    h.created_at AS last_message_at,
    substring(coalesce(h.message->>'content', '📎 Adjunto') FROM 1 FOR 255) AS last_message,
    h.created_at AS last_customer_message_at,
    substring(coalesce(h.message->>'content', '📎 Adjunto') FROM 1 FOR 255) AS last_customer_message
  FROM tickets t
  JOIN customers c ON c.id = t.customer_id
  JOIN n8n_chat_histories h ON (
    (
      -- Line 2 (Basshert) matches only Line 2 messages
      t.whatsapp_number_id = 2 AND (h.session_id LIKE c.whatsapp_number || '__line_2%' OR h.whatsapp_number_id = 2)
    ) OR (
      -- Line 1 (Studio F) matches Line 1 or legacy messages (excluding Line 2)
      (t.whatsapp_number_id = 1 OR t.whatsapp_number_id IS NULL)
      AND (
        h.session_id LIKE c.whatsapp_number || '__line_1%'
        OR (h.session_id LIKE c.whatsapp_number || '%' AND h.session_id NOT LIKE '%__line_2%' AND (h.whatsapp_number_id IS NULL OR h.whatsapp_number_id = 1))
      )
    )
  )
  WHERE h.message->>'type' IN ('human', 'ai')
    AND (
      coalesce(h.message->>'content', '') <> ''
      OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = h.id)
    )
  ORDER BY t.id, h.id DESC
)
UPDATE tickets t
SET
  last_message = lpt.last_message,
  last_message_at = lpt.last_message_at,
  last_customer_message_at = lpt.last_customer_message_at,
  last_customer_message = lpt.last_customer_message
FROM latest_per_ticket lpt
WHERE t.id = lpt.ticket_id;

-- 3. Replace set_customer_last_message trigger to update ONLY the ticket for the line that received/sent the message
CREATE OR REPLACE FUNCTION set_customer_last_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_preview TEXT := substring(coalesce(NEW.message->>'content', '') FROM 1 FOR 255);
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

  IF v_preview = '' THEN
    v_preview := '📎 Adjunto';
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
  -- Crucial: Tickets of other lines are NEVER updated by this message!
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

-- 4. Replace advance_pipeline_stage_from_advisor_message trigger to update ONLY tickets of the matching line
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
      last_message = substring(v_content FROM 1 FOR 255),
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
