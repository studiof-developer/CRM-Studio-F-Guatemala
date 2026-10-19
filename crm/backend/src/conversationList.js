import { pool } from './db.js';
import { EFFECTIVE_STATUS_SQL } from './routes/customers.js';

// La lista "abrir Conversaciones" (las N conversaciones con actividad más reciente) no necesita leer toda la
// tabla de mensajes: con 150 mil mensajes la consulta completa tardaba ~800 ms (lectura de toda la tabla +
// un ordenamiento en disco de todas las filas) y crece con cada mensaje nuevo. Aquí se parte de los mensajes
// más recientes: si en esa ventana hay al menos N conversaciones distintas, esas son las N más recientes (el
// último mensaje de cada una está dentro de la ventana); si no, la ventana se amplía hasta el historial completo.
const LINE_ID_SQL = (col) => `COALESCE(${col}.whatsapp_number_id, CASE WHEN ${col}.session_id ~ '__line_[0-9]+' THEN (regexp_match(${col}.session_id, '__line_([0-9]+)'))[1]::int ELSE 1 END)`;
// Un mensaje "visible" en la lista: con texto, o con adjunto.
const READABLE_SQL = (col) => `${col}.message->>'type' IN ('human', 'ai')
  AND (coalesce(${col}.message->>'content', '') <> ''
       OR (${col}.message->'additional_kwargs'->>'hasAttachment') = 'true'
       OR (${col}.message->'additional_kwargs'->>'fileUrl') IS NOT NULL
       OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.n8n_message_id = ${col}.id))`;

const TOP_SQL = `
  WITH readable AS (
    SELECT h.session_id, h.id, h.message, h.created_at, ${LINE_ID_SQL('h')} AS line_id,
           split_part(h.session_id, '__', 1) AS raw_phone
    FROM n8n_chat_histories h
    WHERE h.id > $2 AND ${READABLE_SQL('h')}
  ),
  threaded AS (
    SELECT r.id, r.message, r.created_at, r.line_id,
           CASE WHEN r.raw_phone ~ '^[0-9]{7,15}$' THEN r.raw_phone ELSE NULL END AS phone,
           CASE WHEN r.raw_phone ~ '^[0-9]{7,15}$' THEN r.raw_phone || '__line_' || r.line_id::text ELSE r.session_id END AS thread_key
    FROM readable r
  ),
  last_msg AS (
    SELECT DISTINCT ON (thread_key) thread_key, phone, line_id, id, message, created_at
    FROM threaded ORDER BY thread_key, id DESC
  ),
  top AS (SELECT * FROM last_msg ORDER BY id DESC LIMIT $1)
  SELECT l.thread_key, l.line_id, l.id AS last_id, l.message, l.created_at,
         1 AS message_count,
         l.phone, c.full_name, c.zone, c.paid_locked, c.payment_suggested_at, t.status AS ticket_status,
         t.assigned_advisor,
         t.brand_name, t.branch_name, t.line_label, t.company_name,
         COALESCE(t.whatsapp_number_id, l.line_id) AS whatsapp_number_id,
         CASE WHEN c.id IS NULL THEN NULL ELSE (${EFFECTIVE_STATUS_SQL}) END AS temperature,
         0 AS unread_count,
         att.kind AS last_attachment_kind, att.filename AS last_attachment_filename
  FROM top l
  LEFT JOIN message_attachments att ON att.n8n_message_id = l.id
  LEFT JOIN customers c ON c.whatsapp_number = l.phone
  LEFT JOIN LATERAL (
    SELECT tk.id, tk.status, tk.handoff_reason, tk.assigned_advisor, tk.whatsapp_number_id,
           brnd.name AS brand_name, br.name AS branch_name, wn.label AS line_label, comp.name AS company_name
    FROM tickets tk
    LEFT JOIN whatsapp_numbers wn ON tk.whatsapp_number_id = wn.id
    LEFT JOIN branches br ON wn.branch_id = br.id
    LEFT JOIN brands brnd ON br.brand_id = brnd.id
    LEFT JOIN companies comp ON brnd.company_id = comp.id
    WHERE tk.customer_id = c.id
      AND (tk.whatsapp_number_id = l.line_id OR (l.line_id = 1 AND tk.whatsapp_number_id IS NULL))
    ORDER BY tk.created_at DESC LIMIT 1
  ) t ON true
  ORDER BY l.id DESC`;

// Mensajes sin leer de cada conversación elegida: una consulta chica por conversación (usa el índice por
// session_id), en vez de recorrer todos los mensajes de todos los clientes.
// Se pide en grupos de 50: un UNION ALL de miles de ramas rebasa la profundidad de pila del planificador.
async function unreadCounts(threads) {
  const counts = new Map();
  for (let i = 0; i < threads.length; i += 50) {
    for (const [k, n] of await unreadCountsChunk(threads.slice(i, i + 50))) counts.set(k, n);
  }
  return counts;
}

async function unreadCountsChunk(threads) {
  if (!threads.length) return new Map();
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const branches = threads.map((t) => {
    const key = p(t.thread_key);
    const line = p(t.line_id);
    let where;
    let lastRead = '0';
    if (t.phone) {
      const phone = p(t.phone);
      const like = p(`${t.phone}\\_\\_%`);
      where = `(u.session_id = ${phone}::text OR u.session_id LIKE ${like}::text)`;
      lastRead = `COALESCE((SELECT cr.last_read_message_id FROM conversation_reads cr WHERE cr.phone = ${phone}::text), 0)`;
    } else {
      where = `u.session_id = ${key}::text`;
    }
    return `SELECT ${key}::text AS thread_key, count(*)::int AS n FROM n8n_chat_histories u
            WHERE ${where} AND u.message->>'type' = 'human' AND u.id > ${lastRead}
              AND ${LINE_ID_SQL('u')} = ${line}::int AND ${READABLE_SQL('u')}`;
  });
  const { rows } = await pool.query(branches.join('\nUNION ALL\n'), params);
  return new Map(rows.map((r) => [r.thread_key, r.n]));
}

// Más allá de esto la consulta completa sale mejor que cientos de consultas chicas.
export const FAST_LIST_MAX = 300;

export async function fetchRecentThreads(limit) {
  const { rows: [{ max }] } = await pool.query('SELECT COALESCE(max(id), 0) AS max FROM n8n_chat_histories');
  const maxId = Number(max);
  // Ventana inicial proporcional al tamaño pedido; si no alcanza se multiplica por 10 y, al final, todo el historial.
  const windows = [Math.max(limit * 60, 3000), Math.max(limit * 600, 30000)].map((w) => maxId - w).filter((start) => start > 0);
  let rows = [];
  for (const start of [...windows, 0]) {
    ({ rows } = await pool.query(TOP_SQL, [limit, start]));
    if (rows.length >= limit) break;
  }
  const unread = await unreadCounts(rows);
  return rows.map((r) => ({ ...r, unread_count: unread.get(r.thread_key) ?? 0 }));
}
