-- Migration 040: motor de ventas basado en evidencia.
-- Cada venta nueva queda atada al mensaje que la originó (comprobante leído por OCR o
-- confirmación de la asesora): de ahí salen su fecha, su monto y su asesora, y el índice
-- único impide registrar dos veces el mismo comprobante.
-- Las ventas anteriores al 16/10/2026 ya fueron calibradas a mano (cierres del 14/10,
-- 12/10, 29/09, etc.), así que quedan BLOQUEADAS: el motor y la auditoría no las tocan.
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS evidence_type TEXT,
  ADD COLUMN IF NOT EXISTS evidence_message_id BIGINT,
  ADD COLUMN IF NOT EXISTS attribution_locked BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_evidence
  ON sales (evidence_type, evidence_message_id)
  WHERE evidence_message_id IS NOT NULL;

UPDATE sales
SET attribution_locked = true,
    evidence_type = COALESCE(evidence_type, 'legacy')
WHERE created_at < '2026-10-16 00:00:00-06'::timestamptz
  AND NOT attribution_locked;
