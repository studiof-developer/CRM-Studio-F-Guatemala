import { Router } from 'express';
import { pool } from '../db.js';
import { isValidStatus } from '../ticketStatus.js';
import { logAccess } from '../auditLog.js';
import { EFFECTIVE_STATUS_SQL } from './customers.js';

const router = Router();

// The advisor team handles every zone for Studio F Guatemala (not zone-assigned
// individually), so this is a no-op — kept as a hook in case that ever changes.
function zoneClause() {
  return '';
}

// Every column a contact can land in, and the order they're drawn in on the board.
// "pendiente" and "resuelto" come straight from the ticket's own status; everything
// else in between is really the customer's temperature wearing a pipeline-stage name
// (see the 2026-08-31 conversation that settled this — Cotización is just "tibio",
// Medio de pago is "caliente", etc., under a name that means something to an advisor
// instead of a weather word). One ticket can only ever be in exactly one column, so
// this is a strict priority order, not a set of independent flags: a resolved ticket
// shows as resuelto no matter what temperature is sitting on the customer underneath.
export const PIPELINE_COLUMNS = ['pendiente', 'en_atencion', 'cotizacion', 'medio_pago', 'pagado', 'pqrs', 'resuelto'];

// Called by both GET /pipeline below and (indirectly, by staying in sync with it)
// anywhere else that needs to know "which column does this row belong to" — kept in
// one place so the board and the SQL CASE that mirrors it can't drift apart silently.
const BUCKET_CASE_SQL = `
  CASE
    WHEN ticket_status = 'resuelto' THEN 'resuelto'
    WHEN ticket_status = 'esperando_asesor' THEN 'pendiente'
    WHEN temperature = 'pqrs' THEN 'pqrs'
    WHEN temperature = 'pagado' THEN 'pagado'
    WHEN temperature = 'caliente' THEN 'medio_pago'
    WHEN temperature = 'tibio' THEN 'cotizacion'
    ELSE 'en_atencion'
  END
`;

// One column at a time, paged — "traer todo" (2026-08-31: 2733 in "en_atencion" alone)
// still can't mean one query that returns thousands of rows. Instead every column loads
// its first page up front and pulls the next one as the advisor scrolls that column,
// same PAGE_SIZE-at-a-time pattern already used for the conversation list — nothing is
// ever hidden, it just arrives incrementally instead of all at once.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Coalesces identical concurrent requests (same reasoning as conversations.js/
// dashboard.js) — several advisors opening the board within the same few seconds share
// one query per column instead of each firing their own.
const READ_CACHE_TTL_MS = 3000;
const pipelineCache = new Map();
function cachedRead(key, run) {
  const hit = pipelineCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = run().catch((err) => { pipelineCache.delete(key); throw err; });
  pipelineCache.set(key, { expires: Date.now() + READ_CACHE_TTL_MS, promise });
  return promise;
}

router.get('/pipeline', async (req, res, next) => {
  try {
    const bucket = req.query.bucket;
    if (!PIPELINE_COLUMNS.includes(bucket)) return res.status(400).json({ error: 'invalid bucket' });
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';

    const { rows } = await cachedRead(`${bucket}:${offset}:${limit}:${sort}`, () => pool.query(`
      WITH temped AS (
        SELECT t.id AS ticket_id, t.status AS ticket_status,
               c.id AS customer_id, c.full_name, c.whatsapp_number,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               GREATEST(t.updated_at, c.updated_at) AS stage_since
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        WHERE t.status != 'bot'
      ),
      -- bucket_total counted here, over the whole (small — tickets/customers, not
      -- messages) set, before narrowing to just this one column.
      totaled AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket, count(*) OVER (PARTITION BY ${BUCKET_CASE_SQL}) AS bucket_total
        FROM temped
      ),
      -- The page is decided here — before the message lookup below runs, not after.
      -- Doing that lookup for the whole column instead of just this one page is exactly
      -- the "scan way more than we're going to render" mistake fixed elsewhere today.
      page AS (
        SELECT * FROM totaled WHERE bucket = $1
        ORDER BY stage_since ${sort}
        OFFSET $2 LIMIT $3
      )
      -- One LATERAL per page row, each an index-backed prefix lookup on session_id
      -- (idx_n8n_chat_histories_session_id is text_pattern_ops specifically for this)
      -- — not a scan, so this stays cheap no matter how deep a column gets paged.
      SELECT p.*, lm.content AS last_message, lm.created_at AS last_message_at
      FROM page p
      LEFT JOIN LATERAL (
        SELECT h.message->>'content' AS content, h.created_at
        FROM n8n_chat_histories h
        WHERE h.session_id LIKE p.whatsapp_number || '%'
          AND h.message->>'type' = 'human'
          AND coalesce(h.message->>'content', '') <> ''
        ORDER BY h.id DESC
        LIMIT 1
      ) lm ON true
      ORDER BY p.stage_since ${sort}
    `, [bucket, offset, limit]));

    res.json({
      total: rows[0] ? Number(rows[0].bucket_total) : 0,
      cards: rows.map((r) => ({
        ticketId: r.ticket_id,
        customerId: r.customer_id,
        fullName: r.full_name,
        whatsappNumber: r.whatsapp_number,
        temperature: r.temperature,
        ticketStatus: r.ticket_status,
        lastMessage: r.last_message,
        // stageSince is when the STATUS/temperature last changed, not when the customer
        // last wrote — those drift apart constantly (a customer can send several
        // messages while the ticket sits untouched), which is exactly why the "hace X"
        // shown next to their latest message looked wrong. lastMessageAt is what the
        // card's time display should use; stageSince stays reserved for the "No
        // atendidos" SLA check, which really is about ticket wait time.
        stageSince: r.stage_since,
        lastMessageAt: r.last_message_at,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const params = [];
    let statusClause = '';
    if (status) {
      if (!isValidStatus(status)) return res.status(400).json({ error: 'invalid status' });
      params.push(status);
      statusClause = `AND t.status = $${params.length}`;
    }
    const zClause = zoneClause(req.user, params);

    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.handoff_reason, t.assigned_advisor, t.created_at, t.updated_at,
              c.id AS customer_id, c.full_name, c.whatsapp_number, c.department
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       WHERE true ${statusClause} ${zClause}
       ORDER BY t.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.handoff_reason, t.assigned_advisor, t.created_at, t.updated_at,
              c.id AS customer_id, c.full_name, c.whatsapp_number, c.department, c.municipio, c.preferred_line,
              c.preferred_size, c.purchase_frequency, c.purchase_status, c.zone
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const ticket = rows[0];

    logAccess(req.user, ticket.customer_id, 'view_ticket');

    const orders = await pool.query(
      `SELECT ticket_code, status, total, payment_method, shipping_address, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
      [ticket.customer_id]
    );
    ticket.orders = orders.rows;
    res.json(ticket);
  } catch (err) { next(err); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await pool.query(`SELECT id FROM tickets WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });

    const { status, assigned_advisor } = req.body ?? {};
    if (status && !isValidStatus(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const { rows } = await pool.query(
      `UPDATE tickets SET
         status = COALESCE($1, status),
         assigned_advisor = COALESCE($2, assigned_advisor),
         first_response_at = CASE WHEN $1 = 'en_atencion' AND first_response_at IS NULL THEN now() ELSE first_response_at END,
         resolved_at = CASE WHEN $1 = 'resuelto' THEN now() ELSE resolved_at END,
         updated_at = now()
       WHERE id = $3
       RETURNING id, status, assigned_advisor, updated_at, first_response_at, resolved_at`,
      [status ?? null, assigned_advisor ?? null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
