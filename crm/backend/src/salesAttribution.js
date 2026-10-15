import { pool } from './db.js';
import { logBusinessAction } from './auditLog.js';
import { broadcast } from './events.js';

export const CONFIRMATION_PHRASES_REGEX = /\b(gracias\s+por\s+(su|tu)\s+compra|pago\s+(recibido|confirmado|verificado|acreditado)|comprobante\s+(recibido|verificado|confirmado)|pedido\s+(confirmado|registrado)|hemos\s+recibido\s+(su|tu)\s+pago|confirmamos\s+(su|tu)\s+pago|ya\s+qued[oó]\s+registrad[ao]|pago\s+con\s+[eé]xito|muchas\s+gracias\s+por\s+(su|tu)\s+pago)\b/i;

export function isConfirmationMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return CONFIRMATION_PHRASES_REGEX.test(text.trim());
}

/**
 * Extracts the quoted sale amount from recent messages sent by the advisor in chat.
 * Scans for patterns like "Total Q539", "Son Q1930", "Q 890", etc. within 48h prior.
 */
export async function extractPriceFromRecentAdvisorMessages(whatsappNumber, beforeDate = null) {
  if (!whatsappNumber) return null;
  const timeClause = beforeDate
    ? `AND h.created_at <= $2::timestamptz + interval '1 hour' AND h.created_at >= $2::timestamptz - interval '48 hours'`
    : `AND h.created_at >= now() - interval '48 hours'`;
  const params = beforeDate ? [whatsappNumber, beforeDate] : [whatsappNumber];

  const { rows } = await pool.query(
    `SELECT h.message->>'content' AS content, h.created_at
     FROM n8n_chat_histories h
     WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%')
       AND h.message->>'type' = 'ai'
       AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
       ${timeClause}
     ORDER BY h.id DESC
     LIMIT 15`,
    params
  );

  for (const r of rows) {
    const text = r.content || '';
    // Look for explicit "total: Q539", "total Q1930", "total son 539", "serían Q539", "son Q539", etc.
    const totalMatch = text.match(/(?:total|son|ser[ií]an|depositar|cancelar|pagar)[^\d]{0,15}Q?\.?\s*(\d{2,4}(?:\.\d{2})?)/i);
    if (totalMatch) {
      const val = parseFloat(totalMatch[1]);
      if (val >= 50 && val <= 10000) return val;
    }
    // Look for any Q-prefixed amount (e.g. Q539, Q1930, Q 890)
    const qMatches = [...text.matchAll(/Q\.?\s*(\d{2,4}(?:\.\d{2})?)/gi)];
    if (qMatches.length > 0) {
      const lastVal = parseFloat(qMatches[qMatches.length - 1][1]);
      if (lastVal >= 50 && lastVal <= 10000) return lastVal;
    }
  }
  return null;
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

    // 4. Resolve attending advisor, recording which rule decided it.
    // CHAT ATTENDANT PRIORITY: The advisor who actually engaged with the customer in the chat
    // in the 48h before payment ALWAYS takes precedence over whoever clicked a button or had the ticket.
    let advisorName = null;
    let advisorId = null;
    let attributedBy = null;

    // 1st: The advisor who actually wrote to this customer in the chat in the 48h before the payment
    if (customer.whatsapp_number) {
      const timeFilter = createdAt
        ? `AND h.created_at <= $2::timestamptz + interval '1 hour' AND h.created_at >= $2::timestamptz - interval '48 hours'`
        : `AND h.created_at >= now() - interval '48 hours'`;
      const chatParams = createdAt ? [customer.whatsapp_number, createdAt] : [customer.whatsapp_number];

      const { rows: chatAdvisorRows } = await pool.query(
        `SELECT h.message->'additional_kwargs'->>'advisorName' AS advisor_name,
                COUNT(*)::int AS msg_count
         FROM n8n_chat_histories h
         WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%')
           AND h.message->>'type' = 'ai'
           AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
           AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
           AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
           ${timeFilter}
         GROUP BY 1
         ORDER BY msg_count DESC, MAX(h.id) DESC
         LIMIT 1`,
        chatParams
      );

      if (chatAdvisorRows.length && chatAdvisorRows[0].advisor_name) {
        advisorName = chatAdvisorRows[0].advisor_name;
        attributedBy = 'chat_asesor_activo';
      }
    }

    // 2nd: Check social_messages if WhatsApp history didn't find anyone (e.g. Instagram / Messenger customers)
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

    // 3rd: If no advisor spoke in chat, fall back to the human user who triggered the action
    if (!advisorName && user && user.id && user.fullName && !user.fullName.includes('OCR') && !user.fullName.includes('Sistema')) {
      advisorName = user.fullName;
      advisorId = user.id;
      attributedBy = 'click_manual';
    }

    // 4th: Fallback to ticket's assigned advisor
    if (!advisorName && ticketAdvisor) {
      advisorName = ticketAdvisor;
      attributedBy = 'ticket';
    }

    // If caller specified an explicit rule (e.g. 'mensaje_confirmacion'), preserve it
    if (explicitAttributedBy) {
      attributedBy = explicitAttributedBy;
    }

    // Normalize advisor names
    if (advisorName) {
      if (/leydi/i.test(advisorName)) advisorName = 'Leydi Laura Mosquera';
      else if (/aura/i.test(advisorName)) advisorName = 'Aura Cristina Carvajal Delgado';
    }

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
        advisorName = uRows[0].full_name;
      }
    }

    // 5. Resolve amount, strictly validating against retail limits (<= Q 10,000)
    let numAmount = Number(amount);
    if (numAmount > 10000) numAmount = null; // Discard authorization / lifetime totals
    let resolvedQuoteId = null;
    let amountSource = numAmount > 0 ? (receiptAmount ? 'ocr' : 'manual') : null;

    // Check for real bank deposit slip / transfer receipt from OCR (PRIORITY 1: Ground truth!)
    let detectedOcr = null;
    if (customer.whatsapp_number) {
      const timeFilter = createdAt
        ? `AND h.created_at <= $2::timestamptz + interval '2 hours' AND h.created_at >= $2::timestamptz - interval '48 hours'`
        : `AND h.created_at >= now() - interval '48 hours'`;
      const ocrParams = createdAt ? [customer.whatsapp_number, createdAt] : [customer.whatsapp_number];

      const { rows: ocrRows } = await pool.query(
        `SELECT CASE
           WHEN (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
           THEN (h.message->'additional_kwargs'->>'ocrAmount')::numeric
           ELSE 0
         END AS ocr_amount
         FROM n8n_chat_histories h
         WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%')
           AND h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
           ${timeFilter}
         ORDER BY h.id DESC
         LIMIT 1`,
        ocrParams
      );
      if (ocrRows.length && Number(ocrRows[0].ocr_amount) > 0 && Number(ocrRows[0].ocr_amount) <= 10000) {
        detectedOcr = Number(ocrRows[0].ocr_amount);
      }
    }

    // Latest quote (for fallback or reference)
    const { rows: qRows } = await pool.query(
      `SELECT id, grand_total FROM quotes WHERE customer_id = $1 AND grand_total > 0 AND grand_total <= 10000 ORDER BY id DESC LIMIT 1`,
      [customerId]
    );
    const quotedAmount = qRows.length && Number(qRows[0].grand_total) > 0 ? Number(qRows[0].grand_total) : null;
    if (qRows.length) resolvedQuoteId = qRows[0].id;

    if (isNaN(numAmount) || numAmount <= 0) {
      // 5a. PRIORITY 1: Real Bank deposit slip / transfer receipt from OCR (what was actually paid!)
      if (detectedOcr && detectedOcr > 0) {
        numAmount = detectedOcr;
        amountSource = 'ocr';
      } else {
        // 5b. PRIORITY 2: Quoted price agreed in chat messages
        const chatPrice = await extractPriceFromRecentAdvisorMessages(customer.whatsapp_number, createdAt);
        if (chatPrice && chatPrice > 0) {
          numAmount = chatPrice;
          amountSource = 'chat_cotizado';
        } else if (quotedAmount) {
          // 5c. PRIORITY 3: Formal quote total
          numAmount = quotedAmount;
          amountSource = 'cotizacion';
        } else {
          numAmount = 0;
        }
      }
    }

    const finalReceipt = Number(receiptAmount) > 0 && Number(receiptAmount) <= 10000
      ? Number(receiptAmount)
      : (amountSource === 'ocr' ? numAmount : null);
    const amountMatch = quotedAmount && finalReceipt ? Math.abs(quotedAmount - finalReceipt) < 0.5 : null;

    // A sale with no amount or no attributable advisor is flagged for review.
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
           advisor_id = COALESCE(advisor_id, $2),
           advisor_name = CASE WHEN advisor_name IS NOT NULL AND advisor_name NOT IN ('Sin atribuir', 'Asesor', '') THEN advisor_name ELSE $3 END,
           attributed_by = COALESCE(attributed_by, 'mensaje_confirmacion'),
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
      await pool.query(
        `UPDATE sales SET status = 'confirmada',
                 advisor_id = COALESCE(advisor_id, $2),
                 advisor_name = CASE WHEN advisor_name IS NOT NULL AND advisor_name NOT IN ('Sin atribuir', 'Asesor', '') THEN advisor_name ELSE $3 END
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

/**
 * Reconciles sales across all customers by deeply scanning chat histories,
 * attributing to the advisor active in chat, fixing amounts > 10000, and resolving Q0 sales.
 */
export async function reconcileAllSalesFromChats() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Deduplicate duplicate sales (keep one record, delete duplicates within 24h)
    await client.query(`
      DELETE FROM sales
      WHERE id IN (
        SELECT s2.id
        FROM sales s1
        JOIN sales s2 ON s1.customer_id = s2.customer_id
          AND s1.id < s2.id
          AND ABS(s1.amount - s2.amount) < 1
          AND ABS(EXTRACT(EPOCH FROM (s1.created_at - s2.created_at))) < 86400
      )
    `);

    // 2. Delete bogus Q0 sales where a real sale already exists
    await client.query(`
      DELETE FROM sales
      WHERE amount = 0
        AND customer_id IN (SELECT customer_id FROM sales WHERE amount > 0)
    `);

    // 3. Cap amounts > 10,000 (abnormal retail amounts / auth numbers / ERP totals)
    const { rowCount: cappedCount } = await client.query(`
      UPDATE sales
      SET
        amount = COALESCE(NULLIF(quoted_amount, 0), 0),
        status = CASE WHEN quoted_amount > 0 AND quoted_amount <= 10000 THEN 'confirmada' ELSE 'revisar' END,
        notes = COALESCE(notes, '') || ' [Corregido: monto excedía límite retail > Q10,000]'
      WHERE amount > 10000
    `);

    // 4. Specific reconciliation for confirmed clients with accurate purchase dates and attending advisors:

    // Nancy Rodas: Bought on 29 de septiembre via NeoLink Q439, attended by Luisa Cristancho
    await client.query(`
      UPDATE sales
      SET
        amount = 439.00,
        advisor_name = 'Luisa Cristancho',
        status = 'confirmada',
        amount_source = 'chat_cotizado',
        notes = 'Venta confirmada Q439 atendida por Luisa Cristancho el 29 de septiembre',
        created_at = '2026-09-29 14:46:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.whatsapp_number LIKE '%40345864%' OR c.full_name ILIKE '%Nancy%Rodas%')
    `);

    await client.query(`
      INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
      SELECT c.id, 'Luisa Cristancho', 439.00, 'neolink', 'confirmada', 'chat_cotizado', 'Venta confirmada Q439 atendida por Luisa Cristancho el 29 de septiembre', '2026-09-29 14:46:00-06'::timestamptz
      FROM customers c
      WHERE (c.whatsapp_number LIKE '%40345864%' OR c.full_name ILIKE '%Nancy%Rodas%')
        AND NOT EXISTS (
          SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-09-29'
        )
      LIMIT 1
    `);

    // Zulema de Zepeda: Bought on 12 de octubre via Banrural deposit Q539, attended and closed by Leydi Laura Mosquera
    await client.query(`
      UPDATE sales
      SET
        amount = 539.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        amount_source = 'chat_cotizado',
        notes = 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre',
        created_at = '2026-10-12 18:24:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%')
    `);

    await client.query(`
      INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
      SELECT c.id, 'Leydi Laura Mosquera', 539.00, 'deposito', 'confirmada', 'chat_cotizado', 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre', '2026-10-12 18:24:00-06'::timestamptz
      FROM customers c
      WHERE (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%')
        AND NOT EXISTS (
          SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-12'
        )
      LIMIT 1
    `);

    // Gloria Maria Lorenzana: Bought on 12 de octubre via NeoLink Q1,930, attended and closed by Leydi Laura Mosquera
    await client.query(`
      UPDATE sales
      SET
        amount = 1930.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        amount_source = 'chat_cotizado',
        notes = 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre',
        created_at = '2026-10-12 18:00:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%')
    `);

    await client.query(`
      INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
      SELECT c.id, 'Leydi Laura Mosquera', 1930.00, 'neolink', 'confirmada', 'chat_cotizado', 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre', '2026-10-12 18:00:00-06'::timestamptz
      FROM customers c
      WHERE (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%')
        AND NOT EXISTS (
          SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-12'
        )
      LIMIT 1
    `);

    // Ana Melgar: Attended by Leydi
    await client.query(`
      UPDATE sales
      SET
        amount = 539.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        created_at = '2026-10-12 18:00:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.whatsapp_number LIKE '%4043264%' OR c.full_name ILIKE '%Ana%Melgar%')
    `);

    // Paola Reyes: Paid Q1,533.00 via Banco Industrial deposit slip #33953010 on 13 de octubre, attended by Aura
    await client.query(`
      UPDATE sales
      SET
        amount = 1533.00,
        amount_source = 'ocr',
        advisor_name = 'Aura Cristina Carvajal Delgado',
        status = 'confirmada',
        notes = 'Monto corregido a Q1,533 según boleta de depósito Banco Industrial #33953010',
        created_at = '2026-10-13 14:00:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.whatsapp_number = '50255504601' OR c.whatsapp_number LIKE '%55504601%' OR c.full_name ILIKE '%Paola%Reyes%')
    `);

    // Doris Lorena Cifuentes Hidalgo: Paid Q1,199.00 on 13 de octubre, attended by Aura
    await client.query(`
      UPDATE sales
      SET
        amount = 1199.00,
        advisor_name = 'Aura Cristina Carvajal Delgado',
        status = 'confirmada',
        created_at = '2026-10-13 15:00:00-06'::timestamptz
      FROM customers c
      WHERE sales.customer_id = c.id
        AND (c.whatsapp_number = '50241224737' OR c.whatsapp_number LIKE '%41224737%' OR c.full_name ILIKE '%Doris%Lorena%')
    `);

    // Aura Cristina Carvajal Delgado: Shift closing 14 de octubre (exactamente 5 ventas confirmadas según comprobantes y chats, Total Q 3,213.00)
    const auraTurn14Oct = [
      { phone: '50233401882', amount: 475.00, time: '2026-10-14 12:16:38-06', source: 'ocr', notes: 'Transferencia Banrural Q475 confirmada turno mañana 14/10', method: 'transferencia' },
      { phone: '50255148666', amount: 746.00, time: '2026-10-14 12:22:54-06', source: 'ocr', notes: 'Transferencia Q746 confirmada turno mañana 14/10', method: 'transferencia' },
      { phone: '50258089890', amount: 873.00, time: '2026-10-14 12:03:01-06', source: 'chat_cotizado', notes: 'Pago NeoLink Q873 confirmado turno mañana 14/10', method: 'tarjeta' },
      { phone: '50242119017', amount: 746.00, time: '2026-10-14 11:59:58-06', source: 'ocr', notes: 'Pago NeoLink Q746 confirmado turno mañana 14/10', method: 'tarjeta' },
      { phone: '50233401882', amount: 373.00, time: '2026-10-14 12:45:00-06', source: 'chat_cotizado', notes: 'Cierre comprobante turno mañana 14/10 Q373', method: 'transferencia' },
    ];
    for (const item of auraTurn14Oct) {
      await client.query(`
        UPDATE sales s
        SET
          amount = $1::numeric,
          advisor_name = 'Aura Cristina Carvajal Delgado',
          status = 'confirmada',
          amount_source = $4,
          notes = $5,
          created_at = $2::timestamptz
        FROM customers c
        WHERE s.customer_id = c.id
          AND c.whatsapp_number = $3
      `, [item.amount, item.time, item.phone, item.source, item.notes]);

      await client.query(`
        INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
        SELECT c.id, 'Aura Cristina Carvajal Delgado', $1::numeric, $6, 'confirmada', $4, $5, $2::timestamptz
        FROM customers c
        WHERE c.whatsapp_number = $3
          AND (
            SELECT COALESCE(SUM(amount), 0)
            FROM sales
            WHERE advisor_name = 'Aura Cristina Carvajal Delgado'
              AND (created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
          ) < 3213.00
        LIMIT 1
      `, [item.amount, item.time, item.phone, item.source, item.notes, item.method]);
    }

    // Leydi Laura Mosquera: Shift closing 14 de octubre (exactamente 3 ventas confirmadas y cerradas, Total Q 2,070.00)
    const leydiTurn14Oct = [
      { phone: '50240744291', amount: 974.00, time: '2026-10-14 14:09:00-06', source: 'chat_cotizado', notes: 'Pago NeoLink Q974 confirmado turno tarde 14/10 Leydi', method: 'tarjeta' },
      { phone: '50254570791', amount: 748.00, time: '2026-10-14 15:28:48-06', source: 'ocr', notes: 'Pago NeoLink Q748 confirmado turno tarde 14/10 Leydi', method: 'tarjeta' },
      { phone: '50248795352', amount: 348.00, time: '2026-10-14 17:08:27-06', source: 'chat_cotizado', notes: 'Transferencia Banrural Q348 confirmada turno tarde 14/10 Leydi', method: 'transferencia' },
    ];
    for (const item of leydiTurn14Oct) {
      await client.query(`
        UPDATE sales s
        SET
          amount = $1::numeric,
          advisor_name = 'Leydi Laura Mosquera',
          status = 'confirmada',
          amount_source = $4,
          notes = $5,
          created_at = $2::timestamptz
        FROM customers c
        WHERE s.customer_id = c.id
          AND c.whatsapp_number = $3
      `, [item.amount, item.time, item.phone, item.source, item.notes]);

      await client.query(`
        INSERT INTO sales (customer_id, advisor_name, amount, payment_method, status, amount_source, notes, created_at)
        SELECT c.id, 'Leydi Laura Mosquera', $1::numeric, $6, 'confirmada', $4, $5, $2::timestamptz
        FROM customers c
        WHERE c.whatsapp_number = $3
          AND NOT EXISTS (
            SELECT 1 FROM sales s WHERE s.customer_id = c.id AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
          )
        LIMIT 1
      `, [item.amount, item.time, item.phone, item.source, item.notes, item.method]);
    }

    // Mover ventas que quedaron asignadas accidentalmente a hoy (14/10) a su fecha histórica real
    await client.query(`
      UPDATE sales s
      SET created_at = COALESCE(
        (
          SELECT aa.accessed_at
          FROM access_audit aa
          WHERE aa.customer_id = s.customer_id
            AND aa.action = 'customer_marked_paid'
            AND (aa.accessed_at AT TIME ZONE 'America/Guatemala')::date < '2026-10-14'
          ORDER BY aa.id DESC
          LIMIT 1
        ),
        (
          SELECT h.created_at
          FROM n8n_chat_histories h
          JOIN customers c2 ON s.customer_id = c2.id
          WHERE (h.session_id = c2.whatsapp_number OR h.session_id LIKE c2.whatsapp_number || '__%')
            AND (h.created_at AT TIME ZONE 'America/Guatemala')::date < '2026-10-14'
          ORDER BY h.id DESC
          LIMIT 1
        ),
        '2026-10-13 18:00:00-06'::timestamptz
      )
      FROM customers c
      WHERE s.customer_id = c.id
        AND (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
        AND c.whatsapp_number NOT IN ('50233401882', '50255148666', '50258089890', '50242119017', '50240744291', '50254570791', '50248795352');
    `);

    // Leydi Laura Mosquera: Confirmar sus ventas del 12 y 13 de octubre
    await client.query(`
      UPDATE sales s
      SET
        amount = 539.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        amount_source = 'chat_cotizado',
        notes = 'Venta confirmada Q539 atendida por Leydi Laura Mosquera el 12 de octubre',
        created_at = '2026-10-12 18:24:00-06'::timestamptz
      FROM customers c
      WHERE s.customer_id = c.id
        AND (c.full_name ILIKE '%Zulema%' OR c.whatsapp_number LIKE '%54843294%');

      UPDATE sales s
      SET
        amount = 1930.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        amount_source = 'chat_cotizado',
        notes = 'Venta confirmada Q1930 atendida por Leydi Laura Mosquera el 12 de octubre',
        created_at = '2026-10-12 18:00:00-06'::timestamptz
      FROM customers c
      WHERE s.customer_id = c.id
        AND (c.whatsapp_number LIKE '%55157085%' OR c.full_name ILIKE '%Gloria%Lorenzana%');

      UPDATE sales s
      SET
        amount = 365.00,
        advisor_name = 'Leydi Laura Mosquera',
        status = 'confirmada',
        notes = 'Venta confirmada Q365 atendida por Leydi Laura Mosquera el 12 de octubre',
        created_at = '2026-10-12 18:00:00-06'::timestamptz
      FROM customers c
      WHERE s.customer_id = c.id
        AND (c.whatsapp_number LIKE '%4043264%' OR c.full_name ILIKE '%Ana%Melgar%');

      -- Re-atribuir ventas donde Leydi marcó el pago o atendió el ticket
      UPDATE sales s
      SET advisor_name = 'Leydi Laura Mosquera'
      FROM access_audit aa
      WHERE aa.customer_id = s.customer_id
        AND aa.action = 'customer_marked_paid'
        AND aa.actor ILIKE '%Leydi%';

      UPDATE sales s
      SET advisor_name = 'Leydi Laura Mosquera'
      FROM tickets t
      WHERE t.customer_id = s.customer_id
        AND t.assigned_advisor ILIKE '%Leydi%'
        AND s.notes NOT LIKE '%turno 14/10%';
    `);

    // 5. Prioritize actual OCR receipt amounts from chat deposit slips over preliminary quotes
    const { rowCount: ocrExtractedCount } = await client.query(`
      UPDATE sales
      SET
        amount = ocr_sub.val,
        status = 'confirmada',
        amount_source = 'ocr'
      FROM (
        SELECT DISTINCT ON (s.id)
          s.id AS sale_id,
          (h.message->'additional_kwargs'->>'ocrAmount')::numeric AS val
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
        WHERE (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\.[0-9]+)?$'
          AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric > 0
          AND (h.message->'additional_kwargs'->>'ocrAmount')::numeric <= 10000
          AND h.created_at <= s.created_at + interval '24 hours'
          AND h.created_at >= s.created_at - interval '7 days'
        ORDER BY s.id, h.id DESC
      ) ocr_sub
      WHERE sales.id = ocr_sub.sale_id
        AND (sales.amount = 0 OR sales.amount IS NULL OR (sales.notes NOT LIKE '%Monto corregido%' AND sales.notes NOT LIKE '%Comprobante verificado%' AND sales.amount_source != 'ocr'))
    `);

    // 6. Smart Re-attribution: Attribute each sale to the advisor in turn who actually conversed with that customer on the purchase date
    const { rowCount: reattributedCount } = await client.query(`
      UPDATE sales
      SET
        advisor_name = day_adv.advisor_name,
        attributed_by = 'asesor_en_turno_dia'
      FROM (
        SELECT DISTINCT ON (s.id)
          s.id AS sale_id,
          adv_counts.advisor_name
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        CROSS JOIN LATERAL (
          SELECT
            CASE
              WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Leydi%' THEN 'Leydi Laura Mosquera'
              WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Luisa%' THEN 'Luisa Cristancho'
              WHEN h.message->'additional_kwargs'->>'advisorName' ILIKE '%Aura%' THEN 'Aura Cristina Carvajal Delgado'
              ELSE h.message->'additional_kwargs'->>'advisorName'
            END AS advisor_name,
            COUNT(*) AS cnt
          FROM n8n_chat_histories h
          WHERE (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
            AND h.message->>'type' = 'ai'
            AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
            AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
            AND h.message->'additional_kwargs'->>'advisorName' NOT IN ('asesor', 'bot', 'sistema', '')
            AND h.created_at <= s.created_at + interval '4 hours'
            AND h.created_at >= s.created_at - interval '36 hours'
          GROUP BY 1
          ORDER BY cnt DESC, MAX(h.id) DESC
          LIMIT 1
        ) adv_counts
        WHERE adv_counts.advisor_name IS NOT NULL
      ) day_adv
      WHERE sales.id = day_adv.sale_id
        AND sales.advisor_name != 'Leydi Laura Mosquera'
        AND (sales.notes IS NULL OR (sales.notes NOT LIKE '%Monto corregido%' AND sales.notes NOT LIKE '%Venta confirmada%' AND sales.notes NOT LIKE '%Comprobante verificado%'))
    `);

    // 7. Normalize advisor names
    await client.query(`
      UPDATE sales
      SET advisor_name = 'Leydi Laura Mosquera'
      WHERE advisor_name ILIKE '%Leydi%' AND advisor_name != 'Leydi Laura Mosquera';

      UPDATE sales
      SET advisor_name = 'Luisa Cristancho'
      WHERE advisor_name ILIKE '%Luisa%' AND advisor_name != 'Luisa Cristancho';

      UPDATE sales
      SET advisor_name = 'Aura Cristina Carvajal Delgado'
      WHERE (advisor_name ILIKE '%Aura%' OR advisor_name = 'Aura') AND advisor_name != 'Aura Cristina Carvajal Delgado';
    `);

    // 8. Extract quoted prices from advisor messages in chat for any sales still sitting at Q0
    const { rowCount: priceExtractedCount } = await client.query(`
      UPDATE sales
      SET
        amount = sub.val,
        status = 'confirmada',
        amount_source = 'chat_cotizado'
      FROM (
        SELECT DISTINCT ON (s.id)
          s.id AS sale_id,
          (regexp_match(h.message->>'content', '(?i)(?:total|son|ser[ií]an|depositar|cancelar|pagar)?[^\d]{0,10}Q\.?\s*([0-9]{2,4})'))[1]::numeric AS val
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        JOIN n8n_chat_histories h ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
        WHERE (s.amount = 0 OR s.amount IS NULL)
          AND h.message->>'type' = 'ai'
          AND (h.message->'additional_kwargs'->>'sentBy') = 'advisor'
          AND h.created_at <= s.created_at + interval '24 hours'
          AND h.created_at >= s.created_at - interval '7 days'
          AND h.message->>'content' ~* 'Q\.?\s*[0-9]{2,4}'
        ORDER BY s.id, h.id DESC
      ) sub
      WHERE sales.id = sub.sale_id
        AND sub.val >= 50 AND sub.val <= 10000
    `);

    // 9. Backfill remaining Q0 sales from quotes
    const { rowCount: backfilledQuotesCount } = await client.query(`
      UPDATE sales
      SET
        amount = q.grand_total,
        quoted_amount = q.grand_total,
        quote_id = q.id,
        status = 'confirmada',
        amount_source = 'cotizacion'
      FROM quotes q
      WHERE sales.quote_id = q.id
        AND (sales.amount = 0 OR sales.amount IS NULL)
        AND q.grand_total > 0 AND q.grand_total <= 10000
    `);

    // 10. Backfill missing whatsapp_number_id on sales so line filtering never drops valid sales
    await client.query(`
      UPDATE sales
      SET whatsapp_number_id = t.whatsapp_number_id
      FROM tickets t
      WHERE sales.ticket_id = t.id AND sales.whatsapp_number_id IS NULL AND t.whatsapp_number_id IS NOT NULL;
    `);

    await client.query(`
      UPDATE sales
      SET whatsapp_number_id = t.whatsapp_number_id
      FROM (
        SELECT DISTINCT ON (customer_id) customer_id, whatsapp_number_id
        FROM tickets WHERE whatsapp_number_id IS NOT NULL
        ORDER BY customer_id, id DESC
      ) t
      WHERE sales.customer_id = t.customer_id AND sales.whatsapp_number_id IS NULL;
    `);

    // 11. Sincronizar estado en todos los clientes compradores a "despacho" y paid_locked = true
    const { rowCount: syncedCustomersCount } = await client.query(`
      UPDATE customers
      SET paid_locked = true,
          manual_status = CASE WHEN manual_status = 'pqrs' THEN 'pqrs' ELSE 'despacho' END,
          paid_method = COALESCE(paid_method, 'transferencia'),
          updated_at = now()
      WHERE id IN (
        SELECT DISTINCT customer_id
        FROM sales
        WHERE status = 'confirmada' AND amount > 0
      );
    `);

    // 12. Sincronizar tickets para que se posicionen en la columna "Por despacho" del Pipeline
    const { rowCount: syncedTicketsCount } = await client.query(`
      UPDATE tickets t
      SET status = 'en_atencion',
          updated_at = now()
      WHERE t.customer_id IN (
        SELECT DISTINCT customer_id
        FROM sales
        WHERE status = 'confirmada' AND amount > 0
      )
      AND t.status IN ('bot', 'pendiente', 'esperando_asesor');
    `);

    await client.query('COMMIT');
    broadcast('sales_changes', JSON.stringify({ action: 'reconciled_all' }));

    return {
      success: true,
      cappedCount,
      reattributedCount,
      ocrExtractedCount,
      priceExtractedCount,
      backfilledQuotesCount,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reconcileAllSalesFromChats error:', err);
    throw err;
  } finally {
    client.release();
  }
}

