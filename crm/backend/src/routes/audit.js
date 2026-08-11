import { Router } from 'express';
import { pool } from '../db.js';
import { findCustomerBySessionId } from './conversations.js';

const router = Router();

router.get('/access', async (req, res, next) => {
  try {
    const { customerId, actorUserId, action, from, to } = req.query;
    const clauses = [];
    const params = [];

    if (customerId) { params.push(customerId); clauses.push(`a.customer_id = $${params.length}`); }
    if (actorUserId) { params.push(actorUserId); clauses.push(`a.actor_user_id = $${params.length}`); }
    if (action) { params.push(action); clauses.push(`a.action = $${params.length}`); }
    if (from) { params.push(from); clauses.push(`a.accessed_at >= $${params.length}`); }
    if (to) { params.push(to); clauses.push(`a.accessed_at <= $${params.length}`); }

    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.accessed_at, a.actor,
              c.id AS customer_id, c.full_name AS customer_name,
              u.id AS actor_user_id, u.full_name AS actor_name, u.role AS actor_role
       FROM access_audit a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE true ${where}
       ORDER BY a.accessed_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/ai-decisions', async (req, res, next) => {
  try {
    const { handedOff } = req.query;
    const clauses = [];
    const params = [];
    if (handedOff !== undefined) { params.push(handedOff === 'true'); clauses.push(`handed_off = $${params.length}`); }
    const where = clauses.length ? `AND ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, session_id, message_in, rag_context, response_out, confidence, handed_off, created_at
       FROM ai_decision_log
       WHERE true ${where}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );

    // Small admin-only view over a modest table — resolving each row's customer via
    // the same phone heuristic used elsewhere is simplest and fast enough at this scale.
    //
    // handed_off is never set by the n8n insert (would need to parse the AI Agent's
    // intermediate tool-call steps, whose shape we can't verify without live access to
    // that workflow). Instead we derive it: a handoff ticket created within ~30s of this
    // log row is, in practice, the same conversation turn escalating.
    // ponytail: 30s correlation window, tighten if turns ever overlap that fast.
    const enriched = await Promise.all(rows.map(async (r) => {
      if (!r.session_id) return { ...r, customerName: null, handed_off: false };
      const { customer } = await findCustomerBySessionId(r.session_id);
      if (!customer) return { ...r, customerName: null, handed_off: false };
      const handoff = await pool.query(
        `SELECT 1 FROM tickets
         WHERE customer_id = $1 AND status IN ('esperando_asesor', 'en_atencion')
           AND created_at BETWEEN $2::timestamptz - interval '30 seconds' AND $2::timestamptz + interval '30 seconds'
         LIMIT 1`,
        [customer.id, r.created_at]
      );
      return { ...r, customerName: customer.full_name, handed_off: handoff.rows.length > 0 };
    }));

    res.json(enriched);
  } catch (err) { next(err); }
});

export default router;
