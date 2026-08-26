import sharp from 'sharp';
import fs from 'fs';
import { pool } from './db.js';

// 1600px keeps a photo clearly identifiable (product detail, a screenshot's text) while
// cutting the multi-MB originals phone cameras produce down to a few hundred KB. Quality
// 78 is the point where JPEG artifacts start being visible on close inspection but not at
// a normal viewing size — well above "al pelo".
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 78;
// Below this, recompressing risks making the file bigger (JPEG overhead) for no real
// storage win — not worth the CPU or the (tiny) risk of touching the file at all.
const MIN_SIZE_TO_COMPRESS = 200 * 1024;

export async function compressImageBuffer(buffer) {
  if (buffer.length < MIN_SIZE_TO_COMPRESS) return null;
  const out = await sharp(buffer)
    .rotate() // bakes in the EXIF orientation before it's stripped below
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return out.length < buffer.length ? out : null;
}

// Recompresses an already-saved attachment in place. Only ever call this on a copy that
// will never be re-read to actually send to WhatsApp again — an advisor's outgoing photo
// is re-read from disk by the queued/orphan-recovery send paths, so this must only run
// after a send is confirmed delivered (see handleSendResult/deliverStoredMessage).
export async function compressStoredImageAttachment(attachmentId) {
  try {
    const { rows } = await pool.query(
      `SELECT file_path, mime_type, kind FROM message_attachments WHERE id = $1`,
      [attachmentId]
    );
    const a = rows[0];
    if (!a || a.kind !== 'image') return;
    const original = await fs.promises.readFile(a.file_path);
    const compressed = await compressImageBuffer(original);
    if (!compressed) return;
    await fs.promises.writeFile(a.file_path, compressed);
    await pool.query(
      `UPDATE message_attachments SET mime_type = 'image/jpeg', size_bytes = $2 WHERE id = $1`,
      [attachmentId, compressed.length]
    );
  } catch (err) {
    // Never worth failing a send or a webhook over — this is a background storage
    // optimization, not something the advisor or customer should ever see fail.
    console.error(`compressStoredImageAttachment(${attachmentId}) failed`, err);
  }
}
