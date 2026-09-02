#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Auto-advances a customer's pipeline stage from what the ADVISOR says in the chat —
-- sends a price -> Cotización (tibio), asks for a payment method -> Medio de pago
-- (caliente). Deliberately different from the payment-suggestion feature (032): this
-- one writes manual_status directly instead of just flagging a suggestion, because
-- every direction here is SAFE to automate outright:
--   - advance-only: it never moves a customer DOWN the ladder (frio < tibio < caliente
--     < pagado/pqrs), so a later, unrelated price mention can't undo real progress an
--     advisor already made, and it can never fight with or override an advisor's own
--     manual pick once they've moved someone at least that far.
--   - pagado/pqrs are always left alone — those stay advisor-only/terminal, same as the
--     rest of the app already treats them.
--   - reversible either way: unlike marking Paid, an advisor can just drag the card (or
--     change the Estado dropdown) if this ever gets it wrong — nothing here is
--     permanent, which is why this one runs automatically instead of asking first
--     (032's payment flag stays suggest-only, since that ONE action is irreversible).
--
-- The "current stage" ladder is recomputed here from the same rule TEMPERATURE_SQL uses
-- in customers.js (purchase_frequency / orders) — a DB trigger can't import that JS, so
-- if that logic ever changes, this needs to change with it.
CREATE OR REPLACE FUNCTION advance_pipeline_stage_from_advisor_message() RETURNS TRIGGER AS $$
DECLARE
  v_phone TEXT;
  v_content TEXT := coalesce(NEW.message->>'content', '');
  v_customer RECORD;
  v_effective_temp TEXT;
  v_rank INT;
  v_new_status TEXT;
  v_price NUMERIC;
BEGIN
  -- Only the advisor's own outgoing messages count — the bot quoting a price or asking
  -- for payment is routine mid-conversation text, not a real stage change.
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
    RETURN NEW; -- no customer record yet, or already Pagado — never touched either way
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
  v_rank := CASE v_effective_temp WHEN 'frio' THEN 0 WHEN 'tibio' THEN 1 WHEN 'caliente' THEN 2 ELSE 3 END; -- pagado/pqrs/anything else = 3, hands off

  -- Captures just the digits after "Q" (substring's first parenthesized group) and
  -- range-checks them — "Q" can show up glued to something that isn't really a garment
  -- price (an order code, a stray fragment), so this only counts it as a real quote when
  -- the number falls in the range a clothing item actually sells for.
  v_price := NULLIF(substring(v_content from 'Q\s?(\d{1,5})\b'), '')::NUMERIC;

  -- Checked highest-first so a single message hitting both patterns (rare, but a
  -- message can quote a price AND ask how they want to pay) lands on the higher stage
  -- in one step instead of needing a second message to get there.
  IF v_rank < 2 AND v_content ~* '(m[eé]todo\s+de\s+pago|medio\s+de\s+pago|c[oó]mo\s+(vas\s+a|deseas|quieres|prefieres)\s+pagar|(link|enlace)\s+(de|para)\s+(el\s+)?pago)' THEN
    v_new_status := 'caliente';
  ELSIF v_rank < 1 AND v_price IS NOT NULL AND v_price BETWEEN 0 AND 10000 THEN
    v_new_status := 'tibio';
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE customers SET manual_status = v_new_status, updated_at = now() WHERE id = v_customer.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_advance_pipeline_stage ON n8n_chat_histories;
CREATE TRIGGER trg_advance_pipeline_stage
AFTER INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION advance_pipeline_stage_from_advisor_message();

EOSQL
