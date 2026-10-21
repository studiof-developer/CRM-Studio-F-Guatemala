-- Revisión día por día: una venta que el motor leyó pero que la persona confirma que NO fue compra se descarta (no queda registro).
ALTER TABLE sales_day_reviews ADD COLUMN IF NOT EXISTS discard BOOLEAN NOT NULL DEFAULT false;
