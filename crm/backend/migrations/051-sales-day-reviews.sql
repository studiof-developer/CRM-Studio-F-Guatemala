-- Revisión humana de las ventas de un día reconstruido: cada venta (o venta por borrar) se marca como correcta o incorrecta, con una nota.
CREATE TABLE IF NOT EXISTS sales_day_reviews (
  day DATE NOT NULL,
  item_key TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'mal')),
  note TEXT,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, item_key)
);
