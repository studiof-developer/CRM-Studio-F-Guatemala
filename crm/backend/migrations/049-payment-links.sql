-- Migration 049: links de pago de NeoLink que las asesoras mandan por el chat. De cada link se guarda el monto que muestra la
-- página de pago ("Monto: Q1,461.00") para mostrar lo pendiente de cobro. Una fila por mensaje (message_id = n8n_chat_histories.id).
CREATE TABLE IF NOT EXISTS payment_links (
  id SERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  amount NUMERIC(10,2),
  phone TEXT NOT NULL,
  line_id INTEGER,
  advisor_name TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_links_sent_at ON payment_links (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_phone ON payment_links (phone);
