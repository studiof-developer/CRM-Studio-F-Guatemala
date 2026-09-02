#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Surfaces a "this customer might have paid" flag for the advisor to confirm with one
-- click — never sets paid_locked itself. That stays a deliberate, one-way action taken
-- from the UI (see customers.js PATCH /:id/tags), since a wrong auto-mark here would be
-- permanent. Cleared the moment an advisor acts on it either way (confirms or dismisses
-- it — same route).
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_suggested_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_suggestion_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_suggestion_method TEXT;

-- Same phone-from-session_id / AFTER INSERT ON n8n_chat_histories pattern as
-- update_customer_last_message() (031) — a separate trigger function since this is a
-- different concern, not an extension of that one. Covers two of the three signals
-- requested; the third (a customer photo, likely a receipt) is flagged from Node in
-- attachments.js's inbound route instead, since that's where inbound media already
-- passes through backend code (n8n writes plain text straight into Postgres with no
-- Node hook to attach to, but media goes through our own /api/attachments/inbound).
CREATE OR REPLACE FUNCTION flag_payment_suggestion() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_type TEXT := NEW.message->>'type';
  v_from_advisor BOOLEAN := (NEW.message->'additional_kwargs'->>'sentBy') = 'advisor';
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_reason TEXT;
  v_method TEXT;
BEGIN
  IF v_type NOT IN ('human', 'ai') THEN
    RETURN NEW;
  END IF;
  -- The bot's own replies never signal a real payment — only an advisor confirming it.
  IF v_type = 'ai' AND NOT v_from_advisor THEN
    RETURN NEW;
  END IF;

  IF v_type = 'human' THEN
    -- Broader than just "ya transferí" glued together — real messages are "ya hice la
    -- transferencia", "ya realicé el pago", etc., so the verb and the "ya" don't have to
    -- be adjacent, and the payment-method nouns (transferencia/depósito) alone are
    -- enough too, not just their verb forms.
    IF v_content !~* '(ya\s+\w+\s+(el|la)\s+(pago|transferencia|dep[oó]sito)|ya\s+(pagu[eé]|deposit[eé]|transfer[ií])|transferencia|dep[oó]sito|comprobante|pago\s+(realizado|hecho)|(ya\s+)?(esta|está)\s+pagado|listo\s+el\s+pago)' THEN
      RETURN NEW;
    END IF;
    v_reason := 'El cliente escribió: "' || left(v_content, 120) || '"';
  ELSE
    IF v_content !~* '(pago\s+(confirmado|recibido)|confirm(amos|o)\s+tu\s+pago|recib(imos|ido)\s+(tu\s+)?pago|vimos\s+tu\s+pago)' THEN
      RETURN NEW;
    END IF;
    v_reason := 'El asesor confirmó el pago en el chat: "' || left(v_content, 120) || '"';
  END IF;

  v_method := CASE
    WHEN v_content ~* 'transfer' THEN 'transferencia'
    WHEN v_content ~* 'deposit' THEN 'deposito'
    WHEN v_content ~* 'efectivo' THEN 'efectivo'
    WHEN v_content ~* 'tarjeta' THEN 'tarjeta'
    ELSE NULL
  END;

  v_phone := split_part(NEW.session_id, '__', 1);
  IF v_phone !~ '^\d{7,15}$' THEN
    RETURN NEW;
  END IF;

  UPDATE customers SET
    payment_suggested_at = NEW.created_at,
    payment_suggestion_reason = v_reason,
    payment_suggestion_method = v_method
  WHERE whatsapp_number = v_phone AND paid_locked = false;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_flag_payment_suggestion ON n8n_chat_histories;
CREATE TRIGGER trg_flag_payment_suggestion
AFTER INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION flag_payment_suggestion();

EOSQL
