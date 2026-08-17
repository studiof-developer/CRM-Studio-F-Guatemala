import { Router } from 'express';
import fs from 'fs';
import { pool } from '../db.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';
import { cleanSessionId, findConversationThread } from './conversations.js';

const router = Router();

router.get('/:id/file', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT filename, mime_type, file_path FROM message_attachments WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const { filename, mime_type, file_path } = rows[0];

    res.setHeader('Content-Type', mime_type);
    // Preview (img/iframe/audio src) needs inline; the explicit download button
    // asks for ?download=1 to force a save-as instead of rendering in place.
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', filename ? `${disposition}; filename="${filename}"` : disposition);
    fs.createReadStream(file_path).pipe(res);
  } catch (err) { next(err); }
});

// n8n calls this directly (no CRM login) when a customer sends media — it downloads the
// bytes from Meta itself and forwards them here. Protected by a shared secret instead of
// a user session, since there's no advisor logged in on that side.
export const inboundRouter = Router();
inboundRouter.post('/', async (req, res, next) => {
  try {
    if (req.headers['x-webhook-secret'] !== process.env.WHATSAPP_INBOUND_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { phone, kind, filename, mimeType, base64, wamid, caption, replyToWamid } = req.body ?? {};
    if (!phone || !kind || !mimeType || !base64) {
      return res.status(400).json({ error: 'phone, kind, mimeType, base64 required' });
    }
    if (!isAllowedAttachmentMime(mimeType)) {
      return res.status(400).json({ error: 'mimeType not allowed' });
    }

    const { sessionIds } = await findConversationThread(phone);
    const sessionId = sessionIds?.[0] ?? `${phone}__whatsapp`;

    const message = {
      type: 'human',
      content: caption ?? '',
      additional_kwargs: { ...(wamid ? { wamid } : {}), ...(replyToWamid ? { replyToWamid } : {}) },
      response_metadata: {},
    };
    const { rows: inserted } = await pool.query(
      `INSERT INTO n8n_chat_histories (session_id, message) VALUES ($1, $2::jsonb) RETURNING id`,
      [sessionId, JSON.stringify(message)]
    );

    const attachmentId = await saveAttachment({
      n8nMessageId: inserted[0].id,
      kind,
      filename,
      mimeType,
      buffer: Buffer.from(base64, 'base64'),
    });

    res.status(201).json({ attachmentId, sessionId: cleanSessionId(sessionId) });
  } catch (err) { next(err); }
});

export default router;
