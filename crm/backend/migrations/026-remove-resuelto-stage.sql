-- 026-remove-resuelto-stage.sql
-- 1. Remove 'resuelto' from app_settings ('pipeline_columns') and ensure 7 standard columns are active.
UPDATE app_settings
SET value = jsonb_build_array(
  jsonb_build_object('key', 'pendiente', 'icon', 'Clock', 'color', 'warning', 'label', 'No atendidos'),
  jsonb_build_object('key', 'en_atencion', 'icon', 'Snowflake', 'color', 'info', 'label', 'En conversación'),
  jsonb_build_object('key', 'cotizacion', 'icon', 'Thermometer', 'color', 'warning', 'label', 'Cotización'),
  jsonb_build_object('key', 'medio_pago', 'icon', 'Flame', 'color', 'danger', 'label', 'Medio de pago'),
  jsonb_build_object('key', 'pagado', 'icon', 'CircleDollarSign', 'color', 'success', 'label', 'Pagado'),
  jsonb_build_object('key', 'despacho', 'icon', 'Package', 'color', 'info', 'label', 'Por despacho'),
  jsonb_build_object('key', 'pqrs', 'icon', 'MessageSquareWarning', 'color', 'purple', 'label', 'PQRS')
),
updated_at = now()
WHERE key = 'pipeline_columns';

-- 2. Reactivate all tickets currently marked as 'resuelto' back to 'en_atencion'
-- so they return to the pipeline according to customer temperature (frío, tibio, caliente, pagado, despacho, etc.)
UPDATE tickets
SET status = 'en_atencion',
    resolved_at = NULL,
    updated_at = now()
WHERE status = 'resuelto';
