import fs from 'fs';
import { pool } from './db.js';
import { compressImageBuffer } from './imageCompression.js';
import { compressPdfBuffer } from './pdfCompression.js';

// Recompresses an already-saved attachment in place, whatever kind it is. Only ever call
// this on a copy that will never be re-read to actually send to WhatsApp again — an
// advisor's outgoing attachment is re-read from disk by the queued/orphan-recovery send
// paths, so this must only run after a send is confirmed delivered (see
// handleSendResult/deliverStoredMessage in routes/conversations.js). A customer-sent
// attachment is never re-sent by us at all, so it's always safe.
export async function compressStoredAttachment(attachmentId) {
  try {
    const { rows } = await pool.query(
      `SELECT file_path, mime_type, kind FROM message_attachments WHERE id = $1`,
      [attachmentId]
    );
    const a = rows[0];
    if (!a) return;
    const original = await fs.promises.readFile(a.file_path);

    let compressed = null;
    let newMimeType = a.mime_type;
    if (a.kind === 'image') {
      compressed = await compressImageBuffer(original);
      if (compressed) newMimeType = 'image/jpeg';
    } else if (a.mime_type === 'application/pdf') {
      compressed = await compressPdfBuffer(original);
    }
    if (!compressed) return;

    await fs.promises.writeFile(a.file_path, compressed);
    await pool.query(
      `UPDATE message_attachments SET mime_type = $2, size_bytes = $3 WHERE id = $1`,
      [attachmentId, newMimeType, compressed.length]
    );
  } catch (err) {
    // Never worth failing a send or a webhook over — this is a background storage
    // optimization, not something the advisor or customer should ever see fail.
    console.error(`compressStoredAttachment(${attachmentId}) failed`, err);
  }
}
