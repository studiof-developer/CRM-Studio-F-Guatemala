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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Per-message, not just "is this customer currently awaiting a reply" — a customer who
// got answered for an earlier message but then sent another that sat unanswered until
// the range closed (even if picked up later, after `to`) still counts. Guatemala never
// observes DST, so a fixed -06 offset for the day boundaries is always correct — same
// assumption the dashboard snapshot's 7am refresh already relies on.
router.get('/unanswered', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
    }
    const fromTs = new Date(`${from}T00:00:00-06:00`);
    const toTs = new Date(`${to}T00:00:00-06:00`);
    toTs.setUTCDate(toTs.getUTCDate() + 1); // exclusive end — the whole "to" day counts
    if (Number.isNaN(fromTs) || Number.isNaN(toTs) || fromTs >= toTs) {
      return res.status(400).json({ error: 'invalid date range' });
    }

    const { rows } = await pool.query(
      `WITH customer_msgs AS (
         SELECT session_id, id, created_at
         FROM n8n_chat_histories
         WHERE message->>'type' = 'human'
           AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
       ),
       sin_responder AS (
         SELECT cm.session_id, cm.created_at
         FROM customer_msgs cm
         WHERE NOT EXISTS (
           SELECT 1 FROM n8n_chat_histories h2
           WHERE h2.session_id = cm.session_id
             AND h2.message->>'type' = 'ai'
             AND h2.created_at > cm.created_at
             AND h2.created_at < $2::timestamptz
         )
       )
       SELECT
         split_part(s.session_id, '__', 1) AS phone,
         c.id AS customer_id,
         c.full_name,
         min(s.created_at) AS first_unanswered_at,
         count(*) AS unanswered_count
       FROM sin_responder s
       LEFT JOIN customers c ON c.whatsapp_number = split_part(s.session_id, '__', 1)
       GROUP BY split_part(s.session_id, '__', 1), c.id, c.full_name
       ORDER BY first_unanswered_at ASC`,
      [fromTs.toISOString(), toTs.toISOString()]
    );
    res.json(rows.map((r) => ({
      phone: r.phone,
      customerId: r.customer_id,
      fullName: r.full_name,
      firstUnansweredAt: r.first_unanswered_at,
      unansweredCount: Number(r.unanswered_count),
    })));
  } catch (err) { next(err); }
});

export default router;
