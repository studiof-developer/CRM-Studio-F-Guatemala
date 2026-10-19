-- Migration 042: caché del OCR de adjuntos (imágenes y PDF de clientes).
-- El análisis histórico lee comprobantes viejos que nunca pasaron por OCR; guardar el resultado
-- aquí evita repetir el trabajo (cada imagen tarda segundos) y deja evidencia de qué se leyó.
-- No toca los mensajes del chat.
CREATE TABLE IF NOT EXISTS attachment_ocr (
  attachment_id INTEGER PRIMARY KEY REFERENCES message_attachments(id) ON DELETE CASCADE,
  amount NUMERIC(10,2),
  voucher BOOLEAN NOT NULL DEFAULT false,
  snippet TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
