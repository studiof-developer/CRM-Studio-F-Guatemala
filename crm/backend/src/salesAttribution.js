import { pool } from './db.js';
import { logBusinessAction } from './auditLog.js';
import { broadcast } from './events.js';

export const CONFIRMATION_PHRASES_REGEX = /\b(gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado|verificado|acreditado)|comprobante\s+(recibido|verificado|confirmado)|pedido\s+(confirmado|registrado)|hemos\s+recibido\s+(su|tu)\s+pago|confirmamos\s+(su|tu)\s+pago|ya\s+qued[oó]\s+registrad[ao]|pago\s+con\s+[eé]xito|muchas\s+gracias\s+por\s+(su|tu)\s+pago)\b/i;

export function isConfirmationMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return CONFIRMATION_PHRASES_REGEX.test(text.trim());
}

/**
 * Automatically attributes and records a sale for a customer if not already recorded today.
 * Looks up the attending advisor from recent chat history or ticket assignment,
 * and looks up amount from quotes or OCR receipts if not explicitly provided.
 */
export async function autoRecordSale({
  customerId,
  ticketId = null,
  user = null,
  paymentMethod = null,
  amount = null,
  notes = null,
  createdAt = null,
  receiptAmount = null,
  channel = null,
  attributedBy: explicitAttributedBy = null,
}) {
  if (!customerId) return null;

  try {
    // 1. Prevent duplicates for the same purchase. Same customer + same day counts as the
    // same sale, unless an explicit amount is given that differs from every sale already
    // recorded that day (a genuine second purchase).
    const dateCheckSql = createdAt
      ? `AND date_trunc('day', created_at AT TIME ZONE 'America/Guatemala') = date_trunc('day', $2::timestamptz AT TIME ZONE 'America/Guatemala')`
      : `AND date_trunc('day', created_at AT TIME ZONE 'America/Guatemala') = date_trunc('day', now() AT TIME ZONE 'America/Guatemala')`;
    const dateParams = createdAt ? [customerId, createdAt] : [customerId];

    const { rows: existingSales } = await pool.query(
      `SELECT id, amount FROM sales WHERE customer_id = $1 ${dateCheckSql} ORDER BY id DESC`,
      dateParams
    );

    if (existingSales.length > 0) {
      const explicitAmount = Number(amount);
      const isNewPurchase = explicitAmount > 0
        && !existingSales.some((s) => Math.abs(Number(s.amount) - explicitAmount) < 0.5);
      if (!isNewPurchase) return existingSales[0]; // Already recorded
    }

    // 2. Fetch customer details
    const { rows: custRows } = await pool.query(
      `SELECT id, whatsapp_number, full_name, paid_method FROM customers WHERE id = $1`,
      [customerId]
    );
    if (!custRows.length) return null;
    const customer = custRows[0];

    // 3. Resolve ticket and whatsapp line
    let resolvedTicketId = ticketId;
    let resolvedLineId = null;
    let ticketAdvisor = null;

    if (!resolvedTicketId) {
      const { rows: tRows } = await pool.query(
        `SELECT id, whatsapp_number_id, assigned_advisor 
         FROM tickets 
         WHERE customer_id = $1 
         ORDER BY (status = 'resuelto') ASC, id DESC LIMIT 1`,
        [customerId]
      );
      if (tRows.length) {
        resolvedTicketId = tRows[0].id;
        resolvedLineId = tRows[0].whatsapp_number_id;
        ticketAdvisor = tRows[0].assigned_advisor;
      }
    } else {
      const { rows: tRows } = await pool.query(
        `SELECT whatsapp_number_id, assigned_advisor FROM tickets WHERE id = $1`,
        [resolvedTicketId]
      );
      if (tRows.length) {
        resolvedLineId = tRows[0].whatsapp_number_id;
        ticketAdvisor = tRows[0].assigned_advisor;
      }
    }

    // 4. Resolve attending advisor, recording which rule decided it so every sale can be
    // defended later: click_manual > ultimo_mensaje_asesor (48h) > ticket > sin_atribuir.
    let advisorName = null;
    let advisorId = null;
    let attributedBy = null;

    // If a human advisor triggered the action (not OCR or system), prioritize them
    if (user && user.id && user.fullName && !user.fullName.includes('OCR') && !user.fullName.includes('Sistema')) {
      advisorName = user.fullName;
      advisorId = user.id;
      attributedBy = 'click_manual';
    }

    // Otherwise, the advisor who last wrote to this customer in the 48h before the payment
    if (!advisorName && customer.whatsapp_number) {
      const timeFilter = createdAt
        ? `AND h.created_at <= $2::timestamptz + interval '1 hour' AND h.created_at >= $2::timestamptz - interval '48 hours'`
        : `AND h.created_at >= now() - interval '48 hours'`;
      const chatParams = createdAt ? [customer.whatsapp_number, createdAt] : [customer.whatsapp_number];

      const { rows: chatAdvisorRows } = await pool.query(
        `SELECT h.message->'additional_kwargs'->>'advisorName' AS advisor_name
         FROM n8n_chat_histories h
         WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%')
           AND h.message->>'type' = 'ai'
           AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
           ${timeFilter}
         ORDER BY h.id DESC
         LIMIT 1`,
        chatParams
      );

      if (chatAdvisorRows.length && chatAdvisorRows[0].advisor_name) {
        advisorName = chatAdvisorRows[0].advisor_name;
        attributedBy = 'ultimo_mensaje_asesor';
      }
    }

    // Check social_messages if WhatsApp history didn't find anyone (e.g. Instagram / Messenger customers)
    if (!advisorName) {
      const { rows: socialAdvisorRows } = await pool.query(
        `SELECT sm.advisor_name, sm.advisor_id
         FROM social_contacts sc
         JOIN social_messages sm ON sm.contact_id = sc.id
         WHERE sc.customer_id = $1
           AND sm.direction = 'out'
           AND sm.advisor_name IS NOT NULL
           AND sm.created_at >= now() - interval '48 hours'
         ORDER BY sm.id DESC LIMIT 1`,
        [customerId]
      );
      if (socialAdvisorRows.length) {
        advisorName = socialAdvisorRows[0].advisor_name;
        advisorId = socialAdvisorRows[0].advisor_id;
        attributedBy = 'social_mensaje_asesor';
      }
    }

    // Fallback to ticket's assigned advisor
    if (!advisorName && ticketAdvisor) {
      advisorName = ticketAdvisor;
      attributedBy = 'ticket';
    }

    // If caller specified an explicit rule (e.g. 'mensaje_confirmacion'), preserve it
    if (explicitAttributedBy) {
      attributedBy = explicitAttributedBy;
    }

    // Never a generic "Asesor": an unattributable sale is visible in the report so it can
    // be assigned by hand instead of being credited to the wrong person.
    if (!advisorName) {
      advisorName = 'Sin atribuir';
      attributedBy = 'sin_atribuir';
    }

    // Find user ID for advisorName if not known
    if (!advisorId && attributedBy !== 'sin_atribuir') {
      const { rows: uRows } = await pool.query(
        `SELECT id, full_name FROM users WHERE full_name ILIKE $1 OR username ILIKE $1 LIMIT 1`,
        [advisorName]
      );
      if (uRows.length) {
        advisorId = uRows[0].id;
        advisorName = uRows[0].full_name; // Normalize name
      }
    }

    // 5. Resolve amount if not provided, keeping the evidence of where it came from.
    let numAmount = Number(amount);
    let resolvedQuoteId = null;
    let amountSource = numAmount > 0 ? (receiptAmount ? 'ocr' : 'manual') : null;

    // Latest quote, always looked up: it's the reference the receipt is validated against.
    const { rows: qRows } = await pool.query(
      `SELECT id, grand_total FROM quotes WHERE customer_id = $1 ORDER BY id DESC LIMIT 1`,
      [customerId]
    );
    const quotedAmount = qRows.length && Number(qRows[0].grand_total) > 0 ? Number(qRows[0].grand_total) : null;

    if (isNaN(numAmount) || numAmount <= 0) {
      if (quotedAmount) {
        numAmount = quotedAmount;
        resolvedQuoteId = qRows[0].id;
        amountSource = 'cotizacion';
      } else if (customer.whatsapp_number) {
        // Check for OCR receipt amount
        const { rows: ocrRows } = await pool.query(
          `SELECT CASE
             WHEN (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
             THEN (h.message->'additional_kwargs'->>'ocrAmount')::numeric
             ELSE 0
           END AS ocr_amount
           FROM n8n_chat_histories h
           WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%')
             AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
           ORDER BY h.id DESC
           LIMIT 1`,
          [customer.whatsapp_number]
        );
        if (ocrRows.length && Number(ocrRows[0].ocr_amount) > 0) {
          numAmount = Number(ocrRows[0].ocr_amount);
          amountSource = 'ocr';
        } else {
          numAmount = 0; // Default to 0 quetzales so the sale count is accurately captured
        }
      } else {
        numAmount = 0;
      }
    }

    const finalReceipt = Number(receiptAmount) > 0 ? Number(receiptAmount) : (amountSource === 'ocr' ? numAmount : null);
    const amountMatch = quotedAmount && finalReceipt ? Math.abs(quotedAmount - finalReceipt) < 0.5 : null;

    // A sale with no amount or no attributable advisor, or whose receipt doesn't match
    // the quote, still counts as recorded but is flagged for review.
    const needsReview = numAmount <= 0 || attributedBy === 'sin_atribuir' || amountMatch === false;
    const finalMethod = paymentMethod || customer.paid_method || 'transferencia';
    const finalNotes = notes || 'Venta registrada automáticamente al confirmar pago';

    // 6. Insert sale
    const { rows: inserted } = await pool.query(
      `INSERT INTO sales (
        customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method,
        quote_id, notes, whatsapp_number_id, created_at,
        status, amount_source, quoted_amount, receipt_amount, amount_match,
        attributed_by, confirmed_at, channel
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()),
        $11, $12, $13, $14, $15, $16, COALESCE($10, now()), $17)
      RETURNING *`,
      [
        customerId,
        resolvedTicketId,
        advisorId,
        advisorName,
        numAmount,
        finalMethod,
        resolvedQuoteId,
        finalNotes,
        resolvedLineId,
        createdAt || null,
        needsReview ? 'revisar' : 'confirmada',
        amountSource,
        quotedAmount,
        finalReceipt,
        amountMatch,
        attributedBy,
        channel || (customer.whatsapp_number ? 'whatsapp' : null),
      ]
    );

    const sale = inserted[0];

    logBusinessAction(
      user || { fullName: advisorName, id: advisorId },
      customerId,
      'sale_recorded',
      `Q${numAmount.toFixed(2)} (${finalMethod}) atribuido automáticamente a ${advisorName}`
    );

    return sale;
  } catch (err) {
    console.error('autoRecordSale error:', err);
    return null;
  }
}

/**
 * Automatically validates and confirms a sale when an attending advisor sends
 * a purchase confirmation / thank-you phrase ("gracias por su compra", "pago recibido", etc.)
 */
export async function confirmSaleByAdvisorMessage({ customerId, user, channel = 'whatsapp', notes = null }) {
  if (!customerId || !user?.fullName) return null;

  try {
    // 1. Mark customer as paid if not already paid_locked
    const { rows: custRows } = await pool.query(
      `SELECT id, paid_locked, manual_status FROM customers WHERE id = $1`,
      [customerId]
    );
    if (!custRows.length) return null;
    const cust = custRows[0];

    if (!cust.paid_locked) {
      await pool.query(
        `UPDATE customers SET
           paid_locked = true,
           manual_status = 'pagado',
           payment_suggested_at = NULL,
           payment_suggestion_reason = NULL,
           payment_suggestion_method = NULL,
           updated_at = now()
         WHERE id = $1`,
        [customerId]
      );
    }

    // 2. Check if a sale was already recorded today in 'revisar' status
    const { rows: todaySales } = await pool.query(
      `SELECT id, status FROM sales
       WHERE customer_id = $1
         AND date_trunc('day', created_at AT TIME ZONE 'America/Guatemala') = date_trunc('day', now() AT TIME ZONE 'America/Guatemala')
       ORDER BY id DESC LIMIT 1`,
      [customerId]
    );

    if (todaySales.length && todaySales[0].status === 'revisar') {
      const saleId = todaySales[0].id;
      const { rows: updated } = await pool.query(
        `UPDATE sales SET
           status = 'confirmada',
           advisor_id = COALESCE($2, advisor_id),
           advisor_name = COALESCE($3, advisor_name),
           attributed_by = 'mensaje_confirmacion',
           confirmed_at = now(),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [saleId, user.id || null, user.fullName]
      );
      broadcast('sales_changes', JSON.stringify({ saleId }));
      return updated[0];
    }

    // 3. Otherwise, record a new confirmed sale attributed to this advisor
    const sale = await autoRecordSale({
      customerId,
      user,
      notes: notes || 'Confirmado por mensaje de asesor (gracias por su compra)',
      channel,
      attributedBy: 'mensaje_confirmacion',
    });

    if (sale?.id) {
      // Ensure status is confirmada and advisor is explicitly set
      await pool.query(
        `UPDATE sales SET status = 'confirmada', advisor_id = COALESCE($2, advisor_id),
                advisor_name = COALESCE($3, advisor_name), attributed_by = 'mensaje_confirmacion'
         WHERE id = $1`,
        [sale.id, user.id || null, user.fullName]
      );
      broadcast('sales_changes', JSON.stringify({ saleId: sale.id }));
    }

    return sale;
  } catch (err) {
    console.error('confirmSaleByAdvisorMessage error:', err);
    return null;
  }
}

