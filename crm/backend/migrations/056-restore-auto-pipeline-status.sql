-- 056: recupera el avance automático de estado (Frío → Tibio → Caliente) y lo extiende a Instagram y Messenger.
-- Por qué dejó de funcionar: la función advance_pipeline_stage_from_advisor_message se redefinió en las migraciones 007, 017, 018, 023 y 025 (aislamiento por
-- línea) con una versión que solo "toma" el ticket y ya no mueve el estado del cliente. Tampoco había nada para las redes: los mensajes de las asesoras en
-- Instagram/Messenger viven en social_messages, no en n8n_chat_histories, así que ningún disparador los veía.
-- Reglas (las mismas de siempre): un precio en el mensaje de la asesora (hasta Q10,000) → Tibio; medios de pago (cuenta, banco, link de pago…) → Caliente;
-- una cotización guardada en el Cotizador → Tibio. Solo sube: nunca baja un estado, ni toca a quien ya pagó (Pagado / Por despacho / PQRS).

-- Sube al cliente a un estado, si todavía no lo alcanzó. Devuelve el estado nuevo o NULL si no cambió nada.
CREATE OR REPLACE FUNCTION raise_customer_status(p_customer_id INT, p_target TEXT, p_actor TEXT) RETURNS TEXT AS $$
DECLARE
  v_c RECORD;
  v_eff TEXT;
  v_rank INT;
  v_target_rank INT := CASE p_target WHEN 'tibio' THEN 1 WHEN 'caliente' THEN 2 ELSE 99 END;
  v_label JSONB := '{"frio":"Frío","tibio":"Tibio","caliente":"Caliente","pagado":"Pagado","despacho":"Por despacho","pqrs":"PQRS"}';
BEGIN
  IF v_target_rank > 2 THEN RETURN NULL; END IF;
  SELECT id, manual_status, paid_locked, purchase_frequency INTO v_c FROM customers WHERE id = p_customer_id;
  IF NOT FOUND OR v_c.paid_locked THEN RETURN NULL; END IF;
  v_eff := COALESCE(v_c.manual_status, CASE
    WHEN v_c.purchase_frequency > 0 THEN 'pagado'
    WHEN EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = v_c.id AND o.status = 'pendiente_pago') THEN 'caliente'
    WHEN EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.customer_id = v_c.id AND o.status = 'carrito') THEN 'tibio'
    ELSE 'frio' END);
  v_rank := CASE v_eff WHEN 'frio' THEN 0 WHEN 'tibio' THEN 1 WHEN 'caliente' THEN 2 ELSE 3 END;
  IF v_rank >= v_target_rank THEN RETURN NULL; END IF;
  UPDATE customers SET manual_status = p_target, updated_at = now() WHERE id = v_c.id;
  INSERT INTO access_audit (actor, actor_user_id, customer_id, action, details)
  VALUES (COALESCE(p_actor, 'Automático') || ' (auto)', NULL, v_c.id, 'customer_status_changed',
          (v_label->>v_eff) || ' → ' || (v_label->>p_target) || ' (automático)');
  RETURN p_target;
END;
$$ LANGUAGE plpgsql;

-- Lee lo que escribió la asesora: medios de pago → Caliente; un precio en quetzales → Tibio.
CREATE OR REPLACE FUNCTION promote_customer_from_advisor_text(p_customer_id INT, p_content TEXT, p_actor TEXT) RETURNS TEXT AS $$
DECLARE
  v_up TEXT := upper(COALESCE(p_content, ''));
  v_price NUMERIC;
  v_extra JSONB;
  v_phrase TEXT;
  v_target TEXT;
BEGIN
  IF COALESCE(p_content, '') = '' THEN RETURN NULL; END IF;

  -- preguntar "cómo quiere pagar" o prometer un link NO cuenta (reporte del 16/17 de septiembre): solo entregar la información.
  IF p_content ~* '(m[eé]todos?\s+de\s+pago|medios?\s+de\s+pago|puedes?\s+pagar\s+(por|con)\s+(transferencia|dep[oó]sito|efectivo|tarjeta)|https?://\S*(neolink|pay|pago)|n[uú]mero\s+de\s+cuenta|cuenta\s+(monetaria|de\s+ahorros?|corriente)|banrural|banco\s+industrial|\mbac\M|neolink|a\s+nombre\s+de|completar\s+tu\s+env[ií]o|nit\s+o\s+dpi)' THEN
    v_target := 'caliente';
  END IF;

  IF v_target IS NULL THEN
    SELECT value INTO v_extra FROM app_settings WHERE key = 'extra_caliente_phrases';
    IF v_extra IS NOT NULL THEN
      FOR v_phrase IN SELECT jsonb_array_elements_text(v_extra) LOOP
        IF p_content ILIKE '%' || v_phrase || '%' THEN v_target := 'caliente'; EXIT; END IF;
      END LOOP;
    END IF;
  END IF;

  IF v_target IS NULL THEN
    -- Q349 · Q 349 · Q.349 · Q1,099 · Q1099 · 349 quetzales · 349Q
    v_price := NULLIF(regexp_replace(COALESCE(
      substring(v_up from '(?:Q|GTQ)\.?\s?(\d{1,3}(?:,\d{3})+|\d{1,5})'),
      substring(v_up from '(\d{1,3}(?:,\d{3})+|\d{2,5})(?:\.\d{1,2})?\s?(?:QUETZALES|Q\M)')), ',', '', 'g'), '')::NUMERIC;
    IF v_price IS NOT NULL AND v_price BETWEEN 1 AND 10000 THEN v_target := 'tibio'; END IF;
  END IF;

  IF v_target IS NULL THEN RETURN NULL; END IF;
  RETURN raise_customer_status(p_customer_id, v_target, p_actor);
END;
$$ LANGUAGE plpgsql;

-- WhatsApp: la misma lógica de toma del ticket de la migración 025 (por línea) más el avance de estado. Una falla al clasificar nunca debe
-- impedir que el mensaje se guarde.
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

  -- difusiones y plantillas llevan precios y links de campaña: no son una cotización ni medios de pago
  IF (NEW.message->'additional_kwargs'->>'campaignId') IS NULL AND (NEW.message->'additional_kwargs'->>'template') IS NULL THEN
    BEGIN
      PERFORM promote_customer_from_advisor_text(v_customer.id, v_content, v_advisor_name);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'promote_customer_from_advisor_text: %', SQLERRM;
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_advance_pipeline_stage ON n8n_chat_histories;
CREATE TRIGGER trg_advance_pipeline_stage
BEFORE INSERT ON n8n_chat_histories
FOR EACH ROW EXECUTE FUNCTION advance_pipeline_stage_from_advisor_message();

-- Instagram y Messenger: lo que escribe la asesora queda en social_messages.
CREATE OR REPLACE FUNCTION social_message_promote() RETURNS TRIGGER AS $$
DECLARE
  v_customer INT;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  SELECT customer_id INTO v_customer FROM social_contacts WHERE id = NEW.contact_id;
  IF v_customer IS NOT NULL THEN
    BEGIN
      PERFORM promote_customer_from_advisor_text(v_customer, NEW.body, NEW.advisor_name);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'social_message_promote: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_message_promote ON social_messages;
CREATE TRIGGER trg_social_message_promote
AFTER INSERT ON social_messages
FOR EACH ROW EXECUTE FUNCTION social_message_promote();

-- Una cotización guardada en el Cotizador (la tarjeta se manda como imagen, sin precio en texto) también pasa al cliente a Tibio.
CREATE OR REPLACE FUNCTION quote_created_promote() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    BEGIN
      PERFORM raise_customer_status(NEW.customer_id, 'tibio', 'Cotizador');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'quote_created_promote: %', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_created_promote ON quotes;
CREATE TRIGGER trg_quote_created_promote
AFTER INSERT ON quotes
FOR EACH ROW EXECUTE FUNCTION quote_created_promote();

-- Se pone al día lo de los últimos 8 días (los clientes que ya cotizaron o recibieron medios de pago y se quedaron en Frío).
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.id AS customer_id, h.message->>'content' AS content, h.message->'additional_kwargs'->>'advisorName' AS advisor
    FROM n8n_chat_histories h JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
    WHERE h.created_at >= now() - interval '8 days' AND h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
      AND (h.message->'additional_kwargs'->>'campaignId') IS NULL AND (h.message->'additional_kwargs'->>'template') IS NULL
    ORDER BY h.created_at, h.id
  LOOP
    PERFORM promote_customer_from_advisor_text(r.customer_id, r.content, r.advisor);
  END LOOP;
  FOR r IN
    SELECT sc.customer_id, sm.body AS content, sm.advisor_name AS advisor
    FROM social_messages sm JOIN social_contacts sc ON sc.id = sm.contact_id
    WHERE sm.direction = 'out' AND sm.created_at >= now() - interval '8 days' AND sc.customer_id IS NOT NULL
    ORDER BY sm.created_at, sm.id
  LOOP
    PERFORM promote_customer_from_advisor_text(r.customer_id, r.content, r.advisor);
  END LOOP;
  FOR r IN SELECT DISTINCT customer_id FROM quotes WHERE created_at >= now() - interval '8 days' AND customer_id IS NOT NULL LOOP
    PERFORM raise_customer_status(r.customer_id, 'tibio', 'Cotizador');
  END LOOP;
END $$;
