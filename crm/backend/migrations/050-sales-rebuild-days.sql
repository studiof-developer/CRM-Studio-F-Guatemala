-- Migration 050: avance de la reconstrucción de ventas de días pasados (salesHistory.js). Un día aparece aquí cuando ya se
-- reconstruyó por completo; si la corrida se corta, la siguiente empieza en el primer día que no esté.
CREATE TABLE IF NOT EXISTS sales_rebuild_days (
  day DATE PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_table TEXT,
  summary JSONB
);
