import { Router } from 'express';
import fs from 'fs';
import { pool } from '../db.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';
import { compressImageBuffer } from '../imageCompression.js';
import { compressPdfBuffer } from '../pdfCompression.js';
import { cleanSessionId, findConversationThread } from './conversations.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';
import { logBusinessAction } from '../auditLog.js';
import { extractText, receiptContainsAmount, guessPaidMethod } from '../ocrPayment.js';
import { getSetting } from './settings.js';

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
// An unset WHATSAPP_INBOUND_SECRET (undefined) would otherwise match a request sent
// with no header at all (also undefined) — a misconfiguration silently becoming no
// authentication at all instead of a loud, obvious failure. Applied to every route on
// this router, not just re-checked per handler.
inboundRouter.use((req, res, next) => {
  if (!process.env.WHATSAPP_INBOUND_SECRET) {
    return res.status(503).json({ error: 'WHATSAPP_INBOUND_SECRET no está configurado' });
  }
  if (req.headers['x-webhook-secret'] !== process.env.WHATSAPP_INBOUND_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});
inboundRouter.post('/', async (req, res, next) => {
  try {
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

    // Never re-sent anywhere by us — this copy only ever gets read back for the CRM's
    // own display, so it's always safe to compress it before it even hits disk. Most
    // multi-MB customer PDFs turn out to be a single scanned receipt/guía photo wrapped
    // in a PDF container by the phone's scan app — Ghostscript shrinks that the same way
    // resizing shrinks a photo, without touching a PDF that's genuinely text/vectors.
    let buffer = Buffer.from(base64, 'base64');
    let storedMimeType = mimeType;
    if (kind === 'image') {
      const compressed = await compressImageBuffer(buffer).catch((err) => {
        console.error('inbound image compression failed', err);
        return null;
      });
      if (compressed) { buffer = compressed; storedMimeType = 'image/jpeg'; }
    } else if (mimeType === 'application/pdf') {
      const compressed = await compressPdfBuffer(buffer).catch((err) => {
        console.error('inbound PDF compression failed', err);
        return null;
      });
      if (compressed) buffer = compressed;
    }

    const attachmentId = await saveAttachment({
      n8nMessageId: inserted[0].id,
      kind,
      filename,
      mimeType: storedMimeType,
      buffer,
    });

    // A photo from the customer is often a payment receipt — same "suggest, don't
    // auto-mark" flag the text-keyword trigger sets (db/init/032), just raised from here
    // instead of a trigger since inbound media already passes through this route (n8n
    // writes plain text straight into Postgres with no Node hook, but forwards media
    // here for us to download/store). Being in Medio de pago (caliente) alone wasn't
    // narrow enough (2026-09-03 report): once there, EVERY photo got flagged — a picture
    // of a different garment, a size chart, anything — not just the actual receipt. Now
    // also requires recent (3h) payment context on either side of the chat: an advisor
    // sharing a payment link (Neolink etc. — matched generically as "any URL", since the
    // gateway varies) or asking for the payment/comprobante, OR the customer themselves
    // having just mentioned transferencia/depósito/comprobante (the deposit-slip flow:
    // customer says "te envío el depósito", THEN sends the photo, with no matching
    // advisor message right before it).
    if (kind === 'image') {
      const contextHours = await getSetting('ocr_context_hours', 3);
      const { rows: gated } = await pool.query(
        `SELECT c.id AS customer_id
         FROM customers c
         WHERE c.whatsapp_number = $1 AND c.paid_locked = false AND (${EFFECTIVE_STATUS_SQL}) = 'caliente'
           AND EXISTS (
             SELECT 1 FROM n8n_chat_histories h
             WHERE h.session_id LIKE $1 || '%'
               AND h.created_at >= now() - make_interval(hours => $2::int)
               AND (
                 (h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
                   AND h.message->>'content' ~* '(m[eé]todo\\s+de\\s+pago|medio\\s+de\\s+pago|(link|enlace)\\s+(de|para)\\s+(el\\s+)?pago|https?://|env[ií]a(nos)?\\s+(tu|el)\\s+comprobante|comprobante\\s+de\\s+(pago|transferencia|dep[oó]sito)|completar\\s+tu\\s+env[ií]o|nit\\s+o\\s+dpi)')
                 OR
                 (h.message->>'type' = 'human'
                   AND h.message->>'content' ~* '(transferencia|dep[oó]sito|comprobante)')
               )
           )`,
        [phone, contextHours]
      );

      if (gated.length) {
        const customerId = gated[0].customer_id;
        let autoConfirmed = false;

        // The only "expected amount" this CRM has anywhere to check a receipt against:
        // whatever Q-price the advisor most recently typed in the chat (same pattern
        // db/init/033's pipeline trigger already reads) — moving a customer through the
        // Pipeline never creates a real orders row with a total to compare against instead.
        // Pulls the raw message text (not a single pre-extracted number) so the LAST
        // Q-amount in the message wins, not the first — a message quoting an original
        // price and then a discounted one ("Antes Q1200, con descuento Q950") must
        // compare against the 950 the customer will actually pay, not the 1200.
        const { rows: priced } = await pool.query(
          `SELECT h.message->>'content' AS content
           FROM n8n_chat_histories h
           WHERE h.session_id LIKE $1 || '%'
             AND h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
             AND h.message->>'content' ~ 'Q\\s?\\d{1,5}'
             AND h.created_at >= now() - make_interval(hours => $2::int)
           ORDER BY h.id DESC LIMIT 1`,
          [phone, contextHours]
        );
        const priceMatches = priced[0]?.content?.match(/Q\s?\d{1,5}/g);
        const expectedAmount = priceMatches?.length
          ? Number(priceMatches[priceMatches.length - 1].replace(/^Q\s?/, ''))
          : null;

        // ponytail: runs inline (Tesseract can take a second or two) rather than a
        // background job — fine at this business's message volume, revisit if it ever
        // measurably delays the inbound webhook.
        if (expectedAmount) {
          const ocrText = await extractText(buffer).catch((err) => {
            console.error('receipt OCR failed', err);
            return '';
          });
          if (receiptContainsAmount(ocrText, expectedAmount)) {
            const paidMethod = guessPaidMethod(ocrText);
            // Re-checks paid_locked/caliente at write time instead of trusting the
            // `gated` SELECT from a few seconds ago — OCR takes long enough that an
            // advisor's own "Marcar como Pagado" click, or the customer moving out of
            // caliente, can land in between. If 0 rows come back here, someone else
            // already resolved this customer while OCR was running, so this result is
            // stale and must NOT overwrite whatever they just set.
            // Also sets manual_status='pagado' — unlike the manual "Marcar como Pagado"
            // button (customers.js), which only sets paid_locked and was leaving the
            // Pipeline card sitting in whatever column it was already in.
            const { rows: updated } = await pool.query(
              `UPDATE customers AS c SET paid_locked = true, paid_method = $2, manual_status = 'pagado',
                 payment_suggested_at = NULL, payment_suggestion_reason = NULL, payment_suggestion_method = NULL,
                 updated_at = now()
               WHERE c.id = $1 AND c.paid_locked = false AND (${EFFECTIVE_STATUS_SQL}) = 'caliente'
               RETURNING c.id`,
              [customerId, paidMethod]
            );
            if (updated.length) {
              // Includes a snippet of what Tesseract actually read, not just the
              // conclusion — so a later audit of a wrong auto-mark can see WHY the
              // system thought this photo matched, not just that it did.
              const ocrSnippet = ocrText.replace(/\s+/g, ' ').trim().slice(0, 160);
              logBusinessAction(
                { fullName: 'Sistema (OCR)', id: null },
                customerId,
                'customer_marked_paid',
                `${paidMethod} — Q${expectedAmount} cotizado, comprobante leído: "${ocrSnippet}" (automático)`
              );
              autoConfirmed = true;
            } else {
              // Stale — don't fall through to the "possible payment" suggestion either;
              // whatever the customer's current state is, it was just set by someone/
              // something else a moment ago and this request has nothing useful to add.
              autoConfirmed = true;
            }
          }
        }

        if (!autoConfirmed) {
          // paid_locked = false here too, for the same reason as above: a customer who
          // got marked Paid (by this same request's race, or by an advisor) in the time
          // it took to reach this line must not have the suggestion banner resurrected.
          await pool.query(
            `UPDATE customers SET payment_suggested_at = now(), payment_suggestion_reason = $2, payment_suggestion_method = NULL
             WHERE id = $1 AND paid_locked = false`,
            [customerId, 'El cliente envió una imagen (posible comprobante de pago)']
          );
        }
      }
    }

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
          // n8n sends "" (not null) when Meta reported no errors array, and ?? only
          // catches null/undefined — without the trim check that stores a blank reason.
          [wamid, (String(error ?? '').trim() || 'WhatsApp reportó que el mensaje no se pudo entregar').slice(0, 500)]
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
