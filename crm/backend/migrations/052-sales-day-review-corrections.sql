-- Correcciones humanas de la revisión día por día: monto y/o asesora correctos de una venta, o conservar una venta que el motor borraría.
ALTER TABLE sales_day_reviews
  ADD COLUMN IF NOT EXISTS amount_override NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS advisor_override TEXT,
  ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT false;
