import { Router } from 'express';
import { pool } from '../db.js';
import { findCustomerBySessionId, PHONE_RE } from './conversations.js';

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
       LEFT JOIN customers c ON c.id = a.customer_id
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

    // Resolving each row's customer and handoff correlation one at a time (up to 200
    // extra queries for 100 rows, each re-scanning that session's full message history
    // just to confirm a phone number regex already tells us) was the same "many small
    // queries fired in parallel" pattern that caused the real slowdowns fixed 2026-08-31
    // elsewhere in the app — batched into two queries total instead.
    //
    // Production session_ids are already the real wa_id (phone) — only the rare legacy
    // test session with a non-phone id needs the expensive transcript-scanning fallback
    // in findCustomerBySessionId, so that only ever runs for those, not for every row.
    const phoneBySessionId = new Map();
    const legacySessionIds = [];
    for (const r of rows) {
      if (!r.session_id) continue;
      if (PHONE_RE.test(r.session_id)) phoneBySessionId.set(r.session_id, r.session_id);
      else legacySessionIds.push(r.session_id);
    }
    for (const sessionId of new Set(legacySessionIds)) {
      const { phone } = await findCustomerBySessionId(sessionId);
      if (phone) phoneBySessionId.set(sessionId, phone);
    }

    const phones = [...new Set(phoneBySessionId.values())];
    const { rows: customers } = phones.length
      ? await pool.query(`SELECT id, full_name, whatsapp_number FROM customers WHERE whatsapp_number = ANY($1)`, [phones])
      : { rows: [] };
    const customerByPhone = new Map(customers.map((c) => [c.whatsapp_number, c]));

    const correlationRows = rows
      .map((r, i) => ({ i, customer: customerByPhone.get(phoneBySessionId.get(r.session_id)) }))
      .filter((c) => c.customer);
    const handedOffByIndex = new Map();
    if (correlationRows.length) {
      const { rows: handoffs } = await pool.query(
        `SELECT v.idx, EXISTS (
           SELECT 1 FROM tickets t
           WHERE t.customer_id = v.customer_id
             AND t.status IN ('esperando_asesor', 'en_atencion')
             AND t.created_at BETWEEN v.created_at - interval '30 seconds' AND v.created_at + interval '30 seconds'
         ) AS handed_off
         FROM unnest($1::int[], $2::int[], $3::timestamptz[]) AS v(idx, customer_id, created_at)`,
        [
          correlationRows.map((c) => c.i),
          correlationRows.map((c) => c.customer.id),
          correlationRows.map((c) => rows[c.i].created_at),
        ]
      );
      for (const h of handoffs) handedOffByIndex.set(h.idx, h.handed_off);
    }

    const enriched = rows.map((r, i) => {
      const customer = customerByPhone.get(phoneBySessionId.get(r.session_id));
      return { ...r, customerName: customer?.full_name ?? null, handed_off: handedOffByIndex.get(i) ?? false };
    });

    res.json(enriched);
  } catch (err) { next(err); }
});

export default router;
