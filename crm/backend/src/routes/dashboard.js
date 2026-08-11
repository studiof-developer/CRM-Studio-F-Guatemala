import { Router } from 'express';
import { pool } from '../db.js';
import { TEMPERATURE_SQL, VALID_TEMPERATURES, zoneClause } from './customers.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const kpiParams = [];
    const kpiZone = zoneClause(req.user, kpiParams);

    const pipelineParams = [];
    const pipelineZone = zoneClause(req.user, pipelineParams);

    const revenueParams = [];
    const revenueZone = zoneClause(req.user, revenueParams);

    const topProductsParams = [];
    const topProductsZone = zoneClause(req.user, topProductsParams);

    const recentOrdersParams = [];
    const recentOrdersZone = zoneClause(req.user, recentOrdersParams);

    const [kpis, pipeline, revenueByDay, topProducts, recentOrders] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT coalesce(sum(o.total),0) FROM orders o JOIN customers c ON c.id=o.customer_id
             WHERE o.status='pagado' ${kpiZone}) AS ingresos_totales,
           (SELECT count(*) FROM orders o JOIN customers c ON c.id=o.customer_id
             WHERE o.status='pagado' AND o.created_at >= date_trunc('month', now()) ${kpiZone}) AS pedidos_mes,
           (SELECT count(*) FROM customers c WHERE true ${kpiZone}) AS clientes_totales,
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
        `SELECT date_trunc('day', o.created_at)::date AS day, sum(o.total) AS total
         FROM orders o JOIN customers c ON c.id=o.customer_id
         WHERE o.status='pagado' AND o.created_at >= now() - interval '14 days' ${revenueZone}
         GROUP BY day ORDER BY day`,
        revenueParams
      ),
      pool.query(
        `SELECT p.name, sum(oi.quantity) AS units
         FROM order_items oi
         JOIN orders o ON o.id=oi.order_id
         JOIN customers c ON c.id=o.customer_id
         JOIN products p ON p.id=oi.product_id
         WHERE o.status='pagado' ${topProductsZone}
         GROUP BY p.name ORDER BY units DESC LIMIT 5`,
        topProductsParams
      ),
      pool.query(
        `SELECT o.ticket_code, c.full_name, c.whatsapp_number, o.total, o.status, o.created_at
         FROM orders o JOIN customers c ON c.id=o.customer_id
         WHERE o.status != 'carrito' ${recentOrdersZone}
         ORDER BY o.created_at DESC LIMIT 6`,
        recentOrdersParams
      ),
    ]);

    const pipelineCounts = Object.fromEntries(VALID_TEMPERATURES.map((t) => [t, 0]));
    for (const r of pipeline.rows) pipelineCounts[r.temperature] = Number(r.count);

    res.json({
      kpis: {
        ingresosTotales: Number(kpis.rows[0].ingresos_totales),
        pedidosMes: Number(kpis.rows[0].pedidos_mes),
        clientesTotales: Number(kpis.rows[0].clientes_totales),
        ticketsPendientes: Number(kpis.rows[0].tickets_pendientes),
        tiempoRespuestaMin: kpis.rows[0].tiempo_respuesta_min === null ? null : Number(kpis.rows[0].tiempo_respuesta_min),
        tiempoResolucionMin: kpis.rows[0].tiempo_resolucion_min === null ? null : Number(kpis.rows[0].tiempo_resolucion_min),
      },
      pipeline: pipelineCounts,
      revenueByDay: revenueByDay.rows.map((r) => ({ day: r.day, total: Number(r.total) })),
      topProducts: topProducts.rows.map((r) => ({ name: r.name, units: Number(r.units) })),
      recentOrders: recentOrders.rows.map((r) => ({
        ticketCode: r.ticket_code,
        customerName: r.full_name || r.whatsapp_number,
        total: r.total === null ? null : Number(r.total),
        status: r.status,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
