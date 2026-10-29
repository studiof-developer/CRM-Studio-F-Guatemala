-- Idempotente: asegura en producción los índices que db/init solo crea al nacer la base,
-- y agrega los de búsqueda por texto (nombre, teléfono, mensajes sociales).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_session_id
  ON n8n_chat_histories (session_id text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_content_trgm
  ON n8n_chat_histories USING GIN ((message->>'content') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_social_messages_body_trgm
  ON social_messages USING GIN (body gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_full_name_trgm
  ON customers USING GIN (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_whatsapp_number_trgm
  ON customers USING GIN (whatsapp_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_social_contacts_customer_id
  ON social_contacts (customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_customer_id
  ON tickets (customer_id);
