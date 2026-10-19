-- Migration 044: ventas cuya asesora no es clara.
-- Una asesora entregó los medios de pago y, antes del comprobante, otra tomó el chat (cambio de
-- turno o dos asesoras en la misma compra). El motor acredita a quien dio los medios de pago, pero
-- el caso queda "por validar" hasta que un supervisor o administrador lo confirme
-- (amount_validated_at, igual que el monto inferido del precio aprobado).
ALTER TABLE sales ADD COLUMN IF NOT EXISTS attribution_uncertain BOOLEAN NOT NULL DEFAULT false;
