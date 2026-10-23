-- Ajustes de la ficha para apegarla a la ficha de papel (Control Ventas Online): el flete va aparte del total, se puede recoger en tienda,
-- hay datos del cliente que el papel recoge (DPI, cumpleaños, zona) y los pagos con Link llevan la verificación de la asesora.

ALTER TABLE order_sheets DROP CONSTRAINT IF EXISTS order_sheets_delivery_type_check;
ALTER TABLE order_sheets ADD CONSTRAINT order_sheets_delivery_type_check CHECK (delivery_type IN ('domicilio', 'agencia', 'tienda'));

-- Quién paga el flete: al recibir (el cliente se lo paga a la paquetería), ya pagado (viene dentro de los pagos) o sin envío (recoge en tienda).
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS shipping_payment TEXT NOT NULL DEFAULT 'pagado';
ALTER TABLE order_sheets DROP CONSTRAINT IF EXISTS order_sheets_shipping_payment_check;
ALTER TABLE order_sheets ADD CONSTRAINT order_sheets_shipping_payment_check CHECK (shipping_payment IN ('al_recibir', 'pagado', 'sin_envio'));

ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS pickup_store TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS dpi TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS birthday_month TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS birthday_day TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS advisor_code TEXT;
ALTER TABLE order_sheets ADD COLUMN IF NOT EXISTS sheet_date DATE;

-- Pago con Link (NeoLink): la asesora lo verifica primero en la plataforma; la auditora lo revisa después contra el banco.
ALTER TABLE order_sheet_payments ADD COLUMN IF NOT EXISTS platform_verified BOOLEAN NOT NULL DEFAULT false;

-- La referencia única debe valer también cuando el pago no lleva banco (el índice anterior ignoraba esos casos).
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_order_sheet_payment_reference_v2
    ON order_sheet_payments (COALESCE(lower(bank), ''), lower(reference_number)) WHERE reference_number IS NOT NULL AND audit_status <> 'rechazado';
  DROP INDEX IF EXISTS uq_order_sheet_payment_reference;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Hay referencias repetidas sin banco: se mantiene el índice anterior';
END $$;
