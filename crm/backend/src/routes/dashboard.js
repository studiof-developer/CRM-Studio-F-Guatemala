import { Router } from 'express';
import { pool } from '../db.js';
import { TEMPERATURE_SQL, VALID_TEMPERATURES, zoneClause } from './customers.js';

const router = Router();

// orders/order_items are dead tables — nothing in this app (CRM UI or n8n) ever
// writes to them, so a revenue/products dashboard built on them always reads zero
// in real operation. This reflects what's actually populated: customers, tickets,
// and the bot -> pendiente -> asesor -> resuelto lifecycle.
router.get('/', async (req, res, next) => {
  try {
    const kpiParams = [];
    const kpiZone = zoneClause(req.user, kpiParams);

    const pipelineParams = [];
    const pipelineZone = zoneClause(req.user, pipelineParams);

    const [kpis, pipeline, ticketsByStatus, conversationsByDay, advisorActivity, recentTickets] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*) FROM customers c WHERE true ${kpiZone}) AS clientes_totales,
           (SELECT count(*) FROM customers c WHERE c.created_at >= now() - interval '7 days' ${kpiZone}) AS registros_semana,
           (SELECT count(*) FROM customers c WHERE c.paid_locked ${kpiZone}) AS clientes_pagados,
           (SELECT count(*) FROM tickets t JOIN customers c ON c.id=t.customer_id
             WHERE t.status IN ('esperando_asesor','en_atencion') ${kpiZone}) AS tickets_pendientes,
           (SELECT round(avg(extract(epoch FROM (t.first_response_at - t.created_at)))/60)
             FROM tickets t JOIN customers c ON c.id=t.customer_id
             WHERE t.first_response_at IS NOT NULL AND t.created_at >= now() - interval '30 days' ${kpiZone}) AS tiempo_respuesta_min,
           (SELECT round(avg(extract(epoch FROM (t.resolved_at - t.created_at)))/60)
             FROM tickets t JOIN customers c ON c.id=t.customer_id
             WHERE t.resolved_at IS NOT NULL AND t.created_at >= now() - interval '30 days' ${kpiZone}) AS tiempo_resolucion_min`,
        kpiParams
      ),
      pool.query(
        `SELECT ${TEMPERATURE_SQL} AS temperature, count(*) AS count
         FROM customers c WHERE true ${pipelineZone} GROUP BY temperature`,
        pipelineParams
      ),
      pool.query(
        `SELECT t.status, count(*) AS count
         FROM tickets t
         WHERE t.status IN ('esperando_asesor','en_atencion','resuelto')
         GROUP BY t.status`
      ),
      pool.query(
        `SELECT date_trunc('day', c.created_at)::date AS day, count(*) AS count
         FROM customers c
         WHERE c.created_at >= now() - interval '14 days'
         GROUP BY day ORDER BY day`
      ),
      pool.query(
        `SELECT t.assigned_advisor, count(*) AS count
         FROM tickets t
         WHERE t.status = 'resuelto' AND t.resolved_at >= now() - interval '30 days' AND t.assigned_advisor IS NOT NULL
         GROUP BY t.assigned_advisor ORDER BY count DESC LIMIT 8`
      ),
      pool.query(
        `SELECT t.id, t.status, t.assigned_advisor, t.handoff_reason, t.created_at,
                c.full_name, c.whatsapp_number
         FROM tickets t JOIN customers c ON c.id = t.customer_id
         ORDER BY t.created_at DESC LIMIT 6`
      ),
    ]);

    const pipelineCounts = Object.fromEntries(VALID_TEMPERATURES.map((t) => [t, 0]));
    for (const r of pipeline.rows) pipelineCounts[r.temperature] = Number(r.count);

    const ticketStatusCounts = { esperando_asesor: 0, en_atencion: 0, resuelto: 0 };
    for (const r of ticketsByStatus.rows) ticketStatusCounts[r.status] = Number(r.count);

    res.json({
      kpis: {
        clientesTotales: Number(kpis.rows[0].clientes_totales),
        registrosSemana: Number(kpis.rows[0].registros_semana),
        clientesPagados: Number(kpis.rows[0].clientes_pagados),
        ticketsPendientes: Number(kpis.rows[0].tickets_pendientes),
        tiempoRespuestaMin: kpis.rows[0].tiempo_respuesta_min === null ? null : Number(kpis.rows[0].tiempo_respuesta_min),
        tiempoResolucionMin: kpis.rows[0].tiempo_resolucion_min === null ? null : Number(kpis.rows[0].tiempo_resolucion_min),
      },
      pipeline: pipelineCounts,
      ticketStatus: ticketStatusCounts,
      conversationsByDay: conversationsByDay.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
      advisorActivity: advisorActivity.rows.map((r) => ({ advisor: r.assigned_advisor, count: Number(r.count) })),
      recentTickets: recentTickets.rows.map((r) => ({
        id: r.id,
        status: r.status,
        assignedAdvisor: r.assigned_advisor,
        handoffReason: r.handoff_reason,
        customerName: r.full_name || r.whatsapp_number,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
