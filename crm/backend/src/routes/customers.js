import { Router } from 'express';
import { pool } from '../db.js';
import { logAccess } from '../auditLog.js';

const router = Router();

// Every registered customer gets a handoff ticket now (not just complaints), so ticket
// existence alone no longer implies PQRS — that badge would've swallowed almost every
// customer. The ticket's own status ("pendiente"/"en atención") already flags that a
// human needs to look; PQRS stays available as a manual override for actual P/Q/R/S.
// Pagado is sticky once true. Caliente/Tibio/Frío only apply to customers who never bought.
export const TEMPERATURE_SQL = `
  CASE
    WHEN c.purchase_frequency > 0 THEN 'pagado'
    WHEN EXISTS (
      SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status = 'pendiente_pago'
    ) THEN 'caliente'
    WHEN EXISTS (
      SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.customer_id = c.id AND o.status = 'carrito'
    ) THEN 'tibio'
    ELSE 'frio'
  END
`;

export const VALID_TEMPERATURES = ['caliente', 'tibio', 'frio', 'pagado', 'pqrs'];
export const VALID_PAID_METHODS = ['tarjeta', 'efectivo', 'transferencia', 'deposito'];

// Advisor override wins whenever set — the bot/n8n never writes manual_status,
// so once an advisor picks a status it's pinned until an advisor changes it again.
export const EFFECTIVE_STATUS_SQL = `COALESCE(c.manual_status, ${TEMPERATURE_SQL})`;

// The advisor team handles every zone for Studio F Guatemala (not zone-assigned
// individually), so this is a no-op — kept as a hook in case that ever changes.
export function zoneClause() {
  return '';
}

router.get('/counts', async (req, res, next) => {
  try {
    const params = [];
    const zClause = zoneClause(req.user, params);
    const { rows } = await pool.query(
      `SELECT ${EFFECTIVE_STATUS_SQL} AS temperature, count(*) AS count
       FROM customers c
       WHERE true ${zClause}
       GROUP BY temperature`,
      params
    );
    const counts = Object.fromEntries(VALID_TEMPERATURES.map((t) => [t, 0]));
    for (const r of rows) counts[r.temperature] = Number(r.count);
    res.json(counts);
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status && !VALID_TEMPERATURES.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const params = [];
    const zClause = zoneClause(req.user, params);
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `WHERE temperature = $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT c.id, c.full_name, c.whatsapp_number, c.department, c.zone,
                c.preferred_line, c.purchase_frequency, c.paid_locked,
                ${EFFECTIVE_STATUS_SQL} AS temperature
         FROM customers c
         WHERE true ${zClause}
       ) t
       ${statusFilter}
       ORDER BY id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, ${EFFECTIVE_STATUS_SQL} AS temperature FROM customers c WHERE c.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const customer = rows[0];

    logAccess(req.user, customer.id, 'view_customer');

    const [orders, tickets, consents, conversations] = await Promise.all([
      pool.query(
        `SELECT id, ticket_code, status, total, payment_method, shipping_address, created_at
         FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`,
        [customer.id]
      ),
      pool.query(
        `SELECT id, status, handoff_reason, assigned_advisor, created_at, updated_at
         FROM tickets WHERE customer_id = $1 ORDER BY created_at DESC`,
        [customer.id]
      ),
      pool.query(
        `SELECT type, accepted, policy_version, channel, created_at
         FROM consents WHERE customer_id = $1 ORDER BY created_at DESC`,
        [customer.id]
      ),
      pool.query(
        `SELECT DISTINCT session_id FROM n8n_chat_histories
         WHERE session_id IN (
           SELECT DISTINCT session_id FROM n8n_chat_histories
           WHERE message->>'type' = 'human' AND trim(message->>'content') = $1
         )`,
        [customer.whatsapp_number]
      ),
    ]);

    res.json({
      ...customer,
      orders: orders.rows,
      tickets: tickets.rows,
      consents: consents.rows,
      conversationSessionIds: conversations.rows.map((r) => r.session_id.split('__')[0]),
    });
  } catch (err) { next(err); }
});

// Plain profile fields — open to every role (asesor, supervisor, admin), since with the
// bot's intake trimmed down to just name + consent, whoever picks up the ticket is the
// one filling in the rest (DPI, dirección, talla, etc.) as the customer gives it to them.
const PROFILE_FIELDS = ['full_name', 'dpi', 'birth_date', 'department', 'municipio', 'address', 'preferred_line', 'preferred_size', 'email'];

router.patch('/:id', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT id FROM customers WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });

    const fields = PROFILE_FIELDS.filter((f) => f in (req.body ?? {}));
    if (!fields.length) return res.status(400).json({ error: 'no fields to update' });

    const setClause = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => {
      const v = req.body[f];
      return typeof v === 'string' ? (v.trim() || null) : v;
    });
    const { rows } = await pool.query(
      `UPDATE customers SET ${setClause}, updated_at = now() WHERE id = $${values.length + 1}
       RETURNING id, full_name, dpi, birth_date, department, municipio, address, preferred_line, preferred_size, email`,
      [...values, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Advisor override: manual_status is fully settable (including back to null, to
// release the override and return to automatic). paid_locked is one-way — the API
// rejects any attempt to send it back to false, since a paid customer stays paid.
router.patch('/:id/tags', async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query(`SELECT id FROM customers WHERE id = $1`, [req.params.id]);
    if (!existing.length) return res.status(404).json({ error: 'not found' });

    const { manualStatus, paidLocked, paidMethod } = req.body ?? {};
    if (manualStatus !== undefined && manualStatus !== null && !VALID_TEMPERATURES.includes(manualStatus)) {
      return res.status(400).json({ error: 'invalid manualStatus' });
    }
    if (paidLocked !== undefined && paidLocked !== true) {
      return res.status(400).json({ error: 'paidLocked cannot be reversed once set' });
    }
    if (paidLocked === true && !VALID_PAID_METHODS.includes(paidMethod)) {
      return res.status(400).json({ error: 'paidMethod is required when marking as paid' });
    }

    const { rows } = await pool.query(
      `UPDATE customers AS c SET
         manual_status = CASE WHEN $1 THEN $2 ELSE manual_status END,
         paid_locked = paid_locked OR COALESCE($3, false),
         paid_method = CASE WHEN $3 THEN $5 ELSE paid_method END
       WHERE c.id = $4
       RETURNING id, manual_status, paid_locked, paid_method, ${EFFECTIVE_STATUS_SQL} AS temperature`,
      [manualStatus !== undefined, manualStatus ?? null, paidLocked, req.params.id, paidMethod ?? null]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
