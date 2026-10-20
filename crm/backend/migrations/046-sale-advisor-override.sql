-- Migration 046: asesora corregida a mano. Un administrador/supervisor puede decir "esta venta no es de X, es de Y"; la
-- corrección queda fija y la auditoría / reconstrucción de ventas ya no mueve esa venta de asesora.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS advisor_override_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS advisor_override_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
