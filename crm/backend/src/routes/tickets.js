import { Router } from 'express';
import { pool } from '../db.js';
import { isValidStatus } from '../ticketStatus.js';
import { logAccess } from '../auditLog.js';
import { ELEVATED_ROLES } from '../auth.js';

const router = Router();

// Admins and supervisors see everything; asesores see tickets for customers in
// their zone plus any not yet assigned a zone (the current intake flow no
// longer collects it upfront).
function zoneClause(user, params) {
  if (ELEVATED_ROLES.includes(user.role)) return '';
  params.push(user.zone);
  return `AND (c.zone IS NULL OR c.zone = $${params.length})`;
}

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

    if (!ELEVATED_ROLES.includes(req.user.role) && ticket.zone !== req.user.zone) {
      return res.status(403).json({ error: 'forbidden' });
    }

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
    const existing = await pool.query(
      `SELECT c.zone FROM tickets t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1`,
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'not found' });
    if (!ELEVATED_ROLES.includes(req.user.role) && existing.rows[0].zone !== req.user.zone) {
      return res.status(403).json({ error: 'forbidden' });
    }

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
