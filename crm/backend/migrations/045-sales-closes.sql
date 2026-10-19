-- Migration 045: cierres del día (corte a una hora). Cada cierre guardado queda congelado: las ventas
-- pagadas y pendientes de cada asesora a esa hora, para poder compararlo luego con lo que ellas reportan.
CREATE TABLE IF NOT EXISTS sales_closes (
  id SERIAL PRIMARY KEY,
  day DATE NOT NULL,
  as_of TIMESTAMPTZ NOT NULL,
  label TEXT,
  result JSONB NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_closes_day ON sales_closes (day, id DESC);
