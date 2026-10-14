import { pool } from './db.js';

async function run() {
  console.log('========================================================');
  console.log('=== 1. VENTAS REGISTRADAS HOY (14/10) ===');
  console.log('========================================================');
  const { rows: todaySales } = await pool.query(`
    SELECT s.id, s.amount, s.advisor_name, s.notes, s.amount_source, c.whatsapp_number,
           to_char(s.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI') as fecha_gt
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    WHERE (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
    ORDER BY s.id DESC
  `);
  console.table(todaySales);
  const totalHoy = todaySales.reduce((acc, r) => acc + Number(r.amount), 0);
  console.log(`TOTAL HOY: Q ${totalHoy.toFixed(2)} (${todaySales.length} ventas)\n`);

  console.log('========================================================');
  console.log('=== 2. VENTAS REGISTRADAS AYER (13/10) ===');
  console.log('========================================================');
  const { rows: yesterdaySales } = await pool.query(`
    SELECT s.id, s.amount, s.advisor_name, s.notes, s.amount_source, c.whatsapp_number,
           to_char(s.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI') as fecha_gt
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    WHERE (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-13'
    ORDER BY s.id DESC
  `);
  console.table(yesterdaySales);
  const totalAyer = yesterdaySales.reduce((acc, r) => acc + Number(r.amount), 0);
  console.log(`TOTAL AYER: Q ${totalAyer.toFixed(2)} (${yesterdaySales.length} ventas)\n`);

  console.log('========================================================');
  console.log('=== 3. ASESORAS ACTIVAS EN CHAT (n8n_chat_histories) ===');
  console.log('========================================================');
  const { rows: advChat } = await pool.query(`
    SELECT 
      message->'additional_kwargs'->>'advisorName' as advisor_en_chat,
      COUNT(*) as total_mensajes,
      MAX(created_at AT TIME ZONE 'America/Guatemala')::text as ultimo_mensaje
    FROM n8n_chat_histories
    WHERE message->>'type' = 'ai'
      AND (message->'additional_kwargs'->>'sentBy') = 'advisor'
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  console.table(advChat);

  console.log('========================================================');
  console.log('=== 4. ASESORAS EN ACCESS_AUDIT (quién marcó pagado) ===');
  console.log('========================================================');
  const { rows: auditPaid } = await pool.query(`
    SELECT actor, COUNT(*) as veces_marco_pagado,
           MAX(accessed_at AT TIME ZONE 'America/Guatemala')::text as ultima_vez
    FROM access_audit
    WHERE action = 'customer_marked_paid'
    GROUP BY 1
    ORDER BY 2 DESC
  `);
  console.table(auditPaid);

  console.log('========================================================');
  console.log('=== 5. TOTAL VENTAS POR ASESOR EN TODA LA TABLA SALES ===');
  console.log('========================================================');
  const { rows: salesByAdv } = await pool.query(`
    SELECT advisor_name, COUNT(*) as ventas, SUM(amount) as total_quetzales
    FROM sales
    GROUP BY 1
    ORDER BY total_quetzales DESC
  `);
  console.table(salesByAdv);

  console.log('========================================================');
  console.log('=== 6. CASOS DE LEYDI (Zulema 54843294, Gloria 55157085, Ana 40432640) ===');
  console.log('========================================================');
  const { rows: leydiCusts } = await pool.query(`
    SELECT c.id, c.full_name, c.whatsapp_number, s.id as sale_id, s.amount, s.advisor_name,
           to_char(s.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI') as fecha_venta
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id
    WHERE c.whatsapp_number LIKE '%54843294%'
       OR c.whatsapp_number LIKE '%55157085%'
       OR c.whatsapp_number LIKE '%4043264%'
  `);
  console.table(leydiCusts);

  console.log('========================================================');
  console.log('=== 7. MIGRACIONES APLICADAS EN LA BASE DE DATOS ===');
  console.log('========================================================');
  const { rows: migs } = await pool.query(`
    SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 10
  `);
  console.table(migs);

  process.exit(0);
}

run().catch(err => {
  console.error('Error en diagnóstico:', err);
  process.exit(1);
});
