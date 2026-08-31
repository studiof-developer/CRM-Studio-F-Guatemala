import { Router } from 'express';
import { pool } from '../db.js';
import { TEMPERATURE_SQL, VALID_TEMPERATURES, zoneClause } from './customers.js';

const router = Router();

// Same request-coalescing as conversations.js's list/unread-count (see that file for the
// full reasoning) — several people opening the Dashboard within the same few seconds
// used to mean several full 9-query fan-outs running at once, all competing for the same
// CPU. One person's load now serves everyone else who asks within the window instead of
// each starting their own. Keyed by canSeePauta since that's the only thing that changes
// which queries run (zoneClause is currently a no-op, so every role sees the same rows
// otherwise) — an asesor's cached result is never handed to an admin/supervisor missing
// the pauta breakdown they're allowed to see, or vice versa.
const DASHBOARD_CACHE_TTL_MS = 3000;
const dashboardCache = new Map();
function cachedDashboard(key, run) {
  const hit = dashboardCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = run().catch((err) => { dashboardCache.delete(key); throw err; });
  dashboardCache.set(key, { expires: Date.now() + DASHBOARD_CACHE_TTL_MS, promise });
  return promise;
}

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

    const canSeePauta = req.user.role === 'admin' || req.user.role === 'supervisor';

    const [kpis, pipeline, ticketsByStatus, conversationsByDay, advisorActivity, recentTickets, paidMethods, handoffReasons, pautaByDay] = await cachedDashboard(String(canSeePauta), () => Promise.all([
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
        // created_at is stored as a UTC instant — grouping by date_trunc('day', created_at)
        // directly buckets by UTC calendar day, whose midnight boundary falls at 6pm
        // Guatemala time. Anything from 6pm-midnight local was landing in the *next*
        // day's bucket instead of the day it actually happened on locally.
        `SELECT date_trunc('day', c.created_at AT TIME ZONE 'America/Guatemala')::date AS day, count(*) AS count
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
      pool.query(
        `SELECT paid_method, count(*) AS count
         FROM customers
         WHERE paid_locked AND paid_method IS NOT NULL
         GROUP BY paid_method ORDER BY count DESC`
      ),
      pool.query(
        `SELECT handoff_reason, count(*) AS count
         FROM tickets
         WHERE handoff_reason IS NOT NULL AND created_at >= now() - interval '30 days'
         GROUP BY handoff_reason ORDER BY count DESC LIMIT 8`
      ),
      // Meta stamps a `referral` object on the inbound message when a customer arrives
      // by clicking a Click-to-WhatsApp ad — that's the only signal of "this came from
      // a pauta" in the data. Counted by distinct session_id, not raw message count —
      // verified against production on 2026-08-26 that a handful of conversations carry
      // referral on more than one message, which would have double-counted the same
      // contact as two separate arrivals. Admin/supervisor only — ad performance isn't
      // something every advisor needs to see day to day.
      // Bucketed by Guatemala's calendar day, not UTC's — same reason as conversationsByDay
      // above — so this lines up with how Meta's own ad reporting divides up a "day"
      // instead of shifting evening messages into the next day's count.
      canSeePauta
        ? pool.query(
            `SELECT date_trunc('day', h.created_at AT TIME ZONE 'America/Guatemala')::date AS day, count(DISTINCT h.session_id) AS count
             FROM n8n_chat_histories h
             WHERE h.message->>'type' = 'human'
               AND h.message->'additional_kwargs'->'referral' IS NOT NULL
               AND h.created_at >= now() - interval '14 days'
             GROUP BY day ORDER BY day`
          )
        : Promise.resolve({ rows: [] }),
    ]));

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
      paidMethods: paidMethods.rows.map((r) => ({ method: r.paid_method, count: Number(r.count) })),
      handoffReasons: handoffReasons.rows.map((r) => ({ reason: r.handoff_reason, count: Number(r.count) })),
      pautaByDay: canSeePauta ? pautaByDay.rows.map((r) => ({ day: r.day, count: Number(r.count) })) : null,
    });
  } catch (err) { next(err); }
});

export default router;
