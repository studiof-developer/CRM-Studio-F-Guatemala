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
    const { phone, kind, filename, mimeType, base64, wamid, caption, replyToWamid, referral } = req.body ?? {};
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
      additional_kwargs: { ...(wamid ? { wamid } : {}), ...(replyToWamid ? { replyToWamid } : {}), ...(referral ? { referral } : {}) },
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

// Meta reports delivery as a separate "statuses" webhook event (sent → delivered →
// read), keyed by the wamid we get back when a message is sent — n8n forwards those
// here the same way it forwards inbound media, so the chat ticks show real state
// instead of a single static checkmark. Upgrade-only: WhatsApp's read/delivered
// events can arrive out of order, so a late "delivered" can't downgrade a "read".
// "failed" is the one that matters most and is NOT part of the sent→delivered→read
// ladder: Meta can accept a message (200 + wamid, so our own send looked fine) and only
// afterwards discover it can't be delivered, reporting it through this webhook. Dropping
// it meant the advisor kept seeing a checkmark for a message WhatsApp already told us
// never arrived — so it bypasses the rank check and always wins.
const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };
inboundRouter.post('/status', async (req, res, next) => {
  try {
    if (req.headers['x-webhook-secret'] !== process.env.WHATSAPP_INBOUND_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { wamid, status, error } = req.body ?? {};
    if (!wamid || !(STATUS_RANK[status] || status === 'failed')) {
      return res.status(400).json({ error: 'wamid and a valid status required' });
    }

    const { rows } = status === 'failed'
      ? await pool.query(
          `UPDATE n8n_chat_histories
           SET message = jsonb_set(
                 jsonb_set(message, '{additional_kwargs,status}', '"failed"'),
                 '{additional_kwargs,statusError}', to_jsonb($2::text))
           WHERE message->'additional_kwargs'->>'wamid' = $1
           RETURNING session_id`,
          [wamid, String(error ?? 'WhatsApp reportó que el mensaje no se pudo entregar').slice(0, 500)]
        )
      : await pool.query(
          `UPDATE n8n_chat_histories
           SET message = jsonb_set(message, '{additional_kwargs,status}', to_jsonb($2::text))
           WHERE message->'additional_kwargs'->>'wamid' = $1
             AND (
               message->'additional_kwargs'->>'status' IS NULL
               OR $3 > CASE message->'additional_kwargs'->>'status' WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END
             )
             -- a late sent/delivered must never overwrite a known failure
             AND coalesce(message->'additional_kwargs'->>'status', '') <> 'failed'
           RETURNING session_id`,
          [wamid, status, STATUS_RANK[status]]
        );
    if (rows.length) {
      await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [rows[0].session_id]);
    }

    res.json({ updated: rows.length > 0 });
  } catch (err) { next(err); }
});

export default router;
