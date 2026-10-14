-- Migration 027: evidencia de cada venta para el reporte por asesora.
-- Solo agrega columnas (nullable / con default): no cambia estados del pipeline ni
-- reescribe ventas existentes. Las ventas anteriores quedan como 'confirmada' con
-- attributed_by = 'historico' (atribución aproximada de los backfills 015/021).
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmada',
  ADD COLUMN IF NOT EXISTS amount_source TEXT,
  ADD COLUMN IF NOT EXISTS quoted_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS receipt_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS amount_match BOOLEAN,
  ADD COLUMN IF NOT EXISTS attributed_by TEXT,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS channel TEXT;

UPDATE sales SET attributed_by = 'historico' WHERE attributed_by IS NULL;
UPDATE sales SET confirmed_at = created_at WHERE confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
