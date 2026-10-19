import { pool } from './db.js';
import { logBusinessAction } from './auditLog.js';
import { broadcast } from './events.js';
import {
  CONFIRMATION_PHRASES_REGEX, isConfirmationMessage, attributeAdvisor, latestQuote,
  isResentReceipt, inRetailRange, guatemalaParts, shiftOf,
} from './salesRules.js';
import {
  defaultLineId, lineFromSession, loadEvents, resolveAdvisor, buildThread, analyzeCustomer, nameResolver,
} from './salesThreads.js';

export { CONFIRMATION_PHRASES_REGEX, isConfirmationMessage };

// Motor de ventas por evidencia. Una venta nace SIEMPRE de un hecho del chat, y qué cuenta como
// venta lo decide un solo lugar (buildEpisodes en salesRules.js):
//   1. la asesora da los medios de pago;  2. DESPUÉS el cliente manda su prueba (foto/PDF con
//   monto, voucher, o el texto del banco);  3. la asesora verifica y confirma ("Gracias por
//   elegir a STUDIO F, tu pedido ya está en proceso de alistamiento").
// Una prueba sin esa confirmación queda "por revisar" (no suma a los totales) hasta que llegue.
// Las ventas anteriores a LOCK_BEFORE están calibradas a mano y este motor no las toca.
const DAY = 86400000;
const LOOKBACK_MS = 7 * DAY;
export const LOCK_BEFORE = new Date('2026-10-16T00:00:00-06:00');

async function getCustomer(customerId) {
  const { rows } = await pool.query(
    'SELECT id, whatsapp_number, full_name, paid_method, paid_locked, manual_status FROM customers WHERE id = $1', [customerId]
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
     WHERE customer_id = $1 AND amount > 0 AND status IN ('confirmada', 'revisar')
       AND created_at < $2 AND created_at >= $2::timestamptz - interval '3 days'
       AND (whatsapp_number_id IS NULL OR whatsapp_number_id = $3)
     ORDER BY created_at DESC`,
    [customerId, before, lineId]
  );
  return rows.map((r) => ({ id: r.id, amount: Number(r.amount), at: r.at }));
}

async function insertSale(s) {
  const { rows } = await pool.query(
    `INSERT INTO sales (
       customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method, quote_id, notes,
       whatsapp_number_id, created_at, status, amount_source, quoted_amount, receipt_amount,
       amount_match, attributed_by, confirmed_at, channel, evidence_type, evidence_message_id, amount_basis
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (evidence_type, evidence_message_id) WHERE evidence_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      s.customerId, s.ticketId ?? null, s.advisorId ?? null, s.advisorName ?? 'Sin atribuir', s.amount,
      s.paymentMethod ?? null, s.quoteId ?? null, s.notes ?? null, s.lineId ?? null, s.at,
      s.status, s.amountSource ?? null, s.quotedAmount ?? null, s.receiptAmount ?? null,
      s.amountMatch ?? null, s.rule, s.status === 'confirmada' ? s.at : null, s.channel ?? 'whatsapp',
      s.evidenceType, s.evidenceId ?? null, s.amountBasis ?? null,
    ]
  );
  return rows[0] ?? null;
}

function announce(sale, user, detail) {
  if (!sale) return;
  broadcast('sales_changes', JSON.stringify({ saleId: sale.id }));
  logBusinessAction(user ?? { fullName: sale.advisor_name, id: sale.advisor_id }, sale.customer_id, 'sale_recorded', detail);
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

// Crea la venta de un episodio reconstruido del chat. Solo queda "confirmada" si la asesora ya
// verificó el pago, hay monto y hay asesora; si no, "por revisar" y no suma a los totales.
async function saleFromEpisode(customer, ep, lineId, { clickUser = null } = {}) {
  const ticket = await ticketFor(customer.id, { lineId });
  let name = ep.advisor ?? null;
  let rule = ep.rule ?? null;
  if (!name && ticket?.assigned_advisor) { name = ticket.assigned_advisor; rule = 'ticket'; }
  if (!name && clickUser?.fullName && !/ocr|sistema/i.test(clickUser.fullName)) { name = clickUser.fullName; rule = 'click_manual'; }
  const advisor = name ? await resolveAdvisor(name) : { id: null, name: null };

  let amount = ep.amount ?? null;
  let source = ep.type === 'comprobante' ? (ep.via === 'texto' ? 'texto_banco' : 'ocr') : (amount ? 'chat_cotizado' : null);
  let quoteId = null;
  let basis = ep.amountBasis ?? (amount ? (ep.type === 'comprobante' ? 'comprobante' : 'precio_aprobado') : null);
  if (!amount) {
    // Sin precio en el chat, la cotización formal del Cotizador.
    const { rows: q } = await pool.query(
      `SELECT id, grand_total FROM quotes WHERE customer_id = $1 AND grand_total > 0 AND grand_total <= 10000
         AND created_at <= $2 AND created_at >= $2::timestamptz - interval '7 days' ORDER BY id DESC LIMIT 1`,
      [customer.id, ep.at]
    );
    if (q.length) { amount = Number(q[0].grand_total); source = 'cotizacion'; quoteId = q[0].id; basis = 'precio_aprobado'; }
  }
  const social = String(customer.whatsapp_number).startsWith('social:');
  const receipt = ep.type === 'comprobante' ? ep.amount : null;
  return insertSale({
    customerId: customer.id, ticketId: ticket?.id, advisorId: advisor.id, advisorName: advisor.name,
    amount: amount ?? 0, paymentMethod: customer.paid_method ?? (ep.medium === 'link' ? 'tarjeta' : 'transferencia'), quoteId,
    notes: ep.verified
      ? 'Venta verificada por la asesora'
      : 'Comprobante recibido: esperando que la asesora confirme el pago',
    lineId, at: ep.at, status: ep.verified && amount > 0 && advisor.name ? 'confirmada' : 'revisar',
    amountSource: amount ? source : null, quotedAmount: ep.quote ?? null, receiptAmount: receipt,
    amountMatch: ep.quote != null && receipt != null ? Math.abs(ep.quote - receipt) < 0.5 : null, rule: rule ?? 'sin_atribuir',
    channel: social ? 'social' : 'whatsapp', evidenceType: ep.type === 'comprobante' ? 'receipt_ocr' : (social ? 'social_confirmation' : 'advisor_confirmation'),
    evidenceId: ep.eventId, amountBasis: basis,
  });
}

// --- 1. Comprobante recibido (OCR de imagen/PDF) -----------------------------------------

// `amount` solo se pasa cuando la suma de varios comprobantes parciales ya coincide con lo
// cotizado (attachments.js); si no, el monto es el que el OCR leyó en este comprobante.
export async function recordSaleFromReceipt({ messageId, amount = null }) {
  const { rows } = await pool.query('SELECT id, session_id, created_at FROM n8n_chat_histories WHERE id = $1', [messageId]);
  const m = rows[0];
  if (!m) return null;
  const phone = m.session_id.split('__')[0];
  const { rows: cRows } = await pool.query('SELECT id FROM customers WHERE whatsapp_number = $1', [phone]);
  if (!cRows.length) return null;
  const customer = await getCustomer(cRows[0].id);
  const line = lineFromSession(m.session_id) ?? (await defaultLineId());

  const thread = await buildThread(customer, line, { from: new Date(+new Date(m.created_at) - LOOKBACK_MS), to: new Date() });
  const ep = thread.episodes.find((e) => e.eventId === Number(messageId));
  // Sin medios de pago antes y sin confirmación: no es concluyente. Si luego la asesora
  // confirma, confirmSaleByAdvisorMessage la toma. Si fue reenvío de otro pago, tampoco es venta.
  if (!ep) return { skipped: thread.orphanReceipts.some((o) => o.eventId === Number(messageId)) ? 'sin_contexto' : 'reenviado' };

  const value = Number(amount) > 0 ? Number(amount) : ep.amount;
  if (!inRetailRange(value)) return { skipped: 'sin_monto' };
  if (isResentReceipt({ amount: value, recentSales: await recentSales(customer.id, line, m.created_at), events: thread.events, atTime: m.created_at })) {
    return { skipped: 'reenviado' };
  }
  const sale = await saleFromEpisode(customer, { ...ep, amount: value }, line);
  if (!sale) return { skipped: 'ya_registrado' };
  announce(sale, null, `Q${value.toFixed(2)} ${sale.status === 'confirmada' ? 'verificada' : 'pendiente de confirmar'}: ${sale.advisor_name} (${sale.attributed_by})`);
  return sale;
}

// --- 2. La asesora confirma el pago ("Gracias por elegir a STUDIO F…") ------------------------

export async function confirmSaleByAdvisorMessage({ customerId, user, channel = 'whatsapp', notes = null, messageId = null, lineId = null }) {
  if (!customerId || !user?.fullName) return null;
  try {
    const customer = await getCustomer(customerId);
    if (!customer) return null;
    const now = new Date();
    const line = lineId ?? (await ticketFor(customerId))?.whatsapp_number_id ?? (await defaultLineId());

    // Un comprobante que ya había entrado "por revisar" se confirma con este mensaje.
    const { rows: pending } = await pool.query(
      `UPDATE sales SET status = 'confirmada', confirmed_at = now(), updated_at = now(),
              notes = 'Venta verificada por la asesora',
              advisor_name = CASE WHEN advisor_id IS NULL AND advisor_name = 'Sin atribuir' THEN $2 ELSE advisor_name END,
              advisor_id = COALESCE(advisor_id, $3)
       WHERE id = (SELECT id FROM sales WHERE customer_id = $1 AND status = 'revisar' AND amount > 0
                     AND NOT attribution_locked AND created_at >= now() - interval '7 days'
                     AND COALESCE(notes, '') NOT LIKE '%Sin comprobante ni confirmación%'
                   ORDER BY id DESC LIMIT 1)
       RETURNING *`,
      [customerId, user.fullName, user.id ?? null]
    );
    if (pending.length) { broadcast('sales_changes', JSON.stringify({ saleId: pending[0].id })); return pending[0]; }

    // Si no, esta confirmación puede cerrar una venta nueva (prueba ya recibida o pago por link).
    const thread = await buildThread(customer, line, { from: new Date(+now - LOOKBACK_MS), to: now });
    const ep = thread.episodes[thread.episodes.length - 1];
    // Seguimiento posterior ("proceso de alistamiento" tras una venta ya registrada): no hay venta nueva.
    if (!ep || !ep.verified || +now - +new Date(ep.confirmedAt) > 10 * 60000) return null;

    const sale = await saleFromEpisode(customer, ep, line, { clickUser: user });
    if (!sale) return null;
    await markCustomerPaid(customer, sale.payment_method);
    announce(sale, user, `Q${Number(sale.amount).toFixed(2)} verificada: ${sale.advisor_name} (${sale.attributed_by})`);
    return sale;
  } catch (err) {
    console.error('confirmSaleByAdvisorMessage error:', err);
    return null;
  }
}

// --- 3. La asesora marca "Pagado" a mano -----------------------------------------------

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

    // Quien marca "Pagado" lo está verificando él mismo: por eso la venta queda confirmada.
    const found = attributeAdvisor(events, now);
    let name = found?.advisor ?? ticket?.assigned_advisor ?? null;
    let rule = found?.rule ?? (ticket?.assigned_advisor ? 'ticket' : null);
    if (!name && user?.fullName && !/ocr|sistema/i.test(user.fullName)) { name = user.fullName; rule = 'click_manual'; }
    const advisor = name ? await resolveAdvisor(name) : { id: null, name: null };
    const sale = await insertSale({
      customerId, ticketId: ticket?.id, advisorId: advisor.id, advisorName: advisor.name,
      amount: value ?? 0, paymentMethod: paymentMethod ?? customer.paid_method ?? 'transferencia', quoteId,
      notes: notes ?? 'Marcado como pagado por la asesora', lineId: line, at: now,
      status: value && advisor.name ? 'confirmada' : 'revisar', amountSource: value ? source : null,
      quotedAmount: quoted, receiptAmount: receipt,
      amountMatch: quoted != null && receipt != null ? Math.abs(quoted - receipt) < 0.5 : null,
      rule: rule ?? 'sin_atribuir', evidenceType: 'manual', amountBasis: receipt ? 'comprobante' : (source === 'manual' ? 'manual' : 'precio_aprobado'),
    });
    announce(sale, user, `Q${Number(value ?? 0).toFixed(2)} atribuido a ${sale?.advisor_name} (${rule})`);
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

// Superconjuntos en SQL solo para encontrar clientes candidatos; la decisión real la toma buildEpisodes.
const CONFIRM_SQL = 'gracias\\s+por\\s+elegir|alistamiento|gracias\\s+por\\s+(su|tu)\\s+compra|pago\\s+(recibido|confirmado|verificado|acreditado|con)|comprobante\\s+(recibido|verificado|confirmado)|hemos\\s+recibido\\s+(su|tu)\\s+pago|confirmamos\\s+(su|tu)\\s+pago|pedido\\s+(confirmado|registrado)|agregado\\s+a\\s+la\\s+compra';
const BANK_SQL = 'compra\\s+con\\s+(tu\\s+)?tarjeta|se\\s+realiz|transferencia\\s+(realizada|exitosa|enviada)|dep[oó]sito\\s+(realizado|exitoso)|pago\\s+(exitoso|aprobado|realizado)|comprobante\\s+de';

export async function auditSales({ from, to, lineId = null }) {
  const { start, end } = rangeBounds(from, to);
  const { rows: candidates } = await pool.query(
    `SELECT DISTINCT c.id, c.whatsapp_number, c.full_name, c.manual_status, c.paid_method
     FROM n8n_chat_histories h JOIN customers c ON c.whatsapp_number = split_part(h.session_id, '__', 1)
     WHERE h.created_at >= $1 AND h.created_at <= $2 AND (
       (h.message->'additional_kwargs'->>'ocrAmount') IS NOT NULL
       OR (h.message->>'type' = 'ai' AND h.message->>'content' ~* $3)
       OR (h.message->>'type' = 'human' AND h.message->>'content' ~* $4))`,
    [start, end, CONFIRM_SQL, BANK_SQL]
  );

  const canonical = nameResolver();
  const claimed = new Set();
  const items = [];
  for (const customer of candidates) {
    const { rows: episodes, orphans } = await analyzeCustomer(customer, { canonical });
    for (const o of orphans) {
      if (new Date(o.at) >= start && new Date(o.at) <= end && (!lineId || Number(lineId) === o.line)) {
        items.push({ status: 'sin_contexto', receiptId: o.eventId, at: o.at, customerId: customer.id, customer: o.customer, phone: customer.whatsapp_number, amount: o.amount, line: o.line, shift: shiftOf(o.at) });
      }
    }
    for (const ep of episodes) {
      if (new Date(ep.at) < start || new Date(ep.at) > end) continue;
      if (lineId && Number(lineId) !== ep.line) continue;
      const evType = ep.type === 'comprobante' ? 'receipt_ocr' : 'advisor_confirmation';
      let sale = (await pool.query('SELECT * FROM sales WHERE evidence_type = $1 AND evidence_message_id = $2', [evType, ep.eventId])).rows[0];
      const linked = !!sale;
      if (!sale) {
        sale = (await pool.query(
          `SELECT * FROM sales WHERE customer_id = $1 AND evidence_message_id IS NULL AND created_at BETWEEN $2 AND $3
             AND (amount = 0 OR $4::numeric IS NULL OR abs(amount - $4::numeric) < 0.5)
           ORDER BY abs(extract(epoch FROM created_at - $5::timestamptz)) LIMIT 3`,
          [customer.id, new Date(+new Date(ep.at) - DAY), new Date(+new Date(ep.at) + DAY), ep.amount, ep.at]
        )).rows.find((s) => !claimed.has(s.id));
      }
      if (sale) claimed.add(sale.id);

      const item = {
        receiptId: ep.eventId, at: ep.at, customerId: customer.id, customer: ep.customer, phone: ep.phone, line: ep.line,
        amount: ep.amount, type: ep.type, verified: ep.verified, medium: ep.medium, shift: ep.shift, issues: ep.issues,
        expectedAdvisor: ep.advisor, rule: ep.rule, saleId: sale?.id ?? null, locked: !!sale?.attribution_locked, linked,
      };
      if (new Date(ep.at) < LOCK_BEFORE) { items.push({ ...item, status: 'historico_bloqueado' }); continue; }
      if (!sale) { items.push({ ...item, status: 'sin_venta' }); continue; }
      item.recordedAdvisor = sale.advisor_name;
      item.recordedAt = sale.created_at;
      item.recordedAmount = Number(sale.amount);
      const wrongAdvisor = ep.advisor && !sameAdvisor(ep.advisor, sale.advisor_name);
      const wrongAmount = ep.type === 'comprobante' && ep.amount && Math.abs(Number(sale.amount) - ep.amount) >= 0.5;
      const wrongDate = guatemalaParts(sale.created_at).ymd !== guatemalaParts(ep.at).ymd;
      const promotable = sale.status === 'revisar' && ep.verified && (ep.amount > 0 || Number(sale.amount) > 0);
      item.status = sale.attribution_locked ? 'bloqueada'
        : wrongAdvisor ? 'asesor_distinto' : wrongAmount ? 'monto_distinto' : wrongDate ? 'fecha_distinta'
        : promotable ? 'confirmacion_pendiente' : 'ok';
      items.push(item);
    }
  }

  // Ventas sin ninguna prueba ni confirmación en el chat que las respalde (y que nadie calibró a mano).
  const { rows: unbacked } = await pool.query(
    `SELECT s.id, s.amount, s.advisor_name, s.created_at, c.full_name, c.whatsapp_number
     FROM sales s JOIN customers c ON c.id = s.customer_id
     WHERE s.created_at >= $1 AND s.created_at <= $2 AND NOT s.attribution_locked
       AND s.evidence_message_id IS NULL AND COALESCE(s.evidence_type, '') <> 'manual' AND s.status <> 'revisar'
     ORDER BY s.created_at`,
    [start, end]
  );
  for (const s of unbacked) {
    if (claimed.has(s.id)) continue;
    items.push({ status: 'sin_evidencia', saleId: s.id, at: s.created_at, customer: s.full_name || s.whatsapp_number, phone: s.whatsapp_number, amount: Number(s.amount), recordedAdvisor: s.advisor_name, shift: shiftOf(s.created_at) });
  }

  const counts = items.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
  return { from, to, counts, items, txtContent: buildAuditText({ from, to, counts, items }) };
}

const STATUS_LABEL = {
  ok: 'OK', sin_venta: 'FALTA VENTA', asesor_distinto: 'ASESORA DISTINTA', fecha_distinta: 'FECHA DISTINTA',
  monto_distinto: 'MONTO DISTINTO', confirmacion_pendiente: 'LISTA PARA CONFIRMAR', sin_evidencia: 'SIN COMPROBANTE',
  sin_contexto: 'SIN MEDIOS DE PAGO NI CONFIRMACIÓN', bloqueada: 'BLOQUEADA (calibrada a mano)', historico_bloqueado: 'HISTÓRICO (antes del 16/10)',
};

function buildAuditText({ from, to, counts, items }) {
  const gt = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', hour12: false });
  const lines = [`AUDITORÍA DE VENTAS ${from} → ${to}`, ''];
  for (const [k, v] of Object.entries(counts)) lines.push(`${STATUS_LABEL[k] ?? k}: ${v}`);
  lines.push('', '--------------------------------------------------------------------------------');
  for (const i of items.filter((x) => !['ok', 'historico_bloqueado', 'bloqueada'].includes(x.status))) {
    lines.push(
      `[${STATUS_LABEL[i.status] ?? i.status}] ${gt(i.at)} (${i.shift}) ${i.customer} ${i.phone ?? ''} Q${i.amount ?? '?'}${i.verified === false ? ' · sin confirmación de la asesora' : ''}`,
      i.expectedAdvisor !== undefined ? `   debería: ${i.expectedAdvisor ?? 'sin atribuir'} (${i.rule})` : '',
      i.recordedAdvisor ? `   registrada: ${i.recordedAdvisor}${i.recordedAt ? ' · ' + gt(i.recordedAt) : ''}${i.recordedAmount != null ? ' · Q' + i.recordedAmount : ''}` : '',
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}

// apply=false solo describe lo que haría. Nunca toca ventas bloqueadas ni borra nada: lo que
// no tiene respaldo en el chat pasa a "por revisar" (queda fuera de los totales).
export async function rebuildSales({ from, to, lineId = null, apply = false, user = null }) {
  const audit = await auditSales({ from, to, lineId });
  const plan = { insertar: 0, reasignar: 0, promover: 0, vincular: 0, marcarRevisar: 0 };
  for (const i of audit.items) {
    if (i.status === 'sin_venta') plan.insertar++;
    else if (['asesor_distinto', 'fecha_distinta', 'monto_distinto'].includes(i.status)) plan.reasignar++;
    else if (i.status === 'confirmacion_pendiente') plan.promover++;
    else if (i.status === 'ok' && !i.linked && i.saleId) plan.vincular++;
    else if (i.status === 'sin_evidencia') plan.marcarRevisar++;
  }
  if (!apply) return { applied: false, plan, ...audit };

  for (const i of audit.items) {
    if (i.status === 'sin_venta') {
      const customer = await getCustomer(i.customerId);
      await saleFromEpisode(customer, { ...i, eventId: i.receiptId, advisor: i.expectedAdvisor, quote: null, via: null }, i.line);
    } else if (i.saleId && !i.locked && ['asesor_distinto', 'fecha_distinta', 'monto_distinto', 'confirmacion_pendiente', 'ok'].includes(i.status)) {
      if (i.status === 'ok' && i.linked) continue;
      const u = i.expectedAdvisor ? await resolveAdvisor(i.expectedAdvisor) : null;
      const evType = i.type === 'comprobante' ? 'receipt_ocr' : 'advisor_confirmation';
      const useReceiptAmount = i.type === 'comprobante' && i.amount > 0;
      await pool.query(
        `UPDATE sales SET created_at = $2, confirmed_at = CASE WHEN $8::boolean THEN $2 ELSE confirmed_at END,
                advisor_name = COALESCE($3, advisor_name), advisor_id = COALESCE($4, advisor_id),
                attributed_by = COALESCE($5, attributed_by),
                amount = CASE WHEN $9::boolean THEN $10::numeric ELSE amount END,
                receipt_amount = CASE WHEN $9::boolean THEN $10::numeric ELSE receipt_amount END,
                amount_source = CASE WHEN $9::boolean THEN 'ocr' ELSE amount_source END,
                amount_basis = CASE WHEN $9::boolean THEN 'comprobante' ELSE amount_basis END,
                status = CASE WHEN $8::boolean AND (CASE WHEN $9::boolean THEN $10::numeric ELSE amount END) > 0 THEN 'confirmada' ELSE status END,
                evidence_type = COALESCE(evidence_type, $6), evidence_message_id = COALESCE(evidence_message_id, $7),
                updated_at = now()
         WHERE id = $1 AND NOT attribution_locked
           AND (evidence_message_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM sales WHERE evidence_type = $6 AND evidence_message_id = $7))`,
        [i.saleId, i.at, u?.name ?? null, u?.id ?? null, i.rule ?? null, evType, i.receiptId, !!i.verified, useReceiptAmount, i.amount ?? null]
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
