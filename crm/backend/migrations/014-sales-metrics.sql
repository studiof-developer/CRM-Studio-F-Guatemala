-- Migration 014: Sales tracking and metrics per advisor
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  advisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  advisor_name TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  payment_method TEXT,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  notes TEXT,
  whatsapp_number_id INTEGER REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_advisor_id ON sales(advisor_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_ticket_id ON sales(ticket_id);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_advisor_name ON sales(advisor_name);
CREATE INDEX IF NOT EXISTS idx_sales_whatsapp_number_id ON sales(whatsapp_number_id);
