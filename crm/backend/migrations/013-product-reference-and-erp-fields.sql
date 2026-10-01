-- Migración 013: Agregar campos de referencia y ERP a products
-- Permite buscar prendas por la referencia real (ej. S740866, S176012A), guardar idArticulo y barcode

ALTER TABLE products ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS erp_article_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_products_reference ON products(reference);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_erp_article_id ON products(erp_article_id);
