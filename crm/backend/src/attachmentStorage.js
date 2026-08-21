import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Whitelist, not blacklist — serving an uploaded file back with Content-Disposition:
// inline means an unrestricted mimetype (e.g. text/html, image/svg+xml) would let
// someone plant a stored-XSS payload via a "photo" attachment.
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/'];
const ALLOWED_MIME_EXACT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export function isAllowedAttachmentMime(mimeType) {
  return ALLOWED_MIME_EXACT.includes(mimeType) || ALLOWED_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

// Split out from saveAttachment so a broadcast can write the header image to disk once
// and reuse the same filePath across many message_attachments rows (one per recipient)
// instead of duplicating the file on disk per send.
export async function writeAttachmentFile(buffer) {
  const diskName = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const filePath = path.join(UPLOAD_DIR, diskName);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

export async function saveAttachment({ n8nMessageId, kind, filename, mimeType, buffer }) {
  const filePath = await writeAttachmentFile(buffer);
  const { rows } = await pool.query(
    `INSERT INTO message_attachments (n8n_message_id, kind, filename, mime_type, file_path, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [n8nMessageId, kind, filename ?? null, mimeType, filePath, buffer.length]
  );
  return rows[0].id;
}

// Links an already-written file to a message without re-saving the bytes — used when
// the same header image is attached to many recipient rows in a broadcast.
export async function linkExistingFile({ n8nMessageId, kind, filename, mimeType, filePath, sizeBytes }) {
  const { rows } = await pool.query(
    `INSERT INTO message_attachments (n8n_message_id, kind, filename, mime_type, file_path, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [n8nMessageId, kind, filename ?? null, mimeType, filePath, sizeBytes]
  );
  return rows[0].id;
}
