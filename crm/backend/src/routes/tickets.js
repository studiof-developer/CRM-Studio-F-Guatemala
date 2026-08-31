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

// Bounded per column, not per query — without the window function a busy "resuelto"
// column (which only ever grows) could crowd out everything else within a flat overall
// LIMIT. 40 cards is already more than a board is meant to be read at a glance; bucket_total
// (the real count before truncating) is what the column header shows.
const CARDS_PER_COLUMN = 40;

router.get('/pipeline', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      WITH temped AS (
        SELECT t.id AS ticket_id, t.status AS ticket_status, t.handoff_reason,
               c.id AS customer_id, c.full_name, c.whatsapp_number,
               ${EFFECTIVE_STATUS_SQL} AS temperature,
               GREATEST(t.updated_at, c.updated_at) AS stage_since
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        WHERE t.status != 'bot'
      ),
      bucketed AS (
        SELECT *, ${BUCKET_CASE_SQL} AS bucket FROM temped
      ),
      -- Bounded to the ≤${CARDS_PER_COLUMN}-per-column set BEFORE the message lookup
      -- below runs, not after — a plain WHERE on the outer query wouldn't guarantee
      -- that ordering, and doing this lookup for every non-bot ticket instead of just
      -- the ones actually shown is exactly the "scan way more than we're going to
      -- render" mistake fixed elsewhere today.
      ranked AS (
        SELECT * FROM (
          SELECT *,
                 -- "pendiente" ranks oldest-waiting-first (that's who the SLA actually
                 -- cares about) — every other column ranks most-recently-active-first.
                 -- Negating the epoch for everything but pendiente lets both directions
                 -- share one ORDER BY: whichever 40 make the cut per column are always
                 -- the ones that matter for that column, not just "whatever's newest".
                 row_number() OVER (
                   PARTITION BY bucket
                   ORDER BY CASE WHEN bucket = 'pendiente' THEN extract(epoch FROM stage_since) ELSE -extract(epoch FROM stage_since) END ASC
                 ) AS rn,
                 count(*) OVER (PARTITION BY bucket) AS bucket_total
          FROM bucketed
        ) x
        WHERE rn <= ${CARDS_PER_COLUMN}
      )
      -- One LATERAL per (already-bounded) row, each an index-backed prefix lookup on
      -- session_id (idx_n8n_chat_histories_session_id is text_pattern_ops specifically
      -- for this) — not a scan, so this stays cheap even at ~280 rows.
      SELECT r.*, lm.content AS last_message
      FROM ranked r
      LEFT JOIN LATERAL (
        SELECT h.message->>'content' AS content
        FROM n8n_chat_histories h
        WHERE h.session_id LIKE r.whatsapp_number || '%'
          AND h.message->>'type' = 'human'
          AND coalesce(h.message->>'content', '') <> ''
        ORDER BY h.id DESC
        LIMIT 1
      ) lm ON true
      ORDER BY r.bucket, r.rn
    `);

    const columns = Object.fromEntries(PIPELINE_COLUMNS.map((key) => [key, { total: 0, cards: [] }]));
    for (const r of rows) {
      columns[r.bucket].total = Number(r.bucket_total);
      columns[r.bucket].cards.push({
        ticketId: r.ticket_id,
        customerId: r.customer_id,
        fullName: r.full_name,
        whatsappNumber: r.whatsapp_number,
        temperature: r.temperature,
        ticketStatus: r.ticket_status,
        lastMessage: r.last_message,
        stageSince: r.stage_since,
      });
    }
    res.json(columns);
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
