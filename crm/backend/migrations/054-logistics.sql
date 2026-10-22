-- Módulo logístico: fichas de pedido, sus prendas y pagos, el registro de auditoría inmutable y los roles de logística.
-- El flujo (estados, pasos, quién puede hacer qué) vive en src/logisticsFlow.js, no aquí: las reglas todavía se están validando.

CREATE SEQUENCE IF NOT EXISTS order_sheet_seq;

CREATE TABLE IF NOT EXISTS logistics_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('auditor_ingresos', 'verificador', 'traslados', 'autorizador', 'bodega', 'facturador', 'empacador', 'auditor_empaque', 'despachador', 'jefe_logistica')),
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS order_sheets (
  id SERIAL PRIMARY KEY,
  sheet_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  whatsapp_number_id INTEGER,
  quote_id INTEGER REFERENCES quotes(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  advisor_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'BORRADOR',
  payment_mode TEXT NOT NULL DEFAULT 'contado' CHECK (payment_mode IN ('contado', 'contraentrega')),
  delivery_type TEXT NOT NULL DEFAULT 'domicilio' CHECK (delivery_type IN ('domicilio', 'agencia')),
  campaign TEXT,
  full_name TEXT,
  phone TEXT,
  phone_alt TEXT,
  email TEXT,
  address TEXT,
  address_ref TEXT,
  city TEXT,
  department TEXT,
  receiver_name TEXT,
  invoice_name TEXT,
  invoice_nit TEXT,
  origin_mode TEXT NOT NULL DEFAULT 'unica' CHECK (origin_mode IN ('unica', 'multiple')),
  origin_warehouses TEXT[] NOT NULL DEFAULT '{}',
  dispatch_warehouse TEXT NOT NULL DEFAULT 'Oakland',
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  shipping NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  total NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes TEXT,
  step_data JSONB NOT NULL DEFAULT '{}',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  observation TEXT,
  hold_reason TEXT,
  hold_prev_status TEXT,
  payment_approved_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_sheets_status ON order_sheets (status);
CREATE INDEX IF NOT EXISTS idx_order_sheets_customer ON order_sheets (customer_id);
CREATE INDEX IF NOT EXISTS idx_order_sheets_created_by ON order_sheets (created_by);

CREATE TABLE IF NOT EXISTS order_sheet_items (
  id SERIAL PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES order_sheets(id) ON DELETE CASCADE,
  product_id INTEGER,
  reference TEXT NOT NULL,
  description TEXT,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  final_price NUMERIC(10,2) NOT NULL CHECK (final_price >= 0),
  origin_warehouse TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_sheet_items_sheet ON order_sheet_items (sheet_id);

-- Un pago de la ficha con su comprobante (en la galería de adjuntos) y el resultado de la auditoría.
CREATE TABLE IF NOT EXISTS order_sheet_payments (
  id SERIAL PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES order_sheets(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('transferencia', 'deposito', 'consignacion', 'tarjeta_link', 'efectivo', 'otro')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  bank TEXT,
  reference_number TEXT,
  paid_at DATE,
  attachment_id INTEGER REFERENCES message_attachments(id) ON DELETE SET NULL,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_status TEXT NOT NULL DEFAULT 'pendiente' CHECK (audit_status IN ('pendiente', 'aprobado', 'observado', 'rechazado')),
  audited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  audited_at TIMESTAMPTZ,
  audit_note TEXT,
  audit_bank_reference TEXT,
  audit_amount NUMERIC(10,2),
  audit_evidence_id INTEGER REFERENCES message_attachments(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_order_sheet_payments_sheet ON order_sheet_payments (sheet_id);
-- Un mismo número de referencia no puede respaldar dos pagos vigentes (control contra comprobantes reutilizados).
CREATE UNIQUE INDEX IF NOT EXISTS uq_order_sheet_payment_reference
  ON order_sheet_payments (lower(bank), lower(reference_number)) WHERE reference_number IS NOT NULL AND audit_status <> 'rechazado';

-- Registro de auditoría: cada paso deja un sello (quién, cuándo, qué cambió, qué evidencia). Nunca se edita ni se borra.
CREATE TABLE IF NOT EXISTS order_sheet_events (
  id BIGSERIAL PRIMARY KEY,
  sheet_id INTEGER NOT NULL REFERENCES order_sheets(id) ON DELETE RESTRICT,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id INTEGER,
  actor_name TEXT NOT NULL,
  actor_roles TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  note TEXT,
  evidence_ids INTEGER[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_order_sheet_events_sheet ON order_sheet_events (sheet_id, at);

CREATE OR REPLACE FUNCTION order_sheet_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'El registro de auditoría de logística no se edita ni se borra';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_order_sheet_events_immutable ON order_sheet_events;
CREATE TRIGGER trg_order_sheet_events_immutable BEFORE UPDATE OR DELETE ON order_sheet_events
  FOR EACH ROW EXECUTE FUNCTION order_sheet_events_immutable();
