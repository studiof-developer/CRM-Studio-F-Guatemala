import { pool } from './db.js';
import { logBusinessAction } from './auditLog.js';
import { broadcast } from './events.js';
import {
  CONFIRMATION_PHRASES_REGEX, isConfirmationMessage, attributeAdvisor, latestQuote,
  startsNewCycle, isResentReceipt, inRetailRange, guatemalaParts, shiftOf,
} from './salesRules.js';

export { CONFIRMATION_PHRASES_REGEX, isConfirmationMessage };

// Motor de ventas por evidencia (2026-10-18). Una venta nace SIEMPRE de un hecho del chat:
//   - receipt_ocr:           un comprobante del cliente leído por OCR (fecha/monto = los del comprobante)
//   - advisor_confirmation:  la asesora confirma el pago (NeoLink/tarjeta no dejan imagen)
//   - manual:                una asesora marca "Pagado" a mano
// La asesora se decide con attributeAdvisor (salesRules.js) sobre el hilo de ESA línea.
// Las ventas anteriores a LOCK_BEFORE están calibradas a mano y este motor no las toca.
const DAY = 86400000;
const LOOKBACK_MS = 7 * DAY;
const GRACE_MS = 2 * 3600000;
export const LOCK_BEFORE = new Date('2026-10-16T00:00:00-06:00');

export async function defaultLineId() {
  const { rows } = await pool.query('SELECT id FROM whatsapp_numbers WHERE is_active = true ORDER BY id ASC LIMIT 1');
  return rows[0]?.id ?? 1;
}

export function lineFromSession(sessionId) {
  const m = /__line_(\d+)/.exec(sessionId ?? '');
  return m ? Number(m[1]) : null;
}

function toChatEvent(row) {
  const m = row.message ?? {};
  const kw = m.additional_kwargs ?? {};
  const role = m.type === 'human' ? 'customer' : (m.type === 'ai' && kw.sentBy === 'advisor' ? 'advisor' : 'bot');
  const ocr = Number(kw.ocrAmount);
  return {
    id: Number(row.id), at: row.created_at, role,
    advisor: kw.advisorName ?? null, text: m.content ?? '',
    ocrAmount: Number.isFinite(ocr) && ocr > 0 ? ocr : null,
  };
}

// Mensajes de UN hilo (cliente + línea). El hilo de la línea por defecto también incluye
// los session_id viejos sin "__line_" — misma regla que usa Conversaciones.
export async function loadEvents({ phone, customerId, lineId, from, to }) {
  if (String(phone ?? '').startsWith('social:')) {
    const { rows } = await pool.query(
      `SELECT sm.id, sm.created_at, sm.direction, sm.body, sm.advisor_name
       FROM social_contacts sc JOIN social_messages sm ON sm.contact_id = sc.id
       WHERE sc.customer_id = $1 AND sm.created_at >= $2 AND sm.created_at <= $3
       ORDER BY sm.created_at, sm.id`,
      [customerId, from, to]
    );
    return rows.map((r) => ({
      id: Number(r.id), at: r.created_at, role: r.direction === 'in' ? 'customer' : 'advisor',
      advisor: r.advisor_name ?? null, text: r.body ?? '', ocrAmount: null,
    }));
  }
  const isDefault = Number(lineId) === Number(await defaultLineId());
  const { rows } = await pool.query(
    `SELECT h.id, h.created_at, h.message
     FROM n8n_chat_histories h
     WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '\\_\\_%')
       AND (h.session_id ~ ('__line_' || $2::text || '(__|$)') OR ($3::boolean AND h.session_id !~ '__line_'))
       AND h.created_at >= $4 AND h.created_at <= $5
     ORDER BY h.created_at, h.id`,
    [phone, String(lineId), isDefault, from, to]
  );
  return rows.map(toChatEvent);
}

async function getCustomer(customerId) {
  const { rows } = await pool.query(
    'SELECT id, whatsapp_number, full_name, paid_method, paid_locked FROM customers WHERE id = $1',
    [customerId]
  );
  return rows[0] ?? null;
}

async function ticketFor(customerId, { ticketId = null, lineId = null } = {}) {
  if (ticketId) {
    const { rows } = await pool.query('SELECT id, whatsapp_number_id, assigned_advisor FROM tickets WHERE id = $1', [ticketId]);
    if (rows.length) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT id, whatsapp_number_id, assigned_advisor FROM tickets
     WHERE customer_id = $1 AND ($2::int IS NULL OR COALESCE(whatsapp_number_id, 1) = $2::int)
     ORDER BY (status = 'resuelto') ASC, id DESC LIMIT 1`,
    [customerId, lineId]
  );
  return rows[0] ?? null;
}

async function lastSale(customerId, lineId, before) {
  const { rows } = await pool.query(
    `SELECT id, amount, created_at AS at FROM sales
     WHERE customer_id = $1 AND amount > 0 AND status = 'confirmada' AND created_at < $2
       AND (whatsapp_number_id IS NULL OR whatsapp_number_id = $3)
     ORDER BY created_at DESC LIMIT 1`,
    [customerId, before, lineId]
  );
  return rows[0] ? { id: rows[0].id, amount: Number(rows[0].amount), at: rows[0].at } : null;
}

async function recentSales(customerId, lineId, before) {
  const { rows } = await pool.query(
    `SELECT id, amount, created_at AS at FROM sales
     WHERE customer_id = $1 AND amount > 0 AND status = 'confirmada'
       AND created_at < $2 AND created_at >= $2::timestamptz - interval '3 days'
       AND (whatsapp_number_id IS NULL OR whatsapp_number_id = $3)
     ORDER BY created_at DESC`,
    [customerId, before, lineId]
  );
  return rows.map((r) => ({ id: r.id, amount: Number(r.amount), at: r.at }));
}

// El nombre que aparece en el chat es el full_name con el que la asesora inició sesión;
// si es un nombre corto/antiguo ("Leydi"), se acepta solo si identifica a una única usuaria.
export async function resolveAdvisor(name) {
  const exact = await pool.query(
    'SELECT id, full_name FROM users WHERE lower(full_name) = lower($1) OR lower(username) = lower($1) LIMIT 2', [name]
  );
  if (exact.rows.length === 1) return { id: exact.rows[0].id, name: exact.rows[0].full_name };
  const prefix = await pool.query(
    `SELECT id, full_name FROM users WHERE lower(full_name) LIKE lower($1) || ' %' LIMIT 2`, [name]
  );
  if (prefix.rows.length === 1) return { id: prefix.rows[0].id, name: prefix.rows[0].full_name };
  return { id: null, name };
}

async function attribute({ events, at, ticketAdvisor = null, clickUser = null }) {
  const found = attributeAdvisor(events, at, { graceMs: GRACE_MS });
  let name = found?.advisor ?? null;
  let rule = found?.rule ?? null;
  if (!name && ticketAdvisor) { name = ticketAdvisor; rule = 'ticket'; }
  if (!name && clickUser?.fullName && !/ocr|sistema/i.test(clickUser.fullName)) { name = clickUser.fullName; rule = 'click_manual'; }
  if (!name) return { advisor: null, advisorId: null, rule: 'sin_atribuir' };
  const user = await resolveAdvisor(name);
  return { advisor: user.name, advisorId: user.id, rule };
}

async function insertSale(s) {
  const { rows } = await pool.query(
    `INSERT INTO sales (
       customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, quote_id, notes,
       whatsapp_number_id, created_at, status, amount_source, quoted_amount, receipt_amount,
       amount_match, attributed_by, confirmed_at, channel, evidence_type, evidence_message_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$10,$17,$18,$19)
     ON CONFLICT (evidence_type, evidence_message_id) WHERE evidence_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      s.customerId, s.ticketId ?? null, s.advisorId ?? null, s.advisorName ?? 'Sin atribuir', s.amount,
      s.paymentMethod ?? null, s.quoteId ?? null, s.notes ?? null, s.lineId ?? null, s.at,
      s.status, s.amountSource ?? null, s.quotedAmount ?? null, s.receiptAmount ?? null,
      s.amountMatch ?? null, s.rule, s.channel ?? 'whatsapp', s.evidenceType, s.evidenceId ?? null,
    ]
  );
  return rows[0] ?? null;
}

function announce(sale, user, detail) {
  if (!sale) return;
  broadcast('sales_changes', JSON.stringify({ saleId: sale.id }));
  logBusinessAction(
    user ?? { fullName: sale.advisor_name, id: sale.advisor_id },
    sale.customer_id, 'sale_recorded', detail
  );
}

async function markCustomerPaid(customer, method) {
  if (customer.paid_locked) return;
  await pool.query(
    `UPDATE customers SET paid_locked = true, paid_method = COALESCE($2, paid_method),
       manual_status = CASE WHEN manual_status IN ('pqrs','despacho') THEN manual_status ELSE 'pagado' END,
       payment_suggested_at = NULL, payment_suggestion_reason = NULL, payment_suggestion_method = NULL,
       updated_at = now()
     WHERE id = $1`,
    [customer.id, method]
  );
}

// --- 1. Comprobante leído por OCR -------------------------------------------------------

async function evaluateReceipt({ customerId, phone, sessionId, at, amount }) {
  const lineId = lineFromSession(sessionId) ?? (await defaultLineId());
  const events = await loadEvents({
    phone, customerId, lineId,
    from: new Date(+new Date(at) - LOOKBACK_MS), to: new Date(+new Date(at) + GRACE_MS),
  });
  const last = await lastSale(customerId, lineId, at);
  const ticket = await ticketFor(customerId, { lineId });
  const attribution = await attribute({ events, at, ticketAdvisor: ticket?.assigned_advisor });
  return {
    lineId, ticketId: ticket?.id ?? null, events, last, attribution,
    quoted: latestQuote(events, last?.at ?? null, at),
    resent: isResentReceipt({ amount, recentSales: await recentSales(customerId, lineId, at), events, atTime: at }),
  };
}

// `amount` solo se pasa cuando la suma de varios comprobantes parciales ya coincide con
// lo cotizado (attachments.js); si no, el monto es el que el OCR leyó en esta imagen.
export async function recordSaleFromReceipt({ messageId, amount = null, paymentMethod = null }) {
  const { rows } = await pool.query(
    'SELECT id, session_id, created_at, message FROM n8n_chat_histories WHERE id = $1', [messageId]
  );
  const m = rows[0];
  if (!m) return null;
  const value = Number(amount ?? m.message?.additional_kwargs?.ocrAmount);
  if (!inRetailRange(value)) return { skipped: 'sin_monto' };
  const phone = m.session_id.split('__')[0];
  const { rows: cRows } = await pool.query('SELECT id FROM customers WHERE whatsapp_number = $1', [phone]);
  if (!cRows.length) return null;
  const customer = await getCustomer(cRows[0].id);

  const ev = await evaluateReceipt({ customerId: customer.id, phone, sessionId: m.session_id, at: m.created_at, amount: value });
  if (ev.resent) return { skipped: 'reenviado' };

  const sale = await insertSale({
    customerId: customer.id, ticketId: ev.ticketId, advisorId: ev.attribution.advisorId,
    advisorName: ev.attribution.advisor, amount: value, paymentMethod: paymentMethod ?? customer.paid_method ?? 'transferencia',
    notes: 'Comprobante leído por OCR', lineId: ev.lineId, at: m.created_at,
    status: ev.attribution.advisor ? 'confirmada' : 'revisar', amountSource: 'ocr',
    quotedAmount: ev.quoted, receiptAmount: value,
    amountMatch: ev.quoted != null ? Math.abs(ev.quoted - value) < 0.5 : null,
    rule: ev.attribution.rule, evidenceType: 'receipt_ocr', evidenceId: m.id,
  });
  if (!sale) return { skipped: 'ya_registrado' };
  announce(sale, null, `Q${value.toFixed(2)} atribuido a ${sale.advisor_name} (${ev.attribution.rule})`);
  return sale;
}

// --- 2. La asesora confirma el pago ("pago recibido", "gracias por su compra"…) ----------

export async function confirmSaleByAdvisorMessage({ customerId, user, channel = 'whatsapp', notes = null, messageId = null, lineId = null }) {
  if (!customerId || !user?.fullName) return null;
  try {
    const customer = await getCustomer(customerId);
    if (!customer) return null;
    const now = new Date();
    const line = lineId ?? (await ticketFor(customerId))?.whatsapp_number_id ?? (await defaultLineId());

    // Una venta que quedó "por revisar" (p. ej. sin asesora clara) se confirma con este mensaje.
    const { rows: pending } = await pool.query(
      `UPDATE sales SET status = 'confirmada', confirmed_at = now(), updated_at = now(),
              advisor_name = CASE WHEN advisor_id IS NULL AND advisor_name = 'Sin atribuir' THEN $2 ELSE advisor_name END,
              advisor_id = COALESCE(advisor_id, $3)
       WHERE id = (SELECT id FROM sales WHERE customer_id = $1 AND status = 'revisar' AND amount > 0
                     AND NOT attribution_locked AND created_at >= now() - interval '3 days'
                   ORDER BY id DESC LIMIT 1)
       RETURNING *`,
      [customerId, user.fullName, user.id ?? null]
    );
    if (pending.length) { broadcast('sales_changes', JSON.stringify({ saleId: pending[0].id })); return pending[0]; }

    const events = await loadEvents({ phone: customer.whatsapp_number, customerId, lineId: line, from: new Date(+now - LOOKBACK_MS), to: now });
    const last = await lastSale(customerId, line, now);
    // "Proceso de alistamiento" y similares llegan DESPUÉS de la venta: sin una cotización
    // o medios de pago nuevos desde la última venta, esto es seguimiento, no una compra.
    if (!startsNewCycle(events, last?.at ?? null, now)) return null;

    const attribution = await attribute({ events, at: now, ticketAdvisor: (await ticketFor(customerId, { lineId: line }))?.assigned_advisor, clickUser: user });
    let amount = latestQuote(events, last?.at ?? null, now);
    let source = amount ? 'chat_cotizado' : null;
    let quoteId = null;
    if (!amount) {
      const { rows: q } = await pool.query(
        `SELECT id, grand_total FROM quotes WHERE customer_id = $1 AND grand_total > 0 AND grand_total <= 10000
           AND created_at >= COALESCE($2::timestamptz, now() - interval '7 days') AND created_at >= now() - interval '7 days'
         ORDER BY id DESC LIMIT 1`,
        [customerId, last?.at ?? null]
      );
      if (q.length) { amount = Number(q[0].grand_total); source = 'cotizacion'; quoteId = q[0].id; }
    }
    const social = String(customer.whatsapp_number).startsWith('social:');
    const sale = await insertSale({
      customerId, ticketId: (await ticketFor(customerId, { lineId: line }))?.id, advisorId: attribution.advisorId,
      advisorName: attribution.advisor, amount: amount ?? 0, paymentMethod: customer.paid_method ?? 'transferencia',
      quoteId, notes: notes ?? 'Confirmado por mensaje de la asesora', lineId: line, at: now,
      status: amount && attribution.advisor ? 'confirmada' : 'revisar', amountSource: source,
      quotedAmount: amount ?? null, rule: attribution.rule, channel: social ? channel : 'whatsapp',
      evidenceType: social ? 'social_confirmation' : 'advisor_confirmation', evidenceId: messageId,
    });
    if (!sale) return null;
    await markCustomerPaid(customer, sale.payment_method);
    announce(sale, user, `Q${Number(sale.amount).toFixed(2)} atribuido a ${sale.advisor_name} (${attribution.rule})`);
    return sale;
  } catch (err) {
    console.error('confirmSaleByAdvisorMessage error:', err);
    return null;
  }
}

// --- 3. La asesora marca "Pagado" a mano --------------------------------------------------

export async function recordManualSale({ customerId, ticketId = null, user = null, paymentMethod = null, amount = null, notes = null }) {
  if (!customerId) return null;
  try {
    const customer = await getCustomer(customerId);
    if (!customer) return null;
    const now = new Date();
    const ticket = await ticketFor(customerId, { ticketId });
    const line = ticket?.whatsapp_number_id ?? (await defaultLineId());
    const events = await loadEvents({ phone: customer.whatsapp_number, customerId, lineId: line, from: new Date(+now - LOOKBACK_MS), to: now });
    const last = await lastSale(customerId, line, now);

    let value = Number(amount);
    let source = 'manual';
    let receipt = null;
    if (!inRetailRange(value)) {
      value = null;
      const since = last ? +new Date(last.at) : -Infinity;
      const receipts = events.filter((e) => e.role === 'customer' && e.ocrAmount && +new Date(e.at) > since);
      if (receipts.length) { receipt = receipts[receipts.length - 1].ocrAmount; value = receipt; source = 'ocr'; }
    }
    const quoted = latestQuote(events, last?.at ?? null, now);
    if (!value && quoted) { value = quoted; source = 'chat_cotizado'; }
    let quoteId = null;
    if (!value) {
      const { rows: q } = await pool.query(
        `SELECT id, grand_total FROM quotes WHERE customer_id = $1 AND grand_total > 0 AND grand_total <= 10000
           AND created_at >= now() - interval '7 days' ORDER BY id DESC LIMIT 1`, [customerId]);
      if (q.length) { value = Number(q[0].grand_total); source = 'cotizacion'; quoteId = q[0].id; }
    }

    // Misma clienta, mismo día y mismo monto: es el mismo clic repetido.
    if (value) {
      const { rows: dup } = await pool.query(
        `SELECT * FROM sales WHERE customer_id = $1 AND abs(amount - $2) < 0.5
           AND (created_at AT TIME ZONE 'America/Guatemala')::date = (now() AT TIME ZONE 'America/Guatemala')::date LIMIT 1`,
        [customerId, value]);
      if (dup.length) return dup[0];
    }

    const attribution = await attribute({ events, at: now, ticketAdvisor: ticket?.assigned_advisor, clickUser: user });
    const sale = await insertSale({
      customerId, ticketId: ticket?.id, advisorId: attribution.advisorId, advisorName: attribution.advisor,
      amount: value ?? 0, paymentMethod: paymentMethod ?? customer.paid_method ?? 'transferencia', quoteId,
      notes: notes ?? 'Marcado como pagado por la asesora', lineId: line, at: now,
      status: value && attribution.advisor ? 'confirmada' : 'revisar', amountSource: value ? source : null,
      quotedAmount: quoted, receiptAmount: receipt,
      amountMatch: quoted != null && receipt != null ? Math.abs(quoted - receipt) < 0.5 : null,
      rule: attribution.rule, evidenceType: 'manual',
    });
    announce(sale, user, `Q${Number(value ?? 0).toFixed(2)} atribuido a ${sale?.advisor_name} (${attribution.rule})`);
    return sale;
  } catch (err) {
    console.error('recordManualSale error:', err);
    return null;
  }
}

// --- 4. Auditoría y reconstrucción contra el chat ----------------------------------------

function rangeBounds(from, to) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
  if (!ok(from) || !ok(to)) throw Object.assign(new Error('from/to deben ser YYYY-MM-DD'), { status: 400 });
  const start = new Date(`${from}T00:00:00-06:00`);
  const end = new Date(`${to}T23:59:59.999-06:00`);
  if (end < start) throw Object.assign(new Error('to debe ser posterior a from'), { status: 400 });
  if ((end - start) / DAY > 31) throw Object.assign(new Error('el rango máximo es 31 días'), { status: 400 });
  return { start, end };
}

const sameAdvisor = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export async function auditSales({ from, to, lineId = null }) {
  const { start, end } = rangeBounds(from, to);
  const { rows: receipts } = await pool.query(
    `SELECT h.id, h.session_id, h.created_at, c.id AS customer_id, c.full_name, c.whatsapp_number,
            CASE WHEN (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (h.message->'additional_kwargs'->>'ocrAmount')::numeric END AS ocr_amount
     FROM n8n_chat_histories h
     JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
     WHERE h.message->>'type' = 'human'
       AND (h.message->'additional_kwargs'->>'ocrAmount') ~ '^[0-9]+(\\.[0-9]+)?$'
       AND h.created_at >= $1 AND h.created_at <= $2
     ORDER BY h.created_at`,
    [start, end]
  );

  const claimed = new Set();
  const items = [];
  for (const r of receipts) {
    const amount = Number(r.ocr_amount);
    if (!inRetailRange(amount)) continue;
    const receiptLine = lineFromSession(r.session_id) ?? (await defaultLineId());
    if (lineId && Number(lineId) !== receiptLine) continue;

    let sale = (await pool.query(`SELECT * FROM sales WHERE evidence_type = 'receipt_ocr' AND evidence_message_id = $1`, [r.id])).rows[0];
    let linked = !!sale;
    if (!sale) {
      sale = (await pool.query(
        `SELECT * FROM sales WHERE customer_id = $1 AND abs(amount - $2) < 0.5 AND evidence_message_id IS NULL
           AND created_at BETWEEN $3 AND $4 ORDER BY abs(extract(epoch FROM created_at - $5::timestamptz)) LIMIT 1`,
        [r.customer_id, amount, new Date(+new Date(r.created_at) - DAY), new Date(+new Date(r.created_at) + DAY), r.created_at]
      )).rows.find((s) => !claimed.has(s.id));
    }
    if (sale) claimed.add(sale.id);

    const item = {
      receiptId: Number(r.id), at: r.created_at, customerId: r.customer_id,
      customer: r.full_name || r.whatsapp_number, phone: r.whatsapp_number, amount, lineId: receiptLine,
      shift: shiftOf(r.created_at), saleId: sale?.id ?? null, locked: !!sale?.attribution_locked, linked,
    };
    if (new Date(r.created_at) < LOCK_BEFORE) { items.push({ ...item, status: 'historico_bloqueado' }); continue; }

    const ev = await evaluateReceipt({ customerId: r.customer_id, phone: r.whatsapp_number, sessionId: r.session_id, at: r.created_at, amount });
    item.expectedAdvisor = ev.attribution.advisor;
    item.rule = ev.attribution.rule;
    if (!sale) { items.push({ ...item, status: ev.resent ? 'reenviado' : 'sin_venta' }); continue; }
    item.recordedAdvisor = sale.advisor_name;
    item.recordedAt = sale.created_at;
    const wrongAdvisor = ev.attribution.advisor && !sameAdvisor(ev.attribution.advisor, sale.advisor_name);
    const wrongDate = guatemalaParts(sale.created_at).ymd !== guatemalaParts(r.created_at).ymd;
    item.status = sale.attribution_locked ? 'bloqueada' : wrongAdvisor ? 'asesor_distinto' : wrongDate ? 'fecha_distinta' : 'ok';
    item.advisorId = ev.attribution.advisorId;
    items.push(item);
  }

  // Ventas sin ningún comprobante ni confirmación que las respalde (y que nadie calibró a mano).
  const { rows: unbacked } = await pool.query(
    `SELECT s.id, s.amount, s.advisor_name, s.created_at, s.notes, s.evidence_type, c.full_name, c.whatsapp_number
     FROM sales s JOIN customers c ON c.id = s.customer_id
     WHERE s.created_at >= $1 AND s.created_at <= $2 AND NOT s.attribution_locked
       AND s.evidence_message_id IS NULL AND COALESCE(s.evidence_type, '') <> 'manual'
       AND s.status <> 'revisar'
     ORDER BY s.created_at`,
    [start, end]
  );
  for (const s of unbacked) {
    if (claimed.has(s.id)) continue;
    items.push({
      status: 'sin_evidencia', saleId: s.id, at: s.created_at, customer: s.full_name || s.whatsapp_number,
      phone: s.whatsapp_number, amount: Number(s.amount), recordedAdvisor: s.advisor_name, shift: shiftOf(s.created_at),
    });
  }

  const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
  return { from, to, counts, items, txtContent: buildAuditText({ from, to, counts, items }) };
}

const STATUS_LABEL = {
  ok: 'OK', sin_venta: 'FALTA VENTA', asesor_distinto: 'ASESORA DISTINTA', fecha_distinta: 'FECHA DISTINTA',
  sin_evidencia: 'SIN COMPROBANTE', reenviado: 'COMPROBANTE REENVIADO', bloqueada: 'BLOQUEADA (calibrada a mano)',
  historico_bloqueado: 'HISTÓRICO (antes del 16/10)',
};

function buildAuditText({ from, to, counts, items }) {
  const gt = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', hour12: false });
  const lines = [`AUDITORÍA DE VENTAS ${from} → ${to}`, ''];
  for (const [k, v] of Object.entries(counts)) lines.push(`${STATUS_LABEL[k] ?? k}: ${v}`);
  lines.push('', '--------------------------------------------------------------------------------');
  for (const i of items.filter((x) => x.status !== 'ok' && x.status !== 'historico_bloqueado')) {
    lines.push(
      `[${STATUS_LABEL[i.status] ?? i.status}] ${gt(i.at)} (${i.shift}) ${i.customer} ${i.phone ?? ''} Q${i.amount}`,
      i.expectedAdvisor !== undefined ? `   debería: ${i.expectedAdvisor ?? 'sin atribuir'} (${i.rule})` : '',
      i.recordedAdvisor ? `   registrada: ${i.recordedAdvisor}${i.recordedAt ? ' · ' + gt(i.recordedAt) : ''}` : '',
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}

// apply=false solo describe lo que haría. Nunca toca ventas bloqueadas ni borra nada: lo
// que no tiene respaldo en el chat pasa a "por revisar" (queda fuera de los totales).
export async function rebuildSales({ from, to, lineId = null, apply = false, user = null }) {
  const audit = await auditSales({ from, to, lineId });
  const plan = { insertar: 0, reasignar: 0, vincular: 0, marcarRevisar: 0 };
  for (const i of audit.items) {
    if (i.status === 'sin_venta') plan.insertar++;
    else if (i.status === 'asesor_distinto' || i.status === 'fecha_distinta') plan.reasignar++;
    else if (i.status === 'ok' && !i.linked && i.saleId) plan.vincular++;
    else if (i.status === 'sin_evidencia') plan.marcarRevisar++;
  }
  if (!apply) return { applied: false, plan, ...audit };

  for (const i of audit.items) {
    if (i.status === 'sin_venta') {
      await recordSaleFromReceipt({ messageId: i.receiptId });
    } else if (i.saleId && !i.locked && ['asesor_distinto', 'fecha_distinta', 'ok'].includes(i.status) && !i.linked) {
      const u = i.expectedAdvisor ? await resolveAdvisor(i.expectedAdvisor) : null;
      await pool.query(
        `UPDATE sales SET evidence_type = 'receipt_ocr', evidence_message_id = $2, created_at = $3, confirmed_at = $3,
                advisor_name = COALESCE($4, advisor_name), advisor_id = COALESCE($5, advisor_id),
                attributed_by = COALESCE($6, attributed_by), updated_at = now()
         WHERE id = $1 AND NOT attribution_locked
           AND NOT EXISTS (SELECT 1 FROM sales WHERE evidence_type = 'receipt_ocr' AND evidence_message_id = $2)`,
        [i.saleId, i.receiptId, i.at, u?.name ?? null, u?.id ?? null, i.rule ?? null]
      );
    } else if (i.saleId && !i.locked && ['asesor_distinto', 'fecha_distinta'].includes(i.status) && i.linked) {
      const u = i.expectedAdvisor ? await resolveAdvisor(i.expectedAdvisor) : null;
      await pool.query(
        `UPDATE sales SET created_at = $2, confirmed_at = $2, advisor_name = COALESCE($3, advisor_name),
                advisor_id = COALESCE($4, advisor_id), attributed_by = COALESCE($5, attributed_by), updated_at = now()
         WHERE id = $1 AND NOT attribution_locked`,
        [i.saleId, i.at, u?.name ?? null, u?.id ?? null, i.rule ?? null]
      );
    } else if (i.status === 'sin_evidencia') {
      await pool.query(
        `UPDATE sales SET status = 'revisar', updated_at = now(),
                notes = COALESCE(notes, '') || ' [Sin comprobante ni confirmación en el chat: revisar]'
         WHERE id = $1 AND NOT attribution_locked AND status <> 'revisar'`,
        [i.saleId]
      );
    }
  }
  logBusinessAction(user ?? { fullName: 'Sistema', id: null }, null, 'sale_updated', `Reconstrucción de ventas ${from} → ${to}: ${JSON.stringify(plan)}`);
  broadcast('sales_changes', JSON.stringify({ action: 'rebuilt' }));
  // Se vuelve a auditar para mostrar cómo quedó, no cómo estaba antes de aplicar.
  return { applied: true, plan, ...(await auditSales({ from, to, lineId })) };
}
