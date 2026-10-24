-- Migration 058: existencias por sucursal.
-- El ERP devuelve una fila de existencia por sucursal, pero el CRM solo guardaba el total (products.stock_quantity). Esta tabla conserva el
-- desglose para ver en el catálogo y en la ficha de pedido en qué tienda está cada prenda. La llena erpSync.js en cada sincronización
-- (se reemplaza completa, en una sola transacción); solo guarda existencias vendibles mayores a cero.
CREATE TABLE IF NOT EXISTS product_store_stock (
  sku TEXT NOT NULL,
  sucursal TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, sucursal)
);
