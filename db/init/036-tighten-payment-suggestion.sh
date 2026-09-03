#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Narrows the text-side "customer might have paid" signal (032) — reported 2026-09-03:
-- it fired on messages that only ASKED about payment or just named the method they'd
-- use, not ones actually confirming it happened. Two fixes:
--   - drops the bare "transferencia"/"depósito"/"comprobante" nouns: a customer
--     answering "¿cómo vas a pagar?" with a one-word "Transferencia" is choosing a
--     method, not confirming a completed payment, and "comprobante" alone matches
--     "¿piden comprobante?" just as easily as "aquí está el comprobante" — comprobante
--     now only counts paired with a sending/pointing verb or "de pago/transferencia/depósito".
--   - skips anything phrased as a question outright (a trailing "?") — a real
--     confirmation is a statement, not a question, on either side of the chat.
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
  IF v_type = 'ai' AND NOT v_from_advisor THEN
    RETURN NEW;
  END IF;
  -- A question is never a confirmation, from either side of the chat.
  IF v_content ~ '\?' THEN
    RETURN NEW;
  END IF;

  IF v_type = 'human' THEN
    IF v_content !~* '(ya\s+\w+\s+(el|la)\s+(pago|transferencia|dep[oó]sito)|ya\s+(pagu[eé]|deposit[eé]|transfer[ií])|(te\s+)?(env[ií][eé]|mand[eé])\s+(el\s+)?comprobante|(aqu[ií]|ah[ií])\s+(est[aá]|tienes|va)\s+(el\s+)?comprobante|comprobante\s+de\s+(pago|transferencia|dep[oó]sito)|pago\s+(realizado|hecho)|(ya\s+)?(esta|está)\s+pagado|listo\s+el\s+pago)' THEN
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

EOSQL
