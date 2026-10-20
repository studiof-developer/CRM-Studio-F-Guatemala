-- Migration 047: checklist de la auditoría del CRM (página /auditoria.html). Cada pendiente guarda quién lo marcó y cuándo;
-- el historial conserva cada marca y desmarca para dejar trazabilidad.
CREATE TABLE IF NOT EXISTS audit_checklist (
  item_key TEXT PRIMARY KEY,
  done BOOLEAN NOT NULL DEFAULT false,
  done_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_by_name TEXT,
  done_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS audit_checklist_log (
  id SERIAL PRIMARY KEY,
  item_key TEXT NOT NULL,
  done BOOLEAN NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_checklist_log_at ON audit_checklist_log (at DESC);
