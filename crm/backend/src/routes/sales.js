import { Router } from 'express';
import { pool } from '../db.js';
import { logBusinessAction } from '../auditLog.js';
import { requireRole } from '../auth.js';
import { auditSales, rebuildSales } from '../salesAttribution.js';
import { startAnalysisRun, getAnalysisRun, crossCheckNotebook } from '../salesAnalysis.js';
import { computeClose, saveClose, listCloses, getClose } from '../salesClose.js';
import { exportChats } from '../salesChatExport.js';
import { lineSessionSql, defaultLineId } from '../salesThreads.js';
import { getGoals, saveGoal, buildGoalRows, monthClock } from '../salesGoals.js';
import { aggregateItems } from '../salesItems.js';
import { syncRecentPaymentLinks } from '../paymentLinks.js';
import { getPendingPayments } from '../pendingPayments.js';
import { startHistoryJob, startRescanJob, getHistoryState, isHistoryJobRunning } from '../salesHistoryJob.js';
import { restoreBackup } from '../salesHistory.js';
import { explainChat } from '../salesExplain.js';
import { reviewDay, markItem, applyHumanCorrections } from '../salesDayReview.js';

const router = Router();

// Solo las ventas confirmadas con monto suman a los totales; las "por revisar" se muestran
// aparte (por_revisar) para que nadie las pierda de vista pero no inflen el cierre.
const CONFIRMED = "s.status = 'confirmada' AND s.amount > 0";
// Monto inferido del último precio aprobado por el cliente (pago por link sin monto en el chat): suma,
// pero un supervisor o administrador debe validarlo contra lo depositado.
// También queda por validar la venta cuya asesora no es clara (otra tomó el chat tras los medios de pago).
const POR_VALIDAR = `${CONFIRMED} AND (s.amount_basis = 'precio_aprobado' OR s.attribution_uncertain) AND s.amount_validated_at IS NULL`;
const GT_HOUR = "extract(hour from s.created_at AT TIME ZONE 'America/Guatemala')";
const GT_DOW = "extract(dow from s.created_at AT TIME ZONE 'America/Guatemala')";
const shiftSum = (cond, alias) => `COALESCE(SUM(s.amount) FILTER (WHERE ${CONFIRMED} AND ${cond}), 0)::numeric(10,2) AS ${alias}`;
// Mismo corte de turnos que shiftOf() en salesRules.js (donde está probado).
const SHIFT_BUCKETS = [
  shiftSum(`${GT_DOW} <> 0 AND ${GT_HOUR} >= 8 AND ${GT_HOUR} < 15`, 'turno_manana'),
  shiftSum(`${GT_DOW} <> 0 AND ${GT_HOUR} >= 15 AND ${GT_HOUR} < 21`, 'turno_tarde'),
  shiftSum(`${GT_DOW} = 0 AND ${GT_HOUR} >= 8 AND ${GT_HOUR} < 21`, 'turno_domingo'),
  shiftSum(`(${GT_HOUR} < 8 OR ${GT_HOUR} >= 21)`, 'turno_fuera'),
].join(', ');

// Builds the date and line filter for sales queries using Guatemala local timezone
// Cláusulas del período (hora de Guatemala) sobre una columna de fecha: las ventas usan s.created_at y los mensajes h.created_at.
function periodClauses(col, period, from, to, params) {
  const gtNow = "(now() AT TIME ZONE 'America/Guatemala')";
  const gtStart = (expr) => `((${expr}) AT TIME ZONE 'America/Guatemala')`;
  const clauses = [];
  if (period === 'ayer') {
    clauses.push(`${col} >= ${gtStart(`date_trunc('day', ${gtNow} - interval '1 day')`)}`);
    clauses.push(`${col} < ${gtStart(`date_trunc('day', ${gtNow})`)}`);
  } else if (period === 'esta_semana') {
    clauses.push(`${col} >= ${gtStart(`date_trunc('week', ${gtNow})`)}`);
  } else if (period === 'este_mes') {
    clauses.push(`${col} >= ${gtStart(`date_trunc('month', ${gtNow})`)}`);
  } else if (period === 'mes_anterior') {
    clauses.push(`${col} >= ${gtStart(`date_trunc('month', ${gtNow} - interval '1 month')`)}`);
    clauses.push(`${col} < ${gtStart(`date_trunc('month', ${gtNow})`)}`);
  } else if (period === 'personalizado' && from) {
    params.push(from);
    // ::timestamp: un date con AT TIME ZONE se toma como UTC y da la hora local del día anterior (arrancaba a las 12:00 del día previo)
    clauses.push(`${col} >= ($${params.length}::date::timestamp AT TIME ZONE 'America/Guatemala')`);
    if (to) {
      params.push(to);
      clauses.push(`${col} < (($${params.length}::date + interval '1 day') AT TIME ZONE 'America/Guatemala')`);
    }
  } else {
    // Default: 'hoy' (el día de hoy en hora local de Guatemala)
    clauses.push(`${col} >= ${gtStart(`date_trunc('day', ${gtNow})`)}`);
    clauses.push(`${col} < ${gtStart(`date_trunc('day', ${gtNow}) + interval '1 day'`)}`);
  }
  return clauses;
}

function buildSalesFilter(period, from, to, lineId, params = []) {
  const clauses = [
    `COALESCE(s.notes, '') NOT LIKE '%no se reconoció como comprobante%'`,
    ...periodClauses('s.created_at', period, from, to, params),
  ];

  if (lineId) {
    params.push(Number(lineId));
    clauses.push(`(s.whatsapp_number_id = $${params.length} OR (s.whatsapp_number_id IS NULL AND EXISTS (
      SELECT 1 FROM tickets t WHERE t.customer_id = s.customer_id AND t.whatsapp_number_id = $${params.length}
    )))`);
  }

  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}

// POST /api/sales
// Registra una venta realizada por un asesor
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      customerId,
      ticketId,
      amount,
      paymentMethod,
      notes,
      quoteId,
      whatsappNumberId,
      markCustomerPaid = true,
    } = req.body ?? {};

    if (!customerId) return res.status(400).json({ error: 'customerId is required' });
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ error: 'paymentMethod is required' });
    }

    await client.query('BEGIN');

    // Resolve advisor info
    const advisorId = req.user?.id || null;
    const advisorName = req.user?.fullName || req.user?.username || 'Asesor';

    // If ticketId not passed, resolve active ticket for customer
    let resolvedTicketId = ticketId || null;
    let resolvedLineId = whatsappNumberId || null;

    if (!resolvedTicketId) {
      const { rows: tRows } = await client.query(
        `SELECT id, whatsapp_number_id FROM tickets WHERE customer_id = $1 ORDER BY (status = 'resuelto') ASC, id DESC LIMIT 1`,
        [customerId]
      );
      if (tRows.length) {
        resolvedTicketId = tRows[0].id;
        if (!resolvedLineId) resolvedLineId = tRows[0].whatsapp_number_id;
      }
    }

    // Insert sale
    const { rows: saleRows } = await client.query(
      `INSERT INTO sales (
        customer_id, ticket_id, advisor_id, advisor_name, amount, payment_method,
        quote_id, notes, whatsapp_number_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        customerId,
        resolvedTicketId,
        advisorId,
        advisorName,
        numAmount,
        paymentMethod,
        quoteId || null,
        notes || null,
        resolvedLineId,
      ]
    );

    const sale = saleRows[0];

    // If requested, mark customer as paid_locked and pagado
    if (markCustomerPaid) {
      await client.query(
        `UPDATE customers SET
           paid_locked = true,
           paid_method = $1,
           manual_status = CASE WHEN manual_status = 'despacho' THEN 'despacho' ELSE 'pagado' END,
           payment_suggested_at = NULL,
           payment_suggestion_reason = NULL,
           payment_suggestion_method = NULL,
           updated_at = now()
         WHERE id = $2`,
        [paymentMethod, customerId]
      );
    }

    await client.query('COMMIT');

    logBusinessAction(
      req.user,
      Number(customerId),
      'sale_recorded',
      `Q${numAmount.toFixed(2)} (${paymentMethod}) por ${advisorName}`
    );

    res.status(201).json({
      id: sale.id,
      customerId: sale.customer_id,
      ticketId: sale.ticket_id,
      advisorId: sale.advisor_id,
      advisorName: sale.advisor_name,
      amount: Number(sale.amount),
      paymentMethod: sale.payment_method,
      notes: sale.notes,
      quoteId: sale.quote_id,
      whatsappNumberId: sale.whatsapp_number_id,
      createdAt: sale.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/sales/customer/:customerId
// Retorna las ventas registradas para este cliente
router.get('/customer/:customerId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, q.quote_number
       FROM sales s
       LEFT JOIN quotes q ON q.id = s.quote_id
       WHERE s.customer_id = $1
       ORDER BY s.created_at DESC`,
      [req.params.customerId]
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        customerId: r.customer_id,
        ticketId: r.ticket_id,
        advisorId: r.advisor_id,
        advisorName: r.advisor_name,
        amount: Number(r.amount),
        paymentMethod: r.payment_method,
        quoteId: r.quote_id,
        quoteNumber: r.quote_number,
        notes: r.notes,
        createdAt: r.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

async function advisorsToShow({ period, from, to, lineId }) {
  const { rows: users } = await pool.query(
    `SELECT u.full_name, u.role, COALESCE(array_agg(uwn.whatsapp_number_id) FILTER (WHERE uwn.whatsapp_number_id IS NOT NULL), '{}') AS lines
     FROM users u LEFT JOIN user_whatsapp_numbers uwn ON uwn.user_id = u.id
     WHERE u.role IN ('asesor', 'supervisor', 'admin') AND u.full_name IS NOT NULL GROUP BY u.id`
  );
  const params = [];
  const when = periodClauses('h.created_at', period, from, to, params).join(' AND ');
  const onLine = lineSessionSql(lineId, await defaultLineId(), params, 'h');
  // atender = escribir como asesora en el CRM (no las difusiones de Marketing, que llevan campaignId)
  const { rows: sent } = await pool.query(
    `SELECT DISTINCT lower(h.message->'additional_kwargs'->>'advisorName') AS name FROM n8n_chat_histories h
     WHERE h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
       AND h.message->'additional_kwargs'->>'campaignId' IS NULL AND h.message->'additional_kwargs'->>'advisorName' IS NOT NULL
       AND ${when}${onLine}`,
    params
  );
  const names = sent.map((r) => r.name);
  const attended = (full) => { const f = full.toLowerCase(); return names.some((n) => n === f || f.startsWith(`${n} `)); };
  return users.filter((u) => (u.role === 'asesor' ? !lineId || u.lines.includes(Number(lineId)) : attended(u.full_name))).map((u) => u.full_name);
}

// GET /api/sales/by-advisor
// Métricas gerenciales consolidadas por asesor
router.get('/by-advisor', async (req, res, next) => {
  try {
    const { period = 'hoy', from, to, lineId } = req.query;

    const summaryParams = [];
    const filterSql = buildSalesFilter(period, from, to, lineId, summaryParams);

    // 1. Totales generales del período
    const { rows: summaryRows } = await pool.query(
      `SELECT
         COUNT(DISTINCT s.customer_id)::int AS total_clientes,
         COUNT(*)::int AS total_ventas,
         COALESCE(SUM(s.amount), 0)::numeric(10,2) AS total_quetzales
       FROM sales s
       WHERE ${CONFIRMED} ${filterSql}`,
      summaryParams
    );

    const summary = summaryRows[0] || { total_clientes: 0, total_ventas: 0, total_quetzales: '0.00' };
    const grandTotal = Number(summary.total_quetzales);
    const totalVentas = Number(summary.total_ventas);
    const ticketPromedioGlobal = totalVentas > 0 ? Number((grandTotal / totalVentas).toFixed(2)) : 0;

    // 2. Desglose detallado por asesor (ranking de ventas)
    const advisorParams = [];
    const advisorFilterSql = buildSalesFilter(period, from, to, lineId, advisorParams);

    const { rows: advisorRows } = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(s.advisor_name), ''), 'Sin Asignar') AS advisor_name,
         MAX(s.advisor_id) AS advisor_id,
         COUNT(DISTINCT s.customer_id) FILTER (WHERE ${CONFIRMED})::int AS clientes_vendidos,
         COUNT(*) FILTER (WHERE ${CONFIRMED})::int AS cantidad_ventas,
         COALESCE(SUM(s.amount) FILTER (WHERE ${CONFIRMED}), 0)::numeric(10,2) AS total_quetzales,
         ROUND(COALESCE(AVG(s.amount) FILTER (WHERE ${CONFIRMED}), 0), 2)::numeric(10,2) AS ticket_promedio,
         COUNT(*) FILTER (WHERE s.status = 'revisar')::int AS por_revisar,
         COUNT(*) FILTER (WHERE ${POR_VALIDAR})::int AS por_validar,
         COALESCE(SUM(s.amount) FILTER (WHERE ${POR_VALIDAR}), 0)::numeric(10,2) AS por_validar_total,
         ${SHIFT_BUCKETS}
       FROM sales s
       WHERE true ${advisorFilterSql}
       GROUP BY COALESCE(NULLIF(TRIM(s.advisor_name), ''), 'Sin Asignar')
       ORDER BY total_quetzales DESC, cantidad_ventas DESC`,
      advisorParams
    );

    // Aparecen aunque lleven 0 ventas: las asesoras (las de la línea, si se filtra una) y, si es supervisor o administrador,
    // solo cuando atendió chats en el período (en esa línea, si se filtra una), no por tener todas las líneas asignadas.
    const knownAdvisors = await advisorsToShow({ period, from, to, lineId });

    const existingNames = new Set(advisorRows.map(a => a.advisor_name.toLowerCase()));
    for (const name of knownAdvisors) {
      if (!existingNames.has(name.toLowerCase())) {
        advisorRows.push({
          advisor_name: name,
          advisor_id: null,
          clientes_vendidos: 0,
          cantidad_ventas: 0,
          total_quetzales: '0.00',
          ticket_promedio: '0.00',
          por_revisar: 0,
          por_validar: 0,
          por_validar_total: '0.00',
          turno_manana: '0.00',
          turno_tarde: '0.00',
          turno_domingo: '0.00',
          turno_fuera: '0.00',
        });
      }
    }

    // Ordenar: mayor monto vendido primero, luego cantidad de ventas, luego nombre
    advisorRows.sort((a, b) => {
      const diff = Number(b.total_quetzales) - Number(a.total_quetzales);
      if (diff !== 0) return diff;
      const countDiff = Number(b.cantidad_ventas) - Number(a.cantidad_ventas);
      if (countDiff !== 0) return countDiff;
      return a.advisor_name.localeCompare(b.advisor_name);
    });

    const advisors = advisorRows.map((a, idx) => {
      const total = Number(a.total_quetzales);
      return {
        rank: idx + 1,
        advisorId: a.advisor_id,
        advisorName: a.advisor_name,
        clientesVendidos: Number(a.clientes_vendidos),
        cantidadVentas: Number(a.cantidad_ventas),
        totalQuetzales: total,
        ticketPromedio: Number(a.ticket_promedio),
        porRevisar: Number(a.por_revisar),
        porValidar: Number(a.por_validar),
        porValidarTotal: Number(a.por_validar_total),
        turnos: {
          manana: Number(a.turno_manana),
          tarde: Number(a.turno_tarde),
          domingo: Number(a.turno_domingo),
          fuera: Number(a.turno_fuera),
        },
        porcentajeDelTotal: grandTotal > 0 ? Number(((total / grandTotal) * 100).toFixed(1)) : 0,
      };
    });

    // 3. Ventas por día dentro del período (para gráficos de evolución)
    const dailyParams = [];
    const dailyFilterSql = buildSalesFilter(period, from, to, lineId, dailyParams);

    const { rows: dailyRows } = await pool.query(
      `SELECT
         date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala')::date AS day,
         COALESCE(SUM(s.amount), 0)::numeric(10,2) AS total_quetzales,
         COUNT(*)::int AS cantidad_ventas
       FROM sales s
       WHERE ${CONFIRMED} ${dailyFilterSql}
       GROUP BY day
       ORDER BY day ASC`,
      dailyParams
    );

    // 4. Desglose por medio de pago
    const methodParams = [];
    const methodFilterSql = buildSalesFilter(period, from, to, lineId, methodParams);

    const { rows: methodRows } = await pool.query(
      `SELECT
         COALESCE(s.payment_method, 'otro') AS method,
         COUNT(*)::int AS count,
         COALESCE(SUM(s.amount), 0)::numeric(10,2) AS total_quetzales
       FROM sales s
       WHERE ${CONFIRMED} ${methodFilterSql}
       GROUP BY method
       ORDER BY total_quetzales DESC`,
      methodParams
    );

    // 5. Últimas transacciones detalladas
    const transParams = [];
    const transFilterSql = buildSalesFilter(period, from, to, lineId, transParams);

    const { rows: transactionRows } = await pool.query(
      `SELECT
         s.id,
         s.amount,
         s.payment_method,
         s.notes,
         s.advisor_name,
         s.advisor_id,
         s.customer_id,
         s.ticket_id,
         s.whatsapp_number_id,
         s.created_at,
         s.status,
         s.amount_source,
         s.quoted_amount,
         s.receipt_amount,
         s.amount_match,
         s.channel,
         s.amount_basis,
         s.amount_validated_at,
         s.attribution_uncertain,
         s.advisor_override_at,
         c.full_name AS customer_name,
         c.whatsapp_number AS customer_phone
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE true ${transFilterSql}
       ORDER BY s.created_at DESC
       LIMIT 300`,
      transParams
    );

    // Pendiente de pago: links de NeoLink mandados en los últimos 8 días sin venta registrada después. Leer los links nuevos puede
    // tardar unos segundos (se abre la página de pago); se espera como máximo 6 s y el resto se completa en la siguiente carga.
    let pending = null;
    try {
      await Promise.race([syncRecentPaymentLinks(), new Promise((resolve) => setTimeout(resolve, 6000))]);
      pending = await getPendingPayments({ lineId });
    } catch (err) { console.error('pending payments', err.message); }

    res.json({
      period,
      from: from || null,
      to: to || null,
      lineId: lineId ? Number(lineId) : null,
      summary: {
        totalQuetzales: grandTotal,
        totalClientes: Number(summary.total_clientes),
        totalVentas: totalVentas,
        ticketPromedio: ticketPromedioGlobal,
      },
      advisors,
      pending,
      daily: dailyRows.map((r) => ({
        day: r.day,
        totalQuetzales: Number(r.total_quetzales),
        cantidadVentas: Number(r.cantidad_ventas),
      })),
      paymentMethods: methodRows.map((r) => ({
        method: r.method,
        count: Number(r.count),
        totalQuetzales: Number(r.total_quetzales),
      })),
      transactions: transactionRows.map((t) => ({
        id: t.id,
        amount: Number(t.amount),
        paymentMethod: t.payment_method,
        notes: t.notes,
        advisorName: t.advisor_name,
        advisorId: t.advisor_id,
        customerId: t.customer_id,
        ticketId: t.ticket_id,
        customerName: t.customer_name || t.customer_phone,
        customerPhone: t.customer_phone,
        whatsappNumberId: t.whatsapp_number_id,
        status: t.status || 'confirmada',
        amountSource: t.amount_source || 'manual',
        quotedAmount: t.quoted_amount ? Number(t.quoted_amount) : null,
        receiptAmount: t.receipt_amount ? Number(t.receipt_amount) : null,
        amountMatch: t.amount_match,
        channel: t.channel || 'whatsapp',
        amountBasis: t.amount_basis || null,
        validated: !!t.amount_validated_at,
        attributionUncertain: !!t.attribution_uncertain,
        advisorOverridden: !!t.advisor_override_at,
        createdAt: t.created_at,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/sales/:id
// Permite actualizar el monto o medio de pago de una venta
// Cumplimiento mensual: por cada línea con meta, lo vendido en el mes por cada asesora contra su meta (independiente del
// período que se esté viendo). GET para todos; la meta la cambian administración y supervisión.
router.get('/goals', async (req, res, next) => {
  try {
    const goals = await getGoals();
    const { month, day, days } = monthClock();
    const out = [];
    for (const [lineId, g] of Object.entries(goals)) {
      const params = [];
      const filter = buildSalesFilter('este_mes', null, null, lineId, params);
      const [totals, advisors, line] = await Promise.all([
        pool.query(
          `SELECT COALESCE(NULLIF(TRIM(s.advisor_name), ''), 'Sin Asignar') AS name, COALESCE(SUM(s.amount), 0) AS total, COUNT(*)::int AS count
           FROM sales s WHERE ${CONFIRMED} ${filter} GROUP BY 1`, params),
        pool.query(
          `SELECT u.full_name AS name FROM users u JOIN user_whatsapp_numbers uwn ON uwn.user_id = u.id
           WHERE u.role = 'asesor' AND u.full_name IS NOT NULL AND uwn.whatsapp_number_id = $1`, [Number(lineId)]),
        pool.query('SELECT label FROM whatsapp_numbers WHERE id = $1', [Number(lineId)]),
      ]);
      out.push({ lineId: Number(lineId), lineLabel: line.rows[0]?.label ?? `Línea ${lineId}`, monthly: Number(g.monthly), month, day, days, ...buildGoalRows({ advisors: advisors.rows, totals: totals.rows, goal: Number(g.monthly), day, days }) });
    }
    res.json({ goals: out, canEdit: ['admin', 'supervisor'].includes(req.user.role) });
  } catch (err) { next(err); }
});

// body: { lineId, monthly } — monthly vacío o 0 quita la meta de esa línea.
router.put('/goals', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    await saveGoal(req.body?.lineId, req.body?.monthly, req.user.id);
    logBusinessAction(req.user, null, 'sales_goal_updated', `línea ${req.body?.lineId}: Q${req.body?.monthly || 0} al mes por asesora`);
    res.json({ ok: true });
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

// Prendas vendidas en el período (y la línea): sale de la cotización de cada venta; las ventas sin cotización se cuentan aparte.
router.get('/items', async (req, res, next) => {
  try {
    const { period = 'hoy', from, to, lineId } = req.query;
    const params = [];
    const filter = buildSalesFilter(period, from, to, lineId, params);
    const { rows } = await pool.query(
      `SELECT s.id AS sale_id, s.amount, q.id AS quote_id, q.grand_total, qi.sku, qi.name, qi.size, qi.quantity, qi.final_price
       FROM sales s
       LEFT JOIN LATERAL (
         SELECT q2.id, q2.grand_total FROM quotes q2
         WHERE q2.id = s.quote_id
            OR (s.quote_id IS NULL AND q2.customer_id = s.customer_id AND q2.created_at <= s.created_at AND q2.created_at >= s.created_at - interval '30 days')
         ORDER BY (q2.id = s.quote_id) DESC NULLS LAST, q2.created_at DESC LIMIT 1
       ) q ON true
       LEFT JOIN quote_items qi ON qi.quote_id = q.id
       WHERE ${CONFIRMED} ${filter}
       ORDER BY s.created_at DESC, qi.id`,
      params
    );
    res.json(aggregateItems(rows));
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT * FROM sales WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Venta no encontrada' });
    const sale = existing[0];

    const { amount, paymentMethod, notes, advisorName, status } = req.body ?? {};

    const updates = [];
    const values = [];

    if (amount !== undefined) {
      const num = Number(amount);
      if (isNaN(num) || num < 0) return res.status(400).json({ error: 'Monto inválido' });
      values.push(num);
      updates.push(`amount = $${values.length}`);
    }
    if (paymentMethod !== undefined) {
      values.push(paymentMethod);
      updates.push(`payment_method = $${values.length}`);
    }
    if (notes !== undefined) {
      values.push(notes);
      updates.push(`notes = $${values.length}`);
    }
    if (status !== undefined && (status === 'confirmada' || status === 'revisar')) {
      values.push(status);
      updates.push(`status = $${values.length}`);
    }
    let advisorChange = '';
    if (advisorName !== undefined && (req.user.role === 'admin' || req.user.role === 'supervisor')) {
      const { rows: u } = await pool.query('SELECT id, full_name FROM users WHERE lower(full_name) = lower($1) LIMIT 1', [String(advisorName).trim()]);
      if (!u.length) return res.status(400).json({ error: 'Esa asesora no existe en el CRM' });
      if (u[0].full_name !== sale.advisor_name) {
        // Corrección manual: queda fija, el motor y las auditorías ya no la mueven (advisor_override_at).
        values.push(u[0].full_name); updates.push(`advisor_name = $${values.length}`);
        values.push(u[0].id); updates.push(`advisor_id = $${values.length}`);
        values.push(req.user.id); updates.push(`advisor_override_by = $${values.length}`);
        updates.push('advisor_override_at = now()', "attributed_by = 'manual'", 'attribution_uncertain = false');
        advisorChange = ` · asesora ${sale.advisor_name} → ${u[0].full_name}`;
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'Nada para actualizar' });

    updates.push(`updated_at = now()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE sales SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    logBusinessAction(
      req.user,
      sale.customer_id,
      'sale_updated',
      `Venta #${sale.id} actualizada: Q${Number(rows[0].amount).toFixed(2)}${advisorChange} por ${req.user.fullName || req.user.username}`
    );

    res.json({
      id: rows[0].id,
      amount: Number(rows[0].amount),
      paymentMethod: rows[0].payment_method,
      notes: rows[0].notes,
      advisorName: rows[0].advisor_name,
      status: rows[0].status,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sales/:id
// Permite eliminar una venta registrada por error (admin, supervisor o el mismo asesor en las primeras 2 horas)
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM sales WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Venta no encontrada' });
    const sale = rows[0];

    const isAdminOrSup = req.user.role === 'admin' || req.user.role === 'supervisor';
    const isOwner = sale.advisor_id === req.user.id;
    const hoursSinceCreation = (Date.now() - new Date(sale.created_at).getTime()) / (1000 * 60 * 60);

    if (!isAdminOrSup && (!isOwner || hoursSinceCreation > 2)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar esta venta' });
    }

    await pool.query(`DELETE FROM sales WHERE id = $1`, [req.params.id]);

    logBusinessAction(
      req.user,
      sale.customer_id,
      'sale_deleted',
      `Venta #${sale.id} de Q${Number(sale.amount).toFixed(2)} eliminada por ${req.user.fullName || req.user.username}`
    );

    res.json({ ok: true, deletedSaleId: sale.id });
  } catch (err) {
    next(err);
  }
});

// POST /api/sales/:id/validate-amount { amount? }
// Un supervisor o administrador confirma que el monto de una venta (inferido del último precio
// aprobado por el cliente) coincide con lo depositado y validado en el banco; puede corregirlo.
router.post('/:id/validate-amount', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query('SELECT * FROM sales WHERE id = $1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'Venta no encontrada' });
    const sale = existing[0];
    const given = req.body?.amount;
    const amount = given === undefined || given === null || given === '' ? Number(sale.amount) : Number(given);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) return res.status(400).json({ error: 'El monto debe estar entre Q1 y Q10,000' });
    const { rows } = await pool.query(
      `UPDATE sales SET amount = $2, status = CASE WHEN advisor_id IS NOT NULL OR advisor_name <> 'Sin atribuir' THEN 'confirmada' ELSE status END,
              amount_validated_by = $3, amount_validated_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [sale.id, amount, req.user.id]
    );
    logBusinessAction(req.user, sale.customer_id, 'sale_updated',
      `Monto validado Q${amount.toFixed(2)}${amount !== Number(sale.amount) ? ` (antes Q${Number(sale.amount).toFixed(2)})` : ''} por ${req.user.fullName || req.user.username}`);
    res.json({ id: rows[0].id, amount: Number(rows[0].amount), validatedAt: rows[0].amount_validated_at });
  } catch (err) { next(err); }
});

// GET /api/sales/audit?from=YYYY-MM-DD&to=YYYY-MM-DD[&lineId=]
// Compara cada comprobante del chat contra las ventas registradas (asesora, día, monto).
// Solo lee: no cambia nada.
router.get('/audit', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { from, to, lineId } = req.query;
    res.json(await auditSales({ from, to, lineId: lineId ? Number(lineId) : null }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/sales/rebuild { from, to, lineId?, apply? }
// Sin apply:true solo muestra el plan. Nunca borra ni toca ventas bloqueadas.
router.post('/rebuild', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const { from, to, lineId, apply } = req.body ?? {};
    res.json(await rebuildSales({ from, to, lineId: lineId ? Number(lineId) : null, apply: apply === true, user: req.user }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Reconstrucción del historial día por día desde los chats (mismo motor que scripts/rebuildHistory.js). Solo admin: reemplaza ventas.
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
const adminOnly = requireRole('admin');

router.get('/history', adminOnly, async (req, res, next) => {
  try { res.json(await getHistoryState(Number(req.query.since) || 0)); } catch (err) { next(err); }
});

// GET /api/sales/history/explain?phone=7107&day=2026-10-15: cómo lee el motor el chat de un cliente (solo lectura)
router.get('/history/explain', adminOnly, async (req, res, next) => {
  try { res.json({ lines: await explainChat({ phone: req.query.phone, day: req.query.day }) }); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Revisión día por día: GET lista las ventas del día para revisarlas a mano; PUT guarda la marca (ok / mal / null) de una de ellas.
router.get('/history/day', adminOnly, async (req, res, next) => {
  try {
    if (!isDay(req.query.day)) return res.status(400).json({ error: 'Indica el día (AAAA-MM-DD)' });
    res.json(await reviewDay(req.query.day));
  } catch (err) { next(err); }
});

router.put('/history/day/mark', adminOnly, async (req, res, next) => {
  try {
    const { day, itemKey, verdict = null, note, amountOverride, advisorOverride, keep, discard } = req.body ?? {};
    await markItem({ day, itemKey, verdict, note, amountOverride, advisorOverride, keep, discard, userId: req.user?.id });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/sales/history/rescan { days? }: relee los comprobantes guardados y quita los que eran pantallas de verificación o de rechazo
router.post('/history/rescan', adminOnly, async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.body?.days) || 30, 1), 90);
    res.status(202).json(await startRescanJob({ days, userName: req.user?.fullName || req.user?.username }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/sales/history/day/apply { day }: reconstruye ese día y fija las correcciones que la persona marcó en la revisión.
router.post('/history/day/apply', adminOnly, async (req, res, next) => {
  try {
    const day = req.body?.day;
    if (!isDay(day)) return res.status(400).json({ error: 'Indica el día (AAAA-MM-DD)' });
    const { rows } = await pool.query('SELECT 1 FROM sales_rebuild_days WHERE day = $1', [day]);
    const userId = req.user?.id;
    res.status(202).json(await startHistoryJob({
      mode: 'apply', from: day, to: day, force: rows.length > 0, userName: req.user?.fullName || req.user?.username,
      hooks: { before: (log) => applyHumanCorrections(day, userId, 'before', log), after: (log) => applyHumanCorrections(day, userId, 'after', log) },
    }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/sales/history { mode: 'preview' | 'apply', from, to, force? }
router.post('/history', adminOnly, async (req, res, next) => {
  try {
    const { mode, from, to, force } = req.body ?? {};
    if (!['preview', 'apply'].includes(mode) || !isDay(from) || !isDay(to) || from > to) return res.status(400).json({ error: 'Indica modo y un rango de fechas válido' });
    res.status(202).json(await startHistoryJob({ mode, from, to, force: force === true, userName: req.user?.fullName || req.user?.username }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/history/restore', adminOnly, async (req, res, next) => {
  try {
    if (isHistoryJobRunning()) return res.status(409).json({ error: 'Hay una reconstrucción corriendo. Espera a que termine.' });
    res.json(await restoreBackup(req.body?.backup));
  } catch (err) {
    if (/Nombre de copia|No existe la copia/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// Análisis histórico de TODOS los chats de clientes que compraron (solo lectura; corre en
// segundo plano y guarda el informe para reabrirlo).
router.post('/analysis', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.status(202).json(await startAnalysisRun(req.user?.id, { from: req.body?.from, to: req.body?.to })); } catch (err) { next(err); }
});

router.get('/analysis/latest', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.json(await getAnalysisRun(null, { full: req.query.full === '1' })); } catch (err) { next(err); }
});

router.get('/analysis/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const run = await getAnalysisRun(Number(req.params.id), { full: req.query.full === '1' });
    if (!run) return res.status(404).json({ error: 'Análisis no encontrado' });
    res.json(run);
  } catch (err) { next(err); }
});

// Contrasta lo que anotan las asesoras a mano (últimos 4 dígitos o nombre, medio, monto)
// con lo que el chat realmente muestra.
// Cierre del día: lo pagado y lo pendiente de cada asesora hasta una hora (corte). GET calcula sin guardar;
// POST guarda el cierre (queda congelado); GET /closes lista los guardados.
router.get('/close', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.json(await computeClose({ day: req.query.date, asOf: req.query.asOf })); } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

router.post('/close', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const label = String(req.body?.label ?? '').trim().slice(0, 80) || `Cierre manual de ${req.user.fullName || req.user.username}`;
    res.status(201).json(await saveClose({ day: req.body?.date, asOf: req.body?.asOf, label, userId: req.user.id }));
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
});

router.get('/closes', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.json(await listCloses(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : null)); } catch (err) { next(err); }
});

router.get('/closes/:id', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const close = await getClose(Number(req.params.id));
    if (!close) return res.status(404).json({ error: 'Cierre no encontrado' });
    res.json(close);
  } catch (err) { next(err); }
});

// Exporta (texto plano) los chats de los clientes en Pagado / Por despacho del período, con lo que leyó el motor y lo
// registrado en el CRM, para revisarlos a mano. Se escribe por partes: con cientos de chats no cabe en una sola respuesta.
router.get('/export-chats', requireRole('admin', 'supervisor'), async (req, res, next) => {
  const { from, to } = req.query;
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from ?? '') || !ymd.test(to ?? '')) return res.status(400).json({ error: 'Usa fechas AAAA-MM-DD (desde y hasta)' });
  try {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chats_pagados_despacho_${from}_${to}.txt"`);
    await exportChats({ from, to, write: (s) => res.write(s) });
    res.end();
  } catch (err) {
    if (res.headersSent) { res.write(`\nERROR: ${err.message}\n`); res.end(); } else next(err);
  }
});

router.post('/analysis/notebook', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'entries es requerido' });
    res.json({ results: await crossCheckNotebook(entries) });
  } catch (err) { next(err); }
});

export default router;
