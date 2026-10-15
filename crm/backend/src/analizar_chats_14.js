import { pool } from './db.js';
import fs from 'fs';
import path from 'path';

export async function analizarChats14Octubre() {
  console.log('========================================================================');
  console.log('=== INICIANDO AUDITORÍA PROFUNDA DE CHATS DEL 14 DE OCTUBRE 2026 ===');
  console.log('========================================================================');

  const auraLast4 = ['4947', '8666', '5352', '1882', '5625', '0037', '7851', '4291'];
  const leydiLast4 = ['1059', '7107'];

  // 1. Clientes por terminación de teléfono
  const { rows: matchedCustomers } = await pool.query(`
    SELECT c.id, c.full_name, c.whatsapp_number, c.manual_status, c.paid_locked, c.paid_method,
           c.payment_suggested_at, c.payment_suggestion_reason, c.payment_suggestion_method
    FROM customers c
    WHERE RIGHT(c.whatsapp_number, 4) = ANY($1)
    ORDER BY c.whatsapp_number
  `, [auraLast4.concat(leydiLast4)]);

  // 2. Clientes con mensajes de Leydi el 14 de octubre
  const { rows: leydiInteractions } = await pool.query(`
    SELECT DISTINCT 
      COALESCE(c.whatsapp_number, split_part(h.session_id, '__', 1)) as whatsapp_number,
      c.id as customer_id,
      c.full_name
    FROM n8n_chat_histories h
    LEFT JOIN customers c ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
    WHERE (h.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
      AND (
        h.message->'additional_kwargs'->>'advisorName' ILIKE '%Leydi%'
        OR h.message->'additional_kwargs'->>'sentBy' ILIKE '%Leydi%'
      )
  `);

  // 3. Clientes con cotización o mención de Q823 en chat el 14 de octubre (el tercer caso de Leydi)
  const { rows: q823Matches } = await pool.query(`
    SELECT DISTINCT 
      COALESCE(c.whatsapp_number, split_part(h.session_id, '__', 1)) as whatsapp_number,
      c.id as customer_id,
      c.full_name
    FROM n8n_chat_histories h
    LEFT JOIN customers c ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
    WHERE (h.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
      AND (h.message->>'content' ILIKE '%823%')
  `);

  // 4. Clientes que enviaron imágenes o comprobantes el 14 de octubre
  const { rows: receiptSenders } = await pool.query(`
    SELECT DISTINCT 
      COALESCE(c.whatsapp_number, split_part(h.session_id, '__', 1)) as whatsapp_number,
      c.id as customer_id,
      c.full_name
    FROM n8n_chat_histories h
    LEFT JOIN customers c ON (h.session_id = c.whatsapp_number OR h.session_id LIKE c.whatsapp_number || '__%' OR h.session_id LIKE '%' || RIGHT(c.whatsapp_number, 8))
    LEFT JOIN message_attachments att ON att.n8n_message_id = h.id
    WHERE (h.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
      AND (
        att.id IS NOT NULL 
        OR h.message->'additional_kwargs'->>'hasAttachment' = 'true'
        OR h.message->'additional_kwargs'->>'ocrAmount' IS NOT NULL
      )
  `);

  // 5. Clientes con ventas registradas el 14 de octubre
  const { rows: salesRows14 } = await pool.query(`
    SELECT DISTINCT c.whatsapp_number, c.id as customer_id, c.full_name
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    WHERE (s.created_at AT TIME ZONE 'America/Guatemala')::date = '2026-10-14'
  `);

  // Unificar teléfonos únicos a auditar
  const phoneMap = new Map();
  for (const r of matchedCustomers) if (r.whatsapp_number) phoneMap.set(r.whatsapp_number, r);
  for (const r of leydiInteractions) if (r.whatsapp_number && !phoneMap.has(r.whatsapp_number)) phoneMap.set(r.whatsapp_number, r);
  for (const r of q823Matches) if (r.whatsapp_number && !phoneMap.has(r.whatsapp_number)) phoneMap.set(r.whatsapp_number, r);
  for (const r of receiptSenders) if (r.whatsapp_number && !phoneMap.has(r.whatsapp_number)) phoneMap.set(r.whatsapp_number, r);
  for (const r of salesRows14) if (r.whatsapp_number && !phoneMap.has(r.whatsapp_number)) phoneMap.set(r.whatsapp_number, r);

  const allPhones = Array.from(phoneMap.keys());
  const auditResults = [];

  for (const phone of allPhones) {
    const { rows: custRows } = await pool.query(
      `SELECT id, full_name, whatsapp_number, manual_status, paid_locked, paid_method,
              payment_suggested_at, payment_suggestion_reason, payment_suggestion_method
       FROM customers WHERE whatsapp_number = $1 OR whatsapp_number LIKE '%' || RIGHT($1, 8)
       ORDER BY id ASC LIMIT 1`,
      [phone]
    );
    const customer = custRows[0] || { id: null, full_name: 'Desconocido', whatsapp_number: phone };

    // Todas las ventas de este cliente
    const { rows: sales } = await pool.query(`
      SELECT s.id, s.amount, s.advisor_name, s.payment_method, s.status, s.amount_source, s.notes, s.attributed_by,
             to_char(s.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI:SS') as fecha_gt,
             (s.created_at AT TIME ZONE 'America/Guatemala')::date as fecha_dia
      FROM sales s
      WHERE s.customer_id = $1
      ORDER BY s.created_at ASC
    `, [customer.id]);

    // Auditorías en access_audit
    const { rows: audits } = await pool.query(`
      SELECT actor, action, details, to_char(accessed_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI:SS') as fecha_gt
      FROM access_audit
      WHERE customer_id = $1
      ORDER BY accessed_at ASC
    `, [customer.id]);

    // Historial cronológico completo de mensajes
    const { rows: rawMsgs } = await pool.query(`
      SELECT 
        h.id,
        to_char(h.created_at AT TIME ZONE 'America/Guatemala', 'YYYY-MM-DD HH24:MI:SS') as fecha_gt,
        (h.created_at AT TIME ZONE 'America/Guatemala')::date as fecha_dia,
        h.message->>'type' as msg_type,
        h.message->'additional_kwargs'->>'sentBy' as sent_by,
        h.message->'additional_kwargs'->>'advisorName' as advisor_name,
        h.message->'additional_kwargs'->>'ocrAmount' as ocr_amount,
        h.message->'additional_kwargs'->>'hasAttachment' as has_attachment,
        h.message->>'content' as content,
        att.id as attachment_id,
        att.kind as attachment_kind,
        att.filename as attachment_filename,
        att.mime_type as attachment_mime
      FROM n8n_chat_histories h
      LEFT JOIN message_attachments att ON att.n8n_message_id = h.id
      WHERE (h.session_id = $1 OR h.session_id LIKE $1 || '__%' OR h.session_id LIKE '%' || RIGHT($1, 8))
        AND (h.created_at AT TIME ZONE 'America/Guatemala')::date >= '2026-10-13'
        AND (h.created_at AT TIME ZONE 'America/Guatemala')::date <= '2026-10-15'
      ORDER BY h.id ASC
    `, [phone]);

    const advisorsFound = new Set();
    const quotedAmounts = [];

    const messages = rawMsgs.map(m => {
      if (m.advisor_name) advisorsFound.add(m.advisor_name);
      if (m.content) {
        const matches = m.content.match(/Q\s*[\d,]+(\.\d{1,2})?/gi);
        if (matches) quotedAmounts.push(...matches);
      }
      return {
        id: m.id,
        fecha: m.fecha_gt,
        dia: m.fecha_dia,
        tipo: m.msg_type,
        sentBy: m.sent_by,
        asesor: m.advisor_name,
        ocrAmount: m.ocr_amount,
        adjunto: m.attachment_id ? { id: m.attachment_id, kind: m.attachment_kind, filename: m.attachment_filename } : null,
        contenido: m.content
      };
    });

    const last4 = phone.slice(-4);
    auditResults.push({
      phone,
      last4,
      customer,
      esCuadernoAura: auraLast4.includes(last4),
      esCuadernoLeydi: leydiLast4.includes(last4),
      asesorasEnChat: Array.from(advisorsFound),
      montosMencionados: Array.from(new Set(quotedAmounts)),
      ventas: sales,
      ventasDia14: sales.filter(s => s.fecha_dia === '2026-10-14'),
      auditorias: audits,
      mensajes14Octubre: messages.filter(m => m.dia === '2026-10-14'),
      mensajesContexto: messages.filter(m => m.dia !== '2026-10-14')
    });
  }

  // Ordenar resultados: primero los del cuaderno de Aura, luego Leydi, luego otros con ventas el 14
  auditResults.sort((a, b) => {
    if (a.esCuadernoAura && !b.esCuadernoAura) return -1;
    if (!a.esCuadernoAura && b.esCuadernoAura) return 1;
    if (a.esCuadernoLeydi && !b.esCuadernoLeydi) return -1;
    if (!a.esCuadernoLeydi && b.esCuadernoLeydi) return 1;
    return b.ventasDia14.length - a.ventasDia14.length;
  });

  // Guardar archivo JSON detallado en disco
  const reportPath = path.resolve(process.cwd(), 'analisis_14_octubre.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditResults, null, 2), 'utf8');

  // Generar reporte en texto plano
  let txt = '========================================================================================\n';
  txt += 'AUDITORÍA INTEGRAL DE CHATS, COMPROBANTES Y VENTAS DEL 14 DE OCTUBRE (STUDIO F)\n';
  txt += '========================================================================================\n\n';

  txt += `Total de clientes examinados: ${auditResults.length}\n`;
  txt += `Clientes de lista Aura (...4947, 8666, 5352, 1882, 5625, 0037, 7851, 4291): ${auditResults.filter(r => r.esCuadernoAura).length}\n`;
  txt += `Clientes de lista Leydi (...1059, 7107): ${auditResults.filter(r => r.esCuadernoLeydi).length}\n\n`;

  for (const r of auditResults) {
    const badge = r.esCuadernoAura ? '[CUADERNO AURA]' : (r.esCuadernoLeydi ? '[CUADERNO LEYDI]' : '[ACTIVIDAD 14/10]');
    txt += `========================================================================================\n`;
    txt += `${badge} CLIENTE: ${r.customer.full_name} | TELÉFONO: ${r.phone} | TERMINA: ${r.last4}\n`;
    txt += `Estado CRM: ${r.customer.manual_status} | Pagado Fijo: ${r.customer.paid_locked} | Método: ${r.customer.paid_method}\n`;
    txt += `Sugerencia Pago: ${r.customer.payment_suggestion_reason || 'Ninguna'}\n`;
    txt += `Asesoras detectadas en conversación: ${r.asesorasEnChat.join(', ') || 'Solo bot / cliente'}\n`;
    txt += `Montos cotizados/mencionados en texto: ${r.montosMencionados.join(', ') || 'Ninguno'}\n`;
    
    txt += `\n--- VENTAS REGISTRADAS EN BD (${r.ventas.length} en total, ${r.ventasDia14.length} el 14/10) ---\n`;
    if (r.ventas.length === 0) {
      txt += `  (Sin ventas registradas en BD)\n`;
    } else {
      for (const v of r.ventas) {
        txt += `  * Venta #${v.id}: Q${v.amount} | Asesor: ${v.advisor_name} | Fecha: ${v.fecha_gt} | Origen: ${v.amount_source} | Estado: ${v.status} | Notas: ${v.notes}\n`;
      }
    }

    txt += `\n--- REGISTROS DE AUDITORÍA (access_audit) (${r.auditorias.length}) ---\n`;
    for (const a of r.auditorias) {
      txt += `  * [${a.fecha_gt}] ${a.actor} -> ${a.action}: ${a.details}\n`;
    }

    txt += `\n--- HISTORIAL DE MENSAJES DEL 14 DE OCTUBRE (${r.mensajes14Octubre.length} mensajes) ---\n`;
    if (r.mensajes14Octubre.length === 0) {
      txt += `  (No hubo mensajes en chat el 14/10; se adjuntan mensajes de días contiguos)\n`;
      for (const m of r.mensajesContexto) {
        const sender = m.asesor ? `[ASESORA: ${m.asesor}]` : (m.tipo === 'human' ? '[CLIENTE]' : '[BOT]');
        const att = m.adjunto ? ` [ADJUNTO: ${m.adjunto.kind} - ${m.adjunto.filename}]` : '';
        const ocr = m.ocrAmount ? ` [OCR: Q${m.ocrAmount}]` : '';
        txt += `  (${m.fecha}) ${sender}${ocr}${att}: ${m.contenido || '(sin texto)'}\n`;
      }
    } else {
      for (const m of r.mensajes14Octubre) {
        const sender = m.asesor ? `[ASESORA: ${m.asesor}]` : (m.tipo === 'human' ? '[CLIENTE]' : '[BOT]');
        const att = m.adjunto ? ` [ADJUNTO: ${m.adjunto.kind} - ${m.adjunto.filename}]` : '';
        const ocr = m.ocrAmount ? ` [OCR: Q${m.ocrAmount}]` : '';
        txt += `  ${m.fecha} ${sender}${ocr}${att}: ${m.contenido || '(sin texto)'}\n`;
      }
    }
    txt += `\n\n`;
  }

  const txtPath = path.resolve(process.cwd(), 'analisis_14_octubre.txt');
  fs.writeFileSync(txtPath, txt, 'utf8');

  console.log(`Auditoría guardada exitosamente:`);
  console.log(`- JSON: ${reportPath}`);
  console.log(`- TXT: ${txtPath}`);

  return {
    totalClientesAnalizados: auditResults.length,
    clientesAuraCuaderno: auditResults.filter(r => r.esCuadernoAura).length,
    clientesLeydiCuaderno: auditResults.filter(r => r.esCuadernoLeydi).length,
    reportFileJson: reportPath,
    reportFileTxt: txtPath,
    txtContent: txt,
    clientes: auditResults
  };
}

if (process.argv[1] && process.argv[1].endsWith('analizar_chats_14.js')) {
  analizarChats14Octubre()
    .then((res) => {
      console.log(`\n¡Auditoría completada! Analizados ${res.totalClientesAnalizados} clientes.`);
      console.log(`Archivo generado: ${res.reportFileTxt}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Error durante la auditoría:', err);
      process.exit(1);
    });
}
