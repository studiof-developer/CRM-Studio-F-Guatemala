import { pool } from './db.js';
import { buildThread, threadLines } from './salesThreads.js';

const gt = (d) => new Date(d).toLocaleString('es-GT', { timeZone: 'America/Guatemala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const q = (n) => `Q${Number(n).toLocaleString('es-GT', { minimumFractionDigits: 2 })}`;
const clip = (s, n = 90) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Muestra tal cual cómo lee el motor el chat de un cliente alrededor de un día: cada mensaje (con lo que se leyó de sus imágenes/PDF),
// y las ventas, pendientes y pruebas descartadas que salen de ahí. Solo lee lo ya guardado: no lanza lecturas OCR nuevas.
export async function explainChat({ phone, day }) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) throw Object.assign(new Error('Indica al menos los últimos 4 dígitos del teléfono'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) throw Object.assign(new Error('Indica el día (AAAA-MM-DD)'), { status: 400 });
  const { rows: customers } = await pool.query(
    `SELECT id, whatsapp_number, full_name, manual_status FROM customers WHERE whatsapp_number LIKE '%' || $1 ORDER BY id LIMIT 5`, [digits]
  );
  const out = [];
  if (!customers.length) return [`No hay ningún cliente cuyo teléfono termine en ${digits}`];
  const from = +new Date(`${day}T00:00:00-06:00`) - 86400000;
  const to = +new Date(`${day}T23:59:59.999-06:00`) + 86400000;
  for (const c of customers) {
    for (const line of await threadLines(c.whatsapp_number)) {
      const t = await buildThread(c, line);
      out.push(`=== ${c.full_name || c.whatsapp_number} (${c.whatsapp_number}) · línea ${line} · estado ${c.manual_status ?? '—'} ===`);
      const inWindow = t.events.filter((e) => +new Date(e.at) >= from && +new Date(e.at) <= to);
      const ids = inWindow.filter((e) => e.id > 0).map((e) => e.id);
      const { rows: atts } = ids.length ? await pool.query(
        `SELECT a.n8n_message_id AS mid, a.kind, a.mime_type, o.amount, o.voucher, o.snippet, (o.attachment_id IS NOT NULL) AS cached
         FROM message_attachments a LEFT JOIN attachment_ocr o ON o.attachment_id = a.id WHERE a.n8n_message_id = ANY($1::int[]) ORDER BY a.id`, [ids]
      ) : { rows: [] };
      const byMsg = new Map();
      for (const a of atts) byMsg.set(Number(a.mid), [...(byMsg.get(Number(a.mid)) ?? []), a]);
      out.push('Mensajes (día anterior, el día y el siguiente):');
      for (const e of inWindow) {
        const who = e.role === 'customer' ? 'CLIENTE ' : e.role === 'advisor' ? `ASESORA ${e.advisor ?? '?'}` : 'BOT';
        out.push(`  ${gt(e.at)}  ${who}: ${clip(e.text)}`);
        for (const a of byMsg.get(e.id) ?? []) {
          const read = !a.cached ? 'NO se ha leído (sin caché)' : (Number(a.amount) > 0 ? `leído: ${q(a.amount)}${a.voucher ? ' · voucher' : ''}` : `leído SIN monto${a.voucher ? ' · voucher' : ''}${a.snippet ? ` · texto: "${clip(a.snippet, 70)}"` : ''}`);
          out.push(`      ↳ ${a.kind === 'image' ? 'imagen' : a.mime_type}: ${read}`);
        }
      }
      out.push('Cómo lo lee el motor:');
      const eps = t.episodes.filter((x) => +new Date(x.at) >= from && +new Date(x.at) <= to);
      for (const x of eps) out.push(`  VENTA ${gt(x.at)} ${x.type} ${x.amount != null ? q(x.amount) : 'sin monto'} · asesora ${x.advisor ?? '—'} (${x.rule ?? '—'}) · ${x.verified ? 'verificada' : 'sin confirmar'}${x.issues.length ? ` · alertas: ${x.issues.join(', ')}` : ''}`);
      for (const o of t.orphanReceipts.filter((x) => +new Date(x.at) >= from && +new Date(x.at) <= to)) out.push(`  PRUEBA DESCARTADA ${gt(o.at)} ${o.amount != null ? q(o.amount) : 'sin monto'}: llegó sin medios de pago previos (24 h) ni confirmación`);
      if (t.pending) out.push(`  PENDIENTE: medios de pago de ${t.pending.advisor ?? '—'} (${gt(t.pending.at)}), sin pago${t.pending.amount != null ? `, ${q(t.pending.amount)}` : ''}`);
      if (!eps.length && !t.pending) out.push('  (ninguna venta ni pendiente en esa ventana)');
    }
  }
  return out;
}
