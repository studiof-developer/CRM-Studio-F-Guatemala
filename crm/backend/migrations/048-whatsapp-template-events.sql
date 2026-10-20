-- Migration 048: avisos que Meta manda por webhook sobre las plantillas de WhatsApp (aprobada, rechazada, pausada, cambio de
-- calidad o de categoría). Se muestran en Marketing > Plantillas y sirven de historial.
CREATE TABLE IF NOT EXISTS whatsapp_template_events (
  id SERIAL PRIMARY KEY,
  waba_id TEXT,
  template_id TEXT,
  template_name TEXT NOT NULL,
  language TEXT,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_template_events_created ON whatsapp_template_events (id DESC);
