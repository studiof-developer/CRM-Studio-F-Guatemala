import { Router } from 'express';
import { pool } from '../db.js';
import { logBusinessAction } from '../auditLog.js';
import { requireRole } from '../auth.js';
import { auditSales, rebuildSales } from '../salesAttribution.js';
import { startAnalysisRun, getAnalysisRun, crossCheckNotebook } from '../salesAnalysis.js';

const router = Router();

// Solo las ventas confirmadas con monto suman a los totales; las "por revisar" se muestran
// aparte (por_revisar) para que nadie las pierda de vista pero no inflen el cierre.
const CONFIRMED = "s.status = 'confirmada' AND s.amount > 0";
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
function buildSalesFilter(period, from, to, lineId, params = []) {
  const clauses = [
    `COALESCE(s.notes, '') NOT LIKE '%no se reconoció como comprobante%'`,
  ];

  if (period === 'ayer') {
    clauses.push(`s.created_at >= (date_trunc('day', (now() AT TIME ZONE 'America/Guatemala') - interval '1 day') AT TIME ZONE 'America/Guatemala')`);
    clauses.push(`s.created_at < (date_trunc('day', now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala')`);
  } else if (period === 'esta_semana') {
    clauses.push(`s.created_at >= (date_trunc('week', now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala')`);
  } else if (period === 'este_mes') {
    clauses.push(`s.created_at >= (date_trunc('month', now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala')`);
  } else if (period === 'mes_anterior') {
    clauses.push(`s.created_at >= (date_trunc('month', (now() AT TIME ZONE 'America/Guatemala') - interval '1 month') AT TIME ZONE 'America/Guatemala')`);
    clauses.push(`s.created_at < (date_trunc('month', now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala')`);
  } else if (period === 'personalizado' && from) {
    params.push(from);
    clauses.push(`s.created_at >= ($${params.length}::date AT TIME ZONE 'America/Guatemala')`);
    if (to) {
      params.push(to);
      clauses.push(`s.created_at < (($${params.length}::date + interval '1 day') AT TIME ZONE 'America/Guatemala')`);
    }
  } else {
    // Default: 'hoy' (el día de hoy en hora local de Guatemala)
    clauses.push(`s.created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Guatemala') AT TIME ZONE 'America/Guatemala')`);
    clauses.push(`s.created_at < ((date_trunc('day', now() AT TIME ZONE 'America/Guatemala') + interval '1 day') AT TIME ZONE 'America/Guatemala')`);
  }

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
         ${SHIFT_BUCKETS}
       FROM sales s
       WHERE true ${advisorFilterSql}
       GROUP BY COALESCE(NULLIF(TRIM(s.advisor_name), ''), 'Sin Asignar')
       ORDER BY total_quetzales DESC, cantidad_ventas DESC`,
      advisorParams
    );

    // Las asesoras siempre aparecen en el ranking aunque lleven 0 ventas; si se filtra por
    // línea, solo las que tienen esa línea asignada.
    const { rows: uAdvs } = await pool.query(
      `SELECT DISTINCT u.full_name FROM users u
       LEFT JOIN user_whatsapp_numbers uwn ON uwn.user_id = u.id
       WHERE u.role IN ('asesor', 'supervisor') AND u.full_name IS NOT NULL
         AND ($1::int IS NULL OR uwn.whatsapp_number_id = $1::int)`,
      [lineId ? Number(lineId) : null]
    );
    const knownAdvisors = uAdvs.map((u) => u.full_name);

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
         c.full_name AS customer_name,
         c.whatsapp_number AS customer_phone
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE true ${transFilterSql}
       ORDER BY s.created_at DESC
       LIMIT 300`,
      transParams
    );

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
    if (advisorName !== undefined && (req.user.role === 'admin' || req.user.role === 'supervisor')) {
      values.push(advisorName);
      updates.push(`advisor_name = $${values.length}`);
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
      `Venta #${sale.id} actualizada: Q${Number(rows[0].amount).toFixed(2)} por ${req.user.fullName || req.user.username}`
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

// GET /api/sales/daily-breakdown
// Retorna un análisis consolidado día por día comparando ventas de asesoras
router.get('/daily-breakdown', async (req, res, next) => {
  try {
    const { from = '2026-09-01', to = '2026-10-31', lineId } = req.query;

    const params = [from, to];
    let lineClause = '';
    if (lineId) {
      params.push(Number(lineId));
      lineClause = `AND s.whatsapp_number_id = $${params.length}`;
    }

    // Consulta detallada por día y asesora
    const { rows: advisorDailyRows } = await pool.query(
      `SELECT
         date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala')::date AS day,
         COALESCE(s.advisor_name, 'Sin asesor') AS advisor_name,
         COUNT(*)::int AS ventas,
         COALESCE(SUM(s.amount), 0)::numeric(10,2) AS monto
       FROM sales s
       WHERE s.created_at >= ($1::date AT TIME ZONE 'America/Guatemala')
         AND s.created_at < (($2::date + interval '1 day') AT TIME ZONE 'America/Guatemala')
         AND s.status = 'confirmada' AND s.amount > 0
         AND COALESCE(s.notes, '') NOT LIKE '%no se reconoció como comprobante%'
         ${lineClause}
       GROUP BY day, s.advisor_name
       ORDER BY day ASC, monto DESC`,
      params
    );

    // Consulta global consolidada día por día
    const { rows } = await pool.query(
      `SELECT
         date_trunc('day', s.created_at AT TIME ZONE 'America/Guatemala')::date AS day,
         COUNT(*) FILTER (WHERE s.advisor_name ILIKE '%Leydi%')::int AS leydi_ventas,
         COALESCE(SUM(s.amount) FILTER (WHERE s.advisor_name ILIKE '%Leydi%'), 0)::numeric(10,2) AS leydi_monto,
         COUNT(*) FILTER (WHERE s.advisor_name ILIKE '%Aura%')::int AS aura_ventas,
         COALESCE(SUM(s.amount) FILTER (WHERE s.advisor_name ILIKE '%Aura%'), 0)::numeric(10,2) AS aura_monto,
         COUNT(*) FILTER (WHERE s.advisor_name NOT ILIKE '%Leydi%' AND s.advisor_name NOT ILIKE '%Aura%')::int AS otros_ventas,
         COALESCE(SUM(s.amount) FILTER (WHERE s.advisor_name NOT ILIKE '%Leydi%' AND s.advisor_name NOT ILIKE '%Aura%'), 0)::numeric(10,2) AS otros_monto,
         COUNT(*)::int AS total_ventas,
         COALESCE(SUM(s.amount), 0)::numeric(10,2) AS total_monto
       FROM sales s
       WHERE s.created_at >= ($1::date AT TIME ZONE 'America/Guatemala')
         AND s.created_at < (($2::date + interval '1 day') AT TIME ZONE 'America/Guatemala')
         AND s.status = 'confirmada' AND s.amount > 0
         AND COALESCE(s.notes, '') NOT LIKE '%no se reconoció como comprobante%'
         ${lineClause}
       GROUP BY day
       ORDER BY day ASC`,
      params
    );

    // Mapeo dinámico por día
    const dayMap = new Map();
    for (const r of advisorDailyRows) {
      const dayKey = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
      if (!dayMap.has(dayKey)) dayMap.set(dayKey, {});
      dayMap.get(dayKey)[r.advisor_name] = {
        ventas: Number(r.ventas),
        monto: Number(r.monto),
      };
    }

    let totalLeydiVentas = 0;
    let totalLeydiMonto = 0;
    let totalAuraVentas = 0;
    let totalAuraMonto = 0;
    let totalVentas = 0;
    let totalMonto = 0;

    const advisorTotals = {};

    for (const r of advisorDailyRows) {
      if (!advisorTotals[r.advisor_name]) {
        advisorTotals[r.advisor_name] = { ventas: 0, monto: 0 };
      }
      advisorTotals[r.advisor_name].ventas += Number(r.ventas);
      advisorTotals[r.advisor_name].monto += Number(r.monto);
    }

    const daily = rows.map((r) => {
      const lV = Number(r.leydi_ventas);
      const lM = Number(r.leydi_monto);
      const aV = Number(r.aura_ventas);
      const aM = Number(r.aura_monto);
      const tV = Number(r.total_ventas);
      const tM = Number(r.total_monto);

      totalLeydiVentas += lV;
      totalLeydiMonto += lM;
      totalAuraVentas += aV;
      totalAuraMonto += aM;
      totalVentas += tV;
      totalMonto += tM;

      const dayKey = r.day.toISOString ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);

      return {
        day: r.day,
        leydi: { ventas: lV, monto: lM },
        aura: { ventas: aV, monto: aM },
        otros: { ventas: Number(r.otros_ventas), monto: Number(r.otros_monto) },
        total: { ventas: tV, monto: tM },
        byAdvisor: dayMap.get(dayKey) || {},
      };
    });

    res.json({
      from,
      to,
      summary: {
        totalVentas,
        totalMonto,
        leydi: { ventas: totalLeydiVentas, monto: totalLeydiMonto },
        aura: { ventas: totalAuraVentas, monto: totalAuraMonto },
        advisors: Object.entries(advisorTotals)
          .map(([name, data]) => ({
            name,
            ventas: data.ventas,
            monto: Number(data.monto.toFixed(2)),
            promedio: data.ventas > 0 ? Number((data.monto / data.ventas).toFixed(2)) : 0,
          }))
          .sort((a, b) => b.monto - a.monto),
      },
      daily,
    });
  } catch (err) {
    next(err);
  }
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

// Análisis histórico de TODOS los chats de clientes que compraron (solo lectura; corre en
// segundo plano y guarda el informe para reabrirlo).
router.post('/analysis', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try { res.status(202).json(await startAnalysisRun(req.user?.id)); } catch (err) { next(err); }
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
router.post('/analysis/notebook', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (!entries.length) return res.status(400).json({ error: 'entries es requerido' });
    res.json({ results: await crossCheckNotebook(entries) });
  } catch (err) { next(err); }
});

export default router;
