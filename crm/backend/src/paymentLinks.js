import { pool } from './db.js';
import { lineFromSession, defaultLineId, nameResolver } from './salesThreads.js';
import { PENDING_HOURS } from './salesRules.js';

// Links de pago de NeoLink: cuando una asesora manda uno por el chat, la página del link muestra el monto a cobrar ("Monto:
// Q1,461.00"). El CRM lo lee (solo lectura: un GET, sin enviar nada) y lo guarda para mostrar lo pendiente de pago. Solo se abre
// la dirección exacta pay.neolink.com.gt por https, sin seguir redirecciones.
const HOST = 'pay.neolink.com.gt';
export const NEOLINK_RE = /https:\/\/pay\.neolink\.com\.gt\/[A-Za-z0-9/_\-.]+/gi;
export const linkUrls = (text) => [...new Set(String(text ?? '').match(NEOLINK_RE) ?? [])];

// El monto que dice la página: el texto "Monto" seguido de Q y la cifra; null si no se encuentra.
export function parseLinkAmount(html) {
  const text = String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/[#*_`]/g, ' ').replace(/\s+/g, ' ');
  const m = /Monto\s*:?\s*Q\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1000000 ? n : null;
}

let doFetch = (...args) => fetch(...args);
export const _setFetchForTests = (fn) => { doFetch = fn; };

export async function fetchLinkAmount(url) {
  let u;
  try { u = new URL(url); } catch { return { amount: null, error: 'dirección inválida' }; }
  if (u.protocol !== 'https:' || u.hostname !== HOST) return { amount: null, error: 'dirección no permitida' };
  try {
    const res = await doFetch(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'CRM-Studio-F/1.0', Accept: 'text/html' } });
    if (res.status !== 200) return { amount: null, error: `la página respondió ${res.status}` };
    const amount = parseLinkAmount((await res.text()).slice(0, 500000));
    return amount ? { amount, error: null } : { amount: null, error: 'no se encontró el monto' };
  } catch (err) {
    return { amount: null, error: err.name === 'TimeoutError' ? 'la página tardó demasiado' : 'no se pudo abrir la página' };
  }
}

// rows: [{ id, session_id, created_at, text, advisor }] — mensajes de asesoras. Guarda el monto de cada link nuevo.
async function registerMessages(rows) {
  if (!rows.length) return;
  const defaultLine = await defaultLineId();
  for (let i = 0; i < rows.length; i += 4) {
    await Promise.all(rows.slice(i, i + 4).map(async (r) => {
      const url = linkUrls(r.text)[0];
      if (!url) return;
      const { amount, error } = await fetchLinkAmount(url);
      await pool.query(
        `INSERT INTO payment_links (message_id, url, amount, phone, line_id, advisor_name, sent_at, fetched_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
         ON CONFLICT (message_id) DO UPDATE SET amount = COALESCE(EXCLUDED.amount, payment_links.amount), fetched_at = now(), error = EXCLUDED.error`,
        [r.id, url, amount, String(r.session_id).split('__')[0], lineFromSession(r.session_id) ?? defaultLine, r.advisor ?? null, r.created_at, error]
      );
    }));
  }
}

const MSG_COLUMNS = `h.id, h.session_id, h.created_at, h.message->>'content' AS text, h.message->'additional_kwargs'->>'advisorName' AS advisor`;
const NOT_READ_YET = `NOT EXISTS (SELECT 1 FROM payment_links p WHERE p.message_id = h.id AND (p.amount IS NOT NULL OR p.fetched_at > now() - interval '10 minutes'))`;

let lastSync = 0;
// Lee los links que las asesoras mandaron en las últimas 72 h y todavía no se han leído. Pensado para llamarse al abrir el
// Dashboard: como mucho una vez cada 30 s, y los que fallan se reintentan cada 10 minutos.
export async function syncRecentPaymentLinks({ throttleMs = 30000 } = {}) {
  if (Date.now() - lastSync < throttleMs) return;
  lastSync = Date.now();
  const { rows } = await pool.query(
    `SELECT ${MSG_COLUMNS} FROM n8n_chat_histories h
     WHERE h.created_at >= now() - interval '${PENDING_HOURS} hours' AND h.message->>'type' = 'ai' AND h.message->'additional_kwargs'->>'sentBy' = 'advisor'
       AND h.message->>'content' ILIKE '%pay.neolink.com.gt/%' AND ${NOT_READ_YET}
     ORDER BY h.id DESC LIMIT 30`
  );
  await registerMessages(rows);
}

// Para el cierre del día: pone el monto del link como monto de cada venta pendiente que se pagó por link (eventId = el mensaje
// de la asesora con los medios de pago). Si el link no se pudo leer, deja el monto que ya traía.
export async function applyLinkAmounts(pending) {
  const ids = [...new Set(pending.map((p) => p.eventId).filter((id) => id > 0))];
  if (!ids.length) return pending;
  const { rows } = await pool.query(
    `SELECT ${MSG_COLUMNS} FROM n8n_chat_histories h WHERE h.id = ANY($1::bigint[]) AND h.message->>'content' ILIKE '%pay.neolink.com.gt/%' AND ${NOT_READ_YET}`, [ids]
  );
  await registerMessages(rows);
  const { rows: known } = await pool.query('SELECT message_id, amount FROM payment_links WHERE message_id = ANY($1::bigint[]) AND amount IS NOT NULL', [ids]);
  const byMsg = new Map(known.map((k) => [Number(k.message_id), Number(k.amount)]));
  for (const p of pending) if (byMsg.has(Number(p.eventId))) { p.amount = byMsg.get(Number(p.eventId)); p.amountSource = 'link'; }
  return pending;
}

// Links mandados en las últimas 72 h al cliente que todavía no tiene una venta registrada después. Si a un cliente le mandaron
// varios links, cuenta solo el último. El resumen y la unión con los pendientes del chat están en pendingPayments.js.
export async function pendingFromLinks() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(c.id::text, pl.phone)) pl.id, pl.url, pl.amount, pl.phone, pl.line_id, pl.sent_at, pl.advisor_name, c.id AS customer_id, c.full_name AS customer_name
     FROM payment_links pl LEFT JOIN customers c ON c.whatsapp_number = pl.phone
     WHERE pl.sent_at >= now() - interval '${PENDING_HOURS} hours'
       AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = c.id AND s.status IN ('confirmada', 'revisar') AND s.created_at >= pl.sent_at)
     ORDER BY COALESCE(c.id::text, pl.phone), pl.sent_at DESC`
  );
  const canonical = nameResolver();
  const items = [];
  for (const r of rows) {
    items.push({
      source: 'link', id: r.id, url: r.url, medium: 'link', amount: r.amount != null ? Number(r.amount) : null, phone: r.phone, line: r.line_id,
      customerId: r.customer_id, customerName: r.customer_name ?? null, sentAt: r.sent_at, advisorName: (await canonical(r.advisor_name)) ?? r.advisor_name ?? 'Sin asignar',
    });
  }
  return items;
}
