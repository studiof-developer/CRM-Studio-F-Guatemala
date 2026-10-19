import { Router } from 'express';
import fs from 'fs';
import { pool } from '../db.js';
import { saveAttachment, isAllowedAttachmentMime } from '../attachmentStorage.js';
import { compressImageBuffer } from '../imageCompression.js';
import { compressPdfBuffer } from '../pdfCompression.js';
import { cleanSessionId, findConversationThread, getDefaultLineId } from './conversations.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';
import { logBusinessAction } from '../auditLog.js';
import { receiptContainsAmount, guessPaidMethod, extractReceiptAmount, parseAmount } from '../ocrPayment.js';
import { extractDocumentText, isPaymentVoucher } from '../ocrDocument.js';
import { getSetting } from './settings.js';
import { recordSaleFromReceipt } from '../salesAttribution.js';

// Shared by both the single-receipt match and the multi-receipt-sum match below —
// re-checks paid_locked/caliente at write time instead of trusting an earlier SELECT,
// since OCR takes long enough that an advisor's own "Marcar como Pagado" click, or the
// customer moving out of caliente, can land in between. If 0 rows come back, someone
// else already resolved this customer while OCR was running, so this result is stale
// and must NOT overwrite whatever they just set — the caller still treats that as
// "handled" (skip the suggestion banner), just without logging a confirmation that
// didn't actually happen.
async function confirmAutoPayment(customerId, paidMethod, detailNote, amount = null, messageId = null) {
  const { rows: updated } = await pool.query(
    `UPDATE customers AS c SET paid_locked = true, paid_method = $2,
       manual_status = CASE WHEN c.manual_status = 'pqrs' THEN 'pqrs' ELSE 'despacho' END,
       payment_suggested_at = NULL, payment_suggestion_reason = NULL, payment_suggestion_method = NULL,
       updated_at = now()
     WHERE c.id = $1
     RETURNING c.id`,
    [customerId, paidMethod]
  );
  if (updated.length) {
    logBusinessAction({ fullName: 'Sistema (OCR)', id: null }, customerId, 'customer_marked_paid', detailNote);

    // La venta nace del comprobante (su fecha, su monto y la asesora que atendía en ese
    // momento) — ver salesAttribution.js.
    if (messageId) {
      // El motor lee el monto del propio mensaje; si el OCR no lo guardó (se confirmó contra lo cotizado), se guarda aquí.
      if (amount) {
        await pool.query(
          `UPDATE n8n_chat_histories SET message = jsonb_set(message, '{additional_kwargs,ocrAmount}', to_jsonb($2::numeric))
           WHERE id = $1 AND (message->'additional_kwargs'->>'ocrAmount') IS NULL`,
          [messageId, Number(amount)]
        );
      }
      await recordSaleFromReceipt({ messageId, amount: amount ? Number(amount) : null });
    }
    return true;
  }
  return false;
}

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

    // Resolve line ID safely so attachments land in the exact same line/thread as text
    let lineId = req.body.lineId || req.body.whatsapp_number_id || req.body.whatsappNumberId || null;
    if (!lineId && (req.body.phoneNumberId || req.body.phone_number_id)) {
      const pId = String(req.body.phoneNumberId || req.body.phone_number_id).trim();
      const { rows } = await pool.query('SELECT id FROM whatsapp_numbers WHERE phone_number_id = $1 LIMIT 1', [pId]);
      if (rows.length) lineId = rows[0].id;
    }
    if (!lineId) {
      // Check customer's most recent active open ticket
      const { rows: tRows } = await pool.query(
        `SELECT t.whatsapp_number_id FROM tickets t
         JOIN customers c ON c.id = t.customer_id
         WHERE c.whatsapp_number = $1 AND t.status != 'resuelto' AND t.whatsapp_number_id IS NOT NULL
         ORDER BY t.updated_at DESC, t.id DESC LIMIT 1`,
        [phone]
      );
      if (tRows.length && tRows[0].whatsapp_number_id) {
        lineId = tRows[0].whatsapp_number_id;
      }
    }
    if (!lineId) {
      // Check customer's most recent message with a line
      const { rows: hRows } = await pool.query(
        `SELECT whatsapp_number_id, session_id FROM n8n_chat_histories
         WHERE (session_id = $1 OR session_id LIKE $1 || '__%')
           AND (whatsapp_number_id IS NOT NULL OR session_id ~ '__line_[0-9]+')
         ORDER BY id DESC LIMIT 1`,
        [phone]
      );
      if (hRows.length) {
        if (hRows[0].whatsapp_number_id) {
          lineId = hRows[0].whatsapp_number_id;
        } else if (hRows[0].session_id?.includes('__line_')) {
          const match = hRows[0].session_id.match(/__line_([0-9]+)/);
          if (match) lineId = parseInt(match[1], 10);
        }
      }
    }
    if (!lineId) {
      lineId = await getDefaultLineId();
    }

    const sessionId = `${phone}__line_${lineId}`;

    const message = {
      type: 'human',
      content: caption ?? '',
      additional_kwargs: {
        ...(wamid ? { wamid } : {}),
        ...(replyToWamid ? { replyToWamid } : {}),
        ...(referral ? { referral } : {}),
        whatsappNumberId: lineId,
      },
      response_metadata: {},
    };
    const { rows: inserted } = await pool.query(
      `INSERT INTO n8n_chat_histories (session_id, message, whatsapp_number_id) VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [sessionId, JSON.stringify(message), lineId]
    );
    const inboundMessageId = inserted[0].id;
    await pool.query(
      `SELECT pg_notify('message_changes', json_build_object('session_id', $1::text, 'phone', $2::text)::text)`,
      [sessionId, phone]
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
    // here for us to download/store). Used to also require a specific advisor/customer
    // trigger phrase nearby (2026-09-08) — dropped (2026-09-09 report) because real chats
    // routinely send the receipt without ever typing one of those exact phrases (e.g. an
    // advisor who only said "lo puedes cancelar..." never says "comprobante" or shares a
    // link). Safe to scope down to just "caliente y sin pagar" now that receiptContainsAmount
    // (ocrPayment.js) itself requires real receipt vocabulary AND a matching amount before
    // anything gets auto-confirmed — a photo of a garment or size chart still won't match.
    // Imagen o PDF: se lee en segundo plano y de uno en uno (varias fotos juntas no deben frenar el CRM);
    // el cliente no espera a que termine.
    if (kind === 'image' || mimeType === 'application/pdf') {
      queueOcr(() => processInboundImageOcr({ buffer, phone, inboundMessageId, mimeType: storedMimeType }));
    }

    res.status(201).json({ attachmentId, sessionId: cleanSessionId(sessionId) });
  } catch (err) { next(err); }
});

let ocrChain = Promise.resolve();
function queueOcr(job) {
  ocrChain = ocrChain.then(job).catch((err) => console.error('inbound OCR failed', err));
  return ocrChain;
}

export async function processInboundImageOcr({ buffer, phone, inboundMessageId, mimeType = 'image/jpeg' }) {
  const contextHours = await getSetting('ocr_context_hours', 3);
  const extraReceiptKeywords = await getSetting('extra_receipt_keywords', []);
  const { rows: gated } = await pool.query(
    `SELECT c.id AS customer_id
     FROM customers c
     WHERE c.whatsapp_number = $1`,
    [phone]
  );

  if (!gated.length) return;

  const customerId = gated[0].customer_id;
  let autoConfirmed = false;
  let suggestionReason = 'El cliente envió una imagen (posible comprobante de pago)';

  const { rows: priced } = await pool.query(
    `SELECT h.message->>'content' AS content
     FROM n8n_chat_histories h
     WHERE h.session_id LIKE $1 || '%'
       AND h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
       AND h.message->>'content' ~ 'Q\\s?\\d{1,5}|\\d{1,5}[.,]\\d{2}'
       AND h.created_at >= now() - interval '48 hours'
     ORDER BY h.id DESC LIMIT 1`,
    [phone]
  );

  const priceMatches = priced[0]?.content?.match(/Q\s?\d[\d.,]*|\d{1,5}[.,]\d{2}/g);
  const expectedAmount = priceMatches?.length
    ? parseAmount(priceMatches[priceMatches.length - 1].replace(/^Q\s?/, ''))
    : null;

  const ocrText = await extractDocumentText(buffer, mimeType).catch((err) => {
    console.error('receipt OCR failed', err);
    return '';
  });
  // El voucher "Aprobada" de NeoLink no trae monto pero prueba que el pago con link se aprobó.
  if (isPaymentVoucher(ocrText)) {
    await pool.query(
      `UPDATE n8n_chat_histories SET message = jsonb_set(message, '{additional_kwargs,ocrVoucher}', 'true'::jsonb) WHERE id = $1`,
      [inboundMessageId]
    );
  }
  const ocrSnippet = ocrText.replace(/\s+/g, ' ').trim().slice(0, 160);
  const ocrAmount = extractReceiptAmount(ocrText, extraReceiptKeywords);

  if (ocrAmount != null && ocrAmount > 0 && ocrAmount <= 10000) {
    await pool.query(
      `UPDATE n8n_chat_histories SET message = jsonb_set(jsonb_set(message, '{additional_kwargs,ocrAmount}', to_jsonb($2::numeric)), '{additional_kwargs,ocrKind}', to_jsonb($3::text)) WHERE id = $1`,
      [inboundMessageId, ocrAmount, mimeType === 'application/pdf' ? 'pdf' : 'imagen']
    );
  }

  if (expectedAmount && receiptContainsAmount(ocrText, expectedAmount, extraReceiptKeywords)) {
    const paidMethod = guessPaidMethod(ocrText);
    await confirmAutoPayment(
      customerId,
      paidMethod,
      `${paidMethod} — Q${expectedAmount} cotizado, comprobante leído: "${ocrSnippet}" (automático)`,
      expectedAmount,
      inboundMessageId
    );
    autoConfirmed = true;
  } else if (ocrAmount != null && ocrAmount >= 50 && ocrAmount <= 10000) {
    const paidMethod = guessPaidMethod(ocrText);
    if (expectedAmount) {
      const { rows: summed } = await pool.query(
        `SELECT COALESCE(SUM((h.message->'additional_kwargs'->>'ocrAmount')::numeric), 0) AS total
         FROM n8n_chat_histories h
         WHERE h.session_id LIKE $1 || '%'
           AND h.message->>'type' = 'human'
           AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
           AND h.created_at >= now() - make_interval(hours => $2::int)`,
        [phone, contextHours]
      );
      if (Math.round(Number(summed[0].total)) === Math.round(expectedAmount)) {
        await confirmAutoPayment(
          customerId,
          paidMethod,
          `${paidMethod} — Q${expectedAmount} cotizado, comprobante leído: "${ocrSnippet}" (combinado con comprobante(s) anterior(es), automático)`,
          expectedAmount,
          inboundMessageId
        );
        autoConfirmed = true;
      }
    }

    if (!autoConfirmed) {
      // Valid bank/NeoLink receipt with receipt keywords and valid retail amount (e.g. NeoLink link sent without plain-text quote or multi-item total)
      await confirmAutoPayment(
        customerId,
        paidMethod,
        `${paidMethod} — Comprobante verificado por OCR por Q${ocrAmount}: "${ocrSnippet}" (automático)`,
        ocrAmount,
        inboundMessageId
      );
      autoConfirmed = true;
    }
  } else {
    // Image is NOT recognized as a payment receipt (e.g. photo of a dress, blouse, catalog screenshot).
    // NEVER auto-record a sale for unrecognized images!
    if (expectedAmount) {
      suggestionReason = `El cliente envió una imagen — no se reconoció como comprobante (sin monto ni palabras de recibo)`;
      logBusinessAction(
        { fullName: 'Sistema (OCR)', id: null },
        customerId,
        'payment_ocr_no_match',
        `Q${expectedAmount} cotizado, imagen sin formato de recibo: "${ocrSnippet}"`
      );
    }
  }
}

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
export const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

export async function updateMessageStatus({ wamid, status, error, code }) {
  if (!wamid || !(STATUS_RANK[status] || status === 'failed')) {
    return { updated: false };
  }

  let finalError = String(error ?? '').trim();
  if (status === 'failed') {
    if (code === 131042 || code === 131056 || /131042|131056|payment|pago|credit limit|facturaci[oó]n|restringid/i.test(finalError)) {
      finalError = 'Cuenta suspendida en Meta por falta de pago o límite alcanzado. Paga en Meta Business Suite.';
    } else if (!finalError) {
      finalError = 'WhatsApp reportó que el mensaje no se pudo entregar';
    }
  }

  const { rows } = status === 'failed'
    ? await pool.query(
        `UPDATE n8n_chat_histories
         SET message = jsonb_set(
               jsonb_set(message, '{additional_kwargs,status}', '"failed"'),
               '{additional_kwargs,statusError}', to_jsonb($2::text))
         WHERE message->'additional_kwargs'->>'wamid' = $1
         RETURNING session_id`,
        [wamid, finalError.slice(0, 500)]
      )
    : await pool.query(
        `UPDATE n8n_chat_histories
         SET message = jsonb_set(message, '{additional_kwargs,status}', to_jsonb($2::text))
         WHERE message->'additional_kwargs'->>'wamid' = $1
           AND (
             message->'additional_kwargs'->>'status' IS NULL
             OR $3 > CASE message->'additional_kwargs'->>'status' WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END
           )
           AND coalesce(message->'additional_kwargs'->>'status', '') <> 'failed'
         RETURNING session_id`,
        [wamid, status, STATUS_RANK[status]]
      );
  if (rows.length) {
    await pool.query(`SELECT pg_notify('message_changes', json_build_object('session_id', $1::text)::text)`, [rows[0].session_id]);
  }
  return { updated: rows.length > 0 };
}

inboundRouter.post('/status', async (req, res, next) => {
  try {
    const { wamid, status, error } = req.body ?? {};
    if (!wamid || !(STATUS_RANK[status] || status === 'failed')) {
      return res.status(400).json({ error: 'wamid and a valid status required' });
    }
    const result = await updateMessageStatus({ wamid, status, error });
    res.json(result);
  } catch (err) { next(err); }
});


export default router;
