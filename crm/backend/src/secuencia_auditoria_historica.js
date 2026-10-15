import { pool } from './db.js';
import fs from 'fs';
import path from 'path';

export async function auditarTodosLosChats() {
  console.log('========================================================================');
  console.log('=== INICIANDO SECUENCIA UNIVERSAL DE AUDITORÍA HISTÓRICA DE CHATS ===');
  console.log('========================================================================');

  // 1. Encontrar todas las conversaciones con evidencia de compra:
  // - Vouchers o comprobantes (adjuntos imágenes/pdf)
  // - Lecturas OCR (ocrAmount)
  // - Enlaces o vouchers de NeoLink
  // - Mensajes de cierre de pedido ("pedido ya está en proceso de alistamiento")
  const { rows: candidateSessions } = await pool.query(`
    SELECT DISTINCT 
      COALESCE(c.whatsapp_number, split_part(h.session_id, '__', 1)) as phone,
      c.id as customer_id,
      c.full_name,
      c.manual_status,
      c.paid_locked
    FROM n8n_chat_histories h
    LEFT JOIN customers c ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
    LEFT JOIN message_attachments att ON att.n8n_message_id = h.id
    WHERE (
      att.id IS NOT NULL 
      OR h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
      OR h.message->'additional_kwargs'->>'hasAttachment' = 'true'
      OR h.message->>'content' ILIKE '%voucher%'
      OR h.message->>'content' ILIKE '%comprobante%'
      OR h.message->>'content' ILIKE '%boleta%'
      OR h.message->>'content' ILIKE '%proceso de alistamiento%'
      OR h.message->>'content' ILIKE '%pay.neolink.com.gt%'
    )
    ORDER BY phone
  `);

  console.log(`Se detectaron ${candidateSessions.length} clientes con potencial evidencia de compra.`);

  const dailyReport = {};
  const allDetectedSales = [];

  for (const cs of candidateSessions) {
    if (!cs.phone) continue;

    // Obtener los mensajes relevantes de esta conversación
    const { rows: msgs } = await pool.query(`
      SELECT 
        h.id,
        to_char(h.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI:SS') as fecha_gt,
        (h.created_at AT TIME ZONE 'America/Guatemala')::date as fecha_dia,
        h.message->>'type' as msg_type,
        h.message->'additional_kwargs'->>'sentBy' as sent_by,
        h.message->'additional_kwargs'->>'advisorName' as advisor_name,
        h.message->'additional_kwargs'->>'ocrAmount' as ocr_amount,
        h.message->>'content' as content,
        att.id as attachment_id,
        att.filename as attachment_filename,
        att.kind as attachment_kind
      FROM n8n_chat_histories h
      LEFT JOIN message_attachments att ON att.n8n_message_id = h.id
      WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%' OR h.session_id LIKE '%' || RIGHT($1, 8))
      ORDER BY h.id ASC
    `, [cs.phone]);

    // Buscar eventos de confirmación de pago
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const isDispatchConfirm = m.content && /proceso de alistamiento|tu pedido ya est[aá] en proceso/i.test(m.content);
      const hasOcr = m.ocr_amount && Number(m.ocr_amount) > 0 && Number(m.ocr_amount) <= 10000;
      const isVoucherPdf = m.attachment_filename && /voucher|comprobante|recibo/i.test(m.attachment_filename);
      const isNeoLinkVoucher = m.content && /pay\.neolink\.com\.gt\/transaccion\/voucher/i.test(m.content);

      if (isDispatchConfirm || hasOcr || isVoucherPdf || isNeoLinkVoucher) {
        // Encontrar la asesora responsable en ese momento
        let advisor = m.advisor_name;
        if (!advisor) {
          // Mirar mensajes de asesor cercanos hacia atrás
          for (let j = i; j >= Math.max(0, i - 10); j--) {
            if (msgs[j].advisor_name && msgs[j].advisor_name !== 'bot' && msgs[j].advisor_name !== 'sistema') {
              advisor = msgs[j].advisor_name;
              break;
            }
          }
        }
        if (!advisor) advisor = 'Aura Cristina Carvajal Delgado'; // default supervisor si no hay tag

        // Normalizar nombre asesora
        if (/leydi/i.test(advisor)) advisor = 'Leydi Laura Mosquera';
        else if (/luisa/i.test(advisor)) advisor = 'Luisa Cristancho';
        else if (/aura/i.test(advisor)) advisor = 'Aura Cristina Carvajal Delgado';

        // Determinar monto
        let amount = hasOcr ? Number(m.ocr_amount) : null;
        if (!amount) {
          // Buscar cotización reciente en mensajes anteriores
          for (let j = i; j >= Math.max(0, i - 15); j--) {
            const txt = msgs[j].content || '';
            const match = txt.match(/Q\.?\s*([0-9]{2,5}(\.[0-9]{1,2})?)/i);
            if (match && Number(match[1]) >= 50 && Number(match[1]) <= 10000) {
              amount = Number(match[1]);
              break;
            }
          }
        }

        if (amount && amount > 0) {
          const saleDate = String(m.fecha_dia);
          if (!dailyReport[saleDate]) {
            dailyReport[saleDate] = { total: 0, count: 0, byAdvisor: {} };
          }
          if (!dailyReport[saleDate].byAdvisor[advisor]) {
            dailyReport[saleDate].byAdvisor[advisor] = { total: 0, count: 0, sales: [] };
          }

          // Evitar registrar duplicados en el mismo día para el mismo cliente
          const already = dailyReport[saleDate].byAdvisor[advisor].sales.find(s => s.phone === cs.phone && Math.abs(s.amount - amount) < 1);
          if (!already) {
            const saleItem = {
              phone: cs.phone,
              customerName: cs.full_name || 'Desconocido',
              amount,
              advisor,
              fecha: m.fecha_gt,
              dia: saleDate,
              evidencia: isDispatchConfirm ? 'Alistamiento confirmado' : (hasOcr ? `OCR Q${amount}` : 'Voucher/Comprobante')
            };

            dailyReport[saleDate].total += amount;
            dailyReport[saleDate].count += 1;
            dailyReport[saleDate].byAdvisor[advisor].total += amount;
            dailyReport[saleDate].byAdvisor[advisor].count += 1;
            dailyReport[saleDate].byAdvisor[advisor].sales.push(saleItem);
            allDetectedSales.push(saleItem);
          }
        }
      }
    }
  }

  // Generar reporte formateado en texto
  let txt = '========================================================================================\n';
  txt += 'REPORTE FORENSE DE VENTAS Y COMPROBANTES DE TODOS LOS CHATS\n';
  txt += '========================================================================================\n\n';

  const sortedDates = Object.keys(dailyReport).sort();
  for (const d of sortedDates) {
    const day = dailyReport[d];
    txt += `----------------------------------------------------------------------------------------\n`;
    txt += `FECHA: ${d} | TOTAL DÍA: Q ${day.total.toFixed(2)} (${day.count} ventas cerradas)\n`;
    txt += `----------------------------------------------------------------------------------------\n`;
    for (const [adv, data] of Object.entries(day.byAdvisor)) {
      txt += `  * ${adv}: Q ${data.total.toFixed(2)} (${data.count} ventas)\n`;
      for (const s of data.sales) {
        txt += `      - ${s.customerName} (${s.phone}) -> Q ${s.amount.toFixed(2)} [${s.evidencia}] @ ${s.fecha}\n`;
      }
    }
    txt += `\n`;
  }

  const outPath = path.resolve(process.cwd(), 'auditoria_historica_todos_los_chats.txt');
  fs.writeFileSync(outPath, txt, 'utf8');

  const jsonPath = path.resolve(process.cwd(), 'auditoria_historica_todos_los_chats.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ dailyReport, allDetectedSales }, null, 2), 'utf8');

  console.log(`Auditoría histórica completada.`);
  console.log(`Archivo TXT: ${outPath}`);
  console.log(`Archivo JSON: ${jsonPath}`);

  return {
    totalDiasAuditados: sortedDates.length,
    totalVentasDetectadas: allDetectedSales.length,
    dailyReport,
    reportFileTxt: outPath,
    reportFileJson: jsonPath
  };
}

if (process.argv[1] && process.argv[1].endsWith('secuencia_auditoria_historica.js')) {
  auditarTodosLosChats()
    .then(r => {
      console.log(`Proceso terminado con éxito. Días auditados: ${r.totalDiasAuditados}. Ventas: ${r.totalVentasDetectadas}`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}
