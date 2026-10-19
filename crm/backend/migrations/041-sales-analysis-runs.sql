-- Migration 041: corridas del análisis histórico de chats de clientes que compraron.
-- Es solo lectura sobre los chats: guarda el informe (jsonb) para poder reabrirlo y
-- descargarlo sin volver a recorrer todos los chats.
CREATE TABLE IF NOT EXISTS sales_analysis_runs (
  id SERIAL PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
