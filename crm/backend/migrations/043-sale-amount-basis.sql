-- Migration 043: de dónde sale el monto de cada venta y su validación.
-- 'comprobante' = leído de una imagen, PDF o texto del banco del cliente.
-- 'precio_aprobado' = el pago por link (NeoLink) no deja monto en el chat: se usa el último
--   precio que el cliente aprobó, y un supervisor o administrador debe validar que coincida
--   con lo depositado / validado en el banco (amount_validated_at).
-- 'manual' = lo escribió la asesora al marcar el pago.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS amount_basis TEXT,
  ADD COLUMN IF NOT EXISTS amount_validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_validated_at TIMESTAMPTZ;
