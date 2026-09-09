#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname studio_f <<-'EOSQL'

-- Seeds the current Pipeline board exactly as it looks today (label/icon/color/order)
-- so the new Configuración > Pipeline editor starts from the real board, not a blank
-- one — and so there's no "setting missing" fallback branch to keep in sync on the
-- frontend. The 7 keys themselves are fixed (temperature/ticket_status decide which
-- one a contact is in) — only what's in this row is meant to change from here on.
INSERT INTO app_settings (key, value) VALUES ('pipeline_columns', '[
  {"key": "pendiente", "label": "No atendidos", "icon": "Clock", "color": "warning"},
  {"key": "en_atencion", "label": "En conversación", "icon": "Snowflake", "color": "info"},
  {"key": "cotizacion", "label": "Cotización", "icon": "Thermometer", "color": "warning"},
  {"key": "medio_pago", "label": "Medio de pago", "icon": "Flame", "color": "danger"},
  {"key": "pagado", "label": "Pagado", "icon": "CircleDollarSign", "color": "success"},
  {"key": "pqrs", "label": "PQRS", "icon": "MessageSquareWarning", "color": "purple"},
  {"key": "resuelto", "label": "Resuelto", "icon": "CheckCircle2", "color": "success"}
]'::jsonb)
ON CONFLICT (key) DO NOTHING;

EOSQL
