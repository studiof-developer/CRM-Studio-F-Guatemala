import fs from 'fs';
import { createHash } from 'crypto';
import { pool } from './db.js';
import { loadEvents, threadLines, analyzeCustomer, nameResolver, defaultLineId } from './salesThreads.js';

// Exporta, como texto plano, los chats de los clientes en Pagado / Por despacho (o con ventas registradas en el período)
// para revisarlos a mano al pie de la letra. Por cliente: la conversación con hora de Guatemala, quién escribió, los
// adjuntos con lo que leyó el OCR, lo que el CRM tiene registrado y cómo lo leyó el motor. Solo lee.
const TEXT_MAX = 700;
const gt = (d) => {
  const g = new Date(+new Date(d) - 6 * 3600000).toISOString(); // MM-DD HH:MM en hora de Guatemala
  return `${g.slice(5, 10)} ${g.slice(11, 16)}`;
};
const q = (n) => (n == null ? '?' : `Q${Number(n).toFixed(2)}`);
const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ⏎ ').trim();

async function attachmentsByMessage(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT a.n8n_message_id, a.kind, a.mime_type, a.file_path, o.amount, o.voucher, o.snippet, (o.attachment_id IS NOT NULL) AS read
     FROM message_attachments a LEFT JOIN attachment_ocr o ON o.attachment_id = a.id
     WHERE a.n8n_message_id = ANY($1::int[]) ORDER BY a.id`,
    [ids]
  );
  const map = new Map();
  for (const r of rows) {
    // Huella corta del archivo: la misma imagen enviada muchas veces (la tarjeta de medios de pago, una guía de tallas) se
    // reconoce por tener la misma huella aunque el OCR no la haya leído.
    r.hash = await fileHash(r.file_path);
    map.set(Number(r.n8n_message_id), [...(map.get(Number(r.n8n_message_id)) ?? []), r]);
  }
  return map;
}

async function fileHash(path) {
  try { return createHash('sha1').update(await fs.promises.readFile(path)).digest('hex').slice(0, 8); } catch { return null; }
}

function describeAttachment(a) {
  const kind = a.mime_type === 'application/pdf' ? 'PDF' : a.kind === 'image' ? 'IMAGEN' : String(a.kind ?? 'ARCHIVO').toUpperCase();
  const bits = [];
  if (!a.read) bits.push('sin leer por OCR');
  else {
    if (a.amount != null) bits.push(`monto leído ${q(a.amount)}`);
    if (a.voucher) bits.push('voucher de pago aprobado');
    if (a.snippet) bits.push(`texto: "${oneLine(a.snippet).slice(0, 110)}"`);
    if (a.amount == null && !a.voucher && !a.snippet) bits.push('el OCR no encontró texto');
  }
  return `[${kind}${a.hash ? ` #${a.hash}` : ''}: ${bits.join(' · ')}]`;
}

export async function exportChats({ from, to, write }) {
  const start = new Date(`${from}T00:00:00-06:00`);
  const end = new Date(`${to}T23:59:59.999-06:00`);
  const canonical = nameResolver();
  const fallbackLine = await defaultLineId();
  const { rows: customers } = await pool.query(
    `SELECT c.id, c.whatsapp_number, c.full_name, c.manual_status, c.paid_locked
     FROM customers c
     WHERE c.manual_status IN ('pagado', 'despacho')
        OR EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.created_at >= $1 AND s.created_at <= $2)
        -- también los chats donde la asesora mandó medios de pago en el período, aunque el cliente no esté en Pagado /
        -- Por despacho (ventas pendientes, o pagadas que nadie movió de columna)
        OR c.whatsapp_number IN (
          SELECT split_part(h.session_id, '__', 1) FROM n8n_chat_histories h
          WHERE h.created_at >= $1 AND h.created_at <= $2 AND h.message->>'type' = 'ai'
            AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
            AND h.message->>'content' ~* '(https?://|neolink|banrural|banco industrial|n[uú]mero de cuenta|a nombre de)'
        )
     ORDER BY c.id`,
    [start, end]
  );

  write(`CHATS DE CLIENTES EN PAGADO / POR DESPACHO (o con ventas registradas en el período)\n`);
  write(`Período: ${from} al ${to} (hora de Guatemala). Generado: ${gt(new Date())}\n`);
  write(`Formato de cada mensaje: [MM-DD HH:MM] #id QUIÉN: texto. QUIÉN = CLIENTE, el nombre de la asesora, o BOT.\n`);
  write(`"MOTOR" = cómo leyó ese chat el motor de ventas; "CRM" = ventas registradas en el CRM.\n\n`);

  let exported = 0;
  for (const c of customers) {
    const blocks = [];
    for (const line of await threadLines(c.whatsapp_number)) {
      // dos días antes del período, para ver los medios de pago que se mandaron la noche anterior
      const events = await loadEvents({ phone: c.whatsapp_number, customerId: c.id, lineId: line ?? fallbackLine, from: new Date(+start - 2 * 86400000), to: end });
      if (!events.some((e) => +new Date(e.at) >= +start)) continue;
      const atts = await attachmentsByMessage(events.map((e) => e.id).filter((id) => id > 0));
      const out = [`  -- línea ${line ?? 'social'} --`];
      for (const e of events) {
        const who = e.role === 'customer' ? 'CLIENTE' : e.role === 'advisor' ? ((await canonical(e.advisor)) ?? e.advisor ?? 'ASESORA') : 'BOT';
        const parts = [];
        if (e.text) parts.push(oneLine(e.text).slice(0, TEXT_MAX));
        for (const a of atts.get(e.id) ?? []) parts.push(describeAttachment(a));
        if (e.role === 'customer' && e.ocrAmount && !(atts.get(e.id) ?? []).length) parts.push(`[monto leído ${q(e.ocrAmount)} (${e.via ?? 'chat'})]`);
        const mark = +new Date(e.at) < +start ? '·' : ' ';
        out.push(`${mark}[${gt(e.at)}] #${e.id} ${who}: ${parts.join(' ') || '(sin texto)'}`);
      }
      blocks.push(out.join('\n'));
    }
    if (!blocks.length) continue;
    exported++;

    const { rows: sales } = await pool.query(
      `SELECT amount, advisor_name, status, created_at, amount_basis FROM sales WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 8`, [c.id]
    );
    let motor = [];
    try {
      const r = await analyzeCustomer(c, { canonical });
      motor = r.rows.filter((x) => +new Date(x.at) >= +start && +new Date(x.at) <= +end).map((x) =>
        `venta ${gt(x.at)} ${q(x.amount)} · asesora ${x.advisor ?? 'sin atribuir'} (${(x.rule ?? '').replace(/_/g, ' ')}) · ${x.type === 'comprobante' ? `comprobante (${x.via ?? '?'})` : 'confirmación sin comprobante'} · ${x.verified ? `confirmada por ${x.confirmedBy ?? 'la asesora'}` : 'SIN confirmar'}${x.amountBasis === 'precio_aprobado' ? ' · monto por validar' : ''}${x.attributionUncertain ? ' · asesora por validar' : ''}`);
      if (r.pending.length) motor.push(...r.pending.map((p) => `pendiente: medios de pago de ${p.advisor ?? '?'} ${gt(p.at)} · ${q(p.amount)}${p.customerAccepted ? ' · el cliente aceptó' : ''}`));
    } catch (err) {
      motor = [`error leyendo el chat: ${err.message}`];
    }

    write(`==================================================================================\n`);
    write(`CLIENTE ${c.whatsapp_number} · ${c.full_name ?? 'sin nombre'} · estado: ${c.manual_status ?? '—'}${c.paid_locked ? ' · pago bloqueado' : ''}\n`);
    write(`CRM: ${sales.length ? sales.map((s) => `${q(s.amount)} ${s.advisor_name} ${gt(s.created_at)} (${s.status}${s.amount_basis ? `, ${s.amount_basis}` : ''})`).join(' | ') : 'sin ventas registradas'}\n`);
    write(`MOTOR: ${motor.length ? motor.join('\n       ') : 'no detectó ventas ni pendientes en el período'}\n`);
    write(`${blocks.join('\n')}\n\n`);
  }
  write(`----------------------------------------------------------------------------------\nClientes exportados: ${exported} de ${customers.length} candidatos (los demás no tienen mensajes en el período).\n`);
  return exported;
}
