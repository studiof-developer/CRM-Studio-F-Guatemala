import fs from 'fs';
import { pool } from './db.js';
import { createOcrSession, extractDocumentText } from './ocrDocument.js';
import { looksRejected } from './ocrPayment.js';

// Vuelve a leer los comprobantes que ya traen un monto o voucher guardado y quita la lectura de los que en realidad son la pantalla de
// verificación (OTP) o de rechazo de la pasarela: el cliente nunca pagó. Al quitarla, el motor deja de ver ahí un comprobante y esa venta,
// si estaba registrada, aparece en "ventas por borrar" de la revisión de su día.
export async function rescanRejectedReceipts({ days = 30, log = console.log }) {
  const { rows } = await pool.query(
    `SELECT h.id AS message_id, h.created_at, split_part(h.session_id, '__', 1) AS phone, COALESCE(h.message->'additional_kwargs'->>'ocrAmount', o.amount::text) AS amount,
            a.id AS att_id, a.file_path, a.mime_type
     FROM n8n_chat_histories h JOIN message_attachments a ON a.n8n_message_id = h.id
     LEFT JOIN attachment_ocr o ON o.attachment_id = a.id
     WHERE h.message->>'type' = 'human'
       AND (h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL OR h.message->'additional_kwargs'->>'ocrVoucher' = 'true'
            OR o.amount IS NOT NULL OR o.voucher = true)
       AND (a.kind = 'image' OR a.mime_type = 'application/pdf') AND h.created_at >= now() - ($1::int * interval '1 day')
     ORDER BY h.id`,
    [days]
  );
  log(`Comprobantes leídos en los últimos ${days} días: ${rows.length}. Releyendo cada uno…`);
  const session = await createOcrSession();
  let removed = 0; let failed = 0;
  try {
    for (const [i, r] of rows.entries()) {
      let text = '';
      try { text = await extractDocumentText(await fs.promises.readFile(r.file_path), r.mime_type, session.recognize); } catch { failed++; continue; }
      if (looksRejected(text)) {
        await pool.query(`UPDATE n8n_chat_histories SET message = message #- '{additional_kwargs,ocrAmount}' #- '{additional_kwargs,ocrKind}' #- '{additional_kwargs,ocrVoucher}' WHERE id = $1`, [r.message_id]);
        await pool.query('DELETE FROM attachment_ocr WHERE attachment_id = $1', [r.att_id]);
        removed++;
        log(`Quitado: …${String(r.phone).slice(-4)} · ${new Date(r.created_at).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}${r.amount ? ` · Q${r.amount}` : ''} · era una pantalla de verificación o de pago rechazado`);
      }
      if ((i + 1) % 25 === 0) log(`${i + 1} de ${rows.length} revisados`);
    }
  } finally {
    await session.close();
  }
  log(`\nListo: ${removed} lecturas quitadas de ${rows.length} comprobantes${failed ? ` (${failed} no se pudieron releer)` : ''}.${removed ? ' Si alguno ya estaba registrado como venta, aparece en "Ventas del CRM que se borrarían" al cargar su día.' : ''}`);
  return { scanned: rows.length, removed, failed };
}
